import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-invoice-platform-ui-'));
let application;
try {
  application = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${directory}`], cwd: process.cwd() });
  const page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  await page.locator('[data-open-view="invoice"]').click();
  assert.equal(await page.locator('input[name="invoiceShopPlatform"]').count(), 2, '两个平台必须直接可见，不能藏在下拉框');
  assert.equal(await page.locator('.invoice-platform-option .invoice-platform-icon').count(), 2);
  assert.equal(await page.locator('input[name="invoiceShopPlatform"]:checked').inputValue(), 'taobao');
  await page.locator('#invoiceShopName').fill('同名店铺');
  await page.locator('#invoiceAddShop').click();
  await page.locator('.invoice-shop-row').filter({ hasText: '同名店铺' }).waitFor();
  await page.locator('input[name="invoiceShopPlatform"][value="pdd"]').check();
  await page.locator('#invoiceShopName').fill('同名店铺');
  await page.locator('#invoiceAddShop').click();
  assert.equal(await page.locator('.invoice-shop-row').count(), 2);
  const labels = await page.locator('.invoice-shop-row .invoice-platform-badge > span:last-child').allTextContents();
  assert.deepEqual(labels.map(s => s.trim()).sort(), ['拼多多', '淘宝']);
  for (const row of await page.locator('.invoice-shop-row').all()) {
    assert.equal(await row.locator('.invoice-platform-icon').count(), 1);
    assert.equal(await row.locator('button[data-invoice-shop-action]').count(), 5);
  }
  const pddRow = page.locator('.invoice-shop-row').filter({ has: page.locator('.invoice-platform-icon[data-platform="pdd"]') });
  const originalId = await pddRow.locator('[data-invoice-shop-action="rename"]').getAttribute('data-shop-id');
  await pddRow.locator('[data-invoice-shop-action="rename"]').click();
  await pddRow.locator('.invoice-shop-rename-input').fill('修正店铺名');
  await pddRow.locator('[data-invoice-shop-action="rename"]').click();
  const renamedRow = page.locator('.invoice-shop-row').filter({ hasText: '修正店铺名' });
  assert.equal(await renamedRow.locator('[data-invoice-shop-action="rename"]').getAttribute('data-shop-id'), originalId);
  assert.match(await page.locator('#invoiceShopStatus').textContent(), /登录会话保留/);
  await renamedRow.locator('[data-invoice-shop-action="scan"]').click();
  await page.locator('#invoiceInspectStatus').getByText(/修正店铺名.*尚未确认/).waitFor();
  const history = await page.evaluate(() => window.inventoryApp.getInvoiceInspectionHistory(10));
  assert.equal(history.length, 1, '单店巡检只登记所选店铺，不触碰其他店');
  assert.equal(history[0].shop, '拼多多·修正店铺名');
  assert.equal(history[0].state, 'needs_login');
  assert.equal(history[0].pending_count, null, '未确认的店铺不能报零');
  assert.doesNotMatch(await page.locator('#invoiceInspectStatus').textContent(), /已发送/);
  await assert.rejects(page.evaluate(() => window.inventoryApp.scanInvoiceShop('invalid-shop-id')), /开票店铺不存在/);
  assert.equal((await page.evaluate(() => window.inventoryApp.getInvoiceInspectionHistory(10))).length, 1, '无效店铺不得触发全店扫描');
  const selected = await page.locator('input[name="invoiceShopPlatform"][value="pdd"]').evaluate(el => getComputedStyle(el.closest('label')).borderColor);
  const other = await page.locator('input[name="invoiceShopPlatform"][value="taobao"]').evaluate(el => getComputedStyle(el.closest('label')).borderColor);
  assert.notEqual(selected, other, '选中平台应有明显边框');
  await page.setViewportSize({ width: 760, height: 850 });
  assert.equal(await page.locator('.invoice-platform-option').count(), 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '窄屏不应水平溢出');
  fs.mkdirSync(path.resolve('dist'), { recursive: true });
  await page.screenshot({ path: path.resolve('dist/invoice-platform-verification.png'), fullPage: true });
  console.log(JSON.stringify({ ok: true, options: 2, rows: labels, screenshot: path.resolve('dist/invoice-platform-verification.png') }));
} finally {
  if (application) await application.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
