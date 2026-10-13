import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-pdd-monthly-ui-'));
let application;
try {
  application=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:['.',`--user-data-dir=${directory}`],cwd:process.cwd()});
  const page=await application.firstWindow();page.setDefaultTimeout(12000);
  await page.waitForURL(url=>url.pathname.endsWith('/index.html'));await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-setup-mode="standalone"]').click();await page.locator('#finishFirstRun').click();await page.locator('#firstRunSetup').waitFor({state:'hidden'});
  const card=page.locator('#featureHome [data-open-view="pdd-monthly"]');
  assert.equal(await card.count(),1,'主页必须有独立的拼多多采购订单导出入口');
  await card.click();await page.locator('#pddMonthlyPanel').waitFor();
  assert.match(await page.locator('h1').innerText(),/拼多多/);
  assert.equal(await page.locator('[data-view-panel="purchase"]').count(),0);
  assert.equal(await page.locator('[data-view-panel="purchase"]').count(),0);
  await page.locator('#pddMonthlyMonth').fill('2026-09');
  assert.equal(await page.locator('#pddMonthlyExport').isDisabled(),true,'采集完成前不能导出旧结果');
  await page.locator('#featureManualButton').click();await page.locator('#featureHelpDialog').waitFor();
  assert.equal(await page.locator('#featureHelpDialog').getAttribute('data-view'),'pdd-monthly');
  assert.match(await page.locator('#featureHelpBody').innerText(),/不.*采购账本/);
  await page.locator('#featureHelpClose').click();
  await page.locator('#backHome').click();assert.equal(await card.isVisible(),true);
  console.log(JSON.stringify({ok:true,checks:'主页独立入口、月份选择、空结果禁止导出、不加载采购页、独立说明书和返回主页',directory}));
} finally {
  if(application){await application.evaluate(({app})=>app.exit(0)).catch(()=>{});await application.close().catch(()=>{});}
}
