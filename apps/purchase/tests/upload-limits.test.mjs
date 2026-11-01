import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {validateOrder} from '../lib/importer.mjs';
import {MAX_FILES,MAX_FILE_BYTES,MAX_TOTAL_BYTES,validateUploadLimits,validateOcrPageCount} from '../public/upload-limits.mjs';
import {validateOcrFiles} from '../public/ocr-files.mjs';
import {recognizeBatch,modelDir} from '../lib/ocr.mjs';

test('真实PDF：20页可读取，21页识别拒绝并返回超限原因', {skip:!['chi_sim','eng'].every(l=>fs.existsSync(path.join(modelDir,l+'.traineddata')))},async()=>{
 const read=n=>fs.readFileSync(new URL('./fixtures/ocr-'+n+'-pages.pdf',import.meta.url));
 const accepted=await recognizeBatch([{buffer:read(20),filename:'20页.pdf'}]);assert.equal(accepted.documents.length,1);assert.match(accepted.text,/PO20261013001/);
 await assert.rejects(()=>recognizeBatch([{buffer:read(21),filename:'21页.pdf'}]),e=>e.code==='UPLOAD_LIMIT'&&/21.*20/.test(e.message));
});

test('统一附件限制：数量、大小、总量边界与累计已有文件',()=>{
 const f=size=>({name:'凭证.png',size});
 assert.doesNotThrow(()=>validateUploadLimits(Array.from({length:20},()=>f(1))));
 assert.throws(()=>validateUploadLimits(Array.from({length:21},()=>f(1))),e=>e.code==='UPLOAD_LIMIT'&&/21.*20/.test(e.message));
 assert.doesNotThrow(()=>validateUploadLimits([f(MAX_FILE_BYTES)]));
 assert.throws(()=>validateUploadLimits([f(MAX_FILE_BYTES+1)]),/50 MB/);
 const existing=Array.from({length:4},()=>({filename:'已有附件',bytes:MAX_FILE_BYTES}));
 assert.doesNotThrow(()=>validateUploadLimits(existing));
 assert.throws(()=>validateUploadLimits([...existing,f(1)]),/200 MB/);
 assert.doesNotThrow(()=>validateOcrFiles(Array.from({length:20},()=>f(1))));
 assert.doesNotThrow(()=>validateOcrPageCount(20));
 assert.throws(()=>validateOcrPageCount(21),e=>e.code==='UPLOAD_LIMIT'&&/21.*20/.test(e.message));
 assert.equal(MAX_TOTAL_BYTES,200*1024*1024);assert.equal(MAX_FILES,20);
});

test('接口放宽到20个；超过上传上限或累计保存上限整批拒绝',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-limits-')),{app,store}=createApp({dataDir:dir});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port,{token}=await fetch(base+'/api/bootstrap').then(r=>r.json());
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const post=async(route,body,method='POST')=>{const r=await fetch(base+route,{method,headers:{'x-purchase-token':token,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const form=n=>{const f=new FormData();for(let i=0;i<n;i++)f.append('files',new Blob(['original']),'凭证'+i+'.txt');return f;};
 const health=await fetch(base+'/api/health').then(r=>r.json());assert.equal(health.uploadLimits.files,20);assert.equal(health.uploadLimits.ocrPages,20);
 const tooMany=await post('/api/attachments',form(21));assert.equal(tooMany.status,400);assert.match(tooMany.data.error,/20/);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM order_attachments').get().n,0);
 const uploaded=await post('/api/attachments',form(20));assert.equal(uploaded.status,200);assert.equal(uploaded.data.length,20);
 const order=validateOrder({platform:'微信',account:'测试账号',orderNo:'LIMIT-20',date:'2026-05-01',supplier:'测试供应商',status:'已完成',amountCents:100,items:[{title:'测试商品',qty:1}],attachmentIds:uploaded.data.map(a=>a.id)});
 const saved=await post('/api/orders',order);assert.equal(saved.status,200);const before=store.list()[0];assert.equal(before.attachmentIds.length,20);
 const extra=(await post('/api/attachments',form(1))).data[0];
 const more=await post('/api/orders/'+before.id,{...before,note:'不应保存',attachmentIds:[extra.id]},'PUT');assert.equal(more.status,400);assert.deepEqual(store.get(before.id),before);
 // Exercise aggregate database validation using recorded byte metadata, without allocating 200 MB in the fixture.
 const four=(await post('/api/attachments',form(4))).data;for(const a of four)store.db.prepare('UPDATE order_attachments SET bytes=? WHERE id=?').run(MAX_FILE_BYTES,a.id);
 assert.doesNotThrow(()=>store.attachments.validate(null,four.map(a=>a.id)));
 const totalSaved=await post('/api/orders',{...order,orderNo:'LIMIT-TOTAL',attachmentIds:four.map(a=>a.id)});assert.equal(totalSaved.status,200);
 const previous=store.get(totalSaved.data.id);
 assert.throws(()=>store.attachments.validate(previous.id,[...four.map(a=>a.id),extra.id]),e=>e.code==='UPLOAD_LIMIT'&&/200 MB/.test(e.message));
 const rejected=await post('/api/orders/'+previous.id,{...previous,note:'总量超限',attachmentIds:[extra.id]},'PUT');
 assert.equal(rejected.status,413);assert.equal(rejected.data.code,'UPLOAD_LIMIT');assert.deepEqual(store.get(previous.id),previous);
 assert.equal(await fetch(base+extra.downloadUrl).then(r=>r.text()),'original');
});
