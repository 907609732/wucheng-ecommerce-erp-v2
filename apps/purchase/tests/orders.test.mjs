import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parse} from 'csv-parse/sync';
import {openStore} from '../lib/store.mjs';
import {readTable,normalizeTable,deliveryOf} from '../lib/importer.mjs';
import {createApp} from '../server.mjs';
import {filterOrders,sortOrders} from '../public/order-query.mjs';
const base=()=>({platform:'1688',account:'测试账号',orderNo:'TEST-001',date:'2026-01-31',paidAt:'2026-02-01',supplier:'测试供应商',amountCents:10001,refundCents:101,shippingCents:500,status:'已完成',note:'原备注',items:[{title:'配件',spec:'M5',sku:'',qty:2,unitPriceCents:4750}]});
const delivery={recipient:'测试收件人',address:'测试省测试市测试路 1 号',phone:'0013800000000',logisticsCompany:'测试快递',trackingNo:'00123456789012345678；SECOND-02'};
test('旧库补回收货物流：保留 ID、原始行、金额、备注、审计与修改时间，重复打开不改数据',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-migrate-'));let store=openStore(dir);
 try{
  const original={headers:['收货人姓名','收货地址','联系手机','物流公司','运单号'],rows:[{cells:[delivery.recipient,delivery.address,delivery.phone,delivery.logisticsCompany,'00123456789012345678']},{cells:[delivery.recipient,delivery.address,delivery.phone,delivery.logisticsCompany,'SECOND-02']}]};
  const o=store.insert(base(),null,original),before=store.db.prepare('SELECT * FROM orders').get(),audit=store.history(o.id);
  store.close();const db=new DatabaseSync(path.join(dir,'purchases.sqlite'));db.exec('ALTER TABLE orders DROP COLUMN delivery');db.close();store=openStore(dir);
  const after=store.db.prepare('SELECT * FROM orders').get();for(const key of Object.keys(before).filter(k=>!['delivery','fingerprint'].includes(k)))assert.equal(after[key],before[key],key);
  assert.deepEqual(deliveryOf(store.get(o.id)),delivery);assert.deepEqual(store.history(o.id),audit);
  store.close();store=openStore(dir);assert.deepEqual(store.db.prepare('SELECT * FROM orders').get(),after);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('导入保留文本手机和长运单号，同单多商品与多包裹去重合并',async()=>{
 const csv='订单编号,下单日期,供应商,商品名称,实付金额,订单状态,收货人姓名,收货地址,联系手机,物流公司,运单号\nA1,2026-01-31,测试供应商,配件一,100.01,交易成功,测试收件人,测试省测试市测试路 1 号,0013800000000,测试快递,00123456789012345678\nA1,2026-01-31,测试供应商,配件二,100.01,交易成功,测试收件人,测试省测试市测试路 1 号,0013800000000,测试快递,SECOND-02';
 const result=normalizeTable(await readTable(Buffer.from(csv),'shipping.csv'));
 assert.equal(result.orders.length,1);assert.equal(result.orders[0].items.length,2);assert.equal(result.orders[0].amountCents,10001);assert.deepEqual(deliveryOf(result.orders[0]),delivery);
});
test('组合筛选跨日期口径、金额、备注和运单信息，数值排序正确',()=>{
 const a={...base(),...delivery},b={...base(),orderNo:'TEST-002',amountCents:999,status:'已关闭',note:'',trackingNo:''},c={...base(),orderNo:'TEST-003',amountCents:20000,status:'待核对',note:'',refundCents:0,trackingNo:''};
 const all=[a,b,c];assert.deepEqual(filterOrders(all,{q:'0013800000000',month:'2026-02',minAmount:'100',maxAmount:'101',note:'yes',tracking:'yes',carrier:'测试快递'}),[a]);assert.equal(filterOrders(all,{month:'2026-02'},'created').length,0);assert.deepEqual(filterOrders(all,{preset:'effective'}),[a]);assert.deepEqual(filterOrders(all,{preset:'closed'}),[b]);assert.deepEqual(filterOrders(all,{preset:'review'}),[c]);assert.deepEqual(sortOrders(all,[{field:'amountCents',dir:'asc'}]).map(o=>o.amountCents),[999,10001,20000]);
});
test('快捷备注只改备注，保留物流、原始数据及金额；阻止旧版本覆盖；导出匹配筛选和排序',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-orders-api-'));const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const first=store.insert({...base(),...delivery},null);store.insert({...base(),...delivery,orderNo:'TEST-002',amountCents:20000},null);store.insert({...base(),orderNo:'TEST-003',platform:'淘宝'},null);
  const original=store.db.prepare('SELECT original FROM orders WHERE id=?').get(first.id).original;
  const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());const patch=body=>fetch(url+'/api/orders/'+first.id+'/note',{method:'PATCH',headers:{'content-type':'application/json','x-purchase-token':boot.token},body:JSON.stringify(body)});
  const res=await patch({note:'待补发\n核对发票 <b>不执行 HTML</b>',updatedAt:first.updatedAt,amountCents:1});assert.equal(res.status,200);const saved=await res.json();assert.equal(saved.amountCents,first.amountCents);assert.deepEqual(deliveryOf(saved),delivery);assert.match(saved.note,/待补发/);assert.equal(store.history(first.id).length,2);assert.equal(store.db.prepare('SELECT original FROM orders WHERE id=?').get(first.id).original,original);
  assert.equal((await patch({note:'过期版本',updatedAt:first.updatedAt})).status,400);assert.match(store.get(first.id).note,/待补发/);
  const qs=new URLSearchParams({platform:'1688',tracking:'yes',sorters:JSON.stringify([{field:'amountCents',dir:'desc'}])});const csv=await fetch(url+'/api/export?'+qs).then(r=>r.text());const rows=parse(csv,{columns:true,bom:true});assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r['订单编号']),['TEST-002','TEST-001']);assert.equal(rows[1]['收货人姓名'],delivery.recipient);assert.equal(rows[1]['联系手机'],delivery.phone);assert.equal(rows[1]['运单号'],delivery.trackingNo);assert.equal(rows[1]['备注'],saved.note);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
