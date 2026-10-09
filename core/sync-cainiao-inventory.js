import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { importInventoryFile } from './erp/importers.js';
import { getInventoryReport, buildInventoryMarkdown } from './erp/reports.js';
import { sendInventoryDingTalkMarkdown } from './dingtalk.js';
import { rootDir } from './config.js';
import {
  findLatestPriorCainiaoFile,
  previousBusinessDate,
  recordInventoryValidation,
  validateCainiaoInventoryFile
} from './erp/inventory-validation.js';

const coreDir = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(rootDir, 'tests', '.auth', 'cainiao.json');
const targetUrl = 'https://b.cainiao.com/business/dsc/oms/inventory/inventoryreport';
const downloadDir = path.join(rootDir, 'downloads');
const businessTimeZone = process.env.BUSINESS_TIME_ZONE || 'Asia/Shanghai';
const authErrorCode = 'CAINIAO_AUTH_REQUIRED';

function authRequired(message) {
  const error = new Error(message);
  error.code = authErrorCode;
  return error;
}

function businessDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function queryDate() {
  return process.env.CAINIAO_INVENTORY_QUERY_DATE || businessDate();
}

function getLatestFile(dir, ext = '.xlsx') {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

async function findVisibleDownloadButton(page, timeout = 120000) {
  const deadline = Date.now() + timeout;
  const selectors = [
    'button:has-text("下载")',
    'a:has-text("下载")',
    '[role="button"]:has-text("下载")'
  ];
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
        const candidate = candidates.nth(index);
        const text = (await candidate.textContent().catch(() => '')).trim();
        if (text.includes('下载') && !text.includes('导出') && await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function isInViewport(page, locator) {
  if (!await locator.isVisible().catch(() => false)) return false;
  const box = await locator.boundingBox().catch(() => null);
  const viewport = page.viewportSize();
  if (!box || !viewport || box.width <= 0 || box.height <= 0) return false;
  return box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0;
}

async function isTopmostInViewport(page, locator) {
  if (!await isInViewport(page, locator)) return false;
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(top && (top === element || element.contains(top)));
  }).catch(() => false);
}

async function findVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await isInViewport(page, candidate)) return candidate;
    }
  }
  return null;
}

async function saveDownload(download, dateStr) {
  const downloadPath = path.join(downloadDir, `库存明细_${dateStr}_${Date.now()}.xlsx`);
  await download.saveAs(downloadPath);
  console.log('✅ 文件已下载:', downloadPath);
  return downloadPath;
}

export function buildMonthPickerPlan(currentMonth, targetMonth) {
  const currentYear = Number(String(currentMonth).slice(0, 4));
  const targetYear = Number(String(targetMonth).slice(0, 4));
  const targetMonthNumber = Number(String(targetMonth).slice(5, 7));
  if (!Number.isInteger(currentYear) || !Number.isInteger(targetYear)
    || !Number.isInteger(targetMonthNumber) || targetMonthNumber < 1 || targetMonthNumber > 12) {
    throw new Error(`无效月份: ${currentMonth} => ${targetMonth}`);
  }
  return {
    direction: targetYear < currentYear ? 'previous' : targetYear > currentYear ? 'next' : 'same',
    steps: Math.abs(targetYear - currentYear),
    targetYear,
    monthLabel: `${targetMonthNumber}月`
  };
}

async function findVisiblePickerYear(page, monthBox) {
  const yearLabels = page.getByText(/^\d{4}年$/, { exact: true });
  for (let index = await yearLabels.count() - 1; index >= 0; index -= 1) {
    const candidate = yearLabels.nth(index);
    const box = await candidate.boundingBox().catch(() => null);
    if (!box || !await isTopmostInViewport(page, candidate)) continue;
    const nearMonthInput = box.x >= monthBox.x - 80
      && box.x <= monthBox.x + monthBox.width + 80
      && box.y > monthBox.y
      && box.y < monthBox.y + 120;
    if (!nearMonthInput) continue;
    const text = (await candidate.textContent()).trim();
    return { box, year: Number(text.slice(0, 4)) };
  }
  return null;
}

