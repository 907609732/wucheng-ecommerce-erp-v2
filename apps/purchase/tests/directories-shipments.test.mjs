import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import AddressPackage from 'address-parse';
import {parse as parseCsv} from 'csv-parse/sync';
import {createApp} from '../server.mjs';
import {openStore} from '../lib/store.mjs';
import {parseAddress,detectCarrier,carrierOptions,normalizeCarrier} from '../public/address-parse.mjs';
import {filterOrders,orderTracking} from '../public/order-query.mjs';
import {auditText} from '../public/audit-values.mjs';
import {validateOrder} from '../lib/importer.mjs';
import {reviewImportOrders} from '../lib/import-review.mjs';

const base=(orderNo='NEW-1',extra={})=>({platform:'微信',account:'账号甲',orderNo,date:'2026-05-01',paidAt:'2026-05-02',supplier:'同名店',status:'已完成',amountCents:10000,refundCents:1000,shippingCents:500,note:'',items:[{title:'商品甲',qty:2,unit:'件',unitPriceCents:5000}],...extra});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-133-')),{app,store}=createApp({dataDir:dir});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port,{token}=await fetch(url+'/api/bootstrap').then(r=>r.json());
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=async(route,body,method=body===undefined?'GET':'POST')=>{
  const r=await fetch(url+route,{method,headers:{'x-purchase-token':token,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error),data,{status:r.status});return data;
 };
 const upload=async(name='证明.txt',content=Buffer.from('原始凭证'),mime='text/plain')=>{const f=new FormData();f.append('files',new Blob([content],{type:mime}),name);return (await request('/api/attachments',f))[0];};
 return {store,dir,url,request,upload};
}
const refs=rows=>rows.map(({id,updatedAt})=>({id,updatedAt}));
function undo(store,id){const p=store.auditLog.preview({auditId:id,scope:'entry'});assert.equal(p.canUndo,true,JSON.stringify(p));return store.auditLog.rollback({auditId:id,scope:'entry',versions:p.orders.map(({auditId,orderId,updatedAt})=>({auditId,orderId,updatedAt}))}).orders[0];}

test('离线地址解析支持分隔符、标签、直辖市和缺失信息',()=>{
 const parser=AddressPackage.default||AddressPackage;
 for(const input of ['张三，13800138000，浙江省杭州市西湖区文三路1号','张三\n13800138000\n浙江省杭州市西湖区文三路1号','收货人：张三 手机：13800138000 地址：浙江省杭州市西湖区文三路1号'])assert.deepEqual(parseAddress(input,parser),{recipient:'张三',phone:'13800138000',address:'浙江省杭州市西湖区文三路1号'});
 assert.equal(parseAddress('李四 13900139000 上海市浦东新区世纪大道1号',parser).address,'上海市浦东新区世纪大道1号');
 assert.equal(parseAddress('浙江省杭州市西湖区文三路1号',parser).phone,'');
 assert.deepEqual(parseAddress('',parser),{recipient:'',phone:'',address:''});
 assert.equal(detectCarrier('SF1234567890123'),'顺丰快递');assert.equal(detectCarrier('12345678'),'');
});

test('地址库标签、关联供应商、版本冲突和删除不改变订单快照',async t=>{
 const {request,store}=await fixture(t);
 let a=await request('/api/addresses',{name:'张三',phone:'13800138000',address:'测试路1号',tags:['收货地址','供应商地址','仓库'],platform:'微信',supplier:'同名店'});
 const o=await request('/api/orders',base('ADDR',{recipient:a.name,phone:a.phone,address:a.address,supplierContact:{name:a.name,phone:a.phone,address:a.address}}));
 assert.equal((await request('/api/addresses?tag='+encodeURIComponent('仓库'))).length,1);
 assert.equal((await request('/api/addresses?q='+encodeURIComponent('同名店'))).length,1);
 const original=a;a=await request('/api/addresses/'+a.id,{...a,address:'测试路2号'},'PUT');
 await assert.rejects(()=>request('/api/addresses/'+a.id,{...original,address:'过期更新'},'PUT'),e=>e.status===409);
 await assert.rejects(()=>request('/api/addresses/'+a.id,{updatedAt:original.updatedAt},'DELETE'),e=>e.status===409);
 await request('/api/addresses/'+a.id,{updatedAt:a.updatedAt},'DELETE');
 assert.equal(store.get(o.id).address,'测试路1号');assert.equal(store.get(o.id).supplierContact.address,'测试路1号');
});

