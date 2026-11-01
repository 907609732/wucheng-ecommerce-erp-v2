import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import jsQR from 'jsqr';
import {PNG} from 'pngjs';
import {createApp} from '../server.mjs';
import {createCanvas,GlobalFonts} from '@napi-rs/canvas';
const origin='https://purchase.test.ts.net';
function qrCode(data){const png=PNG.sync.read(Buffer.from(data.image.split(',')[1],'base64'));const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);assert.ok(decoded,'二维码能被独立解码器读取');const url=new URL(decoded.data);assert.equal(url.origin,origin);assert.equal(url.pathname,'/');assert.equal(url.search,'');const code=new URLSearchParams(url.hash.slice(1)).get('pair');assert.match(code,/^[a-f0-9]{64}$/);return code;}
const order=()=>({platform:'手工',account:'默认账号',orderNo:randomUUID(),date:'2026-10-16',supplier:'手机测试',recipient:'测试收货人',phone:'13800000000',address:'测试收货地址',amountCents:12345,refundCents:0,shippingCents:100,status:'已完成',items:[{title:'螺丝',qty:2,unitPriceCents:100,unit:'盒',shipments:[{trackingNo:'SFTEST123',logisticsCompany:'顺丰速运'}]}]});
test('录入人按会话设置并固定在订单来源，切换用户名不改旧记录，客户端不能伪造来源',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 assert.equal((await f.request('/api/mobile/username',{username:''})).status,400);
 assert.equal((await f.request('/api/mobile/username',{username:'陈奇'})).status,200);
 const body={...order(),sourceChannel:'spreadsheet',uploadedBy:'伪造姓名'};
 const saved=await f.request('/api/mobile/orders',body,{'x-request-id':randomUUID()});assert.equal(saved.status,200);
 assert.equal(saved.data.order.sourceChannel,'mobile');assert.equal(saved.data.order.uploadedBy,'陈奇');
 await f.request('/api/mobile/username',{username:'自定义姓名'});
 assert.equal((await f.request('/api/mobile/session')).data.username,'自定义姓名');
 assert.equal(f.store.get(saved.data.order.id).uploadedBy,'陈奇');
 const {token}=await fetch(f.desktopURL+'/api/bootstrap').then(r=>r.json());
 const desktop=await fetch(f.desktopURL+'/api/orders',{method:'POST',headers:{'content-type':'application/json','x-purchase-token':token},body:JSON.stringify({...order(),uploadedBy:'伪造',sourceChannel:'mobile'})}).then(r=>r.json());
 assert.equal(desktop.sourceChannel,'desktop');assert.equal(desktop.uploadedBy,'');
});
test('手机收货地址共用电脑地址库，鉴权、去重和权限限制',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});
 assert.equal((await f.request('/api/mobile/addresses')).status,401);await f.pair();
 const value={name:'张三',phone:'13800138000',address:'浙江省杭州市西湖区测试路1号',supplier:'不可关联供应商',platform:'微信',tags:['供应商地址']};
 assert.equal((await f.request('/api/mobile/addresses',value,{'x-mobile-csrf':'wrong'})).status,403);
 assert.equal((await f.request('/api/mobile/addresses',{name:'缺少电话地址'})).status,400);
 const saved=await f.request('/api/mobile/addresses',value);assert.equal(saved.status,200);assert.deepEqual(saved.data.tags,['收货地址']);assert.equal(saved.data.supplier,'');
 const retry=await f.request('/api/mobile/addresses',value);assert.equal(retry.data.id,saved.data.id);
 assert.equal((await f.request('/api/mobile/addresses')).data.length,1);
 const desktop=await fetch(f.desktopURL+'/api/addresses').then(r=>r.json());assert.equal(desktop[0].id,saved.data.id);
 assert.equal((await f.request('/api/mobile/addresses/'+saved.data.id,{}, {},'PUT')).status,404);
 const bundle=await f.download('/vendor/address-parse.js');assert.equal(bundle.status,200);assert.ok(bundle.body.length>1000);
 const theme=await f.download('/surface-theme.css');assert.equal(theme.status,200);assert.match(theme.body.toString(),/245bdb/i);
 const entry=await f.download('/');assert.equal(entry.status,200);assert.match(entry.body.toString(),/mobile\.css/);assert.doesNotMatch(entry.body.toString(),/surface-theme\.css/);
});
async function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-mobile-')),{app,store,mobile}=createApp({dataDir:dir,mobilePolicyFile:'',...options});
 const listen=async a=>{const s=a.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));return s;};
 const desktop=await listen(app),phone=await listen(mobile.app),desktopURL='http://127.0.0.1:'+desktop.address().port,url='http://127.0.0.1:'+phone.address().port;
 t.after(async()=>{await Promise.all([new Promise(r=>desktop.close(r)),new Promise(r=>phone.close(r))]);store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const token=(await fetch(desktopURL+'/api/bootstrap').then(r=>r.json())).token;
 const admin=async(route,body)=>{const r=await fetch(desktopURL+'/api/mobile-admin'+route,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-purchase-token':token},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 let cookie='',csrf='';
 const request=async(route,body,extra={},method=body?'POST':'GET')=>{
  const response=body instanceof FormData?new Response(body):null;
  const payload=response?Buffer.from(await response.arrayBuffer()):body?Buffer.from(JSON.stringify(body)):null;
  return new Promise((resolve,reject)=>{const r=http.request(url+route,{method,headers:{host:new URL(origin).host,origin,cookie,'x-mobile-csrf':csrf,'content-type':response?response.headers.get('content-type'):'application/json',...(payload?{'content-length':payload.length}:{}),...extra}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks)),headers:new Headers(res.headers)});}catch(e){reject(e);}});});r.on('error',reject);r.end(payload);});
 };
 const pair=async()=>{const p=await admin('/pairing',{}),r=await request('/api/mobile/pair',{code:p.data.code});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.data.csrf;await request('/api/mobile/username',{username:'五成'});return r;};
 const download=route=>new Promise((resolve,reject)=>{const r=http.get(url+route,{headers:{host:new URL(origin).host,cookie}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}));});r.on('error',reject);});
 return {store,mobile,admin,request,pair,download,desktopURL,url};
}
test('手机入口默认关闭，配对一次性、来源校验、Secure Cookie及所有桌面接口隔离',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/mobile/session')).status,503);
 await f.admin('/config',{enabled:true,origin});assert.equal((await f.request('/api/mobile/orders')).status,401);
 assert.equal((await f.request('/api/mobile/pair',{code:'bad'},{origin:'https://evil.example'})).status,403);
 const p=await f.admin('/pairing',{}),paired=await f.request('/api/mobile/pair',{code:p.data.code});assert.equal(paired.status,200);assert.match(paired.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
 assert.equal((await f.request('/api/mobile/pair',{code:p.data.code})).status,401);
 await f.pair();assert.equal((await f.request('/api/mobile/orders')).status,200);
 for(const route of ['/api/bootstrap','/api/backup','/api/orders','/api/admin/password','/api/mobile-admin','/api/order-logs','/api/attachments','/api/mobile/orders/xyz/note','/api/mobile/unknown'])assert.equal((await f.request(route,{})).status,404,route);
 assert.equal((await f.request('/api/mobile/orders',order(),{'x-mobile-csrf':'invalid'})).status,403);
 const sessions=await f.admin('');for(const s of sessions.data.sessions)await f.admin('/revoke',{id:s.id});assert.equal((await f.request('/api/mobile/session')).status,401);
 await f.pair();f.store.db.prepare('UPDATE mobile_sessions SET expires_at=0').run();assert.equal((await f.request('/api/mobile/session')).status,401);
});
test('手机普通附件无需识别，跟随新单保存，可下载且重试不重复，拒绝其他会话附件',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});
 const file=()=>{const data=new FormData();data.append('files',new Blob(['attachment-test'],{type:'text/plain'}),'附件.txt');return data;};
 assert.equal((await f.request('/api/mobile/attachments',file())).status,401);await f.pair();
 assert.equal((await f.request('/api/mobile/attachments',file(),{'x-mobile-csrf':'bad'})).status,403);
 const upload=await f.request('/api/mobile/attachments',file());assert.equal(upload.status,200);assert.equal(upload.data[0].filename,'附件.txt');
 const id=upload.data[0].id;
 assert.equal((await f.download('/api/mobile/uploads/attachment/'+id)).status,404);
 const body={...order(),attachmentIds:[id]},requestId=randomUUID();
 const saved=await f.request('/api/mobile/orders',body,{'x-request-id':requestId});assert.equal(saved.status,200);assert.deepEqual(saved.data.order.attachmentIds,[id]);
 assert.equal((await f.request('/api/mobile/orders',body,{'x-request-id':requestId})).data.replayed,true);assert.equal(f.store.list().length,1);
 const listed=await f.request('/api/mobile/orders/'+saved.data.order.id+'/attachments');assert.equal(listed.data[0].downloadUrl,'/api/mobile/uploads/attachment/'+id);
 const original=await f.download(listed.data[0].downloadUrl);assert.equal(original.body.toString(),'attachment-test');assert.equal(original.headers['cache-control'],'no-store');
 const orphan=(await f.request('/api/mobile/attachments',file())).data[0].id;await f.pair();
 assert.equal((await f.request('/api/mobile/orders',{...order(),attachmentIds:[orphan]},{'x-request-id':randomUUID()})).status,403);
 const desktop=await f.store.attachments.stash(Buffer.from('desktop'),'desktop.txt','text/plain');
 assert.equal((await f.request('/api/mobile/orders',{...order(),attachmentIds:[desktop.id]},{'x-request-id':randomUUID()})).status,403);
 const history=await f.request('/api/mobile/uploads?kind=attachment');assert.equal(history.data.uploads[0].id,id);
 const desktopOrders=await fetch(f.desktopURL+'/api/bootstrap').then(r=>r.json());assert.deepEqual(desktopOrders.orders[0].attachmentIds,[id]);
});

