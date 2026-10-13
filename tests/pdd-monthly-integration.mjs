import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { _electron as electron } from 'playwright';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-pdd-monthly-integrated-'));
const workspace=path.join(directory,'workspace'),database=path.join(workspace,'data','erp.sqlite');
fs.mkdirSync(path.dirname(database),{recursive:true});
fs.mkdirSync(path.join(workspace,'invoice-inspection'),{recursive:true});
fs.writeFileSync(path.join(workspace,'invoice-inspection','schedule.json'),JSON.stringify({enabled:false,hour:20,minute:0}));
const seed=new DatabaseSync(database);seed.exec("CREATE TABLE preserved_history(id TEXT PRIMARY KEY, amount INTEGER); INSERT INTO preserved_history VALUES('SENTINEL-DO-NOT-ALTER',1234)");seed.close();
function protectedLedger(){const db=new DatabaseSync(database,{readOnly:true});try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);return Object.fromEntries(tables.map(table=>[table,createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).digest('hex')]));}finally{db.close();}}
const before=protectedLedger();
const epoch=text=>Math.floor(Date.parse(text)/1000);
const goods=(name,spec,price,quantity)=>({goods_name:name,spec,goods_price:price,goods_number:quantity});
const captured=[
 {order_sn:'00000000000000000001-ABC',order_time:epoch('2026-08-31T16:10:00Z'),status:4,display_amount:3100,shipping_amount:0,discount_amount:0,mall:{mall_name:'隔离供应商甲'},tracking_number:'0001234567890123456789',offset:'a',order_goods:[goods('隔离螺栓','M6',500,2),goods('隔离螺母','M8',700,3)]},
 {order_sn:'OUTSIDE-OCTOBER',order_time:epoch('2026-09-30T16:01:00Z'),status:4,display_amount:99999,offset:'b',order_goods:[goods('隔离十月订单','不得混入九月',99999,1)]},
 {order_sn:'260930-0000000000000001',order_time:epoch('2026-09-30T15:59:00Z'),status:7,display_amount:10000,shipping_amount:100,discount_amount:350,mall:{mall_name:'隔离供应商乙'},offset:'c',order_goods:[goods('隔离垫圈','M10',205,50)]}
];
let mode='normal',application;const requests=[],held=[];let announceDelay;
const server=http.createServer(async(req,res)=>{
 if(req.method==='POST'&&req.url.startsWith('/proxy/api/api/aristotle/order_list_v4')){
  let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);requests.push(request);
  if(mode==='delayed'){held.push(res);announceDelay?.();return;}
  res.writeHead(200,{'Content-Type':'application/json'});
  if(mode==='error')res.end(JSON.stringify({success:false,error_code:40001,error_msg:'隔离接口失败，不得记为零'}));
  else res.end(JSON.stringify({orders:mode==='empty'?[]:request.offset?[captured[2]]:captured.slice(0,2),has_more:mode==='empty'?false:!request.offset}));
  return;
 }
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':'pdd_user_id=123456789; Path=/; SameSite=Lax'});
 res.end('<!doctype html><html><body>隔离拼多多买家接口夹具 · 全部订单 · 页面已加载</body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try{
 application=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:['.',`--user-data-dir=${directory}`],cwd:process.cwd(),env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,NODE_ENV:'test',PDD_MONTHLY_TEST_ORIGIN:origin}});
 const page=await application.firstWindow();page.setDefaultTimeout(45000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForURL(url=>url.pathname.endsWith('/index.html'));await page.waitForLoadState('domcontentloaded');
 await page.locator('[data-setup-mode="standalone"]').click();await page.locator('#finishFirstRun').click();await page.locator('#firstRunSetup').waitFor({state:'hidden'});
 const window=await application.browserWindow(page);await window.evaluate(win=>win.setSize(1500,1000));
 await page.locator('#featureHome [data-open-view="pdd-monthly"]').scrollIntoViewIfNeeded();
 const homeScreenshot=path.join(directory,'主页-独立拼多多入口.png');await page.locator('#featureHome').screenshot({path:homeScreenshot});
 await page.locator('[data-open-view="pdd-monthly"]').click();await page.locator('#pddMonthlyMonth').fill('2026-09');
 await page.locator('#pddMonthlyStart').click();
 await page.locator('#pddMonthlySummary').filter({hasText:'2 笔订单'}).waitFor().catch(async error=>{console.error('PDD integration status:',await page.locator('#pddMonthlyStatus').innerText());throw error;});
 assert.match(await page.locator('#pddMonthlySummary').innerText(),/131\.00/);
 assert.equal(requests.length,2,'短页但 has_more=true 时必须继续游标分页');assert.equal(requests[1].offset,'b','游标必须原样传递');
 assert.equal(await page.locator('#pddMonthlyGrid .tabulator-row').count(),2);
 assert.match(await page.locator('#pddMonthlyGrid').innerText(),/00000000000000000001-ABC/);
 assert.match(await page.locator('#pddMonthlyGrid').innerText(),/M6/);assert.match(await page.locator('#pddMonthlyGrid').innerText(),/M8/);
 assert.doesNotMatch(await page.locator('#pddMonthlyGrid').innerText(),/OUTSIDE-OCTOBER/);
 assert.equal(await page.locator('[data-view-panel="purchase"]').count(),0);assert.equal(await page.locator('[data-view-panel="purchase"]').count(),0);
 const current=await page.evaluate(()=>window.inventoryApp.getPddMonthlyState());assert.equal(current.state,'completed');assert.equal(current.result.itemCount,3);assert.equal(current.result.month,'2026-09');
 const file=path.join(directory,'拼多多-九月-隔离核验.xlsx');
 await application.evaluate(({dialog},{file})=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},{file});
 await page.locator('#pddMonthlyExport').click();await page.locator('#pddMonthlyStatus').filter({hasText:'已导出 2026-09'}).waitFor();
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);const orderSheet=book.getWorksheet('采购订单'),itemSheet=book.getWorksheet('商品规格');
 assert.equal(orderSheet.actualRowCount,3);assert.equal(itemSheet.actualRowCount,4);
 const header=orderSheet.getRow(1).values;const values=orderSheet.getRows(2,2);
 assert(header.includes('快递单号'),'月度数据表必须保留平台快递单号');
 assert(values.some(row=>row.getCell(header.indexOf('快递单号')).value==='0001234567890123456789'),'快递长号不可删前导零或转成科学记数');
 assert(values.some(row=>row.getCell(header.indexOf('订单号')).value==='00000000000000000001-ABC'));
 assert.equal(values.reduce((sum,row)=>sum+Math.round(row.getCell(header.indexOf('整单实付款')).value*100),0),13100);
 await page.locator('#pddMonthlyMonth').fill('2026-08');await page.waitForFunction(()=>document.getElementById('pddMonthlySummary').textContent.includes('当前月份没有'));
 assert.equal(await page.locator('#pddMonthlyExport').isDisabled(),true);assert.equal(await page.locator('#pddMonthlyGrid .tabulator-row').count(),0);
 mode='error';await page.locator('#pddMonthlyMonth').fill('2026-09');await page.locator('#pddMonthlyStart').click();
 await page.locator('#pddMonthlyStatus.error').filter({hasText:/失败|错误|接口/}).waitFor();
 assert.equal(await page.locator('#pddMonthlyExport').isDisabled(),true);assert.equal((await page.evaluate(()=>window.inventoryApp.getPddMonthlyState())).result,null);
 mode='empty';await page.locator('#pddMonthlyMonth').fill('2026-02');await page.locator('#pddMonthlyStart').click();await page.locator('#pddMonthlySummary').filter({hasText:'0 笔订单'}).waitFor();
 assert.equal(await page.locator('#pddMonthlyExport').isDisabled(),false);const emptyFile=path.join(directory,'拼多多-空月份-隔离核验.xlsx');
 await application.evaluate(({dialog},{file})=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},{file:emptyFile});
 await page.locator('#pddMonthlyExport').click();await page.locator('#pddMonthlyStatus').filter({hasText:'已导出 2026-02'}).waitFor();
 const emptyBook=new ExcelJS.Workbook();await emptyBook.xlsx.readFile(emptyFile);assert.equal(emptyBook.getWorksheet('采购订单').actualRowCount,1);assert.equal(emptyBook.getWorksheet('商品规格').actualRowCount,1);
 mode='delayed';const delayStarted=new Promise(resolve=>announceDelay=resolve);await page.locator('#pddMonthlyMonth').fill('2026-09');await page.locator('#pddMonthlyStart').click();await delayStarted;
 assert.equal(await page.locator('#pddMonthlyMonth').isDisabled(),true);assert.equal(await page.locator('#pddMonthlyStart').isDisabled(),true);
 await page.locator('#pddMonthlyStop').click();await page.locator('#pddMonthlyStatus').filter({hasText:/停止|取消/}).waitFor();
 assert.equal((await page.evaluate(()=>window.inventoryApp.getPddMonthlyState())).state,'canceled');assert.equal(await page.locator('#pddMonthlyExport').isDisabled(),true);
 assert.deepEqual(protectedLedger(),before,'独立采集、失败、空表导出和停止不得改变原采购账本');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,directory,homeScreenshot,orders:2,items:3,totalAmountCents:13100,exportFile:file,emptyExportFile:emptyFile,requests:requests.length,checks:'实际主页→IPC→独立浏览器→拼多多接口分页/月边界→表格→Excel读回；全部状态、错误非零、空月、停止、旧结果保护；采购账本未变'},null,2));
}finally{
 for(const res of held)if(!res.writableEnded)res.end(JSON.stringify({orders:[],has_more:false}));
 if(application){await application.evaluate(({app})=>app.quit()).catch(()=>{});await application.close().catch(()=>{});}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
