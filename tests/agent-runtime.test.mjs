import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentRuntime} from '../desktop/agent-runtime/index.mjs';
import {signAgentApproval,verifyAgentApproval,agentDigest} from '../desktop/agent-runtime/approval.mjs';
import {createAgentStore} from '../desktop/agent-runtime/store.mjs';
import {createAgentScheduler} from '../desktop/agent-runtime/scheduler.mjs';

const key='a'.repeat(64),actor={id:'employee-a',login:'employee-a@example.test',role:'editor',modules:['sales'],canRunTasks:true,channel:'ui'},admin={...actor,role:'admin'};
async function fixture(t,{unknown=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-runtime-'));let revision=1,commits=0,activeActor=actor;const receipts=new Map();
  const adapter={id:'sales',capabilities:[{id:'read',kind:'query',title:'查询账单',inputSchema:{type:'object',additionalProperties:false}},{id:'import',kind:'prepare',title:'导入账单',inputSchema:{type:'object',properties:{amount:{type:'integer',minimum:0}},required:['amount'],additionalProperties:false}}],binding:async()=>({dataSetId:'ledger-fixture',revision}),query:async()=>({summary:'查询已核对',blocks:[{type:'table',columns:[{key:'amount',label:'金额'}],rows:[{amount:1000}]}],evidence:[{id:'fixture-1'}]}),prepare:async(id,input)=>({summary:'待入账',changes:[{amount:input.amount}],commitData:{amount:input.amount},evidence:[{id:'fixture-1'}]}),commit:async(step,ctx)=>{
    const claims=JSON.parse(Buffer.from(ctx.approval.payload,'base64url').toString());verifyAgentApproval(ctx.approval,key,{actorId:ctx.actor.id,module:'sales',capabilityId:step.capabilityId,taskId:ctx.taskId,resultId:claims.resultId,resultVersion:claims.resultVersion,dataSetId:'ledger-fixture',revision,changeDigest:step.changeDigest,idempotencyKey:ctx.idempotencyKey});
    if(receipts.has(ctx.idempotencyKey))return {receipt:receipts.get(ctx.idempotencyKey)};commits++;revision++;const receipt={id:'receipt-'+commits,amount:step.commitData.amount};receipts.set(ctx.idempotencyKey,receipt);if(unknown)throw Error('lost response');return {receipt};
  },receipt:async id=>receipts.has(id)?{state:'completed',idempotencyKey:id,receipt:receipts.get(id)}:{state:'unknown'}};
  let secret='fixture-api-key';const secretStore={has:()=>!!secret,get:async()=>secret,set:async(n,v)=>{secret=v;},delete:async()=>{secret=null;}};
  const config={storeDir:dir,autoStart:false,resolveActor:async id=>id===activeActor?.id?activeActor:null,adapters:[adapter],secretStore,signApproval:async claims=>signAgentApproval(claims,key)};
  let runtime=createAgentRuntime(config);t.after(async()=>{await runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {get runtime(){return runtime;},adapter,meta:{actor,trustedUi:true},config,get commits(){return commits;},get secret(){return secret;},setActor:value=>activeActor=value,setRevision:value=>revision=value,reopen:async()=>{await runtime.close();runtime=createAgentRuntime(config);},async task(){const {task}=await runtime.request('tasks.create',{goal:'核对测试账单',scope:{modules:['sales']}},{actor,trustedUi:true});runtime.store.update('task',task.id,{status:'running'});return task;},async prepare(task,amount=1000){return runtime.invokeTool(task.id,'erp_prepare',{module:'sales',capabilityId:'import',input:{amount}});},async approve(task){const {review}=await runtime.request('tasks.get',{taskId:task.id},{actor});return runtime.request('reviews.approve',{taskId:task.id,reviewId:review.id,resultVersion:review.resultVersion,revision:review.revision},{actor,trustedUi:true});}};
}
test('human approval binds exact result, actor, dataset, data revision and readback receipt',async t=>{
  const f=await fixture(t),task=await f.task();await f.prepare(task);const {review}=await f.runtime.request('tasks.get',{taskId:task.id},f.meta);
  await assert.rejects(f.runtime.request('reviews.approve',{taskId:task.id,reviewId:review.id,resultVersion:review.resultVersion,revision:review.revision},{actor,trustedUi:false}),{code:'HUMAN_REVIEW_REQUIRED'});
  await assert.rejects(f.runtime.request('reviews.approve',{taskId:task.id,reviewId:review.id,resultVersion:review.resultVersion+1,revision:review.revision},f.meta),{code:'REVIEW_STALE'});
  const done=await f.approve(task);assert.equal(done.task.status,'completed');assert.equal(done.result.receipt.state,'verified');assert.equal(f.commits,1);
  await assert.rejects(f.approve(task));assert.equal(f.commits,1);
});
test('changed source data and revoked employee permission cannot commit',async t=>{
  const f=await fixture(t),task=await f.task();await f.prepare(task);f.setRevision(2);await assert.rejects(f.approve(task),{code:'REVIEW_DATA_CHANGED'});assert.equal(f.commits,0);f.setActor(null);await assert.rejects(f.runtime.request('tasks.get',{taskId:task.id},f.meta),{code:'MEMBER_DENIED'});
});
test('unknown response and host restart reconcile rather than repeat the write',async t=>{
  const f=await fixture(t,{unknown:true}),task=await f.task();await f.prepare(task);const first=await f.approve(task);assert.equal(first.task.status,'unknown');assert.equal(f.commits,1);await f.reopen();const done=await f.runtime.request('tasks.control',{taskId:task.id,action:'resume'},f.meta);assert.equal(done.task.status,'completed');assert.equal(f.commits,1);
});
test('pause preserves frozen review and resume does not repeat preparation',async t=>{
  const f=await fixture(t),task=await f.task();await f.prepare(task);const before=await f.runtime.request('tasks.get',{taskId:task.id},f.meta);await f.runtime.request('tasks.control',{taskId:task.id,action:'pause'},f.meta);const after=await f.runtime.request('tasks.control',{taskId:task.id,action:'resume'},f.meta);assert.equal(after.task.status,'waiting_review');assert.deepEqual(after.review,before.review);assert.equal(f.commits,0);
});
test('two writes to one ledger require fresh review after earlier write changes revision',async t=>{
  const f=await fixture(t),task=await f.task();await f.prepare(task,100);await f.prepare(task,200);const partial=await f.approve(task);assert.equal(partial.task.status,'waiting_input');assert.equal(partial.result.receipt.state,'partial');assert.equal(f.commits,1);assert.equal(partial.task.remainingOperations.length,1);
});
test('public task ids, unsafe Windows filenames, forged identity and invalid capability inputs are rejected',async t=>{
  const f=await fixture(t);await assert.rejects(f.runtime.request('tasks.create',{id:'../../outside',goal:'x'},f.meta),{code:'TASK_ID_FORBIDDEN'});
  for(const name of ['..','NUL','x:stream','a/b','a\\b','CON.txt'])await assert.rejects(f.runtime.request('attachments.upload',{name,bytes:'eA=='},f.meta),{code:'UPLOAD_INVALID'});
  const task=await f.task();await assert.rejects(f.runtime.invokeTool(task.id,'erp_prepare',{module:'sales',capabilityId:'import',actor:{role:'admin'},input:{amount:1}}),{code:'IDENTITY_INPUT_DENIED'});await assert.rejects(f.prepare(task,-1),{code:'CAPABILITY_INPUT_INVALID'});assert.equal(f.commits,0);
});
test('stale company settings do not alter secure API credentials',async t=>{
  const f=await fixture(t);f.setActor(admin);const before=await f.runtime.request('settings.get',{},f.meta);await f.runtime.request('settings.save',{version:before.settings.version,company:{model:'test-model',apiKey:'new-key'}},f.meta);await assert.rejects(f.runtime.request('settings.save',{version:before.settings.version,company:{apiKey:'stale-key'}},f.meta),{code:'AGENT_REVISION_CHANGED'});assert.equal(f.secret,'new-key');assert.equal(JSON.stringify(await f.runtime.request('settings.get',{},f.meta)).includes('new-key'),false);
});
test('approval verifier rejects missing expected bindings, wrong actor/task/digest and expired proof',()=>{
  const claims={v:1,approvalId:'review-1',actorId:'actor-1',module:'sales',capabilityId:'import',taskId:'task-1',resultId:'result-1',resultVersion:1,dataSetId:'dataset-1',revision:2,changeDigest:agentDigest({amount:100}),idempotencyKey:'idempotency-1',issuedAt:1000,expiresAt:60000};const proof=signAgentApproval(claims,key,{now:2000});const expected={...claims};delete expected.issuedAt;delete expected.expiresAt;
  assert.throws(()=>verifyAgentApproval(proof,key,{}, {now:2000}),{code:'AGENT_APPROVAL_EXPECTATION_REQUIRED'});for(const k of ['actorId','taskId','capabilityId','changeDigest'])assert.throws(()=>verifyAgentApproval(proof,key,{...expected,[k]:'wrong'},{now:2000}),{code:'AGENT_APPROVAL_MISMATCH'});assert.throws(()=>verifyAgentApproval(proof,key,expected,{now:60001}),{code:'AGENT_APPROVAL_INVALID'});
});
test('schedule task and occurrence claim roll back together on creation failure',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-schedule-'));const store=createAgentStore(directory);const fixed=Date.parse('2026-10-28T10:00:00Z');
  try{store.insert('schedule',{id:'s1',ownerId:actor.id,goal:'查询',engine:'codex',timezone:'Asia/Shanghai',cron:'0 9 * * *',nextRunAt:new Date(fixed).toISOString(),enabled:true,misfirePolicy:'once',scope:{modules:['sales']}});
    const schedule=createAgentScheduler({store,resolveActor:async()=>actor,now:()=>fixed,next:async()=>new Date(fixed+86400000).toISOString(),createTask(){throw Error('crash before task insert');}});await schedule.tick();assert.equal(store.runs('s1').length,0);assert.equal(store.list('task').length,0);assert.equal(store.get('schedule','s1').enabled,false);
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});
