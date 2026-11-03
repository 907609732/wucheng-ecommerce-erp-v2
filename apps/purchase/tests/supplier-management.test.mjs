import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {normalizeSupplier} from '../lib/supplier-management.mjs';
import {supplierChoices} from '../public/supplier-picker.js';
const profile=()=>({name:'测试五金供应商',contact:'张三',phone:'13800000000',wechat:'test',note:'测试资料',shops:[{platform:'淘宝',name:'淘宝五金店',url:'https://shop.example.com'},{platform:'1688',name:'1688五金店'}],addresses:[{label:'工厂',name:'甲',address:'地址一'},{label:'退货',name:'乙',address:'地址二'}],products:[{name:'螺丝',spec:'M8',unit:'个',priceCents:123},{name:'门锁',priceCents:null}]});
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-suppliers-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port,{token}=await fetch(url+'/api/bootstrap').then(r=>r.json());t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});const request=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(url+route,{method,headers:{'content-type':'application/json','x-purchase-token':token},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};return {request,url,store,dir};}
test('供应商产品、多地址、多店铺校验，危险网址和重复关联拒绝',()=>{
 assert.equal(normalizeSupplier(profile()).addresses.length,2);
 assert.throws(()=>normalizeSupplier({...profile(),shops:[{platform:'淘宝',url:'javascript:alert(1)'}]}),/http/);
 assert.throws(()=>normalizeSupplier({...profile(),products:[{name:'x',priceCents:1.1}]}),/参考单价/);
 assert.throws(()=>normalizeSupplier({...profile(),shops:[{platform:'淘宝',name:'相同'},{platform:'淘宝',name:'相同'}]}),/重复/);
});
test('跨平台汇总历史记录，建档更新不改订单，冲突回滚并保存历史',async t=>{
 const f=await fixture(t),order={platform:'淘宝',account:'采购账号',orderNo:'OLD-1',date:'2026-10-01',supplier:'淘宝五金店',amountCents:10000,refundCents:100,shippingCents:0,status:'已完成',supplierContact:{name:'原联系人',address:'原地址'},items:[{title:'螺丝',spec:'M8',unit:'个',qty:10,unitPriceCents:100}]};
 const saved=await f.request('/api/orders',order);assert.equal(saved.status,200);const before=f.store.list();
 let rows=(await f.request('/api/supplier-management')).data;assert.equal(rows.length,1);assert.equal(rows[0].id,null);assert.equal(rows[0].historicalProducts[0].name,'螺丝');assert.equal(rows[0].addresses[0].address,'原地址');
 const created=await f.request('/api/supplier-management',profile());assert.equal(created.status,200);const p=created.data;
 rows=(await f.request('/api/supplier-management')).data;assert.equal(rows.length,1);assert.equal(rows[0].id,p.id);assert.equal(rows[0].orderCount,1);assert.equal(rows[0].netCents,9900);assert.equal(rows[0].addresses.length,2);
 const choices=supplierChoices([],[],[p]);assert.equal(choices.length,2);assert.equal(choices.find(c=>c.platform==='1688').contact.address,'地址一');assert.equal(choices[0].addresses.length,2);
 const changed={...p,name:'测试五金供应商新名称',addresses:[...p.addresses,{label:'仓库',address:'地址三'}]};assert.equal((await f.request('/api/supplier-management/'+p.id,changed,'PUT')).status,200);
 assert.equal((await f.request('/api/supplier-management/'+p.id,changed,'PUT')).status,409);
 assert.equal((await f.request('/api/supplier-management',{...profile(),name:'另一供应商'})).status,409);
 assert.deepEqual(f.store.list(),before);const history=(await f.request('/api/supplier-management/'+p.id+'/history')).data;assert.equal(history.length,2);assert.equal(history[0].before.name,p.name);assert.equal(history[0].after.addresses.length,3);
});
test('新增档案无采购记录也可选择，写入需令牌，备份包含档案和历史',async t=>{
 const f=await fixture(t);const denied=await fetch(f.url+'/api/supplier-management',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(profile())});assert.equal(denied.status,403);
 await f.request('/api/supplier-management',profile());const choices=(await f.request('/api/supplier-management/choices')).data;assert.equal(choices.length,1);assert.equal((await f.request('/api/supplier-management?q='+encodeURIComponent('螺丝'))).data.length,1);assert.equal((await f.request('/api/supplier-management?platform=闲鱼')).data.length,0);
 const backup=path.join(f.dir,'suppliers.sqlite');await f.store.backup(backup);assert.ok(fs.statSync(backup).size>0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM supplier_profile_history').get().n,1);
});
