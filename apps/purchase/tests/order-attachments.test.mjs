import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {openStore} from '../lib/store.mjs';
import {openOrderAttachments} from '../lib/order-attachments.mjs';
import {createApp} from '../server.mjs';

const base=()=>({platform:'手工',account:'默认账号',orderNo:'ATT-1',date:'2026-09-01',paidAt:'2026-09-02',supplier:'附件测试店',amountCents:8800,refundCents:0,shippingCents:0,status:'已完成',note:'',items:[{title:'门锁',qty:1,unit:'把',unitPriceCents:8800}]});
const png=async()=>sharp({create:{width:4,height:4,channels:3,background:'#ffffff'}}).png().toBuffer();

test('采购单附件：暂存、绑定、下载、删除边界与编辑补传',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-att-'));
 const {app,store}=createApp({dataDir:dir});
 const server=app.listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(url+'/api/bootstrap').then(r=>r.json());
  const call=(route,body,method='POST')=>fetch(url+route,{method,headers:{'x-purchase-token':token,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)}).then(async r=>{const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error),{status:r.status});return j;});
  const get=route=>fetch(url+route).then(async r=>{const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error),{status:r.status});return j;});
  const image=await png();
  const form=(...files)=>{const f=new FormData();for(const [name,buf,mime] of files)f.append('files',new Blob([buf],{type:mime}),name);return f;};
  const upload=(...files)=>call('/api/attachments',form(...files));
  const del=id=>fetch(url+'/api/attachments/'+id,{method:'DELETE',headers:{'x-purchase-token':token}});
  // 无 token 上传被拒。
  assert.equal((await fetch(url+'/api/attachments',{method:'POST',body:form(['a.png',image,'image/png'])})).status,403);
  const [saved]=await upload(['a.png',image,'image/png']);
  assert.equal(saved.thumbUrl,'/api/attachments/'+saved.id+'?size=thumb');
  const [txt]=await upload(['b.txt',Buffer.from('hello'),'text/plain']);
  assert.equal(txt.thumbUrl,null);
  // 保存订单时绑定附件。
  const o=await call('/api/orders',{...base(),attachmentIds:[saved.id]});
  const list=await get('/api/orders/'+o.id+'/attachments');
  assert.equal(list.length,1);assert.equal(list[0].id,saved.id);assert.ok(list[0].thumbUrl);assert.ok(list[0].downloadUrl);
  // 原件与缩略图下载。
  const full=await fetch(url+'/api/attachments/'+saved.id);assert.equal(full.status,200);assert.match(full.headers.get('content-type'),/image\/png/);
  const thumb=await fetch(url+saved.thumbUrl);assert.equal(thumb.status,200);assert.match(thumb.headers.get('content-type'),/webp/);
  assert.equal((await fetch(url+'/api/attachments/'+txt.id+'?size=thumb')).status,404);
  // 已绑定不可删；未绑定可删且磁盘文件清除；重复删除 404。
  assert.equal((await del(saved.id)).status,409);
  assert.equal((await del(txt.id)).status,200);
  assert.equal(fs.existsSync(path.join(dir,'attachments',txt.id+'.txt')),false);
  assert.equal((await del(txt.id)).status,404);
  assert.equal((await get('/api/orders/'+o.id+'/attachments')).length,1);
  // 编辑订单补传第二个附件。
  const [second]=await upload(['c.png',image,'image/png']);
  const current=store.get(o.id);
  await call('/api/orders/'+o.id,{...current,note:'补传附件',updatedAt:current.updatedAt,attachmentIds:[second.id]},'PUT');
  assert.equal((await get('/api/orders/'+o.id+'/attachments')).length,2);
  assert.equal((await fetch(url+'/api/orders/不存在/attachments')).status,404);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('sweepOrphans 清理超龄未绑定附件与目录残留，保留已绑定',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-sweep-'));
 const store=openStore(dir);
 try{
  const attachments=openOrderAttachments(store);
  const image=await png();
  const bound=await attachments.stash(image,'bound.png','image/png');
  const stale=await attachments.stash(image,'stale.png','image/png');
  const fresh=await attachments.stash(image,'fresh.png','image/png');
  const order=store.insert(base(),null);
  attachments.bind(order.id,[bound.id]);
  store.db.prepare('UPDATE order_attachments SET created_at=? WHERE id=?').run(new Date(Date.now()-48*3600*1000).toISOString(),stale.id);
  fs.writeFileSync(path.join(attachments.folder,'orphan.bin'),'x');
  const r=attachments.sweepOrphans();
  assert.equal(r.rows,1);assert.ok(r.files>=1);
  assert.equal(store.db.prepare('SELECT id FROM order_attachments WHERE id=?').get(stale.id),undefined);
  assert.ok(store.db.prepare('SELECT id FROM order_attachments WHERE id=?').get(bound.id));
  assert.ok(store.db.prepare('SELECT id FROM order_attachments WHERE id=?').get(fresh.id));
  assert.equal(fs.existsSync(path.join(attachments.folder,'orphan.bin')),false);
  assert.equal(fs.existsSync(path.join(attachments.folder,bound.id+'.png')),true);
  // 已绑定附件不可删除。
  assert.throws(()=>attachments.remove(bound.id),e=>e.status===409);
  assert.throws(()=>attachments.remove('不存在'),e=>e.status===404);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