async function waitForPickerYear(page, monthBox, expectedYear, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const header = await findVisiblePickerYear(page, monthBox);
    if (header?.year === expectedYear) return header;
    await page.waitForTimeout(100);
  }
  return null;
}

export async function selectCainiaoMonth(page, monthInput, targetMonth) {
  const monthBox = await monthInput.boundingBox().catch(() => null);
  if (!monthBox) throw new Error('月份选择器没有可点击区域');

  const currentMonth = await monthInput.inputValue();
  if (currentMonth === targetMonth) return true;

  // 部分旧版控件允许键盘提交，先保留这条最快路径。
  try {
    await monthInput.fill(targetMonth);
    await monthInput.press('Enter');
    await page.waitForTimeout(400);
    if (await monthInput.inputValue() === targetMonth) return true;
  } catch {
    // 新版菜鸟月份控件为只读输入框，需要使用下方的面板选择。
  }

  await page.mouse.click(monthBox.x + monthBox.width / 2, monthBox.y + monthBox.height / 2);
  await page.waitForTimeout(300);
  let header = await findVisiblePickerYear(page, monthBox);
  if (!header) return false;

  const plan = buildMonthPickerPlan(`${header.year}-01`, targetMonth);
  if (plan.steps > 20) throw new Error(`目标月份距当前年份过远，拒绝自动翻页: ${targetMonth}`);
  for (let step = 0; step < plan.steps; step += 1) {
    const expectedYear = header.year + (plan.direction === 'previous' ? -1 : 1);
    // 菜鸟当前控件没有可用的 aria-label；箭头与年份标题同行，左右各留约 16px。
    const arrowX = plan.direction === 'previous'
      ? monthBox.x + 16
      : monthBox.x + monthBox.width - 8;
    await page.mouse.click(arrowX, header.box.y + header.box.height / 2);
    header = await waitForPickerYear(page, monthBox, expectedYear);
    if (!header) return false;
  }

  const monthLabels = page.getByText(plan.monthLabel, { exact: true });
  for (let index = await monthLabels.count() - 1; index >= 0; index -= 1) {
    const candidate = monthLabels.nth(index);
    const box = await candidate.boundingBox().catch(() => null);
    if (!box || !await isTopmostInViewport(page, candidate)) continue;
    const insidePicker = box.x >= monthBox.x - 20
      && box.x <= monthBox.x + monthBox.width + 20
      && box.y > header.box.y
      && box.y < monthBox.y + 280;
    if (!insidePicker) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (await monthInput.inputValue() === targetMonth) return true;
      await page.waitForTimeout(100);
    }
    return false;
  }
  return false;
}

