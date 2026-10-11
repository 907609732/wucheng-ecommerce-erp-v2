/**
 * 千牛取账全链路验证（本地仿真平台 + 真实 Electron 窗口）。
 *
 * 覆盖：登录墙判定、店铺核对（含账号不符时停止，防串店）、账期设置、分类与子类型发现、
 * 同步下载、异步导出中心、分片批次完整性、文件校验与哈希、重复运行不重复入账、空账单与零区分、
 * 第二个店铺互不干扰、真实 IPC 与界面状态显示。
 *
 * 注意：本测试使用的是本地仿真页面，不等于真实千牛页面验收。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { startQianniuFixture } from './fixtures/qianniu-server.mjs';

const MONTH = '2026-09';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-finance-rpa-'));
const output = path.resolve('dist/finance-rpa-verification');
fs.mkdirSync(output, { recursive: true });
const fixture = await startQianniuFixture();
let application = null;
let page = null;
const errors = [];
const checks = [];

async function launch() {
  application = await electron.launch({
    executablePath: process.env.FINANCE_TEST_EXECUTABLE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: [...(process.env.FINANCE_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${directory}`],
    cwd: process.cwd(),
    env: { ...process.env, FINANCE_ALLOW_TEST_ORIGIN: '1', FINANCE_TEST_ORIGIN: fixture.origin, FINANCE_EXPORT_TIMEOUT_MS: '9000', FINANCE_POLL_INTERVAL_MS: '400' }
  });
  const first = await application.firstWindow();
  first.setDefaultTimeout(60000);
  first.on('pageerror', error => errors.push(error.message));
  await first.waitForLoadState('domcontentloaded');
  return first;
}

async function stop() {
  const pid = application?.process()?.pid;
  if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 进程可能已退出 */ } }
  await application?.close().catch(() => {});
  application = null;
}

const report = (shopId, month = MONTH) => page.evaluate(({ shopId, month }) => window.inventoryApp.getFinance(shopId, month), { shopId, month });
const startCollect = (shopId, month, options = {}) => page.evaluate(({ shopId, month, options }) => {
  window.__rpaRun = window.inventoryApp.collectFinance(shopId, month, options)
    .catch(error => ({ state: 'error', message: String((error && error.message) || error) }));
  return true;
}, { shopId, month, options });
const lastRun = () => page.evaluate(() => window.__rpaRun || null);

