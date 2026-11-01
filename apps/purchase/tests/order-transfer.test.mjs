import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {openStore} from '../lib/store.mjs';
import {openOrderTransfers} from '../lib/order-transfer.mjs';
import {integrationHash as hash} from '../lib/local-integration.mjs';
function envelope(platform='taobao',patch={}){
  const task={id:'source-1',platform,from:'2026-10-01',to:'2026-10-20',status:'completed',listOutcome:'complete',count:1,accountKey:'stable-account'};
  const orders=[{platform,account:'当前账号',id:'9999999999999999999999',createdAt:'2026-10-05 12:30:00',paidAt:'2026-10-05',status:'交易成功',shop:'测试供应商',paidFen:12345,freightFen:null,refundFen:null,items:[{id:'a',title:'商品一',quantity:2,unitPriceFen:6000},{id:'b',title:'商品二',quantity:1,unitPriceFen:345}],...patch}];
  return {schema:'order-transfer/v1',task,orders,digest:hash({task,orders})};
}
function context(t,hooks){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-transfer-')),store=openStore(dir),api=openOrderTransfers(store,hooks);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,api};
}
function ready(api,source=envelope(),changes={}){
  let p=api.create(source);
  const decisions={account:'测试采购账号',rows:{[source.orders[0].id]:{refundCents:0,refundEvidence:'已对照平台无退款',...changes}}};
  p=api.save(p.id,{revision:p.revision,decisions});return p;
}
function approve(api,p){
  api.review(p.id,p.revision,'browser-1');
  return api.confirm(p.id,p.revision,'browser-1').receipt;
}
for(const platform of ['taobao','alibaba','pdd','jd','xianyu'])test(platform+' preserves large IDs, all items and whole-order money once',async t=>{
  const {api,store}=context(t),p=ready(api,envelope(platform));
  assert.equal(p.canConfirm,true,JSON.stringify(p.rows[0].issues));assert.equal(store.list().length,0);
  assert.equal(p.total.sourceItems,2);assert.equal(p.total.beforeNetCents,0);assert.equal(p.total.proposedNetCents,12345);
  const receipt=approve(api,p),result=await api.commit(p.id,receipt,'browser-1');
  assert.equal(result.verified,true);const [order]=store.list();assert.equal(order.orderNo,'9999999999999999999999');assert.equal(order.items.length,2);assert.equal(order.amountCents,12345);
  assert.deepEqual(await api.commit(p.id,receipt,'browser-1'),result);assert.equal(store.list().length,1);
  assert.deepEqual(api.verify(p.id),[]);
});
test('unknown refund, account placeholder and incomplete range prevent entire batch',t=>{
  const{api,store}=context(t);let p=api.create(envelope());assert.equal(p.canConfirm,false);
  assert.equal(p.rows[0].normalized.refundCents,null);
  assert.equal(p.rows[0].proposed.refundCents,null);
  assert.equal(p.total.sourceRefundCents,null);
  assert.equal(p.total.deltaNetCents,null);
  assert.throws(()=>api.review(p.id,p.revision,'browser-1'));
  p=api.save(p.id,{revision:p.revision,decisions:{account:'真实账号',rows:{}}});assert.equal(p.canConfirm,false);
  const source=envelope('jd');source.task.id='incomplete';source.task.listOutcome='interrupted';source.digest=hash({task:source.task,orders:source.orders});
  assert.equal(ready(api,source).canConfirm,false);assert.equal(store.list().length,0);
});
test('both UI receipts are required and changing draft invalidates review',async t=>{
  const{api}=context(t);let p=ready(api);
  assert.throws(()=>api.confirm(p.id,p.revision,'browser-1'));
  await assert.rejects(api.commit(p.id,'boolean-true','browser-1'));
  const receipt=approve(api,p);
  await assert.rejects(api.commit(p.id,receipt,'different-browser'));
  p=api.save(p.id,{revision:p.revision,decisions:{account:'其他账号',rows:{[p.rows[0].orderNo]:{refundCents:0,refundEvidence:'核实'}}}});
  await assert.rejects(api.commit(p.id,receipt,'browser-1'));assert.equal(p.state,'draft');
});
test('repeat source and duplicate orders cannot double book',async t=>{
  const{api,store}=context(t);let p=ready(api);await api.commit(p.id,approve(api,p),'browser-1');
  assert.equal(api.create(envelope()).id,p.id);
  const source=envelope();source.task.id='source-2';source.digest=hash({task:source.task,orders:source.orders});
  p=ready(api,source);assert.equal(p.total.skip,1);await api.commit(p.id,approve(api,p),'browser-1');assert.equal(store.list().length,1);
});
test('changed fields require decisions and optimistic version checking protects manual edits',async t=>{
  const{api,store}=context(t);let p=ready(api);await api.commit(p.id,approve(api,p),'browser-1');
  const source=envelope('taobao',{paidFen:13000});source.task.id='changed';source.digest=hash({task:source.task,orders:source.orders});
  p=ready(api,source);assert.equal(p.canConfirm,false);assert.ok(p.rows[0].differences.some(x=>x.field==='amountCents'));
  p=api.save(p.id,{revision:p.revision,decisions:{account:p.account,rows:{[p.rows[0].orderNo]:{refundCents:0,refundEvidence:'核实',fields:{amountCents:'source'}}}}});
  assert.equal(p.canConfirm,true);const receipt=approve(api,p),old=store.list()[0];store.update(old.id,{...old,note:'人工修改'});
  await assert.rejects(api.commit(p.id,receipt,'browser-1'));assert.equal(store.list()[0].amountCents,12345);assert.equal(store.list()[0].note,'人工修改');
});
test('a write/read mismatch rolls back the whole batch including import and audit',async t=>{
  const{api,store}=context(t,{afterWrite({db,written}){db.prepare('UPDATE orders SET amount_cents=1 WHERE id=?').run(written[0].id);}});
  const p=ready(api);await assert.rejects(api.commit(p.id,approve(api,p),'browser-1'),/校验失败/);
  assert.equal(store.list().length,0);assert.equal(store.imports().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM audit').get().n,0);
});
test('post-commit mismatch reverses only this batch, keeping evidence',async t=>{
  const{api,store}=context(t,{afterCommit({db}){db.prepare('UPDATE orders SET amount_cents=1').run();}});
  const p=ready(api);await assert.rejects(api.commit(p.id,approve(api,p),'browser-1'),/已撤销/);
  assert.equal(store.list().length,0);assert.equal(api.preview(p.id).state,'rolled_back');assert.equal(store.imports().length,1);
});
test('missing key fields and mismatching digest are rejected',t=>{
  const{api}=context(t);const source=envelope();source.orders[0].paidFen=null;assert.throws(()=>api.create(source),/校验失败/);
  source.digest=hash({task:source.task,orders:source.orders});assert.equal(ready(api,source).canConfirm,false);
});

test('same order number in separate accounts stays separate; locked month rejects whole batch',async t=>{
  const{api,store}=context(t);let p=ready(api);await api.commit(p.id,approve(api,p),'browser-1');
  const source=envelope();source.task.id='account-b';source.digest=hash({task:source.task,orders:source.orders});
  p=api.create(source);p=api.save(p.id,{revision:p.revision,decisions:{account:'第二采购账号',rows:{[source.orders[0].id]:{refundCents:0,refundEvidence:'已核实'}}}});
  assert.equal(p.total.new,1);await api.commit(p.id,approve(api,p),'browser-1');assert.equal(store.list().length,2);
  store.db.prepare('INSERT INTO month_confirmations(month,platform,confirmed_at,snapshot_json) VALUES(?,?,?,?)').run('2026-10','淘宝',new Date().toISOString(),'{}');
  const locked=envelope('taobao',{id:'new-in-locked-month'});p=ready(api,locked);assert.equal(p.canConfirm,false);assert.match(p.rows[0].issues.join(' '),/锁定/);
  assert.throws(()=>api.review(p.id,p.revision,'browser-1'));assert.equal(store.list().length,2);
});

test('classification, attachments, manual note and multiple shipments survive a retained-order import',async t=>{
  const{api,store}=context(t);let p=ready(api);await api.commit(p.id,approve(api,p),'browser-1');
  let o=store.list()[0];o=store.update(o.id,{...o,note:'人工备注',classification:{mode:'split',owner:'company',parts:[{category:'goods',amountCents:12000,refundCents:0},{category:'expense',amountCents:345,refundCents:0}]},items:o.items.map((i,n)=>n?i:{...i,shipments:[{trackingNo:'one',logisticsCompany:'A'},{trackingNo:'two',logisticsCompany:'B'}]})});
  const source=envelope();source.task.id='preserve-manual';source.digest=hash({task:source.task,orders:source.orders});
  p=ready(api,source,{fields:{items:'keep'}});assert.equal(p.canConfirm,true,p.rows[0].issues.join());
  await api.commit(p.id,approve(api,p),'browser-1');
  const saved=store.get(o.id);assert.equal(saved.note,'人工备注');assert.equal(saved.items[0].shipments.length,2);assert.deepEqual(saved.classification,o.classification);
});

test('retry after failed transaction succeeds once; rollback refuses a later human edit',async t=>{
  let failOnce=true;const{api,store}=context(t,{afterWrite(){if(failOnce){failOnce=false;throw Error('simulated process failure');}}}),p=ready(api),receipt=approve(api,p);
  await assert.rejects(api.commit(p.id,receipt,'browser-1'));assert.equal(store.list().length,0);
  const result=await api.commit(p.id,receipt,'browser-1');assert.equal(result.verified,true);
  const o=store.list()[0];store.update(o.id,{...o,note:'后续人工修改'});
  assert.throws(()=>api.rollback(p.id,'test'),e=>e.code==='ROLLBACK_CONFLICT');assert.equal(store.get(o.id).note,'后续人工修改');
});

test('a second click while backup is running cannot create another batch',async t=>{
  const{api,store}=context(t),p=ready(api),receipt=approve(api,p),first=api.commit(p.id,receipt,'browser-1');
  await assert.rejects(api.commit(p.id,receipt,'browser-1'),e=>e.code==='IMPORT_BUSY');await first;assert.equal(store.list().length,1);
});

test('invalid dates produce row issues and postcommit conflict never reports verified',async t=>{
  const{api,store}=context(t,{afterCommit(){const o=store.list()[0];store.update(o.id,{...o,note:'concurrent edit'});}});
  const bad=envelope('jd',{createdAt:'invalid'});assert.equal(ready(api,bad).canConfirm,false);
  const p=ready(api);await assert.rejects(api.commit(p.id,approve(api,p),'browser-1'),e=>e.code==='ROLLBACK_CONFLICT');
  assert.equal(api.preview(p.id).result.verified,false);assert.equal(api.preview(p.id).result.recoveryRequired,true);
});

test('actual process exits before and after commit recover without a second booking',async t=>{
 for(const phase of ['afterWrite','afterCommit']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'transfer-crash-'));let store=openStore(dir),api=openOrderTransfers(store),p=ready(api),receipt=approve(api,p);store.close();
  const worker=path.join(dir,'worker.mjs');
  fs.writeFileSync(worker,`import {openStore} from ${JSON.stringify(pathToFileURL(path.resolve('lib/store.mjs')).href)};import {openOrderTransfers} from ${JSON.stringify(pathToFileURL(path.resolve('lib/order-transfer.mjs')).href)};const s=openStore(${JSON.stringify(dir)});const a=openOrderTransfers(s,{${phase}(){process.exit(73)}});await a.commit(${JSON.stringify(p.id)},${JSON.stringify(receipt)},'browser-1');`);
  assert.equal(spawnSync(process.execPath,[worker],{windowsHide:true,timeout:20000}).status,73);
  store=openStore(dir);api=openOrderTransfers(store);
  try{
   assert.equal(store.list().length,phase==='afterWrite'?0:1);
   if(phase==='afterWrite'){p=api.preview(p.id);receipt=approve(api,p);}
   const result=await api.commit(p.id,receipt,'browser-1');assert.equal(result.verified,true);assert.equal(result.postVerified,true);assert.equal(store.list().length,1);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
 }
});
