// Deferred to the unified run. This exercises a real fork and real persisted state.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fork} from 'node:child_process';
import {createCanvas} from '@napi-rs/canvas';
import {openStore} from '../lib/store.mjs';import {createPurchaseAgentFiles} from '../lib/agent-files.mjs';
const context=key=>({actor:{id:'cancel-owner',role:'editor',modules:['purchase']},taskId:'cancel-task',idempotencyKey:key});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-cancel-')),store=openStore(dir);let child;
 const files=createPurchaseAgentFiles({store,forkWorker:(...args)=>(child=fork(...args))});
 t.after(()=>{files.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const canvas=createCanvas(1400,1400),c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1400,1400);c.fillStyle='black';c.font='40px sans-serif';c.fillText('ORDER CANCEL 123456',30,100);
 const uploaded=files.upload({filename:'cancel.png',dataBase64:canvas.toBuffer('image/png').toString('base64')},context('upload'));
 return {store,files,uploaded,child:()=>child};}
test('cancel kills actual OCR process, retains original job and ignores late results',{timeout:15000},async t=>{
 const {files,uploaded,child}=fixture(t),start=await files.ops['ocr.start'].execute({fileIds:[uploaded.fileId]},context('start'));
 assert.equal(files.busy(),true);assert.throws(()=>files.ops['ocr.cancel'].execute({jobId:start.data.jobId},{...context('wrong-task'),taskId:'other-task'}),e=>e.code==='OCR_TASK_MISMATCH');
 files.ops['ocr.cancel'].execute({jobId:start.data.jobId},context('cancel'));
 child().emit('message',{result:{text:'late result must never win'}});
 let job;for(let i=0;i<100;i++){job=files.ops['ocr.status'].query({jobId:start.data.jobId},context('status'));if(job.status==='cancelled')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(job.status,'cancelled');assert.equal(job.result,null);assert.equal(files.busy(),false);assert.throws(()=>process.kill(child().pid,0));
 assert.equal(files.metadata(uploaded.fileId,context('metadata')).fileId,uploaded.fileId);
 assert.equal((await files.ops['ocr.start'].execute({fileIds:[uploaded.fileId]},context('start'))).data.jobId,job.jobId);
});
test('cancellation arriving before a lost start persists intent and never forks',{timeout:15000},async t=>{
 const {files,uploaded,child}=fixture(t);files.ops['ocr.cancel'].execute({startRequestKey:'late-start'},context('cancel-before-start'));
 const result=await files.ops['ocr.start'].execute({fileIds:[uploaded.fileId]},context('late-start'));
 assert.equal(result.data.status,'cancelled');assert.equal(child(),undefined);assert.equal(files.busy(),false);
});
