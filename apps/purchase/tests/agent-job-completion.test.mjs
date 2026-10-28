// Completion-contract cases; execution is deferred to the coordinated full run.
import test from 'node:test';import assert from 'node:assert/strict';
import {createPurchaseAgentAdapter} from '../lib/agent-adapter.mjs';
test('OCR start follows the same persisted job to a terminal result instead of reporting started as complete',async()=>{
 let starts=0,queries=0;
 const transport=async(_module,_route,{body})=>{
  if(body.capabilityId==='ocr.start'){starts++;return {requiresReview:false,summary:'started',data:{jobId:'job-1',status:'running'},blocks:[],evidence:[]};}
  queries++;assert.equal(body.input.jobId,'job-1');return {summary:'status',data:{jobId:'job-1',status:queries<2?'running':'done',progress:queries<2?50:100,result:{text:'recognized'}},blocks:[],evidence:[]};
 };
 const adapter=createPurchaseAgentAdapter({transport,pollIntervalMs:1,jobWaitMs:1000}),result=await adapter.prepare('ocr.start',{fileIds:['file-1']},{taskId:'task',idempotencyKey:'once'});
 assert.equal(starts,1);assert.equal(queries,2);assert.equal(result.data.status,'done');assert.equal(result.issues.some(i=>i.blocking),false);assert.equal(result.evidence.at(-1).complete,true);
});
test('processing and interrupted OCR remain blocking with query ID; AbortSignal cancels polling without restarting job',async()=>{
 let starts=0;
 const transport=async(_module,_route,{body})=>{if(body.capabilityId==='ocr.start')starts++;return {summary:'status',data:{jobId:'job-2',status:'running',progress:20},blocks:[],evidence:[]};};
 const adapter=createPurchaseAgentAdapter({transport,jobWaitMs:0}),pending=await adapter.prepare('ocr.start',{fileIds:['file-2']},{taskId:'task',idempotencyKey:'once'});
 assert.equal(pending.issues[0].blocking,true);assert.equal(pending.issues[0].jobId,'job-2');assert.deepEqual(pending.blocks.at(-1).nextInput,{jobId:'job-2'});
 const stopped=await createPurchaseAgentAdapter({transport:async()=>({data:{jobId:'job-2',status:'interrupted'},blocks:[],evidence:[]})}).query('ocr.status',{jobId:'job-2'},{});assert.equal(stopped.issues[0].blocking,true);
 const controller=new AbortController();controller.abort();await assert.rejects(createPurchaseAgentAdapter({transport,pollIntervalMs:1}).prepare('ocr.start',{fileIds:['file-2']},{taskId:'task',idempotencyKey:'same-job',signal:controller.signal}),e=>e.name==='AbortError');assert.equal(starts,2);
});