async function waitFor(predicate, { shopId, month = MONTH, timeoutMs = 900000, label = '取账' }) {
  const deadline = Date.now() + timeoutMs;
  let last = null, nextProgress = 0;
  while (Date.now() < deadline) {
    last = await report(shopId, month);
    const job = (last.jobs || [])[0];
    if (job && predicate(last, job)) return last;
    if (Date.now() >= nextProgress) {
      const progress = await page.evaluate(() => (window.__financeTestProgress || []).slice(-3));
      console.log(JSON.stringify({ testProgress: label, state: job?.state, files: last.pending?.length || 0, progress }));
      nextProgress = Date.now() + 15000;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const runState = await lastRun();
  throw new Error(`等待${label}完成超时：job=${JSON.stringify((last?.jobs || [])[0] || null)} run=${JSON.stringify(runState)}`);
}

const stagedParts = batch => (batch.parts || []).filter(part => part.state === 'staged');

async function commitBatch(batchId) {
  return page.evaluate(async ({ batchId }) => {
    const api = window.inventoryApp;
    const batch = await api.getFinanceBatch(batchId);
    const staged = (batch.parts || []).find(part => part.state === 'staged' || part.state === 'preview');
    if (!staged) throw new Error('批次没有待核对文件');
    const info = await api.inspectFinance(staged.id);
    const sheet = info.sheets[0];
    const preview = await api.previewFinanceBatch(batchId, {
      sheet: sheet.name, kind: batch.kind, month: batch.month, firstRow: 2, lastRow: sheet.lastRow,
      mapping: { date: 'A', gross: 'B', refund: 'C', net: 'D', expense: 'E' }, confirmScope: true
    });
    const committed = await api.commitFinanceBatch(batchId, true);
    return { preview: { records: preview.records, parts: preview.parts.length, net: preview.totals.net }, committed };
  }, { batchId });
}

try {
  page = await launch();
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });

  // 建立四家店铺：甲正常、乙第二家、丙账号不符、丁平台明确无账单。
  const shops = await page.evaluate(async origin => {
    const api = window.inventoryApp;
    // Fixture leaf categories are known to cover its dataset; exclude the overlapping All view.
    const base = { entity: '测试主体', taxId: 'TEST-TAX', entityType: 'enterprise', taxpayer: 'small', cycle: 'monthly', startMonth: '2026-01', excludeSubtypes: [] };
    const a = await api.saveFinanceShop({ ...base, name: '店铺甲', account: 'test-shop-001', billUrl: `${origin}/bill?account=test-shop-001` });
    const b = await api.saveFinanceShop({ ...base, name: '店铺乙', account: 'test-shop-002', billUrl: `${origin}/bill?account=test-shop-002` });
    const c = await api.saveFinanceShop({ ...base, name: '店铺丙', account: 'test-shop-999', billUrl: `${origin}/bill?account=test-shop-001` });
    const d = await api.saveFinanceShop({ ...base, name: '店铺丁', account: 'test-shop-004', billUrl: `${origin}/bill?account=test-shop-004&empty=1` });
    return { a, b, c, d };
  }, fixture.origin);
  await page.evaluate(() => {
    window.__financeTestProgress = [];
    window.inventoryApp.onFinanceChanged(message => {
      window.__financeTestProgress.push(String(message));
      if (window.__financeTestProgress.length > 100) window.__financeTestProgress.shift();
    });
  });
  checks.push('建立四家独立财务店铺');

  // 1) 店铺甲：三个账单类型全部取到文件（收入/支出含多个子类型，涉税走异步导出中心）。
  await startCollect(shops.a.id, MONTH);
  let reportA = await waitFor((_, job) => job.state !== 'running', { shopId: shops.a.id });
  const jobA = reportA.jobs[0];
  assert.equal(jobA.state, 'received', `店铺甲取账应完成，实际 ${jobA.state}：${jobA.message}`);
  assert.equal(reportA.batches.length, 3);
  for (const batch of reportA.batches) assert.equal(batch.state, 'complete', `${batch.kind} 应为 complete，实际 ${batch.state}`);
  const partsA = reportA.batches.flatMap(stagedParts);
  assert.equal(partsA.length, 6, `应收到 6 个文件，实际 ${partsA.length}`);
  assert.deepEqual([...reportA.batches.find(batch => batch.kind === 'income').plan.expected].sort(), ['收入明细', '日汇总', '月汇总']);
  assert.deepEqual([...reportA.batches.find(batch => batch.kind === 'expense').plan.expected].sort(), ['日汇总', '月汇总']);
  for (const part of partsA) { assert.match(part.sha256, /^[a-f0-9]{64}$/); assert.ok(part.bytes > 0); }
  assert.equal(reportA.batches.find(batch => batch.kind === 'tax').parts.length, 1);
  checks.push('店铺甲：收入3个视图 + 支出2个视图（各走同步下载）+ 涉税1个文件（走异步历史下载记录）；带 sha256 与字节数');

  // 2) 整批核对入账：一个批次的所有分片合并成一个可追溯版本，不互相覆盖。
  for (const batch of reportA.batches) {
    const result = await commitBatch(batch.id);
    assert.equal(result.committed.duplicate, undefined);
    assert.equal(result.preview.parts, batch.parts.length);
  }
  reportA = await report(shops.a.id);
  assert.equal(reportA.rows.length, 6, `三类账单各选月汇总的2行入账，实际 ${reportA.rows.length}`);
  assert.equal(reportA.bills.length, 3);
  assert.equal(reportA.history.flatMap(version => version.parts).length, 6, '六份原件必须保留，凭证不重复计入金额');
  assert.equal(reportA.kindTotals.income.net, 26800, '收入只计月汇总，不叠加日汇总与明细视图');
  assert.equal(reportA.kindTotals.tax.net, 25000, '涉税月汇总金额必须与合成原件一致');
  assert.equal(reportA.pending.length, 0);
  checks.push('三类月汇总共6行入账，六份原件保留；其他视图作为凭证，不重复计金额');

  // 3) 重复运行不重复入账。
  await startCollect(shops.a.id, MONTH);
  const reportAgain = await waitFor((state, job) => job.state !== 'running' && job.id !== jobA.id, { shopId: shops.a.id });
  const newBatches=reportAgain.batches.filter(batch=>batch.job===reportAgain.jobs[0].id);
  assert.equal(newBatches.length, 3);
  const duplicateResults = [];
  for (const batch of newBatches) duplicateResults.push(await commitBatch(batch.id));
  assert.ok(duplicateResults.every(result => result.committed.duplicate === true), '重复运行必须判定为重复，不重复入账');
  const reportAfterDuplicate = await report(shops.a.id);
  assert.equal(reportAfterDuplicate.rows.length, 6, '重复运行后行数不应增加');
  assert.equal(reportAfterDuplicate.history.length, 3, '重复运行不应产生新版本');
  checks.push('重复运行：文件哈希一致判定为重复，行数与版本数不变');

  // 4) 店铺丙：页面账号与设置不一致时停止，不下载、不串店。
  await startCollect(shops.c.id, MONTH);
  const reportC = await waitFor((_, job) => job.state !== 'running', { shopId: shops.c.id, label: '店铺丙核对' });
  assert.equal(reportC.jobs[0].state, 'needs_shop_review');
  assert.match(reportC.jobs[0].message, /店铺|串店/);
  assert.equal(reportC.batches.length, 0);
  assert.equal(reportC.pending.length, 0);
  checks.push('店铺丙：账号不符立即停止，未产生任何文件');

  // 5) 店铺丁：平台明确无账单，记录为空而不是记为零。
  await startCollect(shops.d.id, MONTH);
  const reportD = await waitFor((_, job) => job.state !== 'running', { shopId: shops.d.id, label: '店铺丁取账' });
  assert.equal(reportD.batches.length, 3);
  assert.ok(reportD.batches.every(batch => batch.state === 'empty'), `无账单应记为 empty，实际 ${reportD.batches.map(b => b.state).join('/')}`);
  assert.equal(reportD.pending.length, 0);
  assert.equal(reportD.rows.length, 0);
  assert.match(reportD.batches[0].message, /无数据|空/);
  checks.push('店铺丁：平台明确无账单记为 empty，未按零入账');

  // 6) 店铺乙：独立取账，不影响店铺甲。
  await startCollect(shops.b.id, MONTH);
  const reportB = await waitFor((_, job) => job.state !== 'running', { shopId: shops.b.id, label: '店铺乙取账' });
  assert.equal(reportB.jobs[0].state, 'received', reportB.jobs[0].message);
  // 仿真页按真机结构对齐后，每店每账期是 收入3 + 支出2 + 涉税1 = 6 个文件。
  assert.equal(reportB.batches.flatMap(stagedParts).length, 6);
  const reportAIsolated = await report(shops.a.id);
  assert.equal(reportAIsolated.rows.length, 6);
  assert.equal(reportAIsolated.batches.length, 6, '两次取账批次保留，已保存版本仍只有三个');
  checks.push('店铺乙独立取账成功，店铺甲数据未被改写（无串店）');

  // 7) 界面状态显示。
  await page.locator('[data-open-view="finance"]').click();
  await page.locator('#financeMonth').fill(MONTH);
  await page.locator('#financeMonth').dispatchEvent('change');
  await page.waitForFunction(month => document.getElementById('financeStatus').textContent.includes(month), MONTH);
  await page.locator('#financeRun').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#financeRun').isVisible(), true);
  assert.ok((await page.locator('#financeRun').innerText()).includes('取账进度'));
  await page.screenshot({ path: path.join(output, 'finance-rpa-run.png'), fullPage: true });
  await page.locator('[data-finance-tab="history"]').click();
  assert.ok((await page.locator('#financeJobs').innerText()).length > 0);
  await page.screenshot({ path: path.join(output, 'finance-rpa-history.png'), fullPage: true });
  checks.push('Electron 界面显示取账进度、分类型状态与取账记录');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, fixture: fixture.origin, screenshots: output, dataDirectory: directory }, null, 2));
} finally {
  await stop();
  await fixture.close();
}
