import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import XLSX from 'xlsx';
import { sanitizeDiagnosticText } from './diagnostics.mjs';

export class PurchaseActionRequired extends Error {
  constructor(message, state = 'needs_review') { super(message); this.state = state; }
}

export function purchaseRange(meta) {
  const month = String(meta?.month || '');
  const start = String(meta?.startDate || (month ? `${month}-01` : ''));
  const end = String(meta?.endDate || (month ? `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}` : ''));
  const valid = value => { const date = new Date(`${value}T00:00:00Z`); return /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
  if (!valid(start) || !valid(end) || start > end) throw new Error('请选择有效的起止日期，结束日期不能早于开始日期');
  return { start, end };
}

export function validatePurchaseMeta(meta) {
  if (!['taobao', 'alibaba_1688', 'goofish', 'pdd'].includes(meta?.platform)) throw new Error('请选择采购平台');
  const account = String(meta.account || '').trim();
  if (account.length > 60) throw new Error('采购账号ID过长，请重新登录后识别');
  const range = purchaseRange(meta);
  return { platform: meta.platform, account, accountLabel: account, month: range.start.slice(0, 7), startDate: range.start, endDate: range.end };
}

const allowedHost = url => {
  try { const u = new URL(url); return u.protocol === 'https:' && ['1688.com', 'taobao.com', 'tmall.com', 'alipay.com', 'goofish.com', 'yangkeduo.com', 'pinduoduo.com'].some(host => u.hostname === host || u.hostname.endsWith(`.${host}`)); } catch { return false; }
};
const visible = async locator => { const result = []; for (const item of await locator.all()) if (await item.isVisible().catch(() => false)) result.push(item); return result; };
async function uniqueButton(page, name) {
  const buttons = await visible(page.getByRole('button', { name, exact: true }));
  const candidates = buttons.length ? buttons : await visible(page.getByText(name, { exact: true }));
  if (candidates.length !== 1) throw new PurchaseActionRequired(`无法唯一确认“${name}”按钮，请在采集窗口检查页面后重试`);
  return candidates[0];
}
async function pageGuard(page, profile) {
  if (page.isClosed()) throw new PurchaseActionRequired('采集窗口已关闭，请重新打开；无法判断登录是否过期', 'needs_review');
  const body = await page.locator('body').innerText({ timeout: 10000 });
  if (/拖动滑块|安全验证|请完成验证|请输入验证码|访问受限|操作频繁|请求过于频繁/.test(body)) throw new PurchaseActionRequired('平台要求安全验证或限制访问，请在采集窗口处理后重新采集；这不等同于未登录', 'needs_verification');
  if ((profile.need_login_url_contains || []).some(part => page.url().includes(part)) || /扫码登录|请先登录|登录已失效|Session 过期|session 过期/.test(body)) throw new PurchaseActionRequired('检测到登录页或登录失效提示，请在采集窗口登录，完成后返回软件点击“自动采集”', 'needs_login');
  if (profile.need_login_selectors?.length && (await visible(page.locator(profile.need_login_selectors.join(',')))).length) throw new PurchaseActionRequired('检测到可见登录表单，请在采集窗口完成登录', 'needs_login');
  return body;
}

// 仅读取可见的顶部登录身份；不读 Cookie、不从订单卖家信息推测买家账号。
export async function inspectPurchaseAccount(page, platform, profile = {}) {
  const body = await pageGuard(page, profile);
  const selectors = platform === 'alibaba_1688'
    ? ['#alibar .fd-name', '#alibar .account-name', '#alibar .user-name', '#alibar .login-id', '#alibar [data-role="login-id"]', '#alibar-v2 .fd-name', '#alibar-v2 .account-name', '#alibar-v2 .user-name', '#alibar-v2 .login-id']
    : ['.site-nav-login-info-nick', '#J_SiteNavLogin .site-nav-user a'];
  const result = await page.evaluate(({ selectors, platform }) => {
    const width = window.innerWidth, height = window.innerHeight;
    const topBand = Math.min(280, Math.max(160, height * 0.25));
    const roots = [document], candidates = new Set(), bars = new Set();
    for (let index = 0; index < roots.length; index++) for (const element of roots[index].querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    const normalize = text => String(text || '').trim().replace(/^(?:您好|你好|欢迎)[，,：:\s]*/, '');
    const valid = text => /^[\p{L}\p{N}_@.\-:]{2,60}$/u.test(text) && !/^(?:登录|注册|请登录|免费注册|我的阿里|我的淘宝|消息|退出|退出登录|安全退出|手机阿里|手机淘宝|买家工作台|卖家工作台)$/.test(text);
    const onTop = element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < topBand && box.right > 0 && box.left < width && style.visibility !== 'hidden' && style.display !== 'none'; };
    const parentOf = element => element.parentElement || element.getRootNode()?.host;
    let knownElements = 0, fallbackElements = 0, logoutVisible = false, loginVisible = false;
    for (const root of roots) {
      for (const element of root.querySelectorAll(selectors.join(','))) {
        if (!onTop(element)) continue; knownElements++;
        const text = normalize(element.innerText); if (valid(text)) candidates.add(text);
      }
      // 兼容 span/strong/button 与开放 Shadow DOM；范围跟随窗口，不再限制 x<900。
      for (const element of root.querySelectorAll('a,span,strong,b,button')) {
        if (!onTop(element)) continue;
        const text = normalize(element.innerText);
        if (/^(?:退出登录|安全退出)$/.test(text)) logoutVisible = true;
        if (/^(?:请登录|立即登录|免费登录)$/.test(text)) loginVisible = true;
        if (platform !== 'alibaba_1688' || !valid(text)) continue;
        for (let parent = parentOf(element), depth = 0; parent && depth < 7 && parent.tagName !== 'BODY' && parent.tagName !== 'HTML'; parent = parentOf(parent), depth++) {
          const barText = parent.innerText || '';
          if (barText.length >= 2000 || !onTop(parent) || parent.getBoundingClientRect().height > topBand || parent.matches('main,article,section') || parent.querySelector('order-item,table') || !barText.includes('手机阿里') || !barText.includes('消息')) continue;
          bars.add(parent);
          const between = normalize(barText.match(/手机阿里\s*([\s\S]*?)\s*消息/)?.[1]);
          if (/^tb\d{4,}$/i.test(text) || valid(between) && between === text) { candidates.add(text); fallbackElements++; }
          break;
        }
      }
    }
    return { accounts: [...candidates], diagnostics: { width, height, topBand: Math.round(topBand), knownElements, fallbackElements, topBars: bars.size, logoutVisible, loginVisible, shadowRoots: roots.length - 1 } };
  }, { selectors, platform });
  const diagnostic = result.diagnostics;
  diagnostic.orderPageVisible = /导出当前条件/.test(body) && /下单时间|订单号|全部订单/.test(body);
  diagnostic.loggedInEvidence = diagnostic.logoutVisible || diagnostic.orderPageVisible;
  if (result.accounts.length > 1) { const error = new PurchaseActionRequired('顶部出现多个不同账号ID，无法确认当前采购账号，已停止采集'); error.diagnostics = { ...diagnostic, candidates: result.accounts.length }; throw error; }
  if (!result.accounts.length && diagnostic.loginVisible && !diagnostic.loggedInEvidence) throw new PurchaseActionRequired('检测到顶部登录入口，且未看到已登录订单页，请先在采集窗口登录', 'needs_login');
  return { account: result.accounts[0] || '', diagnostics: { ...diagnostic, candidates: result.accounts.length } };
}

export async function readPurchaseAccount(page, platform, profile = {}) { return (await inspectPurchaseAccount(page, platform, profile)).account; }

// 从可见 DOM 识别日期控件；支持开放的 Shadow DOM。绝不执行页面提供的脚本或 URL。
async function dateInputs(page) {
  const inputs = await visible(page.locator('input'));
  const entries = [];
  for (const input of inputs) {
    const meta = await input.evaluate(el => ({ value: el.value || '', placeholder: el.getAttribute('placeholder') || '', label: el.getAttribute('aria-label') || '', type: el.type, nearby: (el.parentElement?.parentElement?.innerText || el.parentElement?.parentElement?.textContent || '').slice(0, 300) }));
    entries.push({ input, ...meta });
  }
  return entries;
}

export async function fillPurchaseDates(page, range) {
  let inputs = await dateInputs(page);
  let pair = inputs.filter(e => e.type === 'date' || /开始日期|结束日期|开始时间|结束时间/.test(e.placeholder + e.label));
  if (pair.length !== 2) {
    const ranges = inputs.filter(e => /20\d{2}[-/]\d{2}[-/]\d{2}.*20\d{2}[-/]\d{2}[-/]\d{2}/.test(e.value) || /下单时间|订单时间/.test(e.placeholder + e.label));
    if (ranges.length !== 1) throw new PurchaseActionRequired('无法唯一识别下单时间控件，请打开下单时间下拉框后再点击自动采集');
    await ranges[0].input.click();
    inputs = await dateInputs(page);
    pair = inputs.filter(e => e.type === 'date' || /^20\d{2}-\d{2}-\d{2}$/.test(e.value) || /开始日期|结束日期|开始时间|结束时间/.test(e.placeholder + e.label));
  }
  if (pair.length !== 2) throw new PurchaseActionRequired('日期弹窗中没有唯一的起止日期输入框，请手动展开自定义时间后再试');
  const startHint = pair.find(e => /开始/.test(e.placeholder + e.label));
  if (startHint && pair[0] !== startHint) pair.reverse();
  for (const [index, value] of [range.start, range.end].entries()) {
    await pair[index].input.fill(value, { timeout: 5000 });
    await pair[index].input.press('Tab');
    if ((await pair[index].input.inputValue()).replace(/\//g, '-') !== value) throw new PurchaseActionRequired('日期填写后回读不一致，已停止导出');
  }
  // 下拉框点击外部时提交范围，避免搜索按钮被浮层遮挡。
  await page.getByText('下单时间', { exact: true }).first().click({ timeout: 2000 }).catch(() => {});
  return async () => {
    const entries = await dateInputs(page);
    const fullRange = entries.some(e => e.value.includes(range.start) && e.value.includes(range.end));
    const pairMatches = entries.some(e => e.value === range.start) && entries.some(e => e.value === range.end);
    if (!fullRange && !pairMatches) throw new PurchaseActionRequired('搜索后的日期条件与选择范围不一致，已停止导出');
  };
}

/** 搜索请求必须完成后才点击“导出当前条件”。监听在点击之前建立，接住即时下载。 */
export async function exportCurrentConditions(page, meta, profile, { destination, progress = () => {}, signal, timeout = 180000 } = {}) {
  const range = purchaseRange(meta);
  progress('正在检查登录状态与平台验证提示…');
  await pageGuard(page, profile);
  progress(`正在设置下单时间：${range.start} 至 ${range.end}`);
  const verifyDates = await fillPurchaseDates(page, range);
  if (signal?.aborted) throw new Error('已停止采集');
  const search = await uniqueButton(page, '搜索');
  progress('正在搜索所选时间的采购订单…');
  await search.click({ timeout: 10000 });
  progress('已点击搜索，等待搜索请求完成（最多30秒）…');
  // 包括 SPA 的 XHR 在内，等待搜索请求结束；超时不导出，避免拿到上一次条件。
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { throw new PurchaseActionRequired('搜索请求尚未结束，请等待页面完成后重新采集'); });
  await pageGuard(page, profile);
  await verifyDates();
  if (signal?.aborted) throw new Error('已停止采集');
  const exportButton = await uniqueButton(page, '导出当前条件');
  progress('搜索完成，正在导出当前条件并等待下载…');
  const downloadPromise = page.waitForEvent('download', { timeout });
  // 预先处理拒绝，点击失败时不会留下未处理的 Promise。
  downloadPromise.catch(() => {});
  await exportButton.click({ timeout: 10000 });
  progress(`已点击导出当前条件，等待文件下载（最多${Math.ceil(timeout / 1000)}秒）…`);
  const download = await downloadPromise.catch(() => { throw new PurchaseActionRequired('未收到导出文件；若出现报表生成弹窗，请完成页面提示后重试或导入下载文件'); });
  if (signal?.aborted) { await download.cancel().catch(() => {}); throw new Error('已停止采集'); }
  const failure = await download.failure(); if (failure) throw new Error(`平台下载失败：${failure}`);
  const name = download.suggestedFilename();
  const extension = path.extname(name).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(extension)) throw new PurchaseActionRequired('导出文件格式不是 Excel/CSV，请在平台选择订单明细导出');
  const file = path.join(destination, `${randomUUID()}${extension}`);
  progress('收到下载事件，正在保存导出文件…');
  await download.saveAs(file);
  if (!fs.statSync(file).size) throw new Error('导出文件为空，请重新采集');
  return { file, originalName: name, range };
}

// 通过 mtop 接口直接采集 1688 订单明细，不依赖 DOM 选择器（适配新版 air.1688.com SPA）。
export async function collectViaMtop(page, meta, { destination, progress = () => {}, signal } = {}) {
  const range = purchaseRange(meta);
  progress('正在通过平台接口采集订单明细（新版采集，无需识别账号）…');
  const payload = await page.evaluate(async ({ start, end }) => {
    if (!window.lib || typeof window.lib.mtop !== 'function') throw new Error('页面未加载平台接口，请确认已登录并停留在订单页');
    const fetchPage = pageNo => window.lib.mtop({
      api: 'mtop.1688.trading.dataline.service',
      v: '1.0',
      data: { serviceId: 'OrderListDataLineService.buyerOrderList',
              param: JSON.stringify({ page: pageNo, pageSize: 50, startDateTime: `${start} 00:00:00`, endDateTime: `${end} 23:59:59` }) }
    }).request();
    const first = await fetchPage(1);
    const parsed = JSON.parse(first.data.data.result);
    const pages = Number(parsed.data.pages) || 1;
    const total = Number(parsed.data.total) || 0;
    const requests = [];
    for (let pageNo = 1; pageNo <= pages; pageNo++) requests.push(fetchPage(pageNo));
    const results = await Promise.all(requests);
    const orders = [];
    for (const response of results) {
      const result = JSON.parse(response.data.data.result);
      for (const order of (result.data.data || [])) orders.push(order);
    }
    return { total, orders };
  }, { start: range.start, end: range.end });

  if (signal?.aborted) throw new Error('已停止采集');
  if (!payload.orders.length) throw new PurchaseActionRequired(`该时间范围（${range.start} 至 ${range.end}）没有采购订单，请确认时间范围或登录状态`);

  const specText = spec => Array.isArray(spec?.specItems) ? spec.specItems.map(item => item?.specValue).filter(Boolean).join(' ') : '';
  const yuan = value => { const number = Number(value); return Number.isFinite(number) ? number / 100 : 0; };
  const rows = [];
  let account = '';
  for (const order of payload.orders) {
    if (!account) account = String(order.buyerInfo?.loginId || '');
    const seller = order.sellerInfo || {};
    const entries = order.orderEntries || [];
    for (const entry of entries) {
      rows.push({
        '订单号': String(order.id ?? ''),
        '下单时间': String(order.gmtCreate ?? ''),
        '商品名称': String(entry.productName ?? ''),
        '规格': specText(entry.specInfo),
        '单价': yuan(entry.actualUnitPrice),
        '数量': entry.quantity?.realAmount ?? entry.quantity?.realAmountStr ?? '',
        '商品金额': yuan(entry.amount),
        '运费': yuan(order.carriage),
        '实付款': yuan(order.sumPayment),
        '供应商': String(seller.companyName ?? ''),
        '状态': String(order.statusLabel ?? ''),
      });
    }
  }
  if (signal?.aborted) throw new Error('已停止采集');
  progress(`接口采集完成：${payload.total} 笔订单、${rows.length} 行明细，正在写入待入库文件…`);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '订单明细');
  const file = path.join(destination, `${randomUUID()}.xlsx`);
  // ESM 下 XLSX.writeFile 内部 require('fs') 不可用，改为 buffer + fs.writeFileSync。
  fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return { file, originalName: `1688_${range.start}_${range.end}.xlsx`, range, account };
}

