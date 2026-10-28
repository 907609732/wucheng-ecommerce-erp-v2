import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {openStore} from './helpers.mjs';
import {stagePdd,pddPreview,commitPdd,pddFundsReport,pddStatementYear,setAttribution,unassignedBatches,movementsPage,movementDetail,saveReference} from '../lib/pdd.mjs';
import {pddCoverage} from '../lib/pdd-services.mjs';
import {exportWorkbook,exportPddMovements} from '../lib/export.mjs';
import {monthData,report} from '../lib/report.mjs';
import {closePreview,lockMonth} from '../lib/close.mjs';
import {createApp,createSessionFetch} from './helpers.mjs';
import {makeBackup,restoreBackup} from '../lib/backup.mjs';

const SHOP='pdd-mipeijiang',OTHER='pdd-other-test',LONG='250901-001234567890123456789';
function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'sales-pdd-details-')),s=openStore(dir);s.run('INSERT INTO shops VALUES(?,?,?,?,?)',OTHER,'拼多多','另一家测试店铺','待核实',0);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
async function zip(rows,{start='2025-09-01 00:00:00',end='2025-09-30 23:59:59'}={}){
  const income=rows.filter(r=>r[2]>0),expense=rows.filter(r=>r[3]<0),inc=income.reduce((a,r)=>a+r[2],0),exp=expense.reduce((a,r)=>a+r[3],0),csv=['拼多多店铺账务明细查询','','起始时间：'+start+'  终止时间：'+end,'----------交易记录明细列表---------','商户订单号,发生时间,收入金额（+元）,支出金额（-元）,账务类型,备注,业务描述',...rows.map(r=>[r[0],r[1],(r[2]/100).toFixed(2),(r[3]/100).toFixed(2),r[4],r[5],r[6]].join(',')),'',`#收入合计：${income.length}笔${(inc/100).toFixed(2)}元`,`#支出合计：${expense.length}笔${(exp/100).toFixed(2)}元`,`#总计：${((inc+exp)/100).toFixed(2)}元`].join('\n'),z=new JSZip();z.file('official.csv',csv);return z.generateAsync({type:'nodebuffer'});
}
const records=()=>[[LONG,'2025-09-02 12:00:00',10000,0,'交易收入','订单备注','0010002|交易收入-订单收入'],[LONG,'2025-09-02 12:00:00',0,-100,'技术服务费','费用备注','0030002|技术服务费-基础技术服务费'],['-','2025-09-03 12:00:00',0,-500,'提现','到账待银行核实','0080001|提现-提现申请']];
async function ingest(s,buffer,filename='bill.zip',shop=SHOP){const b=await stagePdd(s,buffer,filename,{shop_id:shop});const p=pddPreview(s,b.id);return {...b,result:commitPdd(s,b.id,p.revision)};}