test('供应商按平台聚合并引用订单；金额按整单统计且排除不计入支出',async t=>{
 const {request}=await fixture(t);
 await request('/api/orders',base('S1',{items:[...base().items,{title:'乙',qty:3}]}));
 await request('/api/orders',base('S2',{excludedFromSpend:true}));
 await request('/api/orders',base('S3',{platform:'淘宝',account:'账号乙'}));
 const rows=await request('/api/suppliers');assert.equal(rows.length,2);
 const wechat=rows.find(s=>s.platform==='微信');assert.equal(wechat.orderCount,2);assert.equal(wechat.amountCents,20000);assert.equal(wechat.refundCents,2000);assert.equal(wechat.netCents,9000);
 assert.equal((await request('/api/orders?'+new URLSearchParams({platform:'微信',supplier:'同名店'}))).length,2);
 assert.equal((await request('/api/suppliers?'+new URLSearchParams({platform:'淘宝',q:'同名'}))).length,1);
});

test('多商品多运单的保存、旧接口兼容、查询、导出、日志及回退',async t=>{
 const {request,store,url,dir}=await fixture(t),parcel=(trackingNo,logisticsCompany='顺丰速运')=>({trackingNo,logisticsCompany});
 let o=await request('/api/orders',base('SHIP',{trackingNo:'LEGACY',logisticsCompany:'历史物流',items:[{...base().items[0],shipments:[parcel('SF1'),parcel('YT2','圆通速递')]},{title:'商品乙',qty:1,shipments:[parcel('SF1')]}]}));
 assert.equal(o.items[0].shipments.length,2);assert.equal(orderTracking(o),'LEGACY；SF1；YT2');
 const legacy={...o,items:o.items.map(({shipments,...i})=>i),note:'旧接口改备注'};
 o=await request('/api/orders/'+o.id,legacy,'PUT');assert.equal(o.items[0].shipments.length,2);
 assert.equal(filterOrders([o],{q:'yt2'}).length,1);assert.equal(filterOrders([o],{carrier:'圆通速递'}).length,1);
 const csv=await fetch(url+'/api/export').then(r=>r.text()),row=parseCsv(csv,{bom:true,columns:true})[0];assert.match(row['商品行运单号'],/1\. SF1；YT2/);assert.match(row['商品行运单号'],/2\. SF1/);
 const items=structuredClone(o.items);items[0].shipments=[parcel('NEW','新物流')];o=await request('/api/orders/'+o.id,{...o,items,supplierContact:{name:'联系人',phone:'123',address:'供货路'}},'PUT');
 const log=store.auditLog.detail(store.history(o.id)[0].id);assert.match(auditText('items',log.after.items),/NEW.*新物流/);assert.ok(log.changes.some(c=>c.key==='supplierContact'));
 o=undo(store,log.id);assert.equal(o.items[0].shipments.length,2);assert.equal(o.supplierContact,null);
 const reopened=openStore(dir);try{assert.equal(reopened.get(o.id).items[0].shipments.length,2);}finally{reopened.close();}
 await assert.rejects(()=>request('/api/orders/'+o.id,{...o,items:legacy.items.map(i=>({...i,title:'重命名'}))},'PUT'),/核对原有运单/);
});