test('查询默认最近手机上传保存的单据，按上传时间而非采购日期，编辑不改变最近上传顺序',async t=>{
 let now=Date.now();const f=await fixture(t,{mobileNow:()=>now});await f.admin('/config',{enabled:true,origin});await f.pair();
 assert.equal((await f.request('/api/mobile/orders/latest')).data.order,null);
 const first=(await f.request('/api/mobile/orders',{...order(),date:'2026-10-16'},{'x-request-id':randomUUID()})).data.order;
 now+=1000;const second=(await f.request('/api/mobile/orders',{...order(),date:'2026-01-01'},{'x-request-id':randomUUID()})).data.order;
 assert.equal((await f.request('/api/mobile/orders/latest')).data.order.id,second.id);
 const edited=await f.request('/api/mobile/orders/'+first.id,{...first,note:'修改旧单'},{'x-request-id':randomUUID()},'PUT');assert.equal(edited.status,200);
 assert.equal((await f.request('/api/mobile/orders/latest')).data.order.id,second.id);
});

test('手机编辑沿用原单、附件、分类及审计，重试去重，版本冲突和跨会话附件被拒绝',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 const oldAttachment=await f.store.attachments.stash(Buffer.from('original'),'原附件.txt','text/plain');
 const original=f.store.insert({...order(),attachmentIds:[oldAttachment.id],excludedFromSpend:true});
 const upload=new FormData();upload.append('files',new Blob(['new']),'new.txt');const extra=(await f.request('/api/mobile/attachments',upload)).data[0].id;
 const input={...original,note:'手机修改备注',amountCents:6789,attachmentIds:[oldAttachment.id,extra]},requestId=randomUUID(),route='/api/mobile/orders/'+original.id;
 assert.equal((await f.request(route,input,{'x-request-id':requestId,'x-mobile-csrf':'bad'},'PUT')).status,403);
 const changed=await f.request(route,input,{'x-request-id':requestId},'PUT');assert.equal(changed.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.order.id,original.id);assert.equal(changed.data.order.note,input.note);assert.equal(changed.data.order.amountCents,6789);assert.equal(changed.data.order.excludedFromSpend,true);assert.deepEqual(changed.data.order.classification,original.classification);assert.deepEqual(new Set(changed.data.order.attachmentIds),new Set([oldAttachment.id,extra]));
 const history=f.store.history(original.id);assert.equal(history.length,2);assert.equal(history[0].action,'update');assert.equal(JSON.parse(history[0].before_json).amountCents,original.amountCents);
 assert.equal((await f.request(route,input,{'x-request-id':requestId},'PUT')).data.replayed,true);assert.equal(f.store.history(original.id).length,2);assert.equal(f.store.list().length,1);
 assert.equal((await f.request(route,{...input,note:'冲突'},{'x-request-id':requestId},'PUT')).status,409);
 assert.equal((await f.request(route,input,{'x-request-id':randomUUID()},'PUT')).status,409);
 const orphan=await f.store.attachments.stash(Buffer.from('desktop'),'desktop.txt','text/plain');
 assert.equal((await f.request(route,{...changed.data.order,attachmentIds:[orphan.id]},{'x-request-id':randomUUID()},'PUT')).status,403);
 const latest=(await f.request('/api/mobile/orders/latest')).data.order;assert.equal(latest.id,original.id);
 await f.request('/api/mobile/logout',{});assert.equal((await f.request(route,changed.data.order,{'x-request-id':randomUUID()},'PUT')).status,401);
});