export async function findVisibleExportButton(page) {
  const groups = [
    page.getByRole('button', { name: '导出明细', exact: true }),
    page.locator('button:has-text("导出明细"), .ant-btn:has-text("导出明细")')
  ];
  for (const candidates of groups) {
    for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

export async function clickCainiaoControl(locator, { label = '控件', timeout = 1200 } = {}) {
  // Playwright normally auto-scrolls and waits up to 30 seconds. Cainiao's sticky tab layer can
  // keep intercepting the same point, causing visible up/down retries. Scroll once, allow a short
  // actionability window, then use the existing safe force-click fallback for a visible control.
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  try {
    await locator.click({ trial: true, timeout });
    await locator.click({ timeout });
    return { forced: false };
  } catch (error) {
    const visible = await locator.isVisible().catch(() => false);
    const enabled = await locator.isEnabled().catch(() => false);
    if (!visible || !enabled) throw error;
    console.warn(`⚠️ ${label}被页面浮层遮挡，快速强制点击继续`);
    await locator.click({ force: true, timeout });
    return { forced: true };
  }
}

export async function exportFromCainiao({ startDate = '', endDate = '' } = {}) {
  console.log('🚀 启动 Chrome 导出库存明细...');

  if (!fs.existsSync(authFile)) {
    throw authRequired('未找到登录态');
  }

  fs.mkdirSync(downloadDir, { recursive: true });

  const chrome = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-proxy-server'],
  });
  const browser = await chrome.newContext({
    storageState: authFile,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });

  try {
  const pages = browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('📍 当前页面:', page.url());

  if (page.url().includes('login')) {
    throw authRequired('Cookie 失效');
  }

  console.log('✅ 已进入库存多维查询页');
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));

  // 菜鸟默认打开“库存分析”。必须显式点击“库存明细”，否则页面没有“导出明细”按钮。
  const detailTabSelectors = [
    '.cn-next-tabs-tab-inner:has-text("库存明细")',
    '.next-tabs-tab-inner:has-text("库存明细")',
    '.cn-ui-tab-item:has-text("库存明细")',
    '[role="tab"]:has-text("库存明细")'
  ];
  let detailTab = null;
  const detailTabDeadline = Date.now() + 60000;
  while (!detailTab && Date.now() < detailTabDeadline) {
    const exactCandidates = page.getByText('库存明细', { exact: true });
    for (let index = 0; index < await exactCandidates.count(); index += 1) {
      const candidate = exactCandidates.nth(index);
      if (await isTopmostInViewport(page, candidate)) {
        detailTab = candidate;
        break;
      }
    }
    if (!detailTab) detailTab = await findVisibleLocator(page, detailTabSelectors);
    if (!detailTab) await page.waitForTimeout(2000);
  }
  if (!detailTab) {
    const screenshotPath = path.join('reports', `cainiao-detail-tab-missing-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    throw new Error(`未找到“库存明细”标签，已停止导出。排查截图: ${screenshotPath}`);
  }

  console.log('🔄 点击库存明细标签...');
  await page.evaluate(() => window.scrollTo(0, 0));
  const detailTabBox = await detailTab.boundingBox();
  if (!detailTabBox) throw new Error('“库存明细”标签没有可点击区域');
  await page.mouse.click(detailTabBox.x + detailTabBox.width / 2, detailTabBox.y + detailTabBox.height / 2);
  await page.waitForTimeout(5000);
  const activeDetailTab = page.locator([
    '.cn-next-tabs-tab.active:has-text("库存明细")',
    '.next-tabs-tab.active:has-text("库存明细")',
    '.cn-ui-tab-item.active:has-text("库存明细")',
    '[role="tab"][aria-selected="true"]:has-text("库存明细")'
  ].join(', ')).first();
  const detailContent = await findVisibleLocator(page, [
    'th:has-text("期初库存")',
    'th:has-text("期末库存")',
    'th:has-text("入库汇总")'
  ]);
  const activeDetailVisible = await activeDetailTab.isVisible().catch(() => false);
  if (!activeDetailVisible && !detailContent) {
    const screenshotPath = path.join('reports', `cainiao-detail-tab-switch-failed-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    throw new Error(`点击“库存明细”后页面未切换成功，已停止导出。排查截图: ${screenshotPath}`);
  }
  console.log('✅ 已切换到库存明细标签');

  // 新版库存明细页默认已选择“日”。旧版“日”单选框仍以隐藏模板存在，
  // 点击它会把页面错误切回库存分析，因此这里沿用页面默认粒度。

  // 菜鸟库存日报通常在次日发布上一业务日的已结算库存；实际发布日期以导出文件内的来源日期为准。
  const requestedStartDate = startDate || process.env.CAINIAO_INVENTORY_QUERY_START_DATE || process.env.CAINIAO_INVENTORY_QUERY_DATE || '';
  const requestedEndDate = endDate || process.env.CAINIAO_INVENTORY_QUERY_END_DATE || process.env.CAINIAO_INVENTORY_QUERY_DATE || requestedStartDate;
  const monthlyQuery = Boolean(requestedStartDate && requestedEndDate && requestedStartDate !== requestedEndDate);
  const dateStr = requestedStartDate
    ? (requestedStartDate === requestedEndDate ? requestedStartDate : `${requestedStartDate}_${requestedEndDate}`)
    : queryDate();
  if (requestedStartDate) {
    console.log('📅 使用显式查询日期:', requestedStartDate, '至', requestedEndDate);
    if (monthlyQuery) {
      const monthTabs = page.getByText('月', { exact: true });
      let monthTab = null;
      for (let index = 0; index < await monthTabs.count(); index += 1) {
        const candidate = monthTabs.nth(index);
        const box = await candidate.boundingBox().catch(() => null);
        if (box && await isTopmostInViewport(page, candidate) && box.y < 260) {
          monthTab = candidate;
          break;
        }
      }
      if (!monthTab) throw new Error('未找到“月”时间粒度按钮，已停止月度导出');
      const monthTabBox = await monthTab.boundingBox();
      console.log('📅 月时间粒度控件位置:', monthTabBox ? `${Math.round(monthTabBox.x)},${Math.round(monthTabBox.y)}` : '未知');
      await page.mouse.click(monthTabBox.x + monthTabBox.width / 2, monthTabBox.y + monthTabBox.height / 2);
      await page.waitForTimeout(1200);
      console.log('📅 已切换到月时间粒度');
      const monthInputs = page.locator('input[placeholder*="请选择月"]');
      let monthInput = null;
      for (let index = 0; index < await monthInputs.count(); index += 1) {
        const candidate = monthInputs.nth(index);
        if (await isTopmostInViewport(page, candidate)) {
          monthInput = candidate;
          break;
        }
      }
      if (!monthInput) throw new Error('切换月粒度后未找到月份输入框');
      const targetMonth = requestedStartDate.slice(0, 7);
      if (targetMonth !== requestedEndDate.slice(0, 7)) {
        throw new Error('月粒度每次只允许导出一个自然月');
      }
      const beforeMonth = await monthInput.inputValue();
      const monthSelected = await selectCainiaoMonth(page, monthInput, targetMonth);
      const afterMonth = await monthInput.inputValue();
      console.log('📅 月份控件提交前后:', beforeMonth, '=>', afterMonth);
      if (process.env.CAINIAO_DATE_PICKER_DIAGNOSTIC === '1' || !monthSelected || afterMonth !== targetMonth) {
        if (afterMonth !== targetMonth) {
          const monthBox = await monthInput.boundingBox();
          if (monthBox) await page.mouse.click(monthBox.x + monthBox.width / 2, monthBox.y + monthBox.height / 2);
          await page.waitForTimeout(500);
        }
        const screenshotPath = path.join('reports', `cainiao-month-picker-diagnostic-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('月份选择器排查截图:', screenshotPath);
        return null;
      }
      await page.locator('body').click({ position: { x: 900, y: 500 } });
    }
    const dateCandidates = page.locator([
      'input[placeholder*="选择日期"]',
      'input[placeholder*="开始日期"]',
      'input[placeholder*="结束日期"]',
      '.ant-calendar-picker input',
      '.ant-picker-range input',
      '.cn-next-range-picker input',
      '.next-range-picker input',
      'input[type="date"]'
    ].join(', '));
    const visibleDateInputs = [];
    for (let index = 0; index < await dateCandidates.count(); index += 1) {
      const candidate = dateCandidates.nth(index);
      if (await isTopmostInViewport(page, candidate)) visibleDateInputs.push(candidate);
    }
    if (monthlyQuery) {
      // 月粒度使用上方单一月份选择器，已经完成提交。
    } else if (visibleDateInputs.length >= 2) {
      if (process.env.CAINIAO_DATE_PICKER_DIAGNOSTIC === '1') {
        const dateBox = await visibleDateInputs[0].boundingBox();
        if (!dateBox) throw new Error('月份选择器没有可点击区域');
        await page.mouse.click(dateBox.x + dateBox.width / 2, dateBox.y + dateBox.height / 2);
        await page.waitForTimeout(500);
        const screenshotPath = path.join('reports', `cainiao-month-picker-diagnostic-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const visibleButtons = [];
        const buttons = page.locator('button, [role="button"]');
        for (let index = 0; index < await buttons.count(); index += 1) {
          const button = buttons.nth(index);
          if (!await isInViewport(page, button)) continue;
          const text = String(await button.textContent().catch(() => '')).trim();
          if (text && text.length <= 20) visibleButtons.push(text);
        }
        console.log('月份选择器可见按钮:', JSON.stringify([...new Set(visibleButtons)].slice(0, 80)));
        console.log('月份选择器排查截图:', screenshotPath);
        return null;
      }
      const beforeValues = await Promise.all(visibleDateInputs.slice(0, 2).map((input) => input.inputValue()));
      const requestedStartValue = monthlyQuery ? requestedStartDate.slice(0, 7) : requestedStartDate;
      const requestedEndValue = monthlyQuery ? requestedEndDate.slice(0, 7) : requestedEndDate;
      await visibleDateInputs[0].fill(requestedStartValue);
      await visibleDateInputs[0].press('Enter');
      await visibleDateInputs[1].fill(requestedEndValue);
      await visibleDateInputs[1].press('Enter');
      await page.locator('body').click({ position: { x: 900, y: 500 } });
      await page.waitForTimeout(1500);
      const afterValues = await Promise.all(visibleDateInputs.slice(0, 2).map((input) => input.inputValue()));
      console.log('📅 日期控件提交前后:', beforeValues.join(' 至 '), '=>', afterValues.join(' 至 '));
    } else {
      const visibleInputs = [];
      const allInputs = page.locator('input');
      for (let index = 0; index < await allInputs.count(); index += 1) {
        const candidate = allInputs.nth(index);
        if (!await isInViewport(page, candidate)) continue;
        visibleInputs.push({
          type: await candidate.getAttribute('type'),
          placeholder: await candidate.getAttribute('placeholder'),
          ariaLabel: await candidate.getAttribute('aria-label'),
          className: await candidate.getAttribute('class')
        });
      }
      const screenshotPath = path.join('reports', `cainiao-monthly-date-input-missing-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log('可见输入框结构（不含输入值）:', JSON.stringify(visibleInputs));
      console.log('日期控件排查截图:', screenshotPath);
      throw new Error('已指定菜鸟查询起止日期，但未找到可见日期输入框');
    }
  } else {
    console.log('📅 使用菜鸟页面默认的最新可导出日期');
  }

  // 点击查询
  const queryBtn = await findVisibleLocator(page, [
    'button:has-text("查询")',
    '.ant-btn-primary:has-text("查询")'
  ]);
  if (queryBtn) {
    console.log('🔍 点击查询...');
    await clickCainiaoControl(queryBtn, { label: '查询按钮' });
    await page.waitForTimeout(3000);
  }

  console.log('⏳ 等待表格加载...');
  await page.waitForTimeout(2000);

  if (process.env.CAINIAO_QUERY_PREVIEW_ONLY === '1') {
    const screenshotPath = path.join('reports', `cainiao-monthly-query-preview-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('📸 仅查询预览，不触发导出:', screenshotPath);
    return null;
  }

  // 点击导出并等待下载
  let exportBtn = await findVisibleExportButton(page);
  let downloadPath = null;
  if (exportBtn) {
    console.log('📥 点击导出明细...');
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        clickCainiaoControl(exportBtn, { label: '导出明细按钮' }),
      ]);
      downloadPath = await saveDownload(download, dateStr);
    } catch (e) {
      console.log('ℹ️ 导出任务已提交，等待任务生成“下载”按钮...');
      const downloadBtn = await findVisibleDownloadButton(page, 120000);
      if (downloadBtn) {
        try {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 120000 }),
            clickCainiaoControl(downloadBtn, { label: '下载按钮' }),
          ]);
          downloadPath = await saveDownload(download, dateStr);
        } catch (downloadError) {
          console.log('⚠️ 点击任务下载后仍未收到文件:', downloadError.message);
        }
      } else {
        console.log('⚠️ 导出任务在 120 秒内未生成下载按钮');
      }
      if (!downloadPath) {
        const screenshotPath = path.join('reports', `cainiao-download-timeout-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('📸 已保存排查截图:', screenshotPath);
      }
    }
  } else {
    console.log('⚠️ 未找到导出明细按钮');
    const screenshotPath = path.join('reports', `cainiao-export-missing-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('📸 已保存排查截图:', screenshotPath);
  }

  await page.waitForTimeout(2000);
  return downloadPath;
  } finally {
    await browser.close().catch(() => {});
    await chrome.close().catch(() => {});
  }
}