test('quarantined batches keep every row and original, leave all summaries and exports, and can be reassigned',async t=>{
  const s=setup(t),buffer=await zip(records()),b=await ingest(s,buffer),before=s.all('SELECT id,amount FROM ledger ORDER BY id');
  setAttribution(s,b.id,{status:'unassigned',reason:'用户确认这份来自其他店铺'});
  assert.deepEqual(s.all('SELECT id,amount FROM ledger ORDER BY id'),before);assert.equal(unassignedBatches(s)[0].summary.count,3);
  assert.equal(monthData(s,'2025-09').ledger.length,0);assert.equal(pddFundsReport(s,'2025-09','month',SHOP).count,0);assert.equal(report(s,{period:'2025-09',shop:'all'}).totals.sales,null);
  assert.equal(movementsPage(s,{shop_id:SHOP,month:'2025-09'}).total,0);
  assert.equal(movementsPage(s,{attribution:'unassigned',batch_id:b.id}).total,3);
  assert.throws(()=>movementDetail(s,before[0].id,{shop_id:SHOP}),/没有这笔/);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(await exportWorkbook(s,{period:'2025-09',grain:'month',shop:'all'}));assert.equal(wb.getWorksheet('流水原值').rowCount,1);assert.equal(wb.getWorksheet('拼多多货款动账'),undefined);
  const reimport=await stagePdd(s,buffer,'correct-store.zip',{shop_id:SHOP});assert.equal(pddPreview(s,reimport.id).duplicates,0);commitPdd(s,reimport.id,reimport.revision);
  assert.throws(()=>setAttribution(s,b.id,{status:'confirmed',shop_id:SHOP,reason:'目标已有相同记录'}),/重复流水/);
  setAttribution(s,b.id,{status:'confirmed',shop_id:OTHER,reason:'已确认真正的另一家店铺'});
  assert.equal(unassignedBatches(s).length,0);assert.equal(movementsPage(s,{shop_id:OTHER}).total,3);assert.equal(movementsPage(s,{shop_id:SHOP}).total,3);
  assert.equal(s.get("SELECT COUNT(*) n FROM audit WHERE action='import.attribution'").n,2);
});
test('PDD import requires shop, supports unassigned storage and never deduplicates across shops',async t=>{
  const s=setup(t),buffer=await zip(records());await assert.rejects(stagePdd(s,buffer,'missing.zip'),/请选择/);
  const pending=await stagePdd(s,buffer,'unknown.zip',{shop_id:'__unassigned__'});assert.throws(()=>commitPdd(s,pending.id,pending.revision),/先确认/);
  setAttribution(s,pending.id,{status:'confirmed',shop_id:SHOP,reason:'确认来源'});assert.throws(()=>commitPdd(s,pending.id,pending.revision),/预览版本/);assert.equal(commitPdd(s,pending.id,pddPreview(s,pending.id).revision).added,3);
  assert.equal((await ingest(s,buffer,'other.zip',OTHER)).result.added,3);assert.equal(pddFundsReport(s,'2025-09','month',SHOP).count,3);assert.equal(pddFundsReport(s,'2025-09','month',OTHER).count,3);
});
test('declared export intervals join at midnight and distinguish partial coverage from no movements',async t=>{
  const s=setup(t);await ingest(s,await zip([],{start:'2025-08-01 12:00:00',end:'2025-09-01 11:59:59'}),'aug.zip');await ingest(s,await zip(records(),{start:'2025-09-01 12:00:00',end:'2025-10-01 11:59:59'}),'sep.zip');
  assert.equal(pddCoverage(s,SHOP,'2025-09').status,'full');assert.equal(pddCoverage(s,SHOP,'2025-08').status,'partial');const oct=pddCoverage(s,SHOP,'2025-10');assert.equal(oct.status,'partial');assert.equal(oct.gaps[0].start,'2025-10-01 12:00:00');
  saveReference(s,{shop_id:SHOP,month:'2025-09',cutoff:'2025-09-30 23:59:59',income:10000,expense:-600,income_count:1,expense_count:2,opening_balance:0,closing_balance:9400});
  saveReference(s,{shop_id:SHOP,month:'2025-10',cutoff:'2025-10-17 23:59:59',income:50000,expense:-10000,income_count:4,expense_count:2});
  const year=pddStatementYear(s,'2025',SHOP);assert.equal(year.months.find(x=>x.month==='2025-09').comparison,'match');assert.equal(year.months.find(x=>x.month==='2025-10').comparison,'range_difference');
});
test('filtered pagination, original detail and complete Excel export agree and preserve long order numbers',async t=>{
  const s=setup(t),rows=Array.from({length:125},(_,i)=>[LONG+'-'+String(i).padStart(3,'0'),'2025-09-02 12:00:00',100,0,'交易收入','逐笔备注 '+i,'0010002|交易收入-订单收入']);await ingest(s,await zip(rows));
  const q={shop_id:SHOP,month:'2025-09',direction:'income',category:'交易收入',q:'001234567890123456789',page:2,page_size:50,sort:'order_no',sort_dir:'asc'},page=movementsPage(s,q);assert.equal(page.total,125);assert.equal(page.rows.length,50);assert.equal(page.totals.income,12500);assert.equal(page.rows[0].order_no,LONG+'-050');
  const one=movementDetail(s,page.rows[0].id,{shop_id:SHOP});assert.equal(one.original_note,'逐笔备注 50');assert.equal(one.source_row,56);assert.equal(one.business_code,'0010002');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(await exportPddMovements(s,q));const ws=wb.getWorksheet('逐笔明细');assert.equal(ws.rowCount,126);assert.equal(ws.getCell('B2').value,LONG+'-000');assert.equal(ws.getColumn(2).numFmt,'@');assert.equal(wb.getWorksheet('筛选与合计').getCell('B9').value,125);
  assert.equal(movementsPage(s,{...q,q:'NONEXISTENT'}).total,0);assert.throws(()=>movementsPage(s,{...q,sort:'sql injected'}),/排序/);assert.throws(()=>movementsPage(s,{...q,page_size:1000}),/分页/);
});
test('attribution changes respect month locks',async t=>{const s=setup(t),b=await ingest(s,await zip(records()));const p=closePreview(s,'2025-09');await lockMonth(s,{month:'2025-09',revision:p.revision,confirmation:'锁定 2025-09'});assert.throws(()=>setAttribution(s,b.id,{status:'unassigned',reason:'不能绕过锁定'}),/锁定/);assert.throws(()=>s.run('INSERT INTO batch_attributions VALUES(?,?,?,?)',b.id,'unassigned','direct','now'),/MONTH_LOCKED/);});
test('empty intervals covering a locked adjacent month cannot change attribution or completeness',async t=>{const s=setup(t),b=await ingest(s,await zip([],{start:'2025-08-01 12:00:00',end:'2025-09-01 11:59:59'}));const p=closePreview(s,'2025-09');await lockMonth(s,{month:'2025-09',revision:p.revision,confirmation:'锁定 2025-09'});assert.throws(()=>setAttribution(s,b.id,{status:'unassigned',reason:'范围包含已锁定的九月'}),/锁定/);assert.throws(()=>s.run('INSERT INTO batch_attributions VALUES(?,?,?,?)',b.id,'unassigned','direct','now'),/MONTH_LOCKED/);});
test('backup restores platform evidence and historical report files with attribution records',async t=>{const s=setup(t),b=await ingest(s,await zip(records()));setAttribution(s,b.id,{status:'unassigned',reason:'其他店铺待确认'});writeFileSync(path.join(s.dir,'originals','reference.png'),'reference-bytes');writeFileSync(path.join(s.dir,'reports','historical.xlsx'),'historical-report-bytes');saveReference(s,{shop_id:SHOP,month:'2025-09',cutoff:'2025-09-30 23:59:59',income:10000,expense:-600,evidence_path:'originals/reference.png'});const backup=await makeBackup(s),target=path.join(s.dir,'restored-copy');restoreBackup(s,backup.name,target);assert.equal(readFileSync(path.join(target,'originals','reference.png'),'utf8'),'reference-bytes');assert.equal(readFileSync(path.join(target,'reports','historical.xlsx'),'utf8'),'historical-report-bytes');const copy=openStore(target);try{assert.equal(unassignedBatches(copy).length,1);assert.equal(copy.get('SELECT COUNT(*) n FROM ledger').n,3);assert.equal(copy.get('SELECT COUNT(*) n FROM active_ledger').n,0);}finally{copy.close();}});
test('PDD HTTP APIs reject missing shop and export filtered data with token-protected attribution',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'sales-pdd-http-')),{app,store}=createApp({dataDir:dir,port:18861}),server=app.listen(18861,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:18861',fetch=await createSessionFetch(base,'boss'),boot=await(await fetch(base+'/api/bootstrap')).json();const b=await ingest(store,await zip(records()));
  assert.equal((await fetch(base+'/api/pdd/statement?year=2025')).status,400);const list=await(await fetch(base+'/api/pdd/movements?shop_id='+SHOP+'&month=2025-09')).json();assert.equal(list.total,3);
  const exp=await fetch(base+'/api/pdd/movements-export?shop_id='+SHOP+'&month=2025-09&direction=expense');assert.equal(exp.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await exp.arrayBuffer()));assert.equal(wb.getWorksheet('逐笔明细').rowCount,3);
  const url=base+'/api/imports/'+b.id+'/attribution',body=JSON.stringify({status:'unassigned',reason:'归属纠正'});assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-sales-token':boot.token},body})).status,200);assert.equal((await(await fetch(base+'/api/pdd/unassigned')).json()).length,1);
});

