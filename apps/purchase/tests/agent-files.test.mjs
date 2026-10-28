import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {createCanvas,GlobalFonts} from '@napi-rs/canvas';
import {openStore} from '../lib/store.mjs';
import {createPurchaseAgentFiles} from '../lib/agent-files.mjs';
import {signWorkbenchActor,verifyWorkbenchActor,provisionWorkbenchKey} from '../lib/workbench-actor.mjs';
const owner='agent-test-owner';
const ctx=(key=randomUUID(),id=owner,role='editor')=>({actor:{id,role,modules:['purchase']},idempotencyKey:key,taskId:'agent-file-task'});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-agent-files-')),store=openStore(dir),files=createPurchaseAgentFiles({store,dataDir:dir});t.after(()=>{files.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,files};}
const csv=Buffer.from('订单编号,下单日期,供应商,商品名称,实付金额\nAGENTFILE001,2026-06-05,测试供应商,螺丝,123.45\n');
const put=(files,buffer=csv,name='采购原件.csv',c=ctx())=>files.upload({filename:name,dataBase64:buffer.toString('base64')},c);
test('real signed HTTP upload owns opaque files, rejects paths, encoding, size, viewer and forged actor',async t=>{
 const {dir,files}=fixture(t),app=express(),key=provisionWorkbenchKey(dir);app.use(express.json({limit:'12mb'}));
 files.installRoutes(app,q=>{const actor=verifyWorkbenchActor(q.headers,key,{module:'purchase',method:q.method,path:q.originalUrl});return {actor,idempotencyKey:q.headers['x-idempotency-key']};});app.use((e,q,r,n)=>r.status(e.status||e.statusCode||400).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 async function call(route,body,{id=owner,role='editor',signature=true,requestKey=randomUUID()}={}){const now=Date.now(),method=body?'POST':'GET',actor={v:1,module:'purchase',method,path:route,issuedAt:now,expiresAt:now+30000,id,login:id,role,modules:['purchase'],canRunTasks:false,channel:'mcp',sessionId:'files-test',requestId:randomUUID()},r=await fetch(base+route,{method,headers:{'content-type':'application/json','x-idempotency-key':requestKey,...(signature?signWorkbenchActor(actor,key):{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer())};}
 const payload={filename:'原件.csv',dataBase64:csv.toString('base64')},saved=await call('/agent/files',payload,{requestKey:'same-upload'});assert.equal(saved.status,200);assert.match(saved.body.sha256,/^[a-f0-9]{64}$/);assert.equal(saved.body.bytes,csv.length);assert.equal(JSON.stringify(saved.body).includes(dir),false);
 assert.deepEqual((await call('/agent/files',payload,{requestKey:'same-upload'})).body,saved.body);assert.equal((await call('/agent/files/'+saved.body.fileId,undefined,{signature:false})).status,401);
 assert.equal((await call('/agent/files/'+saved.body.fileId,undefined,{id:'other'})).status,404);assert.deepEqual((await call('/agent/files/'+saved.body.fileId+'/download')).body,csv);
 for(const filename of ['../secret.csv','C:\\secret.csv'])assert.equal((await call('/agent/files',{...payload,filename})).status,400);
 assert.equal((await call('/agent/files',{...payload,dataBase64:'not base64'})).status,413);assert.equal((await call('/agent/files',payload,{role:'viewer'})).status,403);assert.throws(()=>put(files,Buffer.alloc(8*1024*1024+1)),/8MiB/);
});
test('persistent table analyze/remap/review imports real source once, isolates owners and cleans external rollback files',async t=>{
 const {files,store,dir}=fixture(t),file=put(files),analyzed=await files.ops['import.analyze'].execute({fileId:file.fileId,platform:'微信',account:'测试采购号'},ctx()),preview=analyzed.data;assert.equal(preview.summary.ready,1);assert.equal(store.list().length,0);
 files.close();const reopened=createPurchaseAgentFiles({store,dataDir:dir});t.after(()=>reopened.close());assert.equal(reopened.ops['import.preview'].query({previewId:preview.previewId},ctx()).summary.ready,1);assert.throws(()=>reopened.metadata(file.fileId,ctx('other','other')),/不属于/);
 const mapped=await reopened.ops['import.remap'].execute({previewId:preview.previewId,mapping:preview.mapping,account:'新采购号'},ctx());assert.equal(mapped.data.account,'新采购号');
 const detail=reopened.ops['import.commit'].prepare({previewId:preview.previewId,indices:[0]},ctx());assert.equal(detail.commitData.orders[0].order.amountCents,12345);let cleanup;assert.throws(()=>store.transaction(()=>{reopened.ops['import.commit'].commit({},detail.commitData,{...ctx(),onRollback:fn=>cleanup=fn});throw Error('outer receipt failed');}),/outer receipt failed/);cleanup();assert.equal(store.list().length,0);assert.equal(fs.readdirSync(path.join(dir,'originals')).length,0);
 const result=store.transaction(()=>reopened.ops['import.commit'].commit({},detail.commitData,ctx()));assert.equal(result.imported,1);assert.deepEqual(fs.readFileSync(path.join(dir,store.db.prepare('SELECT file_path FROM imports').get().file_path)),csv);assert.equal(reopened.ops['import.preview'].query({previewId:preview.previewId},ctx()).summary.duplicate,1);assert.throws(()=>reopened.ops['import.commit'].prepare({previewId:preview.previewId,indices:[0]},ctx()),/重复/);assert.equal(store.imports()[0].metadata.importReport.imported,1);
});
test('real local OCR persists progress/result, preserves originals as order attachments and marks restart interruption',{timeout:120000},async t=>{
 const {files,store,dir}=fixture(t);GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','AgentChinese');const canvas=createCanvas(1500,1000),c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1500,1000);c.fillStyle='#111';c.font='42px AgentChinese';['订单号: AGENTOCR20261028001','日期: 2026-10-16','供应商: 五金配件店','商品: 螺丝','数量: 2','实付金额: 123.45'].forEach((l,i)=>c.fillText(l,80,100+i*120));const buffer=canvas.toBuffer('image/png'),file=put(files,buffer,'采购单.png'),start=await files.ops['ocr.start'].execute({fileIds:[file.fileId]},ctx('ocr-start'));
 const again=await files.ops['ocr.start'].execute({fileIds:[file.fileId]},ctx('ocr-start'));assert.equal(again.data.jobId,start.data.jobId);let job;for(let i=0;i<500;i++){job=files.ops['ocr.status'].query({jobId:start.data.jobId},ctx());if(job.status!=='running')break;await new Promise(r=>setTimeout(r,150));}assert.equal(job.status,'done',job.error);assert.equal(job.progress,100);assert.equal(job.result.order.amountCents,12345);assert.equal(store.list().length,0);
 const input={jobId:job.jobId,order:{...job.result.order,platform:'微信',account:'OCR测试号',status:'已完成'}},detail=await files.ops['ocr.commit'].prepare(input,ctx('ocr-stage'));const result=store.transaction(()=>files.ops['ocr.commit'].commit(input,detail.commitData,ctx()));assert.equal(result.imported,1);const order=store.list()[0];assert.equal(order.amountCents,12345);assert.equal(order.attachmentIds.length,1);assert.deepEqual(fs.readFileSync(store.attachments.resource(order.attachmentIds[0],'full').path),buffer);
 const pending={jobId:'interrupted-synthetic-state',status:'running',progress:45};store.db.prepare('INSERT INTO agent_ocr_jobs VALUES(?,?,?)').run(pending.jobId,owner,JSON.stringify(pending));const reopened=createPurchaseAgentFiles({store,dataDir:dir});t.after(()=>reopened.close());assert.equal(reopened.ops['ocr.status'].query({jobId:pending.jobId},ctx()).status,'interrupted');assert.equal(reopened.ops['ocr.status'].query({jobId:job.jobId},ctx()).result.order.amountCents,12345);
});

test('locks and content hashes reject stale or damaged source without creating original files',async t=>{
 const {files,store,dir}=fixture(t),file=put(files),p=(await files.ops['import.analyze'].execute({fileId:file.fileId,platform:'微信'},ctx())).data;
 const prepared=files.ops['import.commit'].prepare({previewId:p.previewId,indices:[0]},ctx());
 await store.monthLocks.setPassword({password:'Agent-files-isolated-29487',confirmation:'Agent-files-isolated-29487'});store.monthLocks.confirm(store.monthLocks.preview('2026-06','微信'));
 assert.equal(files.ops['import.preview'].query({previewId:p.previewId},ctx()).summary.locked,1);assert.throws(()=>files.ops['import.commit'].prepare({previewId:p.previewId,indices:[0]},ctx()),/锁定/);assert.throws(()=>store.transaction(()=>files.ops['import.commit'].commit({},prepared.commitData,ctx())),{code:'MONTH_LOCKED'});assert.equal(fs.readdirSync(path.join(dir,'originals')).length,0);assert.equal(store.list().length,0);
 fs.writeFileSync(path.join(dir,'agent-files',file.fileId),'tampered');assert.throws(()=>files.resource(file.fileId,ctx()),/摘要不符/);
});
