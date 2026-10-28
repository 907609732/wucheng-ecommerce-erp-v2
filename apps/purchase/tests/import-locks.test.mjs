import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import {createApp} from '../server.mjs';
import {openStore} from '../lib/store.mjs';
import {importReportDraft,reviewImportOrders} from '../lib/import-review.mjs';

test.beforeEach(t=>t.mock.timers.enable({apis:['Date'],now:new Date('2026-12-15T00:00:00+08:00')}));
const password='Isolated-import-test-842761';
const headers='订单编号,下单日期,付款日期,采购账号,供应商,商品名称,数量,实付金额,订单状态';
const row=(id,paid='2026-10-02',{date='2026-08-01',account='测试账号',supplier='测试供应商',amount='100.00'}={})=>[id,date,paid,account,supplier,'测试商品',1,amount,'已完成'].join(',');
const confirm=(store,month='2026-08',platform='微信')=>store.monthLocks.confirm(store.monthLocks.preview(month,platform));
const snapshot=store=>({tables:Object.fromEntries(['orders','imports','audit','settings','month_confirmations','month_events'].map(table=>[table,store.db.prepare('SELECT * FROM '+table).all()])),files:fs.readdirSync(path.join(store.dir,'originals'))});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-import-lock-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(url+'/api/bootstrap')).json();
 await store.monthLocks.setPassword({password,confirmation:password});
 const request=async(route,body,extra={})=>{const response=await fetch(url+route,{method:'POST',headers:{'X-Purchase-Token':token,...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...extra},body:body instanceof FormData?body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 const preview=async(rows,platform='微信')=>{const form=new FormData();form.set('platform',platform);form.set('file',new Blob(['\uFEFF'+headers+'\n'+rows.join('\n')]),'lock-test.csv');const p=await request('/api/import/preview',form);assert.equal(p.status,200);return p;};
 return {store,dir,url,request,preview,commit:(p,indices,extra)=>request('/api/import/'+p.id+'/commit',{indices},extra)};
}

test('混合月份预览排除锁定订单，入库结果逐笔列明锁定、重复、冲突、异常和未勾选，重启后清单仍在',async t=>{
 const f=await fixture(t),{store}=f;
 const seed=await f.preview([row('DUP','2026-08-08'),row('CONFLICT','2026-08-08')]);
 for(const o of seed.orders)store.transaction(()=>store.insert(o));
 const prior=store.list().find(o=>o.orderNo==='DUP');store.classify(prior.id,{updatedAt:prior.updatedAt,classification:{mode:'single',category:'fixed_asset'}});confirm(store);
 const before=snapshot(store);
 const p=await f.preview([
  row('LOCK-PAID','2026-08-08'),row('LOCK-FALLBACK',''),row('LOCK-OTHER-ACCOUNT','2026-08-20',{account:'第二账号'}),
  row('DUP','2026-08-08'),row('CONFLICT','2026-08-08',{amount:'200.00'}),row('INVALID','2026-10-02',{supplier:''}),
  row('NEW-PAID'),row('OLDER-UNLOCKED','2026-07-05',{date:'2026-07-01'}),row('UNCHECKED'),row('')
 ]);
 assert.deepEqual(snapshot(store),before,'预览不得写入任何采购数据');
 assert.deepEqual(p.summary,{orders:9,valid:3,duplicates:1,conflicts:1,invalid:1,locked:3,amountCents:30000});
 assert.equal(p.orders[0].locked.month,'2026-08');assert.equal(p.orders[1].paidAt,'');assert.deepEqual(p.orders[2].sourceRows,[4]);assert.equal(p.issues.length,1);
 const result=await f.commit(p,[6,7]);assert.equal(result.status,200);assert.equal(result.imported,2);assert.equal(result.report.notImported.length,7);assert.equal(result.report.imported+result.report.notImported.length,result.report.totalOrders);
 assert.deepEqual(result.report.notImported.map(o=>[o.orderNo,o.status]),[['LOCK-PAID','locked'],['LOCK-FALLBACK','locked'],['LOCK-OTHER-ACCOUNT','locked'],['DUP','duplicate'],['CONFLICT','conflict'],['INVALID','invalid'],['UNCHECKED','unselected']]);
 assert.equal(result.report.notImported[1].month,'2026-08');assert.match(result.report.notImported[0].reason,/已确认锁定/);assert.equal(result.report.issues[0].row,11);
 assert.equal(store.list().length,4);assert.deepEqual(store.get(prior.id).classification,{mode:'single',category:'fixed_asset',owner:'company'});
 for(const o of before.tables.orders)assert.deepEqual(store.db.prepare('SELECT * FROM orders WHERE id=?').get(o.id),o,'被锁定的现有订单原样保留');
 assert.deepEqual(store.imports()[0].metadata.importReport,result.report);
 const reopened=openStore(f.dir);try{assert.deepEqual(reopened.imports()[0].metadata.importReport,result.report);assert.equal(reopened.monthLocks.confirmations().length,1);}finally{reopened.close();}
});

test('全部锁定时即使伪造勾选和提交管理员请求头也不能导入，取消确认后才能保存',async t=>{
 const f=await fixture(t);confirm(f.store);const p=await f.preview([row('BLOCK-1','2026-08-09'),row('BLOCK-2','')]),before=snapshot(f.store);
 assert.equal(p.summary.valid,0);assert.equal(p.summary.locked,2);
 const r=await f.commit(p,[0,1],{'X-Purchase-Admin':password});assert.equal(r.status,423);assert.equal(r.code,'MONTH_LOCKED');assert.equal(r.report.imported,0);assert.deepEqual(r.report.notImported.map(o=>o.orderNo),['BLOCK-1','BLOCK-2']);assert.deepEqual(snapshot(f.store),before);
 await f.store.monthLocks.cancel({...f.store.monthLocks.confirmations()[0],password});const saved=await f.commit(p,[0,1]);assert.equal(saved.status,200);assert.equal(saved.imported,2);
});

test('预览之后月份被锁定时整批回滚并更新预览，重新选择其他月份才会导入',async t=>{
 const f=await fixture(t),p=await f.preview([row('RACE-LOCK','2026-08-08'),row('RACE-READY')]);assert.equal(p.summary.valid,2);confirm(f.store);const before=snapshot(f.store);
 const r=await f.commit(p,[0,1]);assert.equal(r.status,423);assert.equal(r.preview.summary.valid,1);assert.equal(r.preview.summary.locked,1);assert.deepEqual(r.report.notImported.map(o=>o.status),['locked','batch_aborted']);assert.deepEqual(snapshot(f.store),before);
 const saved=await f.commit(p,[1]);assert.equal(saved.status,200);assert.equal(saved.imported,1);assert.equal(saved.report.notImported[0].orderNo,'RACE-LOCK');assert.equal(f.store.list()[0].orderNo,'RACE-READY');
});

test('锁定覆盖全部账号和全部状态，其他平台同月份仍能导入，缺少付款日使用下单月',async t=>{
 const f=await fixture(t);confirm(f.store);
 const p=await f.preview([row('CLOSED','',{account:'新账号'}).replace('已完成','已关闭'),row('PENDING','2026-08-08').replace('已完成','待付款'),row('FALLBACK-READY','',{date:'2026-10-01'})]);
 assert.equal(p.summary.locked,2);assert.equal(p.summary.valid,1);assert.equal((await f.commit(p,[2])).imported,1);
 const other=await f.preview([row('OTHER-PLATFORM','2026-08-08')],'其他');assert.equal(other.summary.locked,0);assert.equal((await f.commit(other,[0])).imported,1);
});

test('重新导入相同源表不会覆盖分类，预览后出现重复或冲突会列明并整批不保存',async t=>{
 const f=await fixture(t),rows=[row('ORIGINAL','2026-08-08')];const p=await f.preview(rows),out=await f.commit(p,[0]);assert.equal(out.imported,1);
 const o=f.store.list()[0];f.store.classify(o.id,{updatedAt:o.updatedAt,classification:{mode:'single',category:'expense'}});confirm(f.store);
 const again=await f.preview(rows);assert.equal(again.summary.duplicates,1);assert.equal(again.summary.valid,0);const before=snapshot(f.store);const rejected=await f.commit(again,[0]);assert.equal(rejected.status,409);assert.equal(rejected.report.notImported[0].status,'duplicate');assert.deepEqual(snapshot(f.store),before);
 const stale=await f.preview([row('BECAME-DUP'),row('BECAME-CONFLICT')]);for(const item of stale.orders)f.store.transaction(()=>f.store.insert(item));const changed=f.store.list().find(o=>o.orderNo==='BECAME-CONFLICT');f.store.update(changed.id,{...changed,amountCents:99900});const beforeStale=snapshot(f.store);const staleResult=await f.commit(stale,[0,1]);assert.equal(staleResult.status,409);assert.deepEqual(staleResult.report.notImported.map(o=>o.status),['duplicate','conflict']);assert.deepEqual(snapshot(f.store),beforeStale);
});

test('数据库提交异常回滚整批且不留下原文件，可在故障解除后重新提交',async t=>{
 const f=await fixture(t),p=await f.preview([row('ROLLBACK-1'),row('ROLLBACK-2')]),before=snapshot(f.store);
 f.store.db.exec("CREATE TRIGGER test_import_fail BEFORE INSERT ON orders WHEN NEW.order_no='ROLLBACK-2' BEGIN SELECT RAISE(ABORT,'TEST_IMPORT_FAILURE'); END;");
 const rejected=await f.commit(p,[0,1]);assert.equal(rejected.status,400);assert.deepEqual(snapshot(f.store),before);
 f.store.db.exec('DROP TRIGGER test_import_fail');assert.equal((await f.commit(p,[0,1])).imported,2);
});

test('事务开始前出现重复数据时结果清单记录实际跳过订单',async t=>{
 const f=await fixture(t),p=await f.preview([row('LATE-DUP'),row('STILL-READY')]);
 const draft=importReportDraft(p.filename,reviewImportOrders(p.orders,f.store),[],[0,1]);f.store.transaction(()=>f.store.insert(p.orders[0]));
 const r=f.store.importBatch(p.orders.map(o=>({index:o.index,order:o,original:{normalized:o}})),{filename:p.filename,hash:'isolated',lineCount:2,metadata:{importReport:draft}});
 assert.equal(r.imported,1);assert.equal(r.skipped,1);assert.equal(r.report.notImported[0].orderNo,'LATE-DUP');assert.equal(r.report.notImported[0].status,'duplicate');assert.equal(r.report.totalOrders,r.imported+r.report.notImported.length);
});

test('Excel 文件遵守相同月锁规则，多行商品的未导入清单保留全部源行',async t=>{
 const f=await fixture(t);confirm(f.store);
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('采购');
 sheet.addRow(headers.split(','));sheet.addRow(row('XLSX-LOCK','2026-08-09').split(','));sheet.addRow(row('XLSX-LOCK','2026-08-09').replace('测试商品','第二件商品').split(','));sheet.addRow(row('XLSX-READY').split(','));
 const form=new FormData();form.set('platform','微信');form.set('file',new Blob([await workbook.xlsx.writeBuffer()]),'multi-item.xlsx');
 const p=await f.request('/api/import/preview',form);assert.equal(p.status,200);assert.equal(p.summary.locked,1);assert.equal(p.summary.valid,1);assert.equal(p.orders[0].items.length,2);
 const result=await f.commit(p,[1]);assert.equal(result.imported,1);assert.equal(result.report.notImported[0].orderNo,'XLSX-LOCK');assert.deepEqual(result.report.notImported[0].sourceRows,[2,3]);assert.equal(f.store.list().length,1);assert.equal(fs.readdirSync(path.join(f.dir,'originals')).length,1);
});
