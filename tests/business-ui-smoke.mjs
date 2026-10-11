import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { BusinessStore } from '../desktop/shared/business-store.mjs';
import { parseBusinessWorkbook } from '../desktop/shared/business-workbook.mjs';

const workbook = process.env.BUSINESS_TEST_WORKBOOK;
if (!workbook || !fs.existsSync(workbook)) throw new Error('BUSINESS_TEST_WORKBOOK 必须指向本机测试工作簿，不将业务文件放入仓库');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-business-ui-'));
const output = path.resolve('dist', 'business-verification');
fs.mkdirSync(output, { recursive: true });
let application;
async function menuClick(page, id) {
  if (!await page.locator('.business-export-menu').evaluate(e => e.open)) await page.locator('.business-export-menu summary').click();
  await page.locator(`#${id}`).click();
}
async function launch() {
  const executablePath = process.env.BUSINESS_TEST_EXECUTABLE || path.resolve('node_modules/electron/dist/electron.exe');
  application = await electron.launch({ executablePath, args: [...(process.env.BUSINESS_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${directory}`], cwd: process.cwd() });
  const page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForLoadState('domcontentloaded');
  return page;
}
async function stop() {
  const pid = application?.process()?.pid;
  if (pid) try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  await application?.close().catch(() => {});
  application = null;
}
try {
  let page = await launch();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('pageerror', error => console.error('Renderer error: ' + error.message));
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('h1').textContent(), '功能主页');
  await page.screenshot({ path: path.join(output, 'home.png'), fullPage: true });
  await page.locator('[data-open-view="dashboard"]').click();
  assert.equal(await page.locator('[data-view-panel="dashboard"]').isVisible(), true);
  await page.locator('#backHome').click();
  await page.locator('[data-open-view="settings"]').click();
  assert.equal(await page.locator('[data-view-panel="settings"]').isVisible(), true);
  await page.locator('#backHome').click();
  await page.locator('[data-open-view="business"]').click();
  await page.locator('#businessEmpty').waitFor({ state: 'visible' });
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, workbook);
  await menuClick(page, 'businessImport');
  await page.locator('#businessPreview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#businessPreviewBody').textContent(), /53 个图片引用/);
  await page.screenshot({ path: path.join(output, 'preview.png'), fullPage: true });
  await page.locator('#businessCommitImport').click();
  await page.locator('#businessPreview').waitFor({ state: 'hidden' });
  await page.locator('#businessContent').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#businessSummary').textContent.includes('7,913.05'));
  assert.match(await page.locator('#businessSummary').textContent(), /518.55/);
  assert.equal(await page.locator('#businessSummary').isVisible(), true);
  await page.locator('[data-business-page="sales"]').click();
  assert.equal(await page.locator('#businessSummary').isVisible(), false);
  assert.equal(await page.locator('.business-mode-bar').isVisible(), false);
  await page.waitForFunction(()=>document.querySelectorAll('#businessSheetTabs button').length===3);
  assert.equal(await page.locator('#businessSheetTabs button').count(), 3);
  await page.locator('.sheet-grid .tabulator-row').first().waitFor();
  await page.waitForFunction(() => { const img = document.querySelector('.sheet-proof img'); return img?.complete && img.naturalWidth > 0; });
  assert.equal(await page.locator('#businessSheetView').isVisible(), true);
  const firstGrid = page.locator('.sheet-grid').first();
  await firstGrid.locator('.tabulator-col[tabulator-field="F"] .tabulator-col-title').click();
  assert.match(await firstGrid.locator('[data-source-row="5"] [tabulator-field="B"] button').getAttribute('title'), /B5/);
  await page.locator('#businessSheetSearch').fill('37.97');
  await page.waitForFunction(() => document.querySelectorAll('.sheet-grid:first-of-type .tabulator-row').length > 0);
  assert.match(await firstGrid.locator('[data-source-row="5"] [tabulator-field="B"] button').getAttribute('title'), /B5/);
  await page.locator('#businessSheetReset').click();
  await page.screenshot({ path: path.join(output, 'table.png'), fullPage: true });
  const amount = page.locator('.sheet-grid').first().locator('[data-source-row="5"] [tabulator-field="F"]');
  await amount.scrollIntoViewIfNeeded();
  await amount.dblclick();
  await amount.locator('input').fill('47.97');
  await amount.locator('input').press('Enter');
  await page.waitForFunction(() => document.querySelector('#businessDirtyState').textContent.includes('1 个'));
  assert.equal(await page.locator('#businessImport').isDisabled(), true);
  await page.locator('[data-business-page="labor"]').click();
  await page.locator('[data-business-page="sales"]').click();
  assert.match(await amount.textContent(), /47.97/);
  await page.locator('#businessSaveCells').click();
  await page.waitForFunction(() => document.querySelector('#businessDirtyState').textContent === '已保存' && document.querySelector('.sheet-grid [data-source-row="5"] [tabulator-field="F"]')?.textContent === '47.97', undefined, { timeout: 60000 });
  const sheetExport = path.join(directory, 'edited-sheet.xlsx');
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, sheetExport);
  await page.locator('#businessExport').click();
  await page.waitForFunction(() => document.querySelector('#businessStatus').textContent.startsWith('已保存：'), undefined, { timeout: 60000 });
  const editedSheet = parseBusinessWorkbook(sheetExport);
  assert.equal(editedSheet.data.images.length, 53);
  assert.equal(editedSheet.data.sourceCells.find(c => c.sheet === '店铺的销售额具体内容月报' && c.cell === 'F5').value, 47.97);
  await stop(); page = await launch(); page.on('pageerror', error => errors.push(error.message));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, workbook);
  await page.locator('[data-open-view="business"]').click();
  await page.locator('[data-business-page="sales"]').click();
  await page.waitForFunction(() => document.querySelector('.sheet-grid [data-source-row="5"] [tabulator-field="F"]')?.textContent === '47.97');
  // Restore the imported version so all pre-existing financial assertions still apply.
  const versions = await page.evaluate(() => window.inventoryApp.getBusinessVersions());
  await page.evaluate(id => window.inventoryApp.restoreBusinessVersion(id), versions.find(v => !v.active).id);
  await menuClick(page, 'businessRefresh');
  await page.locator('[data-business-page="overview"]').click();
  await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true });
  await page.locator('[data-business-page="purchases"]').click();
  await page.locator('#businessPurchaseEditorSlot .tabulator-row').first().waitFor();
  assert.equal(await page.locator('#businessPurchaseGrid').isVisible(), false);
  await page.locator('#businessMonth').selectOption('2025-03');
  await page.waitForFunction(() => document.querySelectorAll('#businessPurchaseEditorSlot .tabulator-row').length === 2);
  await page.locator('#businessPurchaseStats summary').click();
  await page.locator('#businessPurchaseMonthlyGrid .gridjs-table').waitFor();
  assert.match(await page.locator('#businessPurchaseMonthlyGrid').textContent(), /1,005.00/);
  await page.screenshot({ path: path.join(output, 'purchase-simple.png'), fullPage: true });
  assert.equal(await page.locator('[data-business-page="annual"]').count(), 0);
  assert.equal(await page.locator('#businessSheetTabs button').count(), 3);
  await page.locator('[data-sheet="年度采购金额"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#businessSheetTables .tabulator-row').length > 2);
  assert.equal(await page.locator('#businessMonth').isVisible(), false);
  await page.locator('[data-sheet="结余"]').click();
  await page.waitForFunction(() => document.querySelector('#businessSheetTables')?.textContent.includes('518.55'));
  assert.equal(await page.locator('#businessExport').textContent(), '导出 Excel');
  await page.locator('[data-sheet="2025采购信息"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#businessPurchaseEditorSlot .tabulator-row').length === 2);
  assert.equal(await page.locator('#businessMonth').inputValue(), '2025-03');
  await page.locator('#businessMonth').selectOption('');
  await page.locator('[data-business-page="checks"]').click();
  assert.match(await page.locator('#businessNotices').textContent(), /差额 10.00/);
  await page.screenshot({ path: path.join(output, 'checks.png'), fullPage: true });
  await menuClick(page, 'businessAllImages');
  await page.waitForFunction(() => document.querySelectorAll('.business-image-card').length === 53);
  assert.equal(await page.locator('.business-image-card').count(), 53);
  await page.locator('.business-image-card').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const img = document.querySelector('.business-image-card img'); return img?.complete && img.naturalWidth > 0; });
  await page.locator('.business-image-card button').first().click();
  await page.waitForFunction(() => document.querySelector('#businessFullImage').naturalWidth > 0);
  await page.screenshot({ path: path.join(output, 'image.png') });
  await page.locator('#businessCloseImage').click();
  await page.locator('[data-business-page="overview"]').click();
  await page.locator('#businessShop').selectOption('西施五金淘宝');
  await page.locator('#businessMonth').selectOption('2025-09');
  await page.waitForFunction(() => document.querySelector('#businessSummary').textContent.includes('57.01'));
  await page.locator('#backHome').click();
  await page.locator('[data-open-view="business"]').click();
  assert.equal(await page.locator('#businessMonth').inputValue(), '2025-09');
  assert.equal(await page.locator('#businessShop').inputValue(), '西施五金淘宝');
  await page.locator('#businessShop').selectOption('');
  await page.locator('#businessMonth').selectOption('');
  await page.waitForFunction(() => document.querySelector('#businessSourceInfo').textContent.includes('53 张'));
  const exported = path.join(directory, 'exported.xlsx');
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exported);
  await page.locator('.business-export-menu summary').click();
  await page.locator('#businessExportAll').click();
  await page.waitForFunction(() => document.querySelector('#businessStatus').textContent.startsWith('已保存'), undefined, { timeout: 60000 });
  const roundtrip = parseBusinessWorkbook(exported);
  assert.equal(roundtrip.data.images.length, 53); assert.equal(roundtrip.assets.length, 52);
  await menuClick(page, 'businessImport');
  await page.waitForFunction(() => document.querySelector('#businessStatus').textContent.includes('相同文件已导入'));
  assert.deepEqual(errors, []);
  await stop();
  page = await launch();
  await page.locator('[data-open-view="business"]').click();
  await page.waitForFunction(() => document.querySelector('#businessSummary').textContent.includes('7,913.05'));
  await stop();
  const store = new BusinessStore(path.join(directory, 'workspace', 'data', 'erp.sqlite'), path.join(directory, 'workspace', 'business'));
  try { assert.equal(store.read().images.length, 53); assert.equal(store.read().summary.balance, 518.55); } finally { store.close(); }
  console.log(JSON.stringify({ ok: true, checks: '主页、云仓、设置、原表导入、表格筛选排序凭证不串行、单元格编辑、带图表格导出、编辑重启持久化、恢复、图片原图、筛选保持、带图导出、重复导入', screenshots: output }));
} catch (error) {
  if (application) {
    try { const current = await application.firstWindow(); console.error(await current.evaluate(() => ({ status: document.querySelector('#businessStatus')?.textContent, page: document.querySelector('[data-business-page].active')?.dataset.businessPage, tables: document.querySelectorAll('.sheet-grid').length }))); await current.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); } catch {}
  }
  throw error;
} finally {
  await stop();
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { console.warn('临时验证目录待系统释放句柄：' + directory); }
}
