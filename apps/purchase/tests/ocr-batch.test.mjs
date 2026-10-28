import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCanvas,GlobalFonts} from '@napi-rs/canvas';
import {Open} from 'unzipper';
import {createApp} from '../server.mjs';
import {modelDir} from '../lib/ocr.mjs';
import {validateOcrFiles,clipboardImages} from '../public/ocr-files.mjs';

test('图片粘贴兼容 files 和 items，同时保留多张图片而不拦截纯文字',()=>{
 const a={type:'image/png'},b={type:'image/jpeg'};
 assert.deepEqual(clipboardImages({files:[a,b]}),[a,b]);
 const explorerImage={name:'采购单.png',type:''};assert.deepEqual(clipboardImages({files:[explorerImage]}),[explorerImage]);
 assert.deepEqual(clipboardImages({items:[{kind:'file',type:a.type,getAsFile:()=>a},{kind:'file',type:b.type,getAsFile:()=>b}]}),[a,b]);
 assert.deepEqual(clipboardImages({items:[{kind:'string',type:'text/plain'}]}),[]);
 assert.throws(()=>validateOcrFiles(Array.from({length:21},()=>({name:'x.png',size:1}))),/20/);
 assert.throws(()=>validateOcrFiles([{name:'x.png',size:51*1024*1024}]),/50 MB/);
 assert.throws(()=>validateOcrFiles(Array.from({length:5},()=>({name:'x.png',size:41*1024*1024}))),/200 MB/);
 assert.throws(()=>validateOcrFiles([{name:'x.html',size:10}]),/支持/);
});

const ready=['chi_sim','eng'].every(l=>fs.existsSync(path.join(modelDir,l+'.traineddata')))&&fs.existsSync('C:/Windows/Fonts/msyh.ttc');
test('两张中文图片真实识别后才入账，保留两张原图，拒绝多订单混入', {skip:!ready,timeout:120000},async()=>{
 GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','OcrTestChinese');
 const image=lines=>{const c=createCanvas(1500,750),ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1500,750);ctx.fillStyle='#111';ctx.font='42px OcrTestChinese';lines.forEach((line,i)=>ctx.fillText(line,80,110+i*100));return c.toBuffer('image/png');};
 const first=image(['采购订单','订单号: PO20261013001','供应商: 五金配件店','日期: 2026-10-13']);
 const second=image(['商品: 门锁配件','数量: 2','实付金额: 128.50']);
 fs.mkdirSync('.tmp',{recursive:true});fs.writeFileSync('.tmp/ocr-batch-1.png',first);fs.writeFileSync('.tmp/ocr-batch-2.png',second);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-ocr-batch-')),{app,store}=createApp({dataDir:dir});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const boot=await fetch(base+'/api/bootstrap').then(r=>r.json());
  const post=async(p,body)=>{const r=await fetch(base+p,{method:'POST',headers:{'x-purchase-token':boot.token,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const form=images=>{const f=new FormData();images.forEach((b,i)=>f.append('file',new Blob([b],{type:'image/png'}),`采购单-${i+1}.png`));return f;};
  const poll=async id=>{for(let i=0;i<300;i++){const job=await fetch(base+'/api/ocr/'+id).then(r=>r.json());if(job.status!=='running')return job;await delay(150);}throw Error('OCR timed out');};
  const started=await post('/api/ocr',form([first,second]));assert.equal(started.status,200);assert.equal(store.list().length,0);
  const job=await poll(started.data.id);assert.equal(job.status,'done',job.error);assert.equal(job.fileCount,2);assert.equal(store.list().length,0);
  assert.equal(job.result.order.orderNo,'PO20261013001');assert.equal(job.result.order.date,'2026-10-13');assert.equal(job.result.order.amountCents,12850);assert.match(job.result.order.supplier,/五金/);assert.equal(job.result.order.items[0].qty,2);assert.match(job.result.text,/门锁/);
  const badAttachment=await post('/api/orders',{...job.result.order,status:'已完成',ocrJobId:job.id,attachmentIds:['missing']});assert.equal(badAttachment.status,409);assert.equal(store.list().length,0);assert.equal(fs.readdirSync(path.join(dir,'originals')).length,0);
  const documents=new FormData();documents.append('files',new Blob(['supplementary invoice'],{type:'text/plain'}),'invoice.txt');
  const uploaded=await post('/api/attachments',documents);assert.equal(uploaded.status,200);
  const saved=await post('/api/orders',{...job.result.order,status:'已完成',classification:{mode:'single',category:'expense',owner:'company'},ocrJobId:job.id,attachmentIds:uploaded.data.map(a=>a.id)});assert.equal(saved.status,200);assert.equal(store.list().length,1);assert.equal(saved.data.classification.category,'expense');assert.equal(saved.data.order.classification.category,'expense');assert.equal(store.list()[0].classification.category,'expense');
  const attachment=uploaded.data[0];assert.equal(await fetch(base+attachment.downloadUrl).then(r=>r.text()),'supplementary invoice');
  assert.equal(store.db.prepare('SELECT order_id FROM order_attachments WHERE id=?').get(attachment.id).order_id,store.list()[0].id);
  const original=JSON.parse(store.db.prepare('SELECT original FROM orders').get().original);assert.equal(original.documents.length,2);
  const source=Buffer.from(await fetch(base+'/api/source/'+store.list()[0].sourceId).then(r=>r.arrayBuffer()));const archive=await Open.buffer(source);assert.equal(archive.files.length,2);assert.deepEqual(await archive.files[0].buffer(),first);assert.deepEqual(await archive.files[1].buffer(),second);
  const failed=await post('/api/ocr',form([first,image(['采购订单','订单号: PO20261013999','商品: 螺丝','实付金额: 9.00'])]));assert.equal(failed.status,200);const mismatch=await poll(failed.data.id);assert.equal(mismatch.status,'failed');assert.match(mismatch.error,/不同订单/);assert.equal(store.list().length,1);
  assert.equal((await post('/api/orders',{...job.result.order,orderNo:'SHOULD-NOT-SAVE',ocrJobId:mismatch.id})).status,400);assert.equal(store.list().length,1);
 }finally{await new Promise(r=>server.close(r));store.close();assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),'purchase-ocr-batch-')));fs.rmSync(dir,{recursive:true,force:true});}
});
