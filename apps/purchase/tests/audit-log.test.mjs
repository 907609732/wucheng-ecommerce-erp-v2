import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openStore,summarize} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
const base=(orderNo='LOG-1',extra={})=>({platform:'微信',account:'日志测试',orderNo,date:'2026-05-01',paidAt:'2026-05-02',supplier:'日志测试店',status:'已完成',amountCents:10000,refundCents:1000,shippingCents:0,note:'原始备注',items:[{title:'测试商品',qty:1,unit:'件',unitPriceCents:10000}],...extra});
const refs=orders=>orders.map(({id,updatedAt})=>({id,updatedAt}));
const version=p=>p.orders.map(({auditId,orderId,updatedAt})=>({auditId,orderId,updatedAt}));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-log-'));const store=openStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store};}
const undo=(store,id,scope='entry',reason='测试误操作')=>{const p=store.auditLog.preview({auditId:id,scope});assert.equal(p.canUndo,true);return store.auditLog.rollback({auditId:id,scope,versions:version(p),reason});};
const dump=store=>Object.fromEntries(['orders','audit'].map(name=>[name,store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));

test('旧日志直接可查，新增元信息保留全部历史值；重复升级不新增或覆盖订单日志',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-log-upgrade-'));let store=openStore(dir);
 try{
  let o=store.insert(base());o=store.update(o.id,{...o,note:'以前的修改'});const rawOrder=store.db.prepare('SELECT * FROM orders').get();store.close();
  const legacy=new DatabaseSync(path.join(dir,'purchases.sqlite'));legacy.exec('ALTER TABLE audit DROP COLUMN rollback_of; ALTER TABLE audit DROP COLUMN reason');const before=legacy.prepare('SELECT * FROM audit ORDER BY id').all();legacy.close();
  store=openStore(dir);const after=store.db.prepare('SELECT * FROM audit ORDER BY id').all();for(let i=0;i<before.length;i++)for(const [k,v] of Object.entries(before[i]))assert.equal(after[i][k],v,k);assert.deepEqual(store.db.prepare('SELECT * FROM orders').get(),rawOrder);
  assert.equal(store.auditLog.list().total,1);assert.equal(store.auditLog.list().entries[0].changes[0].before,'原始备注');store.close();store=openStore(dir);assert.deepEqual(store.db.prepare('SELECT * FROM audit ORDER BY id').all(),after);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('订单、属性、分类及备注修改均可搜索；覆盖全部业务字段、分页及北京时间日期边界',t=>{
 const {store}=fixture(t);let o=store.insert(base());o=store.update(o.id,{...o,supplier:'新店名',orderNo:'NEW-NO',platform:'淘宝',note:'查找特殊字符 %_',recipient:'测试收货人',amountCents:20000,shippingCents:50,items:[{title:'新商品',qty:2,unit:'台',unitPriceCents:10000}]});
 const edited=store.history(o.id)[0];assert.ok(edited.id);const detail=store.auditLog.detail(edited.id);for(const key of ['supplier','orderNo','platform','note','recipient','amountCents','shippingCents','items'])assert.ok(detail.changes.some(c=>c.key===key),key);
 assert.equal(store.auditLog.list({q:'%_'}).total,1);assert.equal(store.auditLog.list({q:'LOG-1'}).total,1);assert.equal(store.auditLog.list({q:'NEW-NO',platform:'微信'}).total,1);assert.equal(store.auditLog.list({q:'NEW-NO',platform:'1688'}).total,0);
 o=store.classify(o.id,{updatedAt:o.updatedAt,classification:{mode:'single',category:'fixed_asset',owner:'company'}});store.attributesBatch({orders:refs([o]),patch:{excludedFromSpend:true,status:'待收货'}});
 assert.equal(store.auditLog.list().total,3);assert.equal(store.auditLog.list({action:'all'}).total,4);assert.equal(store.auditLog.list({pageSize:2,page:2}).entries.length,1);assert.equal(store.auditLog.list({action:'attributes'}).entries[0].changes.length,2);
 store.db.prepare('UPDATE audit SET created_at=? WHERE id=?').run('2026-05-31T16:00:00.000Z',edited.id);assert.equal(store.auditLog.list({from:'2026-06-01',to:'2026-06-01',q:'特殊字符'}).total,1);assert.equal(store.auditLog.list({from:'2026-05-31',to:'2026-05-31',action:'update'}).total,0);
 for(const f of [{page:'bad'},{pageSize:100000},{from:'2026-02-30'},{from:'2026-06-01',to:'2026-05-01'},{action:'delete'}])assert.throws(()=>store.auditLog.list(f));
});

test('撤销只恢复选定变更，保留后续其他字段、原件、商品与分类；撤销本身可再撤销并持久化',t=>{
 const {store,dir}=fixture(t);let o=store.insert(base(),null,{proof:'原始凭证',image:'原图引用'});const original=store.db.prepare('SELECT original FROM orders').get().original;
 o=store.update(o.id,{...o,status:'已关闭'});const log=store.history(o.id)[0];o=store.update(o.id,{...o,note:'后来补充的备注'});
 const r=undo(store,log.id);o=r.orders[0];assert.equal(o.status,'已完成');assert.equal(o.note,'后来补充的备注');assert.equal(summarize(store.list(),2026).netCents,9000);
 const rollback=store.history(o.id)[0];assert.equal(rollback.action,'rollback');assert.equal(rollback.rollback_of,log.id);assert.equal(rollback.reason,'测试误操作');assert.equal(rollback.batch_id,r.batchId);assert.equal(JSON.parse(rollback.before_json).status,'已关闭');assert.equal(JSON.parse(rollback.after_json).status,'已完成');
 assert.equal(store.db.prepare('SELECT original FROM orders').get().original,original);undo(store,rollback.id);assert.equal(store.get(o.id).status,'已关闭');assert.equal(store.auditLog.list({q:'测试误操作',action:'rollback'}).total,2);
 const second=openStore(dir);try{assert.equal(second.history(o.id)[0].action,'rollback');assert.equal(second.get(o.id).note,'后来补充的备注');}finally{second.close();}
});

test('整批撤销全部成功，或因字段冲突、过期版本、伪造目标及写入中途失败全部回滚',t=>{
 const {store}=fixture(t),a=store.insert(base()),b=store.insert(base('LOG-2'));
 store.attributesBatch({orders:refs([a,b]),patch:{excludedFromSpend:true}});const id=store.history(a.id)[0].id,input={auditId:id,scope:'batch'};let p=store.auditLog.preview(input);assert.equal(p.count,2);
 const before=dump(store);
 assert.throws(()=>store.auditLog.rollback({...input,versions:version(p).slice(0,1)}),/重新预览/);assert.throws(()=>store.auditLog.rollback({...input,versions:version(p).map(v=>({...v,orderId:'伪造ID'}))}),/预览后/);assert.deepEqual(dump(store),before);
 let updated=store.get(a.id);store.update(a.id,{...updated,note:'预览后又改备注'});const newer=dump(store);assert.throws(()=>store.auditLog.rollback({...input,versions:version(p)}),e=>e.code==='ORDER_VERSION_CONFLICT');assert.deepEqual(dump(store),newer);
 p=store.auditLog.preview(input);store.db.exec("CREATE TRIGGER simulate_undo_failure BEFORE UPDATE ON orders WHEN NEW.order_no='LOG-2' BEGIN SELECT RAISE(ABORT,'undo failure'); END");assert.throws(()=>store.auditLog.rollback({...input,versions:version(p)}),/undo failure/);assert.deepEqual(dump(store),newer);store.db.exec('DROP TRIGGER simulate_undo_failure');
 const r=undo(store,id,'batch');assert.equal(r.changed,2);assert.ok(r.orders.every(o=>!o.excludedFromSpend));assert.ok(r.orders.every(o=>store.history(o.id)[0].batch_id===r.batchId));
 assert.equal(store.auditLog.preview(input).canUndo,false);assert.throws(()=>store.auditLog.rollback({...input,versions:version(p)}),e=>e.code==='ROLLBACK_BLOCKED');
});

test('金额和分类相互校验；已锁定当前月或回退目标月份不能撤销，首笔入账不可删除',async t=>{
 const {store}=fixture(t);let o=store.insert(base());const create=store.history(o.id)[0];assert.equal(store.auditLog.preview({auditId:create.id,scope:'entry'}).canUndo,false);
 o=store.update(o.id,{...o,amountCents:20000});const amountLog=store.history(o.id)[0];o=store.classify(o.id,{updatedAt:o.updatedAt,classification:{mode:'split',owner:'company',parts:[{category:'goods',amountCents:15000,refundCents:1000},{category:'expense',amountCents:5000,refundCents:0}]}});const classLog=store.history(o.id)[0];assert.equal(store.auditLog.preview({auditId:amountLog.id,scope:'entry'}).canUndo,false);undo(store,classLog.id);undo(store,amountLog.id);assert.equal(store.get(o.id).amountCents,10000);
 o=store.get(o.id);o=store.update(o.id,{...o,paidAt:'2026-06-02'});const dateLog=store.history(o.id)[0];const password=randomUUID();await store.monthLocks.setPassword({password,confirmation:password});store.monthLocks.confirm(store.monthLocks.preview('2026-05','微信'));
 assert.match(store.auditLog.preview({auditId:dateLog.id,scope:'entry'}).orders[0].blockedReason,/锁定/);
 o=store.update(o.id,{...o,note:'当前月将锁定'});const noteLog=store.history(o.id)[0];store.monthLocks.confirm(store.monthLocks.preview('2026-06','微信'));const before=dump(store);assert.match(store.auditLog.preview({auditId:noteLog.id,scope:'entry'}).orders[0].blockedReason,/锁定/);assert.deepEqual(dump(store),before);
});

test('撤销平台、账号和订单编号时拒绝唯一键碰撞，拒绝客户端指定恢复值',t=>{
 const {store}=fixture(t);let o=store.insert(base());o=store.update(o.id,{...o,orderNo:'CHANGED'});const log=store.history(o.id)[0];store.insert(base());assert.match(store.auditLog.preview({auditId:log.id,scope:'entry'}).orders[0].blockedReason,/重复/);
 o=store.update(o.id,{...o,note:'可撤销'});const noteLog=store.history(o.id)[0],p=store.auditLog.preview({auditId:noteLog.id,scope:'entry'});store.auditLog.rollback({auditId:noteLog.id,scope:'entry',versions:version(p),target:{amountCents:1},orders:[{id:o.id,amountCents:1}]});assert.equal(store.get(o.id).amountCents,10000);assert.equal(store.get(o.id).note,'原始备注');
});

test('HTTP日志查询、预览、确认、审计与回退统计贯通，修改请求受会话保护',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-log-api-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});const root='http://127.0.0.1:'+server.address().port;
 const get=route=>fetch(root+route).then(r=>r.json()),{token}=await get('/api/bootstrap'),headers={'X-Purchase-Token':token,'Content-Type':'application/json'},post=(route,body,method='POST')=>fetch(root+route,{method,headers,body:JSON.stringify(body)});
 let o=await (await post('/api/orders',base())).json();assert.ok(o.id);await post('/api/orders/'+o.id+'/note',{updatedAt:o.updatedAt,note:'HTTP修改备注'},'PATCH');let list=await get('/api/order-logs?q=HTTP修改备注');assert.equal(list.total,1);assert.equal(list.entries[0].changes[0].key,'note');const logId=list.entries[0].id;
 const p=await (await post('/api/order-logs/rollback-preview',{auditId:logId,scope:'entry'})).json();assert.equal(p.canUndo,true);assert.equal((await fetch(root+'/api/order-logs/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auditId:logId,scope:'entry',versions:version(p)})})).status,403);
 assert.equal((await post('/api/order-logs/rollback',{auditId:logId,scope:'entry',versions:version(p),reason:'HTTP误改恢复'})).status,200);assert.equal(store.get(o.id).note,'原始备注');list=await get('/api/order-logs?action=rollback');assert.equal(list.total,1);const detail=await get('/api/order-logs/'+list.entries[0].id);assert.equal(detail.rollbackOf,logId);assert.equal(detail.reason,'HTTP误改恢复');assert.equal((await get('/api/orders/'+o.id+'/history'))[0].id,detail.id);
 assert.equal((await post('/api/order-logs/rollback',{auditId:logId,scope:'entry',versions:version(p)})).status,409);assert.equal((await fetch(root+'/api/order-logs/99999999')).status,404);
});
