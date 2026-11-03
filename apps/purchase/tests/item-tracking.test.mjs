import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateOrder} from '../lib/importer.mjs';
import {filterOrders,orderTracking,orderCarrier,hasTracking} from '../public/order-query.mjs';
import {createApp} from '../server.mjs';

const base=()=>({platform:'手工',account:'默认账号',orderNo:'TRK-001',date:'2026-10-01',paidAt:'2026-10-02',supplier:'运单测试店',amountCents:10000,refundCents:0,shippingCents:0,status:'已完成',note:'',items:[{title:'门锁',spec:'',sku:'',qty:1,unitPriceCents:10000,unit:'把'}]});

test('商品行运单号与物流公司归一及上限',()=>{
 const o=validateOrder({...base(),items:[{...base().items[0],trackingNo:'  SF123  ',logisticsCompany:' 顺丰速运 '}]});
 assert.equal(o.items[0].trackingNo,'SF123');assert.equal(o.items[0].logisticsCompany,'顺丰速运');
 assert.equal(validateOrder(base()).items[0].trackingNo,'');
 assert.throws(()=>validateOrder({...base(),items:[{...base().items[0],trackingNo:'x'.repeat(101)}]}),/商品运单号最多 100 字/);
 assert.throws(()=>validateOrder({...base(),items:[{...base().items[0],logisticsCompany:'x'.repeat(201)}]}),/商品物流公司最多 200 字/);
});

test('运单号 / 物流公司展示与筛选同时覆盖订单级与商品行',()=>{
 const orderLevel=validateOrder({...base(),trackingNo:'SF111',logisticsCompany:'顺丰速运'});
 const itemLevel=validateOrder({...base(),items:[{...base().items[0],trackingNo:'ZT222',logisticsCompany:'中通快递'}]});
 const none=validateOrder(base());
 assert.equal(orderTracking(orderLevel),'SF111');assert.equal(orderCarrier(orderLevel),'顺丰速运');
 assert.equal(orderTracking(itemLevel),'ZT222');assert.equal(orderCarrier(itemLevel),'中通快递');
 assert.equal(hasTracking(orderLevel),true);assert.equal(hasTracking(none),false);
 const list=[orderLevel,itemLevel,none];
 assert.equal(filterOrders(list,{tracking:'yes'},'paid').length,2);
 assert.deepEqual(filterOrders(list,{tracking:'no'}).map(o=>o.orderNo),['TRK-001']);
 assert.equal(filterOrders(list,{carrier:'中通快递'}).length,1);
 assert.equal(filterOrders(list,{carrier:'顺丰速运'}).length,1);
 assert.equal(filterOrders(list,{q:'zt222'}).length,1);
 assert.equal(filterOrders(list,{q:'sf111'}).length,1);
});

test('商品行运单号经接口保存、编辑保留并出现在导出中',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-trk-'));
 const {app,store}=createApp({dataDir:dir});
 const server=app.listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());
  assert.equal((await fetch(url+'/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(base())})).status,403);
  const request=async(p,b)=>{const r=await fetch(url+p,{method:'POST',headers:{'x-purchase-token':boot.token,...(b instanceof FormData?{}:{'content-type':'application/json'})},body:b instanceof FormData?b:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw Error(j.error);return j;};
  await request('/api/orders',{...base(),items:[
   {title:'门锁',spec:'',sku:'',qty:1,unitPriceCents:5000,unit:'把',trackingNo:'SF1234567890123',logisticsCompany:'顺丰速运'},
   {title:'钥匙胚',spec:'',sku:'',qty:2,unitPriceCents:2500,unit:'个',trackingNo:'ZT789456123',logisticsCompany:'中通快递'}]});
  const saved=store.find(base());
  assert.equal(saved.items.length,2);
  assert.equal(saved.items[0].trackingNo,'SF1234567890123');
  assert.equal(saved.items[1].logisticsCompany,'中通快递');
  const updated=await fetch(url+'/api/orders/'+saved.id,{method:'PUT',headers:{'x-purchase-token':boot.token,'content-type':'application/json'},body:JSON.stringify({...saved,note:'补备注',updatedAt:saved.updatedAt})}).then(r=>r.json());
  assert.equal(updated.items[0].trackingNo,'SF1234567890123');
  assert.equal(updated.items[1].trackingNo,'ZT789456123');
  const csv=await fetch(url+'/api/export').then(r=>r.text());
  assert.match(csv,/商品行运单号/);assert.match(csv,/商品行物流公司/);
  assert.match(csv,/SF1234567890123/);assert.match(csv,/ZT789456123/);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