test('手机编辑事务失败回滚全部数据，锁定月份拒绝修改和移入',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 const original=f.store.insert({...order(),date:'2026-08-01'}),route='/api/mobile/orders/'+original.id;
 f.store.db.exec("CREATE TRIGGER fail_mobile_edit BEFORE INSERT ON mobile_order_edits BEGIN SELECT RAISE(ABORT,'test edit failure'); END;");
 assert.equal((await f.request(route,{...original,note:'不能保存'},{'x-request-id':randomUUID()},'PUT')).status,400);
 assert.deepEqual(f.store.get(original.id),original);assert.equal(f.store.history(original.id).length,1);f.store.db.exec('DROP TRIGGER fail_mobile_edit');
 await f.store.monthLocks.setPassword({password:'mobile-test-password',confirmation:'mobile-test-password'});
 f.store.monthLocks.confirm(f.store.monthLocks.preview('2026-08','手工'));
 assert.equal((await f.request(route,{...original,note:'已锁定'},{'x-request-id':randomUUID()},'PUT')).status,423);
 const other=f.store.insert({...order(),date:'2026-09-01'});
 assert.equal((await f.request('/api/mobile/orders/'+other.id,{...other,date:'2026-08-01'},{'x-request-id':randomUUID()},'PUT')).status,423);
 assert.deepEqual(f.store.get(original.id),original);
});

