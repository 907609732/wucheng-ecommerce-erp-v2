import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import ExcelJS from 'exceljs';
import { FinanceLedger } from '../desktop/shared/finance-ledger.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-finance-ui-'));
const output=path.resolve('dist/finance-verification');fs.mkdirSync(output,{recursive:true});
const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('财务账单');sheet.addRows([['日期','收入总额','退款','收入净额','支出'],['2026-09',200,20,180,12],['2026-09',100,10,90,7]]);
const source=path.join(directory,'合成账单.xlsx');await workbook.xlsx.writeFile(source);
let application;
const errors=[];
async function launch(){application=await electron.launch({executablePath:process.env.FINANCE_TEST_EXECUTABLE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.FINANCE_TEST_EXECUTABLE?[]:['.']),`--user-data-dir=${directory}`],cwd:process.cwd()});const p=await application.firstWindow();p.setDefaultTimeout(30000);p.on('pageerror',e=>errors.push(e.message));await p.waitForLoadState('domcontentloaded');return p;}
async function stop(){const pid=application?.process()?.pid;if(pid)try{execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}await application?.close().catch(()=>{});application=null;}
try{
  let page=await launch();
  await page.locator('[data-setup-mode="standalone"]').click();await page.locator('#finishFirstRun').click();await page.locator('#firstRunSetup').waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-open-view="business"] strong').textContent(),'运营看板');
  assert.equal(await page.locator('[data-open-view="finance"] strong').textContent(),'店铺销售额采集');
  assert.match(await page.locator('[data-open-view="finance"]').textContent(),/按店铺采集销售额 · 月度账单归集与金额核对/);
  await page.locator('[data-open-view="finance"]').click();await page.locator('#financeEmpty').waitFor({state:'visible'});
  assert.equal(await page.locator('h1').textContent(),'店铺销售额采集');
  assert.equal(await page.locator('.subtitle').textContent(),'店铺销售额采集 · 按店铺取账、归集与核对销售金额');
  await page.locator('#financeHelpButton').click();
  assert.equal(await page.locator('#featureHelpTitle').textContent(),'店铺销售额采集 · 说明书');
  await page.locator('#featureHelpClose').click();
  await page.screenshot({path:path.join(output,'finance-empty.png'),fullPage:true});
  // 本测试聚焦账单与设置；登录优先添加流程由 finance-login-ui.mjs 的本地仿真站单独覆盖。
  await page.evaluate(() => window.inventoryApp.saveFinanceShop({ name:'测试店铺（合成数据）', account:'test-account', startMonth:'2026-09' }));
  await page.locator('#backHome').click();await page.locator('[data-open-view="finance"]').click();await page.locator('#financeContent').waitFor({state:'visible'});
  await page.locator('#financeSettings').click();await page.locator('#finName').fill('测试店铺（合成数据）');await page.locator('#finEntity').fill('测试企业');await page.locator('#finTaxId').fill('TEST-NOT-A-TAX-ID');await page.locator('#finAccount').fill('test-account');await page.locator('#finEntityType').selectOption('enterprise');await page.locator('#finTaxpayer').selectOption('small');await page.locator('#finCycle').selectOption('monthly');await page.locator('#financeShopForm [type="submit"]').click();await page.locator('#financeShopDialog').waitFor({state:'hidden'});
  await page.locator('#financeContent').waitFor({state:'visible'});await page.locator('#financeMonth').fill('2026-09');await page.locator('#financeMonth').dispatchEvent('change');await page.waitForFunction(()=>document.getElementById('financeStatus').textContent.includes('2026-09'));
  await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source);
  await page.locator('#financeImport').click();await page.locator('#financeImportDialog').waitFor({state:'visible'});
  await page.locator('#finImportKind').selectOption('tax');
  for(const [field,col] of [['date','A'],['gross','B'],['refund','C'],['net','D']])await page.locator(`[data-finance-map="${field}"]`).selectOption(col);
  await page.locator('#finScope').check();await page.locator('#financePreview').click();await page.waitForFunction(()=>!document.getElementById('financeCommit').disabled);
  assert.match(await page.locator('#finPreviewResult').textContent(),/270.00/);
  await page.screenshot({path:path.join(output,'finance-import-preview.png'),fullPage:true});
  await page.locator('#financeCommit').click();await page.locator('#financeImportDialog').waitFor({state:'hidden'});await page.locator('#financeGrid .tabulator-row').first().waitFor();
  assert.equal(await page.locator('#financeGrid .tabulator-row').count(),2);
  await page.locator('#financeSearch').fill('18000');assert.equal(await page.locator('#financeGrid .tabulator-row').count(),1);await page.locator('#financeSearch').fill('');
  await page.locator('#financeGrid .tabulator-col[tabulator-field="gross"]').click();
  await page.screenshot({path:path.join(output,'finance-bills.png'),fullPage:true});
  await page.locator('[data-finance-tab="draft"]').click();await page.locator('#finDraft-taxable').fill('270');await page.locator('#finBasis-taxable').fill('合成测试凭证，仅用于界面验收');await page.locator('#financeSaveDraft').click();await page.waitForFunction(()=>document.getElementById('financeStatus').textContent==='填表草稿已保存');
  const exported=path.join(directory,'填表资料.xlsx');await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);await page.locator('#financeDraftExport').click();await page.waitForFunction(()=>document.getElementById('financeStatus').textContent.includes('工作底稿已导出'));
  const exportedBook=new ExcelJS.Workbook();await exportedBook.xlsx.readFile(exported);assert.equal(exportedBook.getWorksheet('填表草稿').getCell('B2').value,270);assert.equal(exportedBook.getWorksheet('平台报送参考').getCell('D2').value,270);
  await page.screenshot({path:path.join(output,'finance-draft.png'),fullPage:true});
  await page.locator('#backHome').click();await page.locator('[data-open-view="business"]').click();await page.locator('#businessEmpty').waitFor({state:'visible'});await page.locator('#backHome').click();await page.locator('[data-open-view="dashboard"]').click();assert.equal(await page.locator('[data-view-panel="dashboard"]').isVisible(),true);
  await stop();page=await launch();await page.locator('[data-open-view="finance"]').click();await page.locator('#financeContent').waitFor({state:'visible'});await page.locator('#financeMonth').fill('2026-09');await page.locator('#financeMonth').dispatchEvent('change');await page.waitForFunction(()=>document.getElementById('financeStatus').textContent.includes('2 条'));
  await page.locator('[data-finance-tab="draft"]').click();assert.equal(await page.locator('#finDraft-taxable').inputValue(),'270');
  // 独立临时账本中的同一原件以两个视图接收，验证新界面只选一种计入金额。
  const testStore=new FinanceLedger(path.join(directory,'workspace','finance'));
  try {
    const shop=testStore.shops()[0];const job=testStore.newJob(shop.id,'2026-09');
    const batch=testStore.openBatch(job,shop.id,'2026-09','income');
    for(const subtype of ['月汇总','日汇总'])testStore.addPart(batch,{file:source,name:'合成账单.xlsx',subtype});
    testStore.closeBatch(batch,{expected:['月汇总','日汇总']});testStore.finishJob(job,'needs_review','合成批次待核对');
  } finally { testStore.close(); }
  await page.locator('#backHome').click();await page.locator('[data-open-view="finance"]').click();
  await page.locator('[data-finance-tab="bills"]').click();
  await page.locator('[data-finance-batch]').click();
  await page.locator('#finLedgerView').selectOption('月汇总');
  for(const [field,col] of [['date','A'],['gross','B'],['refund','C'],['net','D']])await page.locator(`[data-finance-map="${field}"]`).selectOption(col);
  await page.locator('#finScope').check();await page.locator('#financePreview').click();
  await page.waitForFunction(()=>!document.getElementById('financeCommit').disabled);
  assert.match(await page.locator('#finPreviewResult').textContent(),/核对凭证，不计金额/);
  assert.match(await page.locator('#finPreviewResult').textContent(),/入账文件/);
  assert.match(await page.locator('#finPreviewResult').textContent(),/2 条记录/);
  assert.doesNotMatch(await page.locator('#finPreviewResult').textContent(),/NaN|undefined/);
  await page.screenshot({path:path.join(output,'finance-batch-preview.png'),fullPage:true});
  await page.locator('#finLedgerView').selectOption('日汇总');assert.equal(await page.locator('#financeCommit').isDisabled(),true);
  await page.locator('#financePreview').click();await page.waitForFunction(()=>!document.getElementById('financeCommit').disabled);
  await page.locator('#financeCommit').click();await page.locator('#financeImportDialog').waitFor({state:'hidden'});
  const batchReport=await page.evaluate(()=>window.inventoryApp.getFinance(document.getElementById('financeShop').value,'2026-09'));
  assert.equal(batchReport.kindTotals.income.net,27000);
  assert.equal(batchReport.history.find(v=>v.kind==='income').parts.length,2);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['independent empty ledger','per-shop settings','import preview','commit','filter/sort','draft/save/export','source provenance','restart','home/operations/cloud navigation','batch view selection and voucher preview'],screenshots:output}));
}finally{await stop();}
