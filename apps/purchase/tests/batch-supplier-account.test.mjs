import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
import {attributePatch} from '../public/order-attributes.mjs';

const base=(orderNo='SUP-1',extra={})=>({platform:'微信',account:'账号甲',orderNo,date:'2026-07-01',paidAt:'2026-07-02',supplier:'老供应商',status:'已完成',amountCents:50000,refundCents:0,shippingCents:0,note:'保留备注',items:[{title:'配件',qty:1,unit:'个',unitPriceCents:50000}],...extra});
const refs=orders=>orders.map(({id,updatedAt})=>({id,updatedAt}));
const audit=store=>store.db.prepare('SELECT * FROM audit ORDER BY id').all();

test('attributePatch 只允许供应商 / 账号等既定键，拒绝空值与超长',()=>{
 assert.deepEqual(attributePatch({supplier:'新供应商'}),{supplier:'新供应商'});
 assert.deepEqual(attributePatch({account:'新账号'}),{account:'新账号'});
 for(const bad of [{},{supplier:'  '},{account:''},{supplier:'x'.repeat(201)},{account:'x'.repeat(201)},{amountCents:1},{note:'x'}])assert.throws(()=>attributePatch(bad));
});

test('批量修改供应商：同批审计、指纹更新、其他字段不动',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-sup-'));const store=openStore(dir);
 try{
  const a=store.insert(base()),b=store.insert(base('SUP-2',{supplier:'另一家'})),before=store.list();
  const r=store.attributesBatch({orders:refs(before),patch:{supplier:'统一供应商'}});
  assert.equal(r.changed,2);assert.equal(r.skipped.length,0);
  for(const old of before){
   const o=store.get(old.id);
   assert.equal(o.supplier,'统一供应商');assert.equal(o.account,old.account);
   assert.equal(o.note,old.note);assert.deepEqual(o.items,old.items);assert.equal(o.amountCents,old.amountCents);
   assert.notEqual(o.fingerprint,old.fingerprint);
   const h=store.history(o.id)[0];assert.equal(h.batch_id,r.batchId);assert.equal(h.action,'attributes');
   assert.equal(JSON.parse(h.before_json).supplier,old.supplier);assert.equal(JSON.parse(h.after_json).supplier,'统一供应商');
  }
  // 二次保存无变化不写历史。
  const history=audit(store);assert.equal(store.attributesBatch({orders:refs(store.list()),patch:{supplier:'统一供应商'}}).changed,0);assert.deepEqual(audit(store),history);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('批量修改采购账号：唯一键冲突列出订单，整批回滚',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-acc-'));const store=openStore(dir);
 try{
  // 同订单号不同账号可共存（唯一键含账号）；改账号撞车时跳过撞车那笔。
  store.insert(base('SAME-1',{account:'账号甲'}));
  const clash=store.insert(base('SAME-1',{account:'账号乙',supplier:'乙家'}));
  const fine=store.insert(base('SAME-2',{account:'账号乙',supplier:'丙家'}));
  const before=store.list(),logs=audit(store);
  assert.throws(()=>store.attributesBatch({orders:refs([fine,clash]),patch:{account:'账号甲'}}),e=>e.status===409&&e.code==='ORDER_IDENTITY_CONFLICT'&&e.conflicts.some(c=>c.id===clash.id));
  assert.deepEqual(store.list(),before);assert.deepEqual(audit(store),logs);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('HTTP：批量改供应商 / 账号贯通，锁定月份 423，无 token 403',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-sup-api-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(url+'/api/bootstrap').then(r=>r.json()),headers={'x-purchase-token':token,'content-type':'application/json'};
  const call=(route,body,method='POST')=>fetch(url+route,{method,headers,body:JSON.stringify(body)}).then(async r=>{const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error),{status:r.status,code:j.code});return j;});
  const o=store.insert(base('HTTP-1'));
  assert.equal((await fetch(url+'/api/orders/attributes/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orders:refs([o]),patch:{supplier:'X'}})})).status,403);
  assert.equal((await call('/api/orders/attributes/batch',{orders:refs([o]),patch:{supplier:'HTTP 新供应商'}})).changed,1);
  assert.equal(store.get(o.id).supplier,'HTTP 新供应商');
  assert.equal((await call('/api/orders/attributes/batch',{orders:refs([store.get(o.id)]),patch:{account:'HTTP 新账号'}})).changed,1);
  assert.equal(store.get(o.id).account,'HTTP 新账号');
  // 锁定月份后批量修改被拒，订单保持原值。
  const password=randomUUID();await store.monthLocks.setPassword({password,confirmation:password});store.monthLocks.confirm(store.monthLocks.preview('2026-07','微信'));
  await assert.rejects(()=>call('/api/orders/attributes/batch',{orders:refs([store.get(o.id)]),patch:{supplier:'再改'}}),e=>e.status===423&&e.code==='MONTH_LOCKED');
  assert.equal(store.get(o.id).supplier,'HTTP 新供应商');
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
