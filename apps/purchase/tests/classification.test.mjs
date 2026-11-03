import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parse} from 'csv-parse/sync';
import {openStore,summarize} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
import {filterOrders} from '../public/order-query.mjs';
import {normalizeClassification,classificationTotals,contribution} from '../public/classification.mjs';
const base=(orderNo='C-001')=>({platform:'微信',account:'测试账号',orderNo,date:'2026-10-01',paidAt:'2026-10-02',supplier:'分类测试供应商',status:'已完成',amountCents:100000,refundCents:15000,shippingCents:500,note:'',items:[{title:'商品与服务',qty:1,unitPriceCents:99500,unit:'批'}]});
const split=()=>({mode:'split',owner:'company',parts:[{category:'goods',amountCents:70000,refundCents:10000},{category:'expense',amountCents:30000,refundCents:0}]});
const single=category=>({mode:'single',category,owner:'company'});
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-classification-'));return {dir,store:openStore(dir)};}

test('分类迁移仅增加字段与审计，保留全部原列、附件引用和历史；重复启动不重复初始化',()=>{
 const {dir,store:initial}=fixture();let store=initial;
 try{
  const o=store.insert(base(),null,{source:'原始单据',rows:[{amount:'1000.00'}]});
  store.close();const db=new DatabaseSync(path.join(dir,'purchases.sqlite'));
  db.exec('ALTER TABLE orders DROP COLUMN classification; DROP INDEX IF EXISTS audit_batch_id; ALTER TABLE audit DROP COLUMN batch_id; PRAGMA user_version=4;');
  const before=db.prepare('SELECT * FROM orders').get(),oldHistory=db.prepare('SELECT * FROM audit').all();db.close();
  store=openStore(dir);const after=store.db.prepare('SELECT * FROM orders').get();
  for(const [key,value] of Object.entries(before))assert.equal(after[key],value,key);
  assert.deepEqual(store.get(o.id).classification,single('goods'));const history=store.history(o.id);assert.equal(history.length,oldHistory.length+1);assert.equal(history[0].action,'initialize-classification');assert.ok(history[0].batch_id);
  assert.equal(JSON.parse(history[0].before_json).classification,undefined);assert.deepEqual(JSON.parse(history[0].after_json).classification,single('goods'));
  store.close();store=openStore(dir);assert.deepEqual(store.history(o.id),history);assert.deepEqual(store.db.prepare('SELECT * FROM orders').get(),after);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('混合金额和退款严格核对，允许待分配退款，防止重复类别、超额、非整数分和隐含归属',()=>{
 assert.deepEqual(normalizeClassification(split(),100000,15000),split());
 for(const bad of [
  {...split(),parts:[{category:'goods',amountCents:70000,refundCents:0},{category:'goods',amountCents:30000,refundCents:0}]},
  {...split(),parts:[{category:'goods',amountCents:70001,refundCents:0},{category:'expense',amountCents:30000,refundCents:0}]},
  {...split(),parts:[{category:'goods',amountCents:70000,refundCents:70001},{category:'expense',amountCents:30000,refundCents:0}]},
  {...split(),parts:[{category:'goods',amountCents:70000,refundCents:15001},{category:'expense',amountCents:30000,refundCents:0}]},
  {...split(),parts:[{category:'goods',amountCents:70000.5,refundCents:0},{category:'expense',amountCents:29999.5,refundCents:0}]},
  {...split(),owner:'shop'},single('unknown'),null
 ])assert.throws(()=>normalizeClassification(bad,100000,15000));
});

test('编辑兼容保留分类，实付变动必须重新拆分，单类退款自动跟随；审计保存批次与前后值',()=>{
 const {dir,store}=fixture();try{
  let o=store.insert(base());const original=store.db.prepare('SELECT original FROM orders WHERE id=?').get(o.id).original,fp=o.fingerprint;
  o=store.classify(o.id,{updatedAt:o.updatedAt,classification:split()});assert.equal(o.fingerprint,fp);assert.equal(store.history(o.id)[0].action,'classification');assert.ok(store.history(o.id)[0].batch_id);
  const {classification,...legacy}=o;o=store.update(o.id,{...legacy,note:'旧接口修改备注'});assert.deepEqual(o.classification,split());
  assert.throws(()=>store.update(o.id,{...o,amountCents:99999}),/重新核对/);assert.equal(store.get(o.id).amountCents,100000);
  assert.throws(()=>store.update(o.id,{...o,refundCents:9000}),/重新核对/);assert.equal(store.get(o.id).refundCents,15000);
  o=store.update(o.id,{...o,amountCents:120000,classification:{...split(),parts:[{category:'goods',amountCents:90000,refundCents:10000},{category:'expense',amountCents:30000,refundCents:0}]}});assert.equal(o.amountCents,120000);
  o=store.classify(o.id,{updatedAt:o.updatedAt,classification:single('fixed_asset')});assert.deepEqual(contribution(o,'fixed_asset'),{amountCents:120000,refundCents:15000,netCents:105000});
  assert.equal(store.db.prepare('SELECT original FROM orders WHERE id=?').get(o.id).original,original);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('批量版本冲突、无效目标、重复 ID 整批回滚，包括审计；成功批次 ID 一致并持久化',()=>{
 const {dir,store:initial}=fixture();let store=initial;try{
  const a=store.insert(base()),b=store.insert(base('C-002'));const old=store.list(),auditCount=store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const entries=[{id:a.id,updatedAt:a.updatedAt},{id:b.id,updatedAt:'过期'}];
  assert.throws(()=>store.classifyBatch({category:'expense',orders:entries}),/已被修改/);assert.deepEqual(store.list(),old);assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n,auditCount);
  assert.throws(()=>store.classifyBatch({category:'expense',orders:[entries[0],entries[0]]}),/重复/);
  assert.throws(()=>store.classifyBatch({category:'split',orders:[entries[0]]}),/有效/);
  const result=store.classifyBatch({category:'expense',orders:old.map(o=>({id:o.id,updatedAt:o.updatedAt}))});assert.equal(result.orders.length,2);
  for(const o of result.orders){assert.equal(store.history(o.id)[0].batch_id,result.batchId);assert.deepEqual(o.classification,single('expense'));}
  store.close();store=openStore(dir);assert.deepEqual(store.list(),result.orders);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('分类报表在筛选、退款待分配、排除状态和跨月口径下能核回原总额，运费不重复',()=>{
 const a={...base(),classification:split()},b={...base('C-002'),amountCents:20000,refundCents:2000,classification:single('fixed_asset')},c={...base('C-003'),status:'待核对',classification:single('expense')},all=[a,b,c];
 const s=summarize(all,2026);assert.equal(s.amountCents,120000);assert.equal(s.refundCents,17000);assert.equal(s.netCents,103000);assert.equal(s.unallocatedRefundCents,5000);assert.equal(s.categories.reduce((n,c)=>n+c.netCents,0)-s.unallocatedRefundCents,s.netCents);assert.equal(s.categories.reduce((n,c)=>n+c.amountCents,0),s.amountCents);assert.equal(s.excludedCount,1);
 assert.deepEqual(filterOrders(all,{category:'expense'}),[a,c]);const expense=summarize(all,2026,'paid','全部','expense');assert.equal(expense.amountCents,30000);assert.equal(expense.refundCents,0);assert.equal(expense.months[9].netCents,30000);assert.equal(expense.categories.reduce((n,c)=>n+c.netCents,0),30000);
 const totals=classificationTotals([a,b]);assert.deepEqual(totals.categories.map(c=>c.netCents),[60000,18000,30000]);
});

test('接口分类、整单与分类明细导出、旧接口以及原表重新导入去重贯通',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-classification-api-')), {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const boot=await fetch(url+'/api/bootstrap').then(r=>r.json()),headers={'x-purchase-token':boot.token,'content-type':'application/json'};
  const call=(route,body,method='POST')=>fetch(url+route,{method,headers,body:JSON.stringify(body)});
  const csv='订单编号,下单日期,付款日期,供应商,商品名称,数量,实付金额,已退款金额,运费,订单状态\nIMPORT-C1,2026-10-01,2026-10-02,测试店,商品,1,1000.00,150.00,5.00,已完成';
  const preview=async()=>{const f=new FormData();f.append('platform','微信');f.append('file',new Blob([csv]),'class.csv');return fetch(url+'/api/import/preview',{method:'POST',headers:{'x-purchase-token':boot.token},body:f}).then(r=>r.json());};
  const first=await preview();assert.equal(first.summary.valid,1);assert.equal((await call('/api/import/'+first.id+'/commit',{indices:[0]})).status,200);
  let o=store.list()[0];const fp=o.fingerprint;
  assert.equal((await call('/api/orders/'+o.id+'/classification',{updatedAt:o.updatedAt,classification:split()},'PATCH')).status,200);o=store.get(o.id);assert.equal(o.fingerprint,fp);
  assert.equal((await preview()).summary.duplicates,1);assert.deepEqual(store.get(o.id).classification,split());
  const list=await fetch(url+'/api/orders?category=expense').then(r=>r.json());assert.equal(list.length,1);assert.deepEqual(list[0].classification,split());assert.deepEqual((await fetch(url+'/api/orders/'+o.id).then(r=>r.json())).classification,split());
  const orderRows=parse(await fetch(url+'/api/export?category=expense').then(r=>r.text()),{columns:true,bom:true});assert.equal(orderRows.length,1);assert.equal(orderRows[0]['实付金额'],'1000.00');assert.equal(orderRows[0]['采购类别'],'混合');assert.equal(orderRows[0]['筛选类别实付'],'300.00');
  const parts=parse(await fetch(url+'/api/classification-export').then(r=>r.text()),{columns:true,bom:true});assert.equal(parts.length,3);assert.equal(parts.reduce((s,p)=>s+Number(p['分类实付']),0),1000);assert.equal(parts.reduce((s,p)=>s+Number(p['净支出调整']),0),850);
  const filtered=parse(await fetch(url+'/api/classification-export?category=expense').then(r=>r.text()),{columns:true,bom:true});assert.equal(filtered.length,1);assert.equal(filtered[0]['分类实付'],'300.00');
  assert.equal((await call('/api/orders/classification/batch',{category:'fixed_asset',orders:[{id:o.id,updatedAt:'旧版本'}]})).status,400);
  const change=await call('/api/orders/classification/batch',{category:'fixed_asset',orders:[{id:o.id,updatedAt:o.updatedAt}]});assert.equal(change.status,200);assert.ok((await change.json()).batchId);
  o=store.get(o.id);const {classification,...legacy}=o;assert.equal((await call('/api/orders/'+o.id,{...legacy,note:'兼容编辑'},'PUT')).status,200);assert.equal(store.get(o.id).classification.category,'fixed_asset');
  assert.equal((await call('/api/orders',{...base('NEW-FIXED'),classification:single('fixed_asset')})).status,200);assert.equal(store.find(base('NEW-FIXED')).classification.category,'fixed_asset');
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