function refreshCainiaoLogin() {
  console.log('\n🔄 登录态失效，自动续登一次...');
  const loginScript = path.join(coreDir, 'playwright-login.js');
  const result = spawnSync(process.execPath, [loginScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      CAINIAO_LOGIN_RECOVERY: '1',
      CAINIAO_LOGIN_TIMEOUT_MS: process.env.CAINIAO_LOGIN_TIMEOUT_MS || '45000'
    },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('菜鸟自动续登失败，已停止；如页面要求验证码、滑块或短信验证，请人工完成');
  }
  console.log('✅ 登录态已刷新，继续本次库存采集');
}

async function exportWithSingleAuthRecovery() {
  try {
    return await exportFromCainiao();
  } catch (error) {
    if (error.code !== authErrorCode) throw error;
    if (process.env.CAINIAO_AUTO_LOGIN_RECOVERY === '0') throw error;
    refreshCainiaoLogin();
    return exportFromCainiao();
  }
}

export async function main() {
  // 1. 从菜鸟导出
  const file = await exportWithSingleAuthRecovery();
  if (!file || !fs.existsSync(file)) {
    throw new Error('没有下载到新的库存文件，已停止后续本地导入和钉钉通知。');
  }

  // 2. 发布前先验证原始文件。失败时不能修改本地 ERP 或发送钉钉。
  console.log('\n🔐 正在校验库存数据...');
  const strictSourceDate = process.env.CAINIAO_EXPECTED_SOURCE_DATE || "";
  const preliminary = validateCainiaoInventoryFile({ file, expectedSourceDate: strictSourceDate, minRows: 10 });
  const previousFile = preliminary.sourceDate
    ? findLatestPriorCainiaoFile({ dir: downloadDir, currentFile: file, sourceDate: preliminary.sourceDate })
    : '';
  const validation = validateCainiaoInventoryFile({ file, expectedSourceDate: strictSourceDate, previousFile, minRows: 10 });
  recordInventoryValidation(validation);
  if (!validation.ok) {
    throw new Error(`库存数据校验失败，已禁止同步和钉钉发送：${validation.errors.join('；')}`);
  }
  console.log(`✅ 数据校验通过：来源日期 ${validation.sourceDate}，${validation.rowCount} 个 SKU，库存合计 ${validation.totalQuantity}`);
  if (validation.warnings.length) console.log(`   提醒：${validation.warnings.join('；')}`);

  // 3. 导入到本地系统。快照日期使用菜鸟文件日期，不使用任务运行日期。
  console.log('\n📥 正在导入本地系统...');
  const snapshotDate = validation.sourceDate;

  const result = importInventoryFile({
    file,
    warehouseId: 'cainiao',
    snapshotDate,
  });
  console.log('✅ 导入完成:', result);

  // 保留历史库存快照，用于跨日验真和审计；仅停用当前快照已经不存在的 SKU。
  console.log('\n🧹 更新库存主数据...');
  const { getDb } = await import('./erp/db.js');
  const db = getDb();
  console.log('   历史库存快照已保留');

  const inactiveResult = db.prepare("UPDATE skus SET status = 'inactive' WHERE source = 'inventory' AND status = 'active' AND sku NOT IN (SELECT sku FROM inventory_snapshots WHERE warehouse_id = 'cainiao' AND snapshot_date = ?)").run(snapshotDate);
  console.log(`   清理旧 SKU: ${inactiveResult.changes} 个`);

  // 4. 生成库存报告
  console.log('\n📊 生成库存报告...');
  const report = getInventoryReport();
  console.log(`   SKU 总数: ${report.skuCount}`);
  console.log(`   库存总量: ${report.totalQuantity}`);
  console.log(`   预警 SKU: ${report.lowStockItems?.length || 0}`);

  // 5. 发送钉钉
  console.log('\n📤 发送钉钉消息...');
  const markdown = buildInventoryMarkdown('table');
  const dingResult = await sendInventoryDingTalkMarkdown({
    title: markdown.title,
    text: markdown.text,
    shouldNotify: markdown.shouldNotify,
  });
  console.log('✅ 钉钉发送结果:', dingResult);

  console.log('\n🎉 全流程完成');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('\n❌ 错误:', err.message);
    process.exit(1);
  });
}