// 淘宝买家订单自动采集：通过 mtop.taobao.order.queryboughtlistv2 分页拉取，客户端按日期过滤。
export async function collectViaTaobao(page, meta, { destination, progress = () => {}, signal } = {}) {
  const range = purchaseRange(meta);
  progress('正在通过平台接口采集订单明细（淘宝新版接口）…');
  const payload = await page.evaluate(async ({ start }) => {
    const mtop = window.lib?.mtop;
    if (!mtop || typeof mtop.H5Request !== 'function') throw new Error('页面未加载平台接口，请确认已登录并停留在订单页');
    const fetchPage = pageNo => new Promise((resolve, reject) => {
      mtop.H5Request({
        api: 'mtop.taobao.order.queryboughtlistv2',
        v: '1.0',
        type: 'post',
        dataType: 'json',
        ecode: 1,
        data: { tabCode: 'all', page: pageNo, OrderType: 'OrderList', appName: 'tborder', appVersion: '3.0', condition: '{"directRouteToTm2Scene":"1"}', __needlessClearProtocol__: true },
        ttid: '1@tbwang_windows_1.0.0#pc',
      }, resp => resolve(resp), err => reject(err?.ret ? err.ret.join(', ') : String(err)));
    });
    const orders = [];
    let minDay = '9999-99-99';
    for (let pageNo = 1; pageNo <= 200; pageNo++) {
      const resp = await fetchPage(pageNo);
      const root = resp?.data?.data || {};
      const orderIds = Object.keys(root).filter(key => key.startsWith('shopOrderContainer_')).map(key => key.slice('shopOrderContainer_'.length));
      if (!orderIds.length) break;
      for (const oid of orderIds) {
        const shopInfo = root[`shopInfo_${oid}`]?.fields || {};
        const pay = root[`orderPayment_${oid}`]?.fields || {};
        const itemKeys = Object.keys(root).filter(key => key.startsWith(`orderItemInfo_${oid}_`));
        const items = itemKeys.map(key => {
          const item = root[key]?.fields?.item || {};
          return { title: String(item.title ?? ''), skuText: String(item.skuText ?? ''), quantity: String(item.quantity ?? ''), unitPrice: item.priceInfo?.actualTotalFee ?? '' };
        });
        const createTime = String(shopInfo.createTime ?? '');
        const day = createTime.slice(0, 10);
        if (day < minDay) minDay = day;
        orders.push({
          orderId: String(shopInfo.orderId || oid),
          createTime,
          shopName: String(shopInfo.shopName ?? ''),
          tradeTitle: String(shopInfo.tradeTitle ?? ''),
          actualFee: pay.actualFee?.value ?? '',
          discountFee: pay.discountFee?.value ?? '',
          postFee: pay.pcPostFee?.value ?? '',
          totalFee: pay.totalFee?.value ?? '',
          items,
        });
      }
      const hasMore = resp?.data?.global?.pageControl?.hasMore;
      if (!hasMore) break;
      if (minDay < start) break; // 订单按时间倒序，已拉到早于起始日的订单，后续更早，停止
    }
    const accountCookie = document.cookie.split(';').map(s => s.trim()).find(c => c.startsWith('_nk_='));
    return { orders, account: accountCookie ? decodeURIComponent(accountCookie.split('=').slice(1).join('=')) : '' };
  }, { start: range.start });

  if (signal?.aborted) throw new Error('已停止采集');
  if (!payload.orders.length) throw new PurchaseActionRequired(`该时间范围（${range.start} 至 ${range.end}）没有采购订单，请确认时间范围或登录状态`);

  const money = value => { const n = Number(String(value ?? '').replace(/[￥¥,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const quantityOf = value => { const n = Number(String(value ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
  const rows = [];
  for (const order of payload.orders) {
    const freight = money(order.postFee), discount = money(order.discountFee), paid = money(order.actualFee);
    for (const item of order.items) {
      const unitPrice = money(item.unitPrice), quantity = quantityOf(item.quantity);
      const itemAmount = Math.round(unitPrice * quantity * 100) / 100;
      rows.push({
        '订单号': order.orderId,
        '下单时间': order.createTime,
        '商品名称': item.title,
        '规格': item.skuText,
        '单价': unitPrice,
        '数量': quantity,
        '商品金额': itemAmount,
        '运费': freight,
        '优惠': discount,
        '实付款': paid,
        '供应商': order.shopName,
        '状态': order.tradeTitle,
      });
    }
  }
  if (signal?.aborted) throw new Error('已停止采集');
  progress(`接口采集完成：${payload.orders.length} 笔订单、${rows.length} 行明细，正在写入待入库文件…`);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '订单明细');
  const file = path.join(destination, `${randomUUID()}.xlsx`);
  fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return { file, originalName: `taobao_${range.start}_${range.end}.xlsx`, range, account: payload.account };
}

// 闲鱼买家订单自动采集：mtop.idle.web.trade.bought.list 分页拉取，pageNumber 与 offsetRow 联动翻历史订单（仅 pageNumber 只能拉到最近约 79 单）。
export async function collectViaGoofish(page, meta, { destination, progress = () => {}, signal } = {}) {
  const range = purchaseRange(meta);
  progress('正在通过平台接口采集订单明细（闲鱼网页版接口）…');
  const payload = await page.evaluate(async ({ start }) => {
    const mtop = window.lib?.mtop;
    if (!mtop || typeof mtop.H5Request !== 'function') throw new Error('页面未加载平台接口，请确认已登录并停留在订单页');
    const fetchPage = async data => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await new Promise((resolve, reject) => {
            mtop.H5Request({ api: 'mtop.idle.web.trade.bought.list', v: '1.0', type: 'post', dataType: 'json', ecode: 1, data }, r => resolve(r.data), e => reject(e?.ret ? e.ret.join(', ') : String(e)));
          });
        } catch (error) {
          lastError = error;
          if (!/SESSION_EXPIRED|Session过期/.test(String(error)) || attempt >= 2) throw error;
          await new Promise(r => setTimeout(r, 3000)); // 闲鱼 session 尚未就绪，等待刷新后重试
        }
      }
      throw lastError;
    };
    const orders = [];
    const seen = new Set();
    let minDay = '9999-99-99';
    for (let pageNumber = 1; pageNumber <= 300; pageNumber++) {
      // 闲鱼 bought.list 分页：pageNumber 与 offsetRow 联动。前 7 页 offsetRow=0，之后 offsetRow=(pageNumber-8)*10+1 才能翻到更早的历史订单。
      const data = pageNumber === 1
        ? { pageNumber: 1, orderStatus: 'ALL' }
        : pageNumber < 8
          ? { pageNumber, orderStatus: 'ALL', offsetRow: '0' }
          : { pageNumber, orderStatus: 'ALL', offsetRow: String((pageNumber - 8) * 10 + 1) };
      const resp = await fetchPage(data);
      const items = resp?.items || [];
      if (!items.length) break;
      let hasNew = false;
      for (const it of items) {
        const orderId = String(it.commonData?.orderIdStr ?? '');
        if (!orderId || seen.has(orderId)) continue;
        seen.add(orderId);
        const createTime = String(it.head?.data?.createTime ?? '');
        if (!createTime) continue; // 退款/异常订单无下单时间，无法归月，跳过
        hasNew = true;
        const day = createTime.slice(0, 10);
        if (day < minDay) minDay = day;
        orders.push({
          orderId,
          createTime,
          title: String(it.content?.data?.detailInfo?.auctionTitle ?? ''),
          sku: String(it.content?.data?.detailInfo?.skuInfo ?? ''),
          buyAmount: String(it.content?.data?.priceInfo?.buyAmount ?? '1'),
          price: String(it.content?.data?.priceInfo?.price ?? ''),
          seller: String(it.head?.data?.userInfo?.userNick ?? ''),
          status: String(it.head?.data?.statusViewMsg ?? ''),
        });
      }
      if (!hasNew) break; // 整页都是已见过的订单，说明已拉完
      if (minDay < start) break; // 订单按时间倒序，已拉到早于起始日
    }
    const tracknick = document.cookie.split(';').map(s => s.trim()).find(c => c.startsWith('tracknick='));
    return { orders, account: tracknick ? decodeURIComponent(tracknick.split('=').slice(1).join('=')) : '' };
  }, { start: range.start });

  if (signal?.aborted) throw new Error('已停止采集');
  if (!payload.orders.length) throw new PurchaseActionRequired(`该时间范围（${range.start} 至 ${range.end}）没有采购订单，请确认时间范围或登录状态`);

  const money = value => { const n = Number(String(value ?? '').replace(/[￥¥,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const quantityOf = value => { const n = Number(String(value ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
  const rows = [];
  for (const order of payload.orders) {
    const paid = money(order.price);
    const quantity = quantityOf(order.buyAmount) || 1;
    const unitPrice = quantity ? Math.round((paid / quantity) * 100) / 100 : paid;
    rows.push({
      '订单号': order.orderId,
      '下单时间': order.createTime,
      '商品名称': order.title,
      '规格': order.sku,
      '单价': unitPrice,
      '数量': quantity,
      '商品金额': paid,
      '运费': 0,
      '优惠': 0,
      '实付款': paid,
      '供应商': order.seller,
      '状态': order.status,
    });
  }
  if (signal?.aborted) throw new Error('已停止采集');
  progress(`接口采集完成：${payload.orders.length} 笔订单、${rows.length} 行明细，正在写入待入库文件…`);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '订单明细');
  const file = path.join(destination, `${randomUUID()}.xlsx`);
  fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return { file, originalName: `goofish_${range.start}_${range.end}.xlsx`, range, account: payload.account };
}

// 拼多多买家订单自动采集：网页版 order_list_v4 接口，offset 游标分页，金额单位为分，anti_content 传空即可。
export async function collectViaPdd(page, meta, { destination, progress = () => {}, signal } = {}) {
  const range = purchaseRange(meta);
  progress('正在通过平台接口采集订单明细（拼多多网页版接口）…');
  const payload = await page.evaluate(async () => {
    const cookie = String(document.cookie || '');
    const uidMatch = cookie.match(/(?:^|;\s*)pdd_user_id=([^;]+)/);
    const nicknameMatch = cookie.match(/(?:^|;\s*)pdd_user_nickname=([^;]+)/);
    const uid = uidMatch ? decodeURIComponent(uidMatch[1]) : '';
    const fetchPage = async offset => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body = { type: 'all', page: 1, page_from: 0, size: 50, origin_host_name: 'mobile.yangkeduo.com', scene: 'order_list_h5', front_env: 1, pay_front_supports: [], anti_content: '' };
          if (offset) body.offset = offset;
          const res = await fetch(`/proxy/api/api/aristotle/order_list_v4?pdduid=${uid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(`接口返回 ${res.status}`);
          return await res.json();
        } catch (error) {
          lastError = error;
          if (attempt >= 2) throw error;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      throw lastError;
    };
    const orders = [];
    const seen = new Set();
    let offset = '';
    for (let i = 0; i < 60; i++) {
      const data = await fetchPage(offset);
      const list = data?.orders || [];
      if (!list.length) break;
      let hasNew = false;
      for (const order of list) {
        const sn = String(order.order_sn || '');
        if (!sn || seen.has(sn)) continue;
        seen.add(sn);
        hasNew = true;
        orders.push(order);
      }
      if (!hasNew) break;
      offset = list[list.length - 1]?.offset || '';
    }
    return { orders, account: uid };
  });

  if (signal?.aborted) throw new Error('已停止采集');
  if (!payload.orders.length) throw new PurchaseActionRequired(`该时间范围（${range.start} 至 ${range.end}）没有采购订单，请确认时间范围或登录状态`);

  const statusLabel = status => ({ 1: '待支付', 2: '待发货', 3: '待收货', 4: '交易成功', 5: '交易取消', 6: '退款成功', 7: '交易关闭' }[status] || '未知');
  const fenToYuan = value => { const n = Number(value); return Number.isFinite(n) ? Math.round(n) / 100 : 0; };
  const formatTime = unix => { const n = Number(unix); return n ? new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' ') : ''; };

  const rows = [];
  for (const order of payload.orders) {
    const time = formatTime(order.order_time);
    const day = time.slice(0, 10);
    if (day < range.start || day > range.end) continue; // 按选定日期范围过滤
    const mall = String(order.mall?.mall_name || '');
    const status = statusLabel(order.status);
    for (const goods of order.order_goods || []) {
      const price = fenToYuan(goods.goods_price);
      const quantity = Number(goods.goods_number) || 1;
      const amount = fenToYuan(Number(goods.goods_price) * quantity);
      rows.push({
        '订单号': String(order.order_sn || ''),
        '下单时间': time,
        '商品名称': String(goods.goods_name || ''),
        '规格': String(goods.spec || ''),
        '单价': Math.round(price * 100) / 100,
        '数量': quantity,
        '商品金额': Math.round(amount * 100) / 100,
        '运费': fenToYuan(order.shipping_amount),
        '优惠': fenToYuan(order.discount_amount),
        '实付款': fenToYuan(order.display_amount),
        '供应商': mall,
        '状态': status,
        '快递单号': String(order.tracking_number || ''),
      });
    }
  }
  if (!rows.length) throw new PurchaseActionRequired(`该时间范围（${range.start} 至 ${range.end}）没有采购订单，请确认时间范围或登录状态`);

  progress(`接口采集完成：${payload.orders.length} 笔订单、${rows.length} 行明细，正在写入待入库文件…`);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '订单明细');
  const file = path.join(destination, `${randomUUID()}.xlsx`);
  fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return { file, originalName: `pdd_${range.start}_${range.end}.xlsx`, range, account: payload.account };
}

export class PurchaseAutomation {
  constructor({ directory, profiles, preview, notify = () => {}, log = () => {}, launch, testOrigin = '', commitPreview, cancelPreview }) {
    this.directory = directory; this.profiles = profiles; this.preview = preview; this.notify = notify; this.launch = launch;
    this.commitPreview = commitPreview; this.cancelPreview = cancelPreview;
    this.testOrigin = testOrigin; this.contexts = new Map(); this.identities = {}; this.accountNotices = {}; this.watchers = new Map(); this.job = null;
    fs.mkdirSync(directory, { recursive: true });
    this.logDirectory = path.join(directory, 'logs'); fs.mkdirSync(this.logDirectory, { recursive: true });
    this.logs = []; this.onLog = log;
    const latest = fs.readdirSync(this.logDirectory).filter(name => /^purchase-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().at(-1);
    if (latest) {
      const file = path.join(this.logDirectory, latest), size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try { const buffer = Buffer.alloc(Math.min(size, 256 * 1024)); fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length); this.logs = buffer.toString('utf8').split('\n').flatMap(line => { try { const entry = JSON.parse(line); return typeof entry.message === 'string' && typeof entry.time === 'string' ? [entry] : []; } catch { return []; } }).slice(-300); } finally { fs.closeSync(fd); }
    }
  }
  safeMessage(message) { return sanitizeDiagnosticText(message, [this.job?.meta?.account, ...Object.values(this.identities).map(identity => identity.account)]).replace(/https?:\/\/[^\s"'<>]+/gi, '[平台地址已隐藏]').slice(0, 1800); }
  state() { return { ...(this.job ? { ...this.job, controller: undefined } : { state: 'idle', message: '先打开采集窗口登录，账号ID会自动识别；选择时间后点击自动采集。' }), identities: this.identities, accountNotices: this.accountNotices, logs: this.logs }; }
  setIdentity(platform, account) {
    if ((this.identities[platform]?.account || '') === account) return;
    if (account) this.identities[platform] = { platform, account, accountLabel: account };
    else delete this.identities[platform];
    this.log(account ? '已自动识别顶部登录账号ID，已回填到软件（日志隐藏ID）。' : '当前账号ID暂无法确认，已清空显示；具体原因见账号识别提示。');
  }
  identityDiagnostics(diagnostic) {
    if (!diagnostic) return;
    this.log(`账号识别诊断：网页${diagnostic.width}×${diagnostic.height}；顶部范围${diagnostic.topBand}px；已知控件${diagnostic.knownElements}；顶栏${diagnostic.topBars}；候选${diagnostic.candidates}；开放Shadow根${diagnostic.shadowRoots}；订单页${diagnostic.orderPageVisible ? '可见' : '未确认'}；退出入口${diagnostic.logoutVisible ? '可见' : '未确认'}。`);
  }
  accountNotice(platform, state, message, diagnostic) {
    message = this.safeMessage(message);
    const previous = this.accountNotices[platform];
    this.accountNotices[platform] = { state, message, diagnostic };
    if (previous?.state !== state || previous?.message !== message) {
      this.identityDiagnostics(diagnostic);
      this.log(message, state === 'ready' ? 'info' : 'warning');
    }
  }
  async identify(page, meta, profile, { quiet = false } = {}) {
    try {
      const { account, diagnostics } = await inspectPurchaseAccount(page, meta.platform, profile);
      if (!quiet) this.identityDiagnostics(diagnostics);
      if (!account) {
        const message = diagnostics.loggedInEvidence
          ? '已看到登录后的订单页或退出入口，但顶部账号ID识别失败；这不代表未登录，无需反复扫码。请保留当前页面排查，未开始导出。'
          : '顶部账号ID识别失败，且登录状态尚不明确；未检测到明确的未登录提示，不要求重复登录。请确认已进入订单页，未开始导出。';
        const error = new PurchaseActionRequired(message, 'needs_review'); error.diagnostics = diagnostics; throw error;
      }
      this.setIdentity(meta.platform, account);
      this.accountNotice(meta.platform, 'ready', '登录账号ID已识别，选择时间后可以自动采集。', diagnostics);
      return { ...meta, account, accountLabel: account };
    } catch (error) {
      this.setIdentity(meta.platform, '');
      this.accountNotice(meta.platform, error.state || 'needs_review', error.message, error.diagnostics);
      throw error;
    }
  }
  async identifyCurrent(input) {
    const meta = validatePurchaseMeta(input), key = createHash('sha256').update(`${meta.platform}\0automatic-account-session`).digest('hex');
    const context = this.contexts.get(key), page = context?.pages().find(page => !page.isClosed());
    if (!page) throw new PurchaseActionRequired('请先打开采集窗口登录，自动识别账号ID后再导入文件', 'needs_login');
    return this.identify(page, meta, this.profiles[meta.platform]);
  }
  watchAccount(context, platform, profile) {
    let busy = false;
    const check = async () => {
      if (busy || this.job?.state === 'running') return; busy = true;
      try {
        const pages = context.pages().filter(page => !page.isClosed() && (allowedHost(page.url()) || this.testOrigin && page.url().startsWith(this.testOrigin + '/')));
        const page = pages.at(-1);
        if (!page) return;
        await this.identify(page, { platform }, profile, { quiet: true });
      } catch { /* identify 已更新提示，不把识别失败误报成未登录。 */ } finally { busy = false; }
    };
    const timer = setInterval(check, 3000); timer.unref?.(); this.watchers.set(platform, timer);
    context.on('close', () => { clearInterval(timer); this.watchers.delete(platform); this.setIdentity(platform, ''); this.accountNotice(platform, 'needs_review', '采集窗口已关闭，请重新打开；没有据此判断登录已失效。'); });
    void check();
  }
  log(message, level = 'info') {
    const entry = { time: new Date().toISOString(), level, jobId: this.job?.id || '', message: this.safeMessage(message) };
    this.stage = entry.message; this.logs = [...this.logs, entry].slice(-300);
    try { fs.appendFileSync(path.join(this.logDirectory, `purchase-${entry.time.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n'); }
    catch { this.logs.push({ time: entry.time, level: 'error', message: '日志文件写入失败，请检查磁盘空间和目录权限。' }); }
    this.onLog(entry); this.notify(this.state());
  }
  update(state, message, extra = {}) { this.job = { ...this.job, ...extra, state, message: this.safeMessage(message), updatedAt: new Date().toISOString() }; this.log(this.job.message, ['failed','needs_review','needs_login','needs_verification'].includes(state) ? 'error' : 'info'); }
  async open(input) {
    const meta = validatePurchaseMeta(input), key = createHash('sha256').update(`${meta.platform}\0automatic-account-session`).digest('hex');
    let context = this.contexts.get(key);
    if (!context) {
      this.log('正在启动本机 Chrome 独立采集窗口（最多30秒）…');
      const options = { headless: false, channel: 'chrome', timeout: 30000, acceptDownloads: true, viewport: null, args: ['--start-maximized'] };
      const profileDir = path.join(this.directory, 'profiles', 'chrome', key);
      if (this.launch) context = await this.launch(profileDir, options);
      else {
        try { context = await chromium.launchPersistentContext(profileDir, options); }
        catch (error) { this.log(`Chrome 启动失败：${error.message}`, 'error'); throw new Error('未能打开 Chrome 采集窗口，请检查本机 Chrome 是否已安装，或关闭该账号重复打开的采集窗口后重试'); }
      }
      this.contexts.set(key, context);
      context.on('close', () => this.contexts.delete(key));
      await context.route('**/*', route => { const request = route.request(); if (request.isNavigationRequest() && !allowedHost(request.url()) && !(this.testOrigin && request.url().startsWith(this.testOrigin + '/'))) return route.abort(); return route.continue(); });
      this.log('采集浏览器已启动。');
      this.log('已请求启动最大化；网页已取消固定视口，随 Chrome 窗口尺寸调整。');
      if (meta.platform !== 'alibaba_1688' && meta.platform !== 'goofish' && meta.platform !== 'pdd') this.watchAccount(context, meta.platform, this.profiles[meta.platform]);
    } else this.log('正在复用该平台的采集窗口，稍后重新核对登录账号。');
    const page = context.pages().find(p => !p.isClosed()) || await context.newPage();
    const profile = this.profiles[meta.platform];
    const target = this.testOrigin || profile.order_url;
    const inLogin = (profile.need_login_url_contains || []).some(part => page.url().includes(part));
    if (!inLogin && !page.url().startsWith(target.split('?')[0])) { this.log('正在打开平台采购订单页（最多45秒）…'); await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    await page.bringToFront();
    this.log('采集窗口已就绪，接下来检查页面和日期控件。');
    await page.evaluate(() => window.scrollTo(0, 0));
    if (this.job?.state !== 'running' && meta.platform !== 'alibaba_1688' && meta.platform !== 'goofish' && meta.platform !== 'pdd') { try { await this.identify(page, meta, profile); } catch { /* 已输出明确分类的登录/账号识别提示。 */ } }
    return { page, profile, meta, context };
  }
  start(input) {
    const meta = validatePurchaseMeta(input);
    if (this.job?.state === 'running') throw new Error('已有采购任务在运行，请等待完成或停止后重试');
    if (this.job?.state === 'preview') throw new Error('请先确认或取消上一份采购预览');
    const id = randomUUID(), controller = new AbortController();
    this.activeContext = null;
    this.job = { id, meta, controller, state: 'running', message: '正在打开采购采集窗口…', createdAt: new Date().toISOString() };
    this.log(`开始采购采集：${meta.platform === 'alibaba_1688' ? '1688' : '淘宝'}，${meta.startDate} 至 ${meta.endDate}。`);
    const started = Date.now();
    const heartbeat = setInterval(() => { if (this.job?.id === id && this.job.state === 'running') { const stage = this.stage; this.log(`仍在等待（累计${Math.floor((Date.now() - started) / 1000)}秒）：${stage}`); this.stage = stage; } }, 10000);
    const task = this.run(meta, controller.signal).catch(error => { if (this.job?.id === id) this.update(controller.signal.aborted ? 'canceled' : error.state || 'failed', controller.signal.aborted ? '采集已停止，台账未变更。' : error.message); }).finally(() => clearInterval(heartbeat));
    this.task = task; return this.state();
  }
  async run(meta, signal) {
    const { page, profile, context } = await this.open(meta);
    this.activeContext = context;
    if (signal.aborted) { await context.close().catch(() => {}); throw new Error('已停止采集'); }
    const incoming = path.join(this.directory, 'incoming'); fs.mkdirSync(incoming, { recursive: true });
    let capture;
    if (meta.platform === 'alibaba_1688') {
      this.update('running', '正在通过平台接口采集订单明细…');
      capture = await collectViaMtop(page, meta, { destination: incoming, signal, progress: message => this.update('running', message) });
    } else if (meta.platform === 'goofish') {
      this.update('running', '正在通过平台接口采集订单明细（闲鱼）…');
      capture = await collectViaGoofish(page, meta, { destination: incoming, signal, progress: message => this.update('running', message) });
    } else if (meta.platform === 'pdd') {
      this.update('running', '正在通过平台接口采集订单明细（拼多多）…');
      capture = await collectViaPdd(page, meta, { destination: incoming, signal, progress: message => this.update('running', message) });
    } else {
      this.update('running', '正在通过平台接口采集订单明细（淘宝）…');
      capture = await collectViaTaobao(page, meta, { destination: incoming, signal, progress: message => this.update('running', message) });
    }
    meta = { ...meta, account: capture.account, accountLabel: capture.account }; this.job.meta = meta;
    if (signal.aborted) throw new Error('已停止采集');
    this.update('running', '已收到数据，正在校验表头、时间范围和重复数据…');
    const preview = await this.preview(capture.file, { ...meta, originalName: capture.originalName });
    if (signal.aborted) { if (preview.token && this.cancelPreview) await this.cancelPreview(preview.token); throw new Error('已停止采集'); }
    if (preview.duplicate) { this.update('completed', preview.message, { autoCommitted: true }); return; }
    this.update('running', `已收到 ${preview.rows} 条明细，正在自动入库…`);
    const committed = await this.commitPreview(preview.token);
    this.update('completed', `自动采集完成并已入库：新增 ${committed.inserted} 条${committed.skipped ? `，跳过重复 ${committed.skipped} 条` : ''}。可切换到「数据查看 / 表格」查看，或在操作日志中撤回。`, { autoCommitted: true, committed });
  }
  backfill(input) {
    const platform = ['taobao', 'goofish', 'pdd', 'alibaba_1688'].includes(input?.platform) ? input.platform : 'alibaba_1688';
    const year = String(input?.year || '');
    if (!/^20\d{2}$/.test(year)) throw new Error('请选择年份');
    const months = Array.isArray(input?.months) ? input.months.map(String) : [];
    if (!months.length) throw new Error(`${year} 年没有需要补齐的月份`);
    if (this.job?.state === 'running') throw new Error('已有采购任务在运行，请等待完成或停止后重试');
    if (this.job?.state === 'preview') throw new Error('请先确认或取消上一份采购预览');
    const id = randomUUID(), controller = new AbortController();
    this.activeContext = null;
    this.job = { id, meta: { platform }, controller, state: 'running', message: `正在补齐 ${year} 年缺失月份…`, createdAt: new Date().toISOString() };
    this.log(`开始批量补齐：${platform === 'alibaba_1688' ? '1688' : platform === 'goofish' ? '闲鱼' : platform === 'pdd' ? '拼多多' : '淘宝'}，${year} 年 ${months.join('、')}。`);
    const started = Date.now();
    const heartbeat = setInterval(() => { if (this.job?.id === id && this.job.state === 'running') this.log(`仍在等待（累计${Math.floor((Date.now() - started) / 1000)}秒）：${this.stage || ''}`); }, 10000);
    const task = this.runBackfill(platform, year, months, controller.signal).then(results => {
      if (this.job?.id === id) this.update('completed', `批量补齐完成：${results.map(r => r.empty ? `${r.month} 无订单` : `${r.month} ${r.rows}条${r.duplicate ? '（已存在）' : ''}`).join('，')}`, { backfill: results });
    }).catch(error => {
      if (this.job?.id === id) this.update(controller.signal.aborted ? 'canceled' : error.state || 'failed', controller.signal.aborted ? '补齐已停止。' : error.message);
    }).finally(() => clearInterval(heartbeat));
    this.task = task; return this.state();
  }
  async runBackfill(platform, year, months, signal) {
    const { page, context } = await this.open({ platform, month: months[0] });
    this.activeContext = context;
    if (signal.aborted) { await context.close().catch(() => {}); throw new Error('已停止采集'); }
    const incoming = path.join(this.directory, 'incoming'); fs.mkdirSync(incoming, { recursive: true });
    const results = [];
    for (const month of months) {
      if (signal.aborted) throw new Error('已停止采集');
      const start = `${month}-01`, end = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`;
      this.update('running', `正在采集 ${month}（${start} 至 ${end}）…`);
      const meta = { platform, month, startDate: start, endDate: end };
      const collect = platform === 'pdd' ? collectViaPdd : platform === 'goofish' ? collectViaGoofish : platform === 'taobao' ? collectViaTaobao : collectViaMtop;
      let capture;
      try {
        capture = await collect(page, meta, { destination: incoming, signal, progress: message => this.update('running', `${month}：${message}`) });
      } catch (error) {
        if (error instanceof PurchaseActionRequired && /没有采购订单/.test(error.message || '')) { results.push({ month, rows: 0, empty: true }); continue; }
        throw error;
      }
      if (signal.aborted) throw new Error('已停止采集');
      this.update('running', `${month}：已收到数据，正在校验并入库…`);
      const preview = await this.preview(capture.file, { ...meta, account: capture.account, accountLabel: capture.account, originalName: capture.originalName });
      if (preview.duplicate) { results.push({ month, rows: 0, duplicate: true }); continue; }
      const committed = await this.commitPreview(preview.token);
      results.push({ month, rows: preview.rows, inserted: committed.inserted, skipped: committed.skipped });
    }
    return results;
  }
  finish(token) { if (this.job?.preview?.token === token) this.update('completed', '采购预览已处理。', { preview: null }); }
  async stop() { if (this.job?.state !== 'running') return this.state(); this.log('收到停止请求，正在关闭采集窗口…', 'warning'); this.job.controller.abort(); await this.activeContext?.close().catch(() => {}); await this.task; return this.state(); }
  closeAll() { this.job?.controller?.abort(); for (const timer of this.watchers.values()) clearInterval(timer); return Promise.allSettled([...this.contexts.values()].map(context => context.close())); }
}