test('动态二维码强随机、一次性、重生成失效、需桌面令牌且关闭不可生成',async t=>{
 const f=await fixture(t);
 assert.equal((await f.admin('/qrcode',{})).status,400);
 await f.admin('/config',{enabled:true,origin});
 const denied=await fetch(f.desktopURL+'/api/mobile-admin/qrcode',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
 assert.equal(denied.status,403);
 const qr=await f.admin('/qrcode',{});
 assert.equal(qr.status,200);assert.equal(qr.data.origin,origin);
 assert.deepEqual(Object.keys(qr.data).sort(),['expiresAt','image','origin']);
 assert.match(qr.data.image,/^data:image\/png;base64,/);
 assert.equal(Buffer.from(qr.data.image.split(',')[1],'base64').subarray(1,4).toString(),'PNG');
 assert.equal((await f.request('/api/mobile/session')).status,401);
 const first=qrCode(qr.data),second=qrCode((await f.admin('/qrcode',{})).data);assert.notEqual(first,second);
 assert.equal((await f.request('/api/mobile/pair',{code:first})).status,401);
 assert.equal((await f.request('/api/mobile/pair',{code:second})).status,200);
 assert.equal((await f.request('/api/mobile/pair',{code:second})).status,401);
 assert.equal((await f.admin('')).data.pairingExpiresAt,null);
 const code=qrCode((await f.admin('/qrcode',{})).data);await f.admin('/pairing',{});
 assert.equal((await f.request('/api/mobile/pair',{code})).status,401);
 await f.admin('/config',{enabled:false});assert.equal((await f.admin('/qrcode',{})).status,400);
});
test('二维码到期、配置变更和重启均不能继续授权',async t=>{
 let now=Date.now();const f=await fixture(t,{mobileNow:()=>now});await f.admin('/config',{enabled:true,origin});
 const qr=(await f.admin('/qrcode',{})).data,code=qrCode(qr);assert.equal(qr.expiresAt,now+300000);now+=300000;
 assert.equal((await f.request('/api/mobile/pair',{code})).status,401);
 const changed=qrCode((await f.admin('/qrcode',{})).data);await f.admin('/config',{enabled:true,origin});
 assert.equal((await f.request('/api/mobile/pair',{code:changed})).status,401);
 const other=await fixture(t);await other.admin('/config',{enabled:true,origin});
 assert.equal((await other.request('/api/mobile/pair',{code:qrCode((await f.admin('/qrcode',{})).data)})).status,401);
});
test('Tailscale 打开按钮仅允许电脑会话，手机不能调用',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 const denied=await fetch(f.desktopURL+'/api/mobile-admin/tailscale/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:'untrusted',path:'untrusted'})});assert.equal(denied.status,403);
 assert.equal((await f.request('/api/mobile-admin/tailscale/open',{})).status,404);
 assert.equal((await f.request('/api/mobile/tailscale/open',{})).status,404);
});
test('手机共用电脑平台、供应商地址与商品多运单，保存后桌面数据一致',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});
 assert.equal((await f.request('/api/mobile/form-options')).status,401);await f.pair();
 const contact={name:'联系人',phone:'13800000000',address:'测试地址'};
 const {token}=await fetch(f.desktopURL+'/api/bootstrap').then(r=>r.json());
 const maintained=await fetch(f.desktopURL+'/api/supplier-management',{method:'POST',headers:{'content-type':'application/json','x-purchase-token':token},body:JSON.stringify({name:'微信供应商',contact:contact.name,phone:contact.phone,shops:[{platform:'微信',name:'微信供应商'}],addresses:[{address:contact.address}]})});assert.equal(maintained.status,200);
 const body={...order(),platform:'微信',supplier:'微信供应商',supplierContact:contact,refundCents:0,shippingCents:0,items:[{title:'零件',spec:'M8',sku:'TEST-8',qty:2,unit:'个',unitPriceCents:100,shipments:[{trackingNo:'SF123',logisticsCompany:'顺丰速运'},{trackingNo:'YT456',logisticsCompany:'圆通速递'}]}]};
 const saved=await f.request('/api/mobile/orders',body,{'x-request-id':randomUUID()});assert.equal(saved.status,200);
 const options=await f.request('/api/mobile/form-options');assert.equal(options.status,200);assert.ok(options.data.platforms.includes('微信'));assert.ok(options.data.platforms.includes('其他'));
 const supplier=options.data.orders.find(o=>o.supplier===body.supplier);assert.equal(supplier.platform,'微信');assert.deepEqual(supplier.supplierContact,contact);
 const profile=options.data.supplierProfiles.find(p=>p.name===body.supplier);assert.equal(profile.contact,contact.name);assert.equal(profile.phone,contact.phone);assert.equal(profile.addresses[0].address,contact.address);
 const desktop=await fetch(f.desktopURL+'/api/bootstrap').then(r=>r.json()),record=desktop.orders.find(o=>o.orderNo===body.orderNo);
 assert.deepEqual(record.items[0].shipments,body.items[0].shipments);assert.deepEqual(record.supplierContact,contact);assert.equal(record.items[0].sku,'TEST-8');assert.equal(record.refundCents,0);assert.equal(record.shippingCents,0);
 assert.equal((await f.request('/api/addresses',{})).status,404);
});
test('保存与重试原子去重、冲突不覆盖、查询、关闭及桌面回归',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();const body=order(),id=randomUUID();
 const send=b=>f.request('/api/mobile/orders',b,{'x-request-id':id});
 const [a,b]=await Promise.all([send(body),send(body)]);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(f.store.list().length,1);assert.equal(f.store.history(a.data.order.id).length,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mobile_requests').get().n,1);
 const retry=await send(body);assert.equal(retry.data.replayed,true);assert.equal((await send({...body,amountCents:99})).status,409);assert.equal(f.store.get(a.data.order.id).amountCents,12345);
 const query=await f.request('/api/mobile/orders?q='+encodeURIComponent('螺丝'));assert.equal(query.data.total,1);assert.equal(query.headers.get('cache-control'),'no-store');assert.equal((await f.request('/api/mobile/orders/'+a.data.order.id)).data.items[0].unit,'盒');
 assert.equal((await f.request('/api/mobile/orders',{...order(),ocrJobId:'desktop-job'},{'x-request-id':randomUUID()})).status,403);
 await f.admin('/config',{enabled:false});assert.equal((await f.request('/api/mobile/session')).status,503);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mobile_sessions').get().n,0);
 const desktop=await fetch(f.desktopURL+'/api/bootstrap').then(r=>r.json());assert.equal(desktop.orders.length,1);assert.ok(desktop.token);
});
test('手机请求记录失败时整笔订单回滚，锁定月份拒绝录入',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 f.store.db.exec("CREATE TRIGGER fail_mobile_request BEFORE INSERT ON mobile_requests BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 assert.equal((await f.request('/api/mobile/orders',order(),{'x-request-id':randomUUID()})).status,400);assert.equal(f.store.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n,0);
 f.store.db.exec('DROP TRIGGER fail_mobile_request');
 await f.store.monthLocks.setPassword({password:'mobile-test-password',confirmation:'mobile-test-password'});
 f.store.monthLocks.confirm(f.store.monthLocks.preview('2026-08','手工'));
 assert.equal((await f.request('/api/mobile/orders',{...order(),date:'2026-08-01'},{'x-request-id':randomUUID()})).status,423);assert.equal(f.store.list().length,0);
 const p=await f.admin('/pairing',{});for(let i=0;i<5;i++)assert.equal((await f.request('/api/mobile/pair',{code:'wrong'})).status,401);assert.equal((await f.request('/api/mobile/pair',{code:p.data.code})).status,429);
});
test('五分钟过期配对码不能授权，Host伪造与空请求编号被拒绝',async t=>{
 let now=Date.now();const f=await fixture(t,{mobileNow:()=>now});await f.admin('/config',{enabled:true,origin});const p=await f.admin('/pairing',{});now+=300001;
 assert.equal((await f.request('/api/mobile/pair',{code:p.data.code})).status,401);await f.pair();
 assert.equal((await f.request('/api/mobile/session',null,{host:'evil.example'})).status,403);
 assert.equal((await f.request('/api/mobile/orders',order())).status,400);
});
test('手机查询复用电脑筛选，所有业务字段与金额均可查询',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});assert.equal((await f.request('/api/mobile/uploads')).status,401);await f.pair();
 const body={...order(),platform:'微信',account:'账号查询',recipient:'收货人查询',phone:'13812345678',address:'仓库查询地址',supplierContact:{name:'供应商联系人查询'},note:'备注查询',items:[{title:'商品查询',spec:'M8规格',sku:'SKU001',unit:'箱',qty:3,unitPriceCents:2500,shipments:[{trackingNo:'SF123456789',logisticsCompany:'顺丰速运'}]}]};
 const saved=await f.request('/api/mobile/orders',body,{'x-request-id':randomUUID()});assert.equal(saved.status,200);
 for(const [field,q] of [['platform','微信'],['account','账号查询'],['recipient','收货人查询'],['phone','13812345678'],['address','仓库查询地址'],['supplierContact','供应商联系人查询'],['note','备注查询'],['amount','123.45'],['status','已完成'],['spec','M8规格'],['sku','SKU001'],['unit','箱'],['qty','3'],['price','25.00'],['tracking','SF123456789'],['carrier','顺丰速运']]){const r=await f.request('/api/mobile/orders?'+new URLSearchParams({q,searchField:field}));assert.equal(r.data.total,1,field);assert.equal((await f.request('/api/mobile/orders?'+new URLSearchParams({q}))).data.total,1,field+' all');}
 assert.equal((await f.request('/api/mobile/orders?platform=淘宝')).data.total,0);
 assert.equal((await f.request('/api/mobile/orders?minAmount=124')).data.total,0);
 assert.equal((await f.request('/api/mobile/orders?basis=created&from=2027-01-01')).data.total,0);
 assert.equal((await f.request('/api/mobile/orders?tracking=yes&refund=no')).data.total,1);
 assert.equal((await f.request('/api/mobile/uploads/source/not-found')).status,404);
 assert.equal((await f.request('/api/mobile/uploads/attachment/not-found')).status,404);
});
test('上传历史可查已绑定订单附件，原件下载必须有手机会话且不缓存',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 const saved=await f.request('/api/mobile/orders',order(),{'x-request-id':randomUUID()}),attachment=await f.store.attachments.stash(Buffer.from('original document'),'原始单据.txt','text/plain');f.store.attachments.bind(saved.data.order.id,[attachment.id]);
 const list=(await f.request('/api/mobile/uploads?kind=attachment&q='+encodeURIComponent('原始单据'))).data;assert.equal(list.total,1);assert.equal(list.uploads[0].orders[0].id,saved.data.order.id);
 const resource=await f.download(list.uploads[0].downloadUrl);assert.equal(resource.status,200);assert.equal(resource.body.toString(),'original document');assert.equal(resource.headers['cache-control'],'no-store');assert.match(resource.headers['content-disposition'],/^attachment/);
 await f.request('/api/mobile/logout',{});assert.equal((await f.download(list.uploads[0].downloadUrl)).status,401);
});
test('手机中文原单真实OCR、会话隔离、原图保存与响应丢失重试', {timeout:120000},async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','MobileChinese');const canvas=createCanvas(1500,1000),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1500,1000);ctx.fillStyle='#111';ctx.font='42px MobileChinese';
 ['订单号: MOBILE20261016001','日期: 2026-10-16','供应商: 五金配件店','商品: 螺丝','数量: 2','实付金额: 123.45'].forEach((l,i)=>ctx.fillText(l,80,100+i*120));const image=canvas.toBuffer('image/png');
 const form=new FormData();form.append('file',new Blob([image],{type:'image/png'}),'采购单.png');const started=await f.request('/api/mobile/ocr',form);assert.equal(started.status,200);
 let job;for(let i=0;i<400;i++){job=(await f.request('/api/mobile/ocr/'+started.data.id)).data;if(job.status!=='running')break;await new Promise(r=>setTimeout(r,150));}
 assert.equal(job.status,'done',job.error);assert.equal(job.result.order.amountCents,12345);assert.equal(f.store.list().length,0);
 const pending=(await f.request('/api/mobile/uploads?q='+encodeURIComponent('采购单'))).data;assert.equal(pending.total,1);assert.equal(pending.uploads[0].kind,'attempt');assert.equal(pending.uploads[0].status,'done');assert.equal(pending.uploads[0].downloadUrl,null);
 const extra=new FormData();extra.append('files',new Blob([image],{type:'image/png'}),'补充图片.png');const extraId=(await f.request('/api/mobile/attachments',extra)).data[0].id;
 const body={...job.result.order,recipient:'测试收货人',phone:'13800000000',address:'测试收货地址',items:job.result.order.items.map(i=>({...i,shipments:[{trackingNo:'SFTEST123',logisticsCompany:'顺丰速运'}]})),status:'已完成',ocrJobId:job.id,attachmentIds:[extraId]},id=randomUUID();const saved=await f.request('/api/mobile/orders',body,{'x-request-id':id});assert.equal(saved.status,200,JSON.stringify(saved.data));
 assert.deepEqual(saved.data.order.attachmentIds,[extraId]);assert.deepEqual((await f.download('/api/mobile/uploads/attachment/'+extraId)).body,image);
 const original=f.store.db.prepare('SELECT file_path FROM imports').get();assert.deepEqual(fs.readFileSync(path.join(f.store.dir,original.file_path)),image);
 const retry=await f.request('/api/mobile/orders',body,{'x-request-id':id});assert.equal(retry.status,200);assert.equal(retry.data.replayed,true);assert.equal(f.store.list().length,1);
 const uploaded=(await f.request('/api/mobile/uploads?q='+encodeURIComponent(body.orderNo))).data;assert.equal(uploaded.total,2);assert.equal(uploaded.uploads[0].status,'saved');assert.equal(uploaded.uploads[0].orders[0].id,saved.data.order.id);assert.equal((await f.request('/api/mobile/uploads?kind=attempt')).data.total,0);
 const downloaded=await f.download(uploaded.uploads.find(u=>u.kind==='source').downloadUrl);assert.equal(downloaded.status,200);assert.deepEqual(downloaded.body,image);assert.equal(downloaded.headers['cache-control'],'no-store');
 await f.pair();assert.equal((await f.request('/api/mobile/ocr/'+job.id)).status,404);
 assert.equal((await f.request('/api/mobile/orders',{...body,orderNo:'OTHER'},{'x-request-id':randomUUID()})).status,403);assert.equal(f.store.list().length,1);
});

