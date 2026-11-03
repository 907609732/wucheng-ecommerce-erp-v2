import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../lib/store.mjs';
import {createPurchaseAgentService} from '../lib/agent-service.mjs';
import {agentDigest,signAgentApproval} from '../lib/agent-approval.mjs';
test('signed review binds real revision, actor, digest and durable transactional receipt',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-agent-')),store=openStore(dir),key='ab'.repeat(32);
 try{
  let version='1';const binding=()=>({dataSetId:'synthetic-ledger',revision:version});
  const service=createPurchaseAgentService({store,key,binding,operations:{'address.save':{prepare:i=>({changes:[{name:i.name}],commitData:{}}),commit:i=>{store.db.prepare('INSERT INTO settings VALUES(?,?)').run('agent-test',i.name);return {saved:i.name};}}}});
  const ctx={actor:{id:'owner',role:'admin',modules:['purchase']},taskId:'task'},p=await service.prepare('address.save',{name:'test'},ctx);
  const sign=(over={})=>signAgentApproval({v:1,approvalId:'review',actorId:'owner',module:'purchase',capabilityId:p.capabilityId,taskId:'task',resultId:'result',resultVersion:1,...binding(),changeDigest:agentDigest({capabilityId:p.capabilityId,input:p.input,commitData:p.commitData,changes:p.changes}),idempotencyKey:'once',issuedAt:Date.now(),expiresAt:Date.now()+30000,...over},key);
  const commitCtx={...ctx,resultId:'result',resultVersion:1,idempotencyKey:'once'};
  await assert.rejects(service.commit(p.id,commitCtx),/人审/);
  await assert.rejects(service.commit(p.id,{...commitCtx,approval:sign({actorId:'other'})}),/变化/);
  version='2';await assert.rejects(service.commit(p.id,{...commitCtx,approval:sign({revision:'1'})}),/账本已变化/);version='1';
  const result=await service.commit(p.id,{...commitCtx,approval:sign()});assert.equal(result.receipt.result.saved,'test');
  assert.deepEqual(await service.commit(p.id,{...commitCtx,approval:sign()}),result);
  assert.deepEqual(service.receipt('once',ctx),result);
  assert.equal(store.db.prepare('SELECT count(*) n FROM settings WHERE key=?').get('agent-test').n,1);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('unknown async commit is recovered only by verified business readback without replay',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-agent-recovery-')),store=openStore(dir),key='cd'.repeat(32),binding=()=>({dataSetId:'recovery-ledger',revision:'1'});let writes=0;
 try{
  const service=createPurchaseAgentService({store,key,binding,operations:{'address.save':{async:true,prepare:()=>({changes:[{action:'save-address'}]}),commit:async i=>{store.db.prepare('INSERT INTO settings VALUES(?,?)').run('recovered-name',i.name);writes++;throw Error('response lost after business commit');},recover:()=>{const row=store.db.prepare('SELECT value FROM settings WHERE key=?').get('recovered-name');return row?{ok:true,verified:true,postVerified:true,name:row.value}:null;}}}});
  const ctx={actor:{id:'owner',role:'admin',modules:['purchase']},taskId:'recover-task'},input={name:'恢复核对'},p=await service.prepare('address.save',input,ctx),now=Date.now();
  const claims={v:1,approvalId:'review-recover',actorId:'owner',module:'purchase',capabilityId:'address.save',taskId:ctx.taskId,resultId:'result',resultVersion:1,...binding(),changeDigest:agentDigest({capabilityId:p.capabilityId,input,commitData:p.commitData,changes:p.changes}),idempotencyKey:'recover-once',issuedAt:now,expiresAt:now+30000};
  const commitCtx={...ctx,resultId:'result',resultVersion:1,idempotencyKey:'recover-once',approval:signAgentApproval(claims,key)};
  await assert.rejects(service.commit(p.id,commitCtx),/response lost/);assert.equal(writes,1);
  const receipt=service.receipt('recover-once',ctx);assert.equal(receipt.state,'completed');assert.equal(receipt.receipt.result.name,input.name);
  assert.deepEqual(await service.commit(p.id,commitCtx),receipt);assert.equal(writes,1);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
