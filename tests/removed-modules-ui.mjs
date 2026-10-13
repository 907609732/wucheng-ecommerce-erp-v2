import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-removed-modules-'));
const data = path.join(directory, 'workspace/data');
fs.mkdirSync(data, { recursive: true });
const database = path.join(data, 'erp.sqlite');
const db = new DatabaseSync(database);
db.exec("CREATE TABLE preserved_history(id TEXT PRIMARY KEY, amount INTEGER); INSERT INTO preserved_history VALUES('retained-history',1234)");
db.close();
let application;
try {
  application = await electron.launch({ executablePath: path.resolve(process.env.REMOVAL_TEST_EXE || 'dist/win-unpacked/云仓库存同步（测试版）.exe'), args: [`--user-data-dir=${directory}`] });
  const page = await application.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.locator('#firstRunSetup').waitFor({ state: 'visible' });
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.locator('.feature-number').allTextContents(), ['01', '05', '06']);
  assert.equal(await page.locator('[data-view-panel="business"], [data-view-panel="finance"], [data-view-panel="purchase"]').count(), 0);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.inventoryApp).filter(name => /Finance|Business|Purchase/.test(name))), []);
  fs.mkdirSync('dist/removal-verification', { recursive: true });
  await page.screenshot({ path: path.resolve('dist/removal-verification/home.png'), fullPage: true });
  for (const view of ['dashboard', 'inventory', 'sales', 'invoice', 'pdd-monthly', 'settings']) {
    if (['inventory', 'sales'].includes(view)) {
      await page.locator('[data-open-view="dashboard"]').click();
      await page.locator(`[data-view="${view}"]`).click();
    } else await page.locator(`[data-open-view="${view}"]`).click();
    await page.locator(`[data-view-panel="${view}"]`).waitFor({ state: 'visible' });
    await page.locator('#featureManualButton').click();
    assert.equal(await page.locator('#featureHelpDialog').getAttribute('data-view'), view);
    await page.locator('#featureHelpClose').click();
    await page.locator('#backHome').click();
  }
  assert.deepEqual(errors, []);
  const verify = new DatabaseSync(database, { readOnly: true });
  assert.equal(verify.prepare('SELECT amount FROM preserved_history WHERE id=?').get('retained-history').amount, 1234);
  verify.close();
  console.log(JSON.stringify({ ok: true, checks: '打包客户端仅有01/05/06；被删接口不可用；全部保留页面及说明可打开；历史数据未变', directory }));
} finally {
  if (application) { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await application.close().catch(() => {}); }
}
