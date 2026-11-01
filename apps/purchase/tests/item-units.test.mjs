import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'csv-parse/sync';
import {readTable,normalizeTable,validateOrder,backfillItemUnits,extractText} from '../lib/importer.mjs';
import {openStore} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
const order=()=>({platform:'1688',account:'默认账号',orderNo:'UNIT-TEST',date:'2026-10-13',paidAt:'2026-10-13',supplier:'单位测试',amountCents:1400,refundCents:0,shippingCents:100,status:'已完成',note:'保留备注',items:[{title:'门把手',spec:'黑色',sku:'A',qty:2,unitPriceCents:500},{title:'螺丝',spec:'M5',sku:'B',qty:3,unitPriceCents:100}]});
test('逐项导入单价、数量、单位，金额仍按整单去重；文字提取仅使用明确单位',async()=>{
 const csv='订单编号,下单日期,供应商,商品名称,单价(元),数量,单位,实付金额,订单状态\nU1,2026-10-13,测试店,门把手,5.00,2,把,14.00,交易成功\nU1,2026-10-13,测试店,螺丝,1.00,3,件,14.00,交易成功\nU1,2026-10-13,测试店,赠品,0.00,1,,14.00,交易成功';
 const parsed=normalizeTable(await readTable(Buffer.from(csv),'units.csv')).orders[0];
 assert.equal(parsed.amountCents,1400);assert.deepEqual(parsed.items.map(i=>[i.unitPriceCents,i.qty,i.unit]),[[500,2,'把'],[100,3,'件'],[0,1,'']]);
 assert.deepEqual(validateOrder(parsed).items.map(i=>i.unit),['把','件','']);assert.equal(extractText('数量：2\n单位：把\n单价：5.00').items[0].unit,'把');assert.equal(extractText('数量：2\n单价：5.00').items[0].unit,'');
});
test('单位迁移只补新增字段，保留原始数据、审计、时间、金额和已编辑商品；重复启动幂等',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-unit-'));let store=openStore(dir);
 try{
  const raw={headers:['单位'],rows:[{row:5,cells:['把']},{row:6,cells:['件']}],normalized:{items:order().items.map((i,n)=>({...i,sourceRow:n+5}))}};
  const saved=store.insert(order(),null,raw);store.db.prepare('UPDATE orders SET items=?').run(JSON.stringify(order().items));store.db.exec('PRAGMA user_version=2');
  const before=store.db.prepare('SELECT * FROM orders').get(),audit=store.history(saved.id);store.close();store=openStore(dir);const after=store.db.prepare('SELECT * FROM orders').get();
  for(const key of Object.keys(before).filter(k=>!['items','fingerprint'].includes(k)))assert.equal(before[key],after[key],key);
  const items=store.get(saved.id).items;assert.deepEqual(items.map(({unit,...i})=>i),order().items);assert.deepEqual(items.map(i=>i.unit),['把','件']);assert.deepEqual(store.history(saved.id),audit);
  store.close();store=openStore(dir);assert.deepEqual(store.db.prepare('SELECT * FROM orders').get(),after);
  assert.equal(backfillItemUnits([{...order().items[0],qty:99}],raw)[0].unit,'');assert.equal(backfillItemUnits([{...order().items[0],unit:'套'}],raw)[0].unit,'套');assert.equal(backfillItemUnits([{...order().items[0],unit:''}],raw)[0].unit,'');
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('编辑单位后重启仍保留，CSV 三列与商品逐项对应，订单金额不重复',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-unit-api-'));const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());const headers={'content-type':'application/json','x-purchase-token':boot.token};const input=order();input.items[0].unit='把';input.items[1].unit='件';
  const saved=await fetch(url+'/api/orders',{method:'POST',headers,body:JSON.stringify(input)}).then(r=>r.json());saved.items[1].unit='包';const res=await fetch(url+'/api/orders/'+saved.id,{method:'PUT',headers,body:JSON.stringify(saved)});assert.equal(res.status,200);
  const rows=parse(await fetch(url+'/api/export').then(r=>r.text()),{columns:true,bom:true});assert.equal(rows.length,1);assert.equal(rows[0]['实付金额'],'14.00');assert.equal(rows[0]['单价(元)'],'1. 5.00\n2. 1.00');assert.equal(rows[0]['数量'],'1. 2\n2. 3');assert.equal(rows[0]['单位'],'1. 把\n2. 包');assert.equal(rows[0]['备注'],'保留备注');
  const history=store.history(saved.id);assert.equal(JSON.parse(history[0].before_json).items[1].unit,'件');assert.equal(JSON.parse(history[0].after_json).items[1].unit,'包');
  const legacy=store.get(saved.id);legacy.items=legacy.items.map(({unit,...i})=>i);legacy.note='旧页面修改备注';const retained=store.update(saved.id,legacy);assert.equal(retained.items[1].unit,'包');
  const copy=path.join(dir,'copy');fs.mkdirSync(copy);await store.backup(path.join(copy,'purchases.sqlite'));const reopened=openStore(copy);assert.equal(reopened.get(saved.id).items[1].unit,'包');reopened.close();
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