test('附件原链接可用、跨订单引用拒绝、绑定事务原子性、审计回退和重做保留原件',async t=>{
 const {request,store,upload,url}=await fixture(t),image=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
 const a=await upload('图片.png',image,'image/png');assert.equal((await fetch(url+a.thumbUrl)).status,200);
 const o=await request('/api/orders',base('ATT-A',{attachmentIds:[a.id]}));
 const logBefore=store.history(o.id).length,other=await request('/api/orders',base('ATT-B'));
 await assert.rejects(()=>request('/api/orders/'+other.id,{...other,note:'应回滚',attachmentIds:[a.id]},'PUT'),e=>e.status===409);
 assert.equal(store.get(other.id).note,'');assert.equal(store.history(o.id).length,logBefore);
 const b=await upload();let updated=await request('/api/orders/'+o.id,{...o,attachmentIds:[b.id]},'PUT');assert.equal(updated.attachmentIds.length,2);
 const log=store.auditLog.detail(store.history(o.id)[0].id);assert.equal(log.changes.length,1);assert.equal(log.changes[0].key,'attachmentIds');
 updated=undo(store,log.id);assert.deepEqual(updated.attachmentIds,[a.id]);
 store.attachments.sweepOrphans(0);assert.equal((await fetch(url+b.downloadUrl)).status,200);
 const rollback=store.history(o.id)[0].id;updated=undo(store,rollback);assert.equal(updated.attachmentIds.length,2);
 await assert.rejects(()=>request('/api/orders',base('ATT-INVALID',{attachmentIds:['missing']})),e=>e.status===409);assert.equal(store.list().length,2);
 for(const invalid of [null,false,{},'missing']){
  await assert.rejects(()=>request('/api/orders',base('BAD-LIST',{attachmentIds:invalid})),/附件列表/);
  await assert.rejects(()=>request('/api/orders/'+o.id,{...updated,note:'不应保存',attachmentIds:invalid},'PUT'),/附件列表/);
 }
 const missing=await upload('missing.txt');fs.unlinkSync(store.attachments.resource(missing.id).path);
 await assert.rejects(()=>request('/api/orders/'+o.id,{...updated,note:'失败写入',attachmentIds:[missing.id]},'PUT'),e=>e.status===409);assert.equal(store.get(o.id).note,'');
});

test('附件数量上限、锁定保护与冲突批次不留下部分修改',async t=>{
 const {request,store,upload}=await fixture(t);
 const uploads=[];for(let i=0;i<21;i++)uploads.push(await upload(i+'.txt'));
 await assert.rejects(()=>request('/api/orders',base('TOO-MANY',{attachmentIds:uploads.map(a=>a.id)})),/20/);assert.equal(store.list().length,0);
 let a=await request('/api/orders',base('SAME')),b=await request('/api/orders',base('SAME',{account:'账号乙'}));
 const before=store.list();await assert.rejects(()=>request('/api/orders/attributes/batch',{orders:refs([a,b]),patch:{account:'账号丙'}}),e=>e.status===409&&e.conflicts.length===2);assert.deepEqual(store.list(),before);
 const password=randomUUID();await store.monthLocks.setPassword({password,confirmation:password});store.monthLocks.confirm(store.monthLocks.preview('2026-05','微信'));
 await assert.rejects(()=>request('/api/orders/'+a.id,{...a,attachmentIds:[uploads[0].id]},'PUT'),e=>e.status===423);assert.equal(store.attachments.list(a.id).length,0);
 await assert.rejects(()=>request('/api/orders/attributes/batch',{orders:refs([a,b]),patch:{supplier:'新商家'}}),e=>e.status===423);assert.deepEqual(store.list(),before);
});

test('人工补充地址和运单后重导入原订单不会新增、覆盖；改账号历史仍可定位',async t=>{
 const {store}=await fixture(t),original=validateOrder(base('REIMPORT'));let o=store.insert(original);
 o=store.update(o.id,{...o,supplierContact:{name:'供货人'},items:[{...o.items[0],shipments:[{trackingNo:'SF1',logisticsCompany:'顺丰'}]}]});
 let reviewed=reviewImportOrders([{...original,errors:[]}],store)[0];assert.notEqual(reviewed.importStatus,'ready');assert.equal(reviewed.existingId,o.id);
 o=store.attributesBatch({orders:refs([o]),patch:{account:'新账号'}}).orders[0];reviewed=reviewImportOrders([{...original,errors:[]}],store)[0];assert.equal(reviewed.existingId,o.id);assert.notEqual(reviewed.importStatus,'ready');assert.equal(store.list().length,1);assert.equal(store.get(o.id).items[0].shipments.length,1);
});

test('物流公司只使用固定选项，历史别名对应，其他公司归其他',()=>{
 assert.deepEqual(carrierOptions,['申通快递','圆通快递','中通快递','韵达快递','顺丰快递','京东快递','其他']);
 for(const [input,expected] of [['顺丰速运','顺丰快递'],['京东物流','京东快递'],['圆通速递','圆通快递'],['百世汇通','其他'],['中通快递(ZTO)','中通快递'],['极兔速递','其他'],['德邦物流','其他'],['中国邮政 EMS','其他'],['','']])assert.equal(normalizeCarrier(input),expected,input);
 assert.equal(detectCarrier('JD123456789012'),'京东快递');assert.equal(detectCarrier('JT123456789012'),'其他');
});
