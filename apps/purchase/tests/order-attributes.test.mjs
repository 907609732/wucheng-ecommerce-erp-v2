import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {parse} from 'csv-parse/sync';
import {openStore,summarize} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
import {filterOrders} from '../public/order-query.mjs';

const base=(orderNo='ATTR-1',extra={})=>({platform:'微信',account:'属性测试',orderNo,date:'2026-05-01',paidAt:'2026-05-02',supplier:'隔离测试供应商',status:'已完成',amountCents:100000,refundCents:15000,shippingCents:500,note:'保留原备注',items:[{title:'商品与服务',qty:1,unit:'批',unitPriceCents:99500}],...extra});
const refs=orders=>orders.map(({id,updatedAt})=>({id,updatedAt}));
const fixture=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-attributes-'));return {dir,store:openStore(dir)};};
const setup=async store=>{const password=randomUUID();await store.monthLocks.setPassword({password,confirmation:password});};
const audit=store=>store.db.prepare('SELECT * FROM audit ORDER BY id').all();

test('升级只添加默认字段，保留已确认月份、原始数据与审计，重复启动幂等',async()=>{
 const {dir,store:initial}=fixture();let store=initial;
 try{
  store.insert(base(),null,{proof:'原凭证',image:'原图片链接'});await setup(store);store.monthLocks.confirm(store.monthLocks.preview('2026-05','微信'));
  const history=audit(store),locks=store.monthLocks.confirmations();store.close();
  const legacy=new DatabaseSync(path.join(dir,'purchases.sqlite'));legacy.exec('ALTER TABLE orders DROP COLUMN excluded_from_spend');const before=legacy.prepare('SELECT * FROM orders').get();legacy.close();
  store=openStore(dir);const after=store.db.prepare('SELECT * FROM orders').get();
  for(const [k,v] of Object.entries(before))assert.equal(after[k],v,k);
  assert.equal(after.excluded_from_spend,0);assert.equal(store.list()[0].excludedFromSpend,false);assert.deepEqual(audit(store),history);assert.deepEqual(store.monthLocks.confirmations(),locks);
  store.close();store=openStore(dir);assert.deepEqual(store.db.prepare('SELECT * FROM orders').get(),after);assert.deepEqual(audit(store),history);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('批量排除、恢复和关闭相互独立，原始数据不变；同批审计完整、无效重复保存不写历史',()=>{
 const {dir,store:initial}=fixture();let store=initial;
 try{
  const a=store.insert(base()),b=store.insert(base('ATTR-2',{status:'已关闭'})),before=store.list(),original=store.db.prepare('SELECT id,original FROM orders ORDER BY id').all();
  const excluded=store.attributesBatch({orders:refs(before),patch:{excludedFromSpend:true}});assert.equal(excluded.changed,2);
  for(const old of before){const o=store.get(old.id);assert.equal(o.status,old.status);assert.equal(o.fingerprint,old.fingerprint);assert.deepEqual(o.items,old.items);assert.deepEqual(o.classification,old.classification);assert.equal(o.note,old.note);assert.equal(o.amountCents,old.amountCents);const h=store.history(o.id)[0];assert.equal(h.batch_id,excluded.batchId);assert.equal(JSON.parse(h.before_json).excludedFromSpend,false);assert.equal(JSON.parse(h.after_json).excludedFromSpend,true);}
  const history=audit(store);assert.equal(store.attributesBatch({orders:refs(store.list()),patch:{excludedFromSpend:true}}).changed,0);assert.deepEqual(audit(store),history);
  store.close();store=openStore(dir);assert.ok(store.list().every(o=>o.excludedFromSpend));assert.equal(summarize(store.list(),2026).netCents,0);
  store.attributesBatch({orders:refs(store.list()),patch:{excludedFromSpend:false}});assert.equal(summarize(store.list(),2026).netCents,85000);assert.equal(store.get(b.id).status,'已关闭');
  store.attributesBatch({orders:refs([store.get(a.id)]),patch:{status:'已关闭'}});assert.equal(summarize(store.list(),2026).netCents,0);assert.equal(store.get(a.id).excludedFromSpend,false);
  assert.deepEqual(store.db.prepare('SELECT id,original FROM orders ORDER BY id').all(),original);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('过期版本、无效属性、重复ID及保存中途失败均整批回滚，包括审计',()=>{
 const {dir,store}=fixture();try{
  const a=store.insert(base()),b=store.insert(base('ATTR-2')),orders=refs([a,b]),before=store.list(),history=audit(store);
  for(const patch of [{},{status:'无效'},{excludedFromSpend:'true'},{excludedFromSpend:null},{amountCents:0},{note:'不是批量属性'}])assert.throws(()=>store.attributesBatch({orders,patch}));
  assert.throws(()=>store.attributesBatch({orders:[orders[0],orders[0]],patch:{excludedFromSpend:true}}),/重复/);
  assert.throws(()=>store.attributesBatch({orders:[orders[0],{...orders[1],updatedAt:'旧版本'}],patch:{excludedFromSpend:true}}),e=>e.code==='ORDER_VERSION_CONFLICT');
  assert.throws(()=>store.attributesBatch({orders:[orders[0],{id:'不存在',updatedAt:b.updatedAt}],patch:{status:'已关闭'}}),/不存在/);
  store.db.exec("CREATE TRIGGER test_attribute_failure BEFORE UPDATE ON orders WHEN NEW.order_no='ATTR-2' BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
  assert.throws(()=>store.attributesBatch({orders,patch:{excludedFromSpend:true}}),/simulated failure/);
  assert.deepEqual(store.list(),before);assert.deepEqual(audit(store),history);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('锁定订单禁止批量或旧编辑接口改变计入选项，混选时其他月份也不保存',async()=>{
 const {dir,store}=fixture();try{
  const locked=store.insert(base()),open=store.insert(base('ATTR-2',{paidAt:'2026-06-01'}));await setup(store);store.monthLocks.confirm(store.monthLocks.preview('2026-05','微信'));
  const before=store.list(),history=audit(store);
  assert.throws(()=>store.attributesBatch({orders:refs([open,locked]),patch:{status:'已关闭',excludedFromSpend:true}}),e=>e.code==='MONTH_LOCKED');
  assert.throws(()=>store.update(locked.id,{...locked,excludedFromSpend:true}),e=>e.code==='MONTH_LOCKED');assert.deepEqual(store.list(),before);assert.deepEqual(audit(store),history);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('排除混合订单后分类、待分配退款、月度及筛选均一致，恢复能核对回原净额',()=>{
 const {dir,store}=fixture();try{
  const mixed=store.insert(base('MIX',{classification:{mode:'split',owner:'company',parts:[{category:'goods',amountCents:70000,refundCents:10000},{category:'expense',amountCents:30000,refundCents:0}]}}));
  const other=store.insert(base('OTHER',{amountCents:20000,refundCents:0}));
  store.attributesBatch({orders:refs([mixed]),patch:{excludedFromSpend:true}});let all=store.list(),s=summarize(all,2026);
  assert.equal(s.netCents,20000);assert.equal(s.unallocatedRefundCents,0);assert.equal(s.months[4].count,1);assert.deepEqual(filterOrders(all,{preset:'effective'}).map(o=>o.id),[other.id]);assert.deepEqual(filterOrders(all,{preset:'excluded'}).map(o=>o.id),[mixed.id]);assert.equal(filterOrders(all,{spend:'excluded'}).length,1);assert.equal(summarize(all,2026,'paid','全部','expense').netCents,0);
  store.attributesBatch({orders:refs([store.get(mixed.id)]),patch:{excludedFromSpend:false}});s=summarize(store.list(),2026);assert.equal(s.netCents,105000);assert.equal(s.unallocatedRefundCents,5000);assert.equal(s.categories.reduce((n,c)=>n+c.netCents,0)-s.unallocatedRefundCents,s.netCents);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('真实HTTP导入去重、批量保存、筛选、旧编辑、导出和月份锁定贯通',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-attributes-api-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(url+'/api/bootstrap').then(r=>r.json()),headers={'x-purchase-token':token,'content-type':'application/json'};
  const call=(route,body,method='POST')=>fetch(url+route,{method,headers,body:JSON.stringify(body)}),get=route=>fetch(url+route).then(r=>r.json()),rows=async route=>parse(await fetch(url+route).then(r=>r.text()),{columns:true,bom:true});
  const csv='订单编号,下单日期,付款日期,供应商,商品名称,数量,实付金额,已退款金额,订单状态\nIMPORT-A1,2026-05-01,2026-05-02,测试店,商品,1,1000.00,150.00,已完成';
  const preview=()=>{const f=new FormData();f.append('platform','微信');f.append('file',new Blob([csv]),'attributes.csv');return fetch(url+'/api/import/preview',{method:'POST',headers:{'x-purchase-token':token},body:f}).then(r=>r.json());};
  const first=await preview();assert.equal(first.summary.valid,1);assert.equal((await call('/api/import/'+first.id+'/commit',{indices:[0]})).status,200);let o=store.list()[0];
  const batch=patch=>call('/api/orders/attributes/batch',{orders:refs([o]),patch});
  assert.equal((await fetch(url+'/api/orders/attributes/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orders:refs([o]),patch:{excludedFromSpend:true}})})).status,403);
  assert.equal((await batch({excludedFromSpend:true})).status,200);assert.equal((await batch({status:'已关闭'})).status,409);o=store.get(o.id);
  assert.equal((await preview()).summary.duplicates,1);assert.equal((await get('/api/orders?preset=effective')).length,0);assert.equal((await get('/api/orders?spend=excluded')).length,1);assert.equal((await get('/api/dashboard?year=2026')).netCents,0);
  const orderRows=await rows('/api/export'),parts=await rows('/api/classification-export'),months=await rows('/api/monthly-export?year=2026');
  assert.equal(orderRows[0]['实付金额'],'1000.00');assert.equal(orderRows[0]['计入看板'],'否');assert.equal(orderRows[0]['支出统计设置'],'不计入');assert.equal(orderRows[0]['计入采购净支出'],'0.00');assert.equal(parts[0]['计入采购净支出'],'0.00');assert.equal(months[4]['净采购支出'],'0.00');
  const {excludedFromSpend,...legacy}=o;assert.equal((await call('/api/orders/'+o.id,{...legacy,note:'旧接口仍保留排除标记'},'PUT')).status,200);o=store.get(o.id);assert.equal(o.excludedFromSpend,true);
  assert.equal((await batch({excludedFromSpend:false,status:'待收货'})).status,200);o=store.get(o.id);assert.equal((await get('/api/dashboard?year=2026')).netCents,85000);assert.equal((await rows('/api/export'))[0]['计入采购净支出'],'850.00');
  await setup(store);store.monthLocks.confirm(store.monthLocks.preview('2026-05','微信'));assert.equal((await batch({excludedFromSpend:true})).status,423);assert.equal(store.get(o.id).excludedFromSpend,false);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