test('手机查询支持上传日期升降序，修改原单不改变上传日期',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 const a=f.store.insert({...order(),date:'2026-10-15'}),b=f.store.insert({...order(),date:'2026-01-01'});
 f.store.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z',a.id);
 f.store.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run('2026-10-18T09:00:01.000Z',b.id);
 const desc=await f.request('/api/mobile/orders?sortBy=uploaded-desc');assert.equal(desc.data.orders[0].id,b.id);assert.equal(desc.data.orders[0].fields.uploadedAt,'2026-10-18 17:00:01');
 const asc=await f.request('/api/mobile/orders?sortBy=uploaded-asc');assert.equal(asc.data.orders[0].id,a.id);
 const before=f.store.get(b.id);f.store.update(b.id,{...before,note:'修改备注'});assert.equal(f.store.get(b.id).createdAt,before.createdAt);
});

test('手机最近上传返回逐条摘要列表，按手机保存时间分页，排除电脑录入且需会话',async t=>{
 let now=Date.now();const f=await fixture(t,{mobileNow:()=>now});await f.admin('/config',{enabled:true,origin});
 assert.equal((await f.request('/api/mobile/orders/recent')).status,401);await f.pair();assert.equal((await f.request('/api/mobile/orders/recent')).data.total,0);
 f.store.insert(order());const first=(await f.request('/api/mobile/orders',{...order(),date:'2026-10-16'},{'x-request-id':randomUUID()})).data.order;
 now+=1000;const second=(await f.request('/api/mobile/orders',{...order(),date:'2026-01-01'},{'x-request-id':randomUUID()})).data.order;
 const list=(await f.request('/api/mobile/orders/recent')).data;assert.equal(list.total,2);assert.deepEqual(list.orders.map(o=>o.id),[second.id,first.id]);assert.equal(list.orders[0].product,'螺丝');assert.equal(list.orders[0].createdAt,second.createdAt);assert.equal(list.orders[0].items,undefined);assert.equal(list.orders[0].address,undefined);
 assert.equal((await f.request('/api/mobile/orders/recent?page=2')).data.orders.length,0);assert.equal((await f.request('/api/mobile/orders/'+second.id)).data.items[0].title,'螺丝');
});

test('手机收货与物流必填，空白地址、缺少或不完整商品运单均拒绝保存',async t=>{
 const f=await fixture(t);await f.admin('/config',{enabled:true,origin});await f.pair();
 for(const key of ['recipient','phone','address']){const r=await f.request('/api/mobile/orders',{...order(),[key]:'  '},{'x-request-id':randomUUID()});assert.equal(r.status,400);}
 for(const shipments of [[],[{trackingNo:'123',logisticsCompany:''}],[{trackingNo:'',logisticsCompany:'中通'}]]){const body=order();body.items[0].shipments=shipments;assert.equal((await f.request('/api/mobile/orders',body,{'x-request-id':randomUUID()})).status,400);}
 assert.equal(f.store.list().length,0);const good=(await f.request('/api/mobile/orders',order(),{'x-request-id':randomUUID()})).data.order;
 assert.equal((await f.request('/api/mobile/orders/'+good.id,{...good,phone:''},{'x-request-id':randomUUID()},'PUT')).status,400);assert.equal(f.store.get(good.id).phone,good.phone);
});