test('scoped PDD summaries match locked snapshots and reject invalid period queries',async t=>{
 const s=setup(t);await ingest(s,await zip([['long-1','2025-09-10 10:00:00',12345,0,'收入','n','0010002|订单收入'],['long-1','2025-09-10 10:00:01',0,-345,'退款','n','0020002|订单退款']]));
 const expected=pddFundsReport(s,'2025-09','month',SHOP),before=pddStatementYear(s,'2025',SHOP);const p=closePreview(s,'2025-09');await lockMonth(s,{month:'2025-09',revision:p.revision,confirmation:'锁定 2025-09'});
 assert.deepEqual(pddFundsReport(s,'2025-09','month',SHOP),expected);assert.deepEqual(pddStatementYear(s,'2025',SHOP),before);
 const all=s.all;s.all=(sql,...args)=>sql.startsWith('SELECT * FROM active_ledger WHERE shop_id=')?[]:all(sql,...args);
 assert.deepEqual(pddFundsReport(s,'2025-09','month',SHOP),expected);assert.equal(pddFundsReport(s,'2025-09-10','day',SHOP).income,12345);assert.equal(pddFundsReport(s,'2025','year',SHOP).income,12345);
 assert.throws(()=>pddFundsReport(s,'2025-13','month',SHOP));assert.throws(()=>pddFundsReport(s,'2025-02-30','day',SHOP));assert.throws(()=>pddFundsReport(s,'bad','year',SHOP));assert.throws(()=>pddFundsReport(s,'2025-09','invalid',SHOP));
});
test('empty operations trend shortcut keeps totals and does not skip real sales reports',t=>{
 const s=setup(t);const ordinary=report(s,{period:'2025-09',shop:SHOP}),fast=report(s,{period:'2025-09',shop:SHOP,empty_trend:'skip'});assert.deepEqual(fast.totals,ordinary.totals);assert.deepEqual(fast.reconciliation,ordinary.reconciliation);assert.deepEqual(fast.trend,[]);
 s.run('INSERT INTO operations(id,shop_id,start,end,currency,sales,definition,compatible,source) VALUES(?,?,?,?,?,?,?,?,?)','ops-fast-test',SHOP,'2025-09-01','2025-09-30','CNY',2500,'支付日期',0,'test');const sales=report(s,{period:'2025-09',shop:SHOP,empty_trend:'skip'});assert.equal(sales.totals.sales,2500);assert.equal(sales.trend.length,12);
});
