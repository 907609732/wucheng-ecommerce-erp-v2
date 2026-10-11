import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const directory = path.resolve('.codex-artifacts', `purchase-auto-ui-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
let application;
try {
  application = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${directory}`], cwd: process.cwd(), timeout: 20000 });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-setup-mode="standalone"]').click(); await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  await page.locator('[data-open-view="purchase"]').click();
  await page.locator('#purchasePanel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('h1').textContent(), '采购数据采集');
  assert.equal(await page.locator('#purchaseAuto').isVisible(), true);
  assert.equal(await page.locator('#purchaseLogin').isVisible(), true);
  await page.locator('#purchaseStart').fill('2026-09-01'); await page.locator('#purchaseEnd').fill('2026-10-31');
  assert.equal((await page.evaluate(() => window.inventoryApp.getPurchaseAutoState())).state, 'idle');
  // 真实IPC参数校验，不打开平台、不使用真实账号。
  assert.equal(await page.locator('#purchaseAccount').getAttribute('readonly'), '');
  assert.match(await page.evaluate(async () => { try { await window.inventoryApp.startPurchaseAuto({ platform:'alibaba_1688', startDate:'2026-10-31', endDate:'2026-09-01' }); return 'unexpected'; } catch (error) { return error.message; } }), /起止日期/);
  await page.locator('#purchaseStart').fill('2026-11-01');
  await page.locator('#purchaseAuto').click();
  await page.waitForFunction(() => document.querySelector('#purchaseLogs').textContent.includes('已点击自动采集') && document.querySelector('#purchaseLogs').textContent.includes('起止日期'));
  assert.match(await page.locator('#purchaseLogs').textContent(), /采集未启动/);
  assert.equal(await page.locator('#purchaseCopyLogs').isVisible(), true);
  assert.equal(await page.locator('#purchaseOpenLogs').isVisible(), true);
  await page.reload(); await page.locator('[data-open-view="purchase"]').click();
  await page.waitForFunction(() => document.querySelector('#purchaseLogs').textContent.includes('采集未启动'));
  // 模拟主进程身份通知，只测试本地UI回填，不访问平台。
  const view = await application.browserWindow(page);
  await view.evaluate(win => win.webContents.send('purchase:progress', { state: 'idle', message: '账号已识别', identities: { alibaba_1688: { account: 'tb12345678' } }, logs: [] }));
  await page.waitForFunction(() => document.querySelector('#purchaseAccount').value === 'tb12345678');
  await page.locator('#purchasePlatform').selectOption('taobao'); assert.equal(await page.locator('#purchaseAccount').inputValue(), '');
  await page.locator('#purchasePlatform').selectOption('alibaba_1688'); assert.equal(await page.locator('#purchaseAccount').inputValue(), 'tb12345678');
  await view.evaluate(win => win.webContents.send('purchase:progress', { state: 'idle', message: '等待采集', identities: {}, accountNotices: { alibaba_1688: { state: 'needs_review', message: '已看到订单页，但账号ID识别失败；不代表未登录。' } }, logs: [] }));
  await page.waitForFunction(() => document.querySelector('#purchaseAutoStatus').textContent.includes('不代表未登录'));
  assert.equal(await page.locator('#purchaseAutoStatus').evaluate(el => el.classList.contains('error')), true);
  await page.screenshot({ path: path.join(directory, 'purchase-auto.png'), fullPage: true });
  await page.locator('#backHome').click(); assert.equal(await page.locator('[data-open-view="purchase"] .feature-number').textContent(), '04');
  await page.screenshot({ path: path.join(directory, 'home.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok:true, checks:'功能04独立入口、自动采集与登录按钮、跨月日期、真实IPC状态与参数校验、返回主页', screenshots: directory }));
} finally { await application?.close(); }
