import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {openStore} from '../lib/store.mjs';
import {validateOrder,fingerprint,deliveryOf} from '../lib/importer.mjs';
import {reviewImportOrders} from '../lib/import-review.mjs';

const base=()=>({platform:'1688',account:'默认账号',orderNo:'FP-001',date:'2026-03-05',paidAt:'2026-03-06',supplier:'指纹测试店',amountCents:12345,refundCents:0,shippingCents:0,status:'已完成',note:'',items:[{title:'锁芯',spec:'A级',sku:'',qty:2,unitPriceCents:6000,unit:'个'}]});
// v5 旧算法复刻：商品行只含六个字段，不含运单号 / 物流公司。
const legacyFingerprint=o=>createHash('sha256').update(JSON.stringify({platform:o.platform,account:o.account,orderNo:o.orderNo,date:o.date,paidAt:o.paidAt||'',supplier:o.supplier,amountCents:o.amountCents,refundCents:o.refundCents||0,shippingCents:o.shippingCents||0,status:o.status,note:o.note||'',...deliveryOf(o),items:o.items.map(({title,spec,sku,qty,unitPriceCents,unit})=>({title,spec,sku,qty,unitPriceCents,unit:String(unit??'').trim()}))})).digest('hex');
const reviewed=(orders,store)=>reviewImportOrders(orders.map(o=>({...o,errors:[]})),store);

test('v6 指纹迁移：旧账本升级后重算指纹，同一原文件重导入仍判重复不判冲突',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-fp-'));
 let store=openStore(dir);
 try{
  const order=store.transaction(()=>store.insert(base(),null));
  // 新入库的商品行默认带空运单号 / 物流公司。
  assert.equal(order.items[0].trackingNo,'');assert.equal(order.items[0].logisticsCompany,'');
  // 模拟 v5 旧账本：指纹改回旧算法，版本号回到 5。
  const legacy=legacyFingerprint(order);
  assert.notEqual(legacy,order.fingerprint);
  store.db.prepare('UPDATE orders SET fingerprint=?').run(legacy);
  store.db.exec('PRAGMA user_version=5');
  // 迁移前：同一订单重导入会被误判为冲突。
  assert.equal(reviewed([validateOrder(base())],store)[0].importStatus,'conflict');
  store.close();
  // 重新打开触发 v6 迁移：指纹按新算法重算。
  store=openStore(dir);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,6);
  const saved=store.get(order.id);
  assert.equal(saved.fingerprint,fingerprint(saved));
  assert.equal(reviewed([validateOrder(base())],store)[0].importStatus,'duplicate');
  // 幂等：再次打开不改变指纹与版本。
  const once=saved.fingerprint;
  store.close();store=openStore(dir);
  assert.equal(store.get(order.id).fingerprint,once);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,6);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('商品行运单号参与指纹：仅运单号不同的两笔订单指纹不同',()=>{
 const a=validateOrder(base()),b=validateOrder({...base(),items:[{...base().items[0],trackingNo:'SF1234567890123'}]});
 assert.notEqual(fingerprint(a),fingerprint(b));
 assert.equal(fingerprint(validateOrder({...base(),items:[{...base().items[0],trackingNo:''}]})),fingerprint(a));
 assert.equal(validateOrder({...base(),items:[{...base().items[0],trackingNo:'  SF123  '}]}).items[0].trackingNo,'SF123');
});

test('v5 含已锁定月份也能升级：原订单、日志和确认记录不变，兼容指纹幂等',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-fp-lock-'));let store=openStore(dir);
 try{
  const o=store.insert(base());store.db.prepare('UPDATE orders SET fingerprint=? WHERE id=?').run(legacyFingerprint(o),o.id);store.db.exec('PRAGMA user_version=5');
  const password=randomUUID();await store.monthLocks.setPassword({password,confirmation:password});store.monthLocks.confirm(store.monthLocks.preview('2026-03','1688'));
  const before=store.db.prepare('SELECT * FROM orders').all(),audit=store.history(o.id),locks=store.monthLocks.confirmations();store.close();store=openStore(dir);
  assert.deepEqual(store.db.prepare('SELECT * FROM orders').all(),before);assert.deepEqual(store.history(o.id),audit);assert.deepEqual(store.monthLocks.confirmations(),locks);
  assert.equal(reviewed([validateOrder(base())],store)[0].importStatus,'duplicate');
  assert.throws(()=>store.update(o.id,{...store.get(o.id),note:'越过锁定'}),e=>e.code==='MONTH_LOCKED');
  const compat=store.db.prepare('SELECT * FROM order_fingerprint_compat').all();store.close();store=openStore(dir);assert.deepEqual(store.db.prepare('SELECT * FROM order_fingerprint_compat').all(),compat);assert.deepEqual(store.db.prepare('SELECT * FROM orders').all(),before);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
