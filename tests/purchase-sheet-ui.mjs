import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import XLSX from 'xlsx';
import { purchaseJob } from '../desktop/shared/purchase-jobs.mjs';
const directory = path.resolve('.codex-artifacts', `purchase-sheet-ui-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
const database = path.join(directory, 'workspace/data/erp.sqlite'), originals = path.join(directory, 'workspace/purchase-exports');
async function addSource(order, paid) {
  const file = path.join(directory, `${order}.xlsx`), book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ 订单号: order, 下单时间: '2026-09-03 10:20:00', 商品名称: '本地测试采集订单', 实付款: paid, 数量: 2 }]), '订单');
  fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const preview = await purchaseJob(database, originals, 'preview', [file, { platform: 'taobao', account: '测试账号', month: '2026-09' }]);
  await purchaseJob(database, originals, 'commit', [preview.token]);
}
let application;
try {
  const packaged = process.env.PURCHASE_SHEET_TEST_EXE;
  application = await electron.launch({ executablePath: packaged || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(packaged ? [] : ['.']), `--user-data-dir=${directory}`], cwd: process.cwd(), timeout: 30000 });
  const page = await application.firstWindow(); page.setDefaultTimeout(25000);
  const errors = [], consoleErrors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', event => { if (event.type() === 'error') consoleErrors.push(event.text()); });
  await page.locator('[data-setup-mode="standalone"]').click(); await page.locator('#finishFirstRun').click(); await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  await page.locator('[data-open-view="purchase"]').click();
  assert.equal(await page.locator('#purchaseCollection').isVisible(), true);
  assert.equal(await page.locator('#purchaseDataPage').isVisible(), false);
  await page.locator('#purchaseDataTab').click();
  const frame = page.frameLocator('#purchaseSheetFrame');
  await frame.locator('#status').filter({ hasText: /已载入|已补入/ }).waitFor();
  await frame.locator('canvas').first().waitFor();
  assert.equal(await page.locator('#purchaseSheetFrame').evaluate(el => el.getBoundingClientRect().bottom <= window.innerHeight), true);
  const sheet = page.frames().find(item => item.url().endsWith('purchase-sheet.html'));
  await sheet.waitForFunction(() => [...document.querySelectorAll('canvas')].some(el => el.getBoundingClientRect().height > 200));
  // Regression: an already-open empty grid must display a subsequent import
  // when returning from collection, without the manual reload button.
  assert.equal(await sheet.evaluate(() => Object.keys(window.purchaseSheet.snapshot().sheets['purchase-details'].cellData).length), 1);
  await page.locator('#purchaseCollectTab').click();
  await addSource('TEST-0001', 12);
  await page.evaluate(() => window.dispatchEvent(new Event('purchase:imported')));
  await page.locator('#purchaseDataTab').click();
  await frame.locator('#status').filter({ hasText: '已补入 1 条' }).waitFor();
  await sheet.waitForFunction(() => window.purchaseSheet.snapshot().sheets['purchase-analysis'].cellData[1][1].v === 12);
  await sheet.evaluate(() => {
    const workbook = window.purchaseSheet.api.getActiveWorkbook(), current = workbook.getSheetBySheetId('purchase-details');
    current.getRange('A2').setValue('手工补充'); current.getRange('H2').setValue(2); current.getRange('I2').setValue(12.5);
    current.getRange('M2').setValue('=H2*I2'); current.getRange('F2').setValue('本地测试采购商品'); current.getRange('F2').setFontWeight('bold'); current.getRange('F2').setBackgroundColor('#fff1b8');
  });
  await sheet.waitForFunction(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][12].v === 25);
  await frame.locator('#save').click(); await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await page.evaluate(() => window.purchaseSheetEditor.dirty()), false);
  await frame.locator('#filter').click();
  assert.equal(await sheet.evaluate(() => Boolean(window.purchaseSheet.api.getActiveWorkbook().getActiveSheet().getFilter())), true);
  await frame.locator('#save').click(); await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await page.locator('#purchaseCollectTab').click(); assert.equal(await page.locator('#purchaseSheetFrame').isVisible(), false); assert.equal(await page.locator('#purchaseAuto').isVisible(), true);
  await page.locator('#purchaseDataTab').click();
  const browserWindow = await application.browserWindow(page); await browserWindow.evaluate(win => win.setSize(1500, 1000));
  await page.screenshot({ path: path.join(directory, 'purchase-sheet.png'), fullPage: true });
  const width = await frame.locator('#sheet').evaluate(el => el.clientWidth); assert.ok(width > 1200, `spreadsheet width ${width}`);
  await page.reload(); await page.locator('[data-open-view="purchase"]').click(); await page.locator('#purchaseDataTab').click();
  await frame.locator('#status').filter({ hasText: '已载入' }).waitFor();
  const restored = page.frames().find(item => item.url().endsWith('purchase-sheet.html'));
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][5].v), '本地测试采购商品');
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][12].v), 25);
  assert.equal(await restored.evaluate(() => window.purchaseSheet.api.getActiveWorkbook().getSheetBySheetId('purchase-details').getRange('M2').getValue()), '25.00');
  assert.equal(await restored.evaluate(() => Boolean(window.purchaseSheet.api.getActiveWorkbook().getActiveSheet().getFilter())), true);
  // A physical keyboard edit through the actual cell editor, not only the facade.
  await browserWindow.evaluate(win => { win.show(); win.focus(); });
  await restored.waitForFunction(() => [...document.querySelectorAll('canvas')].some(el => el.getBoundingClientRect().height > 200));
  const point = await restored.evaluate(() => { const rect = window.purchaseSheet.api.getActiveWorkbook().getSheetBySheetId('purchase-details').getRange('F2').getCellRect(); const main = document.getElementById('sheet').getBoundingClientRect(); const canvas = [...document.querySelectorAll('canvas')].find(el => el.getBoundingClientRect().height > 200).getBoundingClientRect(); return { x: rect.x + rect.width / 2 + canvas.x - main.x, y: rect.y + rect.height / 2 + canvas.y - main.y }; });
  await frame.locator('#sheet').dblclick({ position: point });
  await page.keyboard.press('Control+A'); await page.keyboard.type('keyboard-edit-verified'); await page.keyboard.press('Enter');
  await restored.waitForFunction(() => window.purchaseSheet.api.getActiveWorkbook().getSheetBySheetId('purchase-details').getRange('F2').getValue() === 'keyboard-edit-verified');
  await page.waitForFunction(() => window.purchaseSheetEditor.dirty());
  // Simulate choosing "return to save" in the native quit confirmation.
  await application.evaluate(({ app, dialog }) => { dialog.showMessageBoxSync = () => 0; app.quit(); });
  assert.equal(page.isClosed(), false);
  await addSource('TEST-0002', 17.5);
  await page.evaluate(() => window.dispatchEvent(new Event('purchase:imported')));
  await frame.locator('#status').filter({ hasText: '当前编辑已保留' }).waitFor();
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][5].v), 'keyboard-edit-verified');
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[2]?.[4]?.v), undefined);
  await frame.locator('#save').click(); await frame.locator('#status').filter({ hasText: '已补入 1 条' }).waitFor();
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][5].v), 'keyboard-edit-verified');
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[2][4].v), 'TEST-0002');
  assert.equal((await page.evaluate(() => window.inventoryApp.getPurchaseCollection({ month: '2026-09' }))).total, 29.5);
  await frame.locator('#save').click(); await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  // Clean visible grids refresh immediately; repeated notifications do not duplicate rows.
  await addSource('TEST-0003', 5);
  await page.evaluate(() => { window.dispatchEvent(new Event('purchase:imported')); window.dispatchEvent(new Event('purchase:imported')); });
  await restored.waitForFunction(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[3]?.[4]?.v === 'TEST-0003');
  await restored.waitForFunction(() => window.purchaseSheet.snapshot().sheets['purchase-analysis'].cellData[1][1].v === 47.5);
  assert.equal(await restored.evaluate(() => Object.keys(window.purchaseSheet.snapshot().sheets['purchase-details'].cellData).length), 4);
  await frame.locator('#save').click(); await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  // Delay one IPC request to simulate typing during the asynchronous refresh.
  await restored.evaluate(() => {
    const original = parent.postMessage.bind(parent);
    parent.postMessage = (...args) => {
      if (args[0]?.channel !== 'erp-purchase-sheet' || args[0]?.action !== 'load') return original(...args);
      parent.postMessage = original;
      setTimeout(() => {
        window.purchaseSheet.api.getActiveWorkbook().getSheetBySheetId('purchase-details').getRange('F2').setValue('edit-during-refresh');
        setTimeout(() => original(...args), 100);
      }, 100);
    };
  });
  await addSource('TEST-0004', 2.5);
  await page.evaluate(() => window.dispatchEvent(new Event('purchase:imported')));
  await restored.waitForFunction(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][5].v === 'edit-during-refresh' && !document.getElementById('save').disabled);
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[4]?.[4]?.v), undefined);
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][5].v), 'edit-during-refresh');
  await frame.locator('#save').click(); await frame.locator('#status').filter({ hasText: '已补入 1 条' }).waitFor();
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[1][5].v), 'edit-during-refresh');
  assert.equal(await restored.evaluate(() => window.purchaseSheet.snapshot().sheets['purchase-details'].cellData[4][4].v), 'TEST-0004');
  await restored.waitForFunction(() => window.purchaseSheet.snapshot().sheets['purchase-analysis'].cellData[1][1].v === 50);
  await frame.locator('#save').click(); await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await page.locator('#backHome').click(); assert.equal(await page.locator('[data-open-view="purchase"] .feature-number').textContent(), '04');
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors.filter(item => !item.includes('favicon')), []);
  console.log(JSON.stringify({ ok: true, checks: '空表采集后自动显示、可见表自动刷新、重复通知去重、未保存编辑保留及保存后补入、刷新期间编辑保护、中文表格、公式、格式、筛选、键盘编辑、保存重载、原始数据隔离、退出保护、窗口自适应、功能04', directory }));
} catch (error) {
  console.error('TEST FAILURE', error);
  const page = application && await application.firstWindow();
  if (page) { console.error(await page.locator('#purchaseSheetFrame').count() ? await page.frameLocator('#purchaseSheetFrame').locator('body').innerText().catch(() => 'iframe unavailable') : 'no frame'); await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }); }
  const failedFrame = page?.frames().find(item => item.url().endsWith('purchase-sheet.html'));
  if (failedFrame) console.error('test fixture values', await failedFrame.evaluate(() => ({ details: window.purchaseSheet?.snapshot()?.sheets['purchase-details']?.cellData[1], analysis: window.purchaseSheet?.snapshot()?.sheets['purchase-analysis']?.cellData[1] })).catch(() => null));
  throw error;
} finally { if (application) { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await application.close().catch(() => {}); } }
