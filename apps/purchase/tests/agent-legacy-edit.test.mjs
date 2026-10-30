// Deferred to unified verification. Uses the real draft writer, backup and ledger.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openStore} from '../lib/store.mjs';import {installPurchaseEdits} from '../lib/integration-edits.mjs';import {validateOrder} from '../lib/importer.mjs';
import {createPurchaseAgentService} from '../lib/agent-service.mjs';import {signAgentApproval,agentDigest} from '../lib/agent-approval.mjs';
test('legacy pending edit is centrally reviewed without a UI session and persists verified one-time result',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-old-edit-')),store=openStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const edits=installPurchaseEdits({router:{get(){},post(){}},requireReview(){}},store),order=store.insert(validateOrder({platform:'微信',account:'测试账号',orderNo:'OLD-EDIT',date:'2020-01-01',supplier:'合成店',amountCents:10000,items:[{title:'测试商品',qty:1}]}));
 const draft=edits.create({type:'order',target:order.id,patch:{refundCents:100},reason:'原始退款凭证复核'}),ctx={actor:{id:'owner',role:'admin',modules:['purchase']},taskId:'task'},key='ab'.repeat(32),binding=()=>({dataSetId:'synthetic',revision:'1'});
 assert.throws(()=>edits.commitAgent(draft.id,draft.revision,ctx),/中央/);
 const op={async:true,prepare:i=>{const d=edits.previewAgent(i.id,i.revision);return {changes:[{before:d.before,after:d.proposed}],commitData:{revision:d.revision}};},commit:(i,d,c)=>edits.commitAgent(i.id,d.revision,c)};
 const service=createPurchaseAgentService({store,key,binding,operations:{'edit.commit':op}}),input={id:draft.id,revision:draft.revision},prepared=await service.prepare('edit.commit',input,ctx),now=Date.now();
 const claims={v:1,approvalId:'central',actorId:'owner',module:'purchase',capabilityId:'edit.commit',taskId:'task',resultId:'result',resultVersion:1,...binding(),changeDigest:agentDigest({capabilityId:'edit.commit',input,commitData:prepared.commitData,changes:prepared.changes}),idempotencyKey:'once',issuedAt:now,expiresAt:now+30000};
 const commitCtx={...ctx,resultId:'result',resultVersion:1,idempotencyKey:'once',approval:signAgentApproval(claims,key)};
 const result=await service.commit(prepared.id,commitCtx);assert.equal(result.receipt.result.verified,true);assert.equal(store.get(order.id).refundCents,100);assert.equal(edits.get(draft.id).state,'committed');
 assert.deepEqual(await service.commit(prepared.id,commitCtx),result);const event=JSON.parse(store.db.prepare("SELECT payload FROM integration_edit_events WHERE action='confirmed-and-committed'").get().payload);assert.equal(event.session,null);assert.equal(event.approvalId,'central');
});
