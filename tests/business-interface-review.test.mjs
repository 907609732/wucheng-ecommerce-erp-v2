import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBusinessInterface} from '../desktop/business-interface/index.mjs';
const a={id:'windows:owner',channel:'ui'},b={id:'tailscale:second',channel:'ui'};
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'business-review-'));let revision=1,commits=0,known=false;
 const adapter={id:'purchase',capabilities:[{id:'orders.import',kind:'prepare',requiresReview:true,inputSchema:{type:'object',additionalProperties:false}}],binding:async()=>({dataSetId:'copy-ledger',revision}),prepare:async()=>({summary:'Import',commitData:{batch:'one'},changes:[{amountCents:123}],issues:[]}),commit:async()=>{commits++;},receipt:async(key)=>known?{state:'completed',idempotencyKey:key,receipt:{state:'completed',idempotencyKey:key}}:{state:'unknown'}};
 const api=await createBusinessInterface({paths:{profile:root,environment:{mode:'test'}},services:{},identity:{resolveActor:id=>[a,b].find(x=>x.id===id)},adapters:[adapter],transport:{signApproval:async()=>({payload:'proof'})},startBridge:false});
 t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true});});
 const prepare=()=>api.request('prepare',{module:'purchase',capabilityId:'orders.import',input:{}},{actor:a});
 const approve=(review,actor=a,trustedUi=true)=>api.request('reviews.approve',{id:review.id,version:review.version,revision:review.revision,digest:review.digest},{actor,trustedUi});
 return {api,prepare,approve,change:()=>revision++,known:()=>known=true,commits:()=>commits};
}
test('external caller cannot inject confirmation or impersonate a reviewer',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.api.request('prepare',{confirmed:true},{actor:a}),{code:'IDENTITY_INPUT_DENIED'});
 const {review}=await f.prepare();await assert.rejects(()=>f.approve(review,a,false),{code:'HUMAN_REVIEW_REQUIRED'});await assert.rejects(()=>f.approve(review,b),{code:'REVIEW_OWNER_MISMATCH'});assert.equal(f.commits(),0);
});
test('ledger revision changes invalidate a prepared business mutation',async t=>{
 const f=await fixture(t),{review}=await f.prepare();f.change();await assert.rejects(()=>f.approve(review),{code:'REVIEW_DATA_CHANGED'});assert.equal(f.commits(),0);
});
test('unknown commit is never replayed and completes only after receipt readback',async t=>{
 const f=await fixture(t),{review}=await f.prepare(),out=await f.approve(review);assert.equal(out.review.state,'unknown');assert.equal(f.commits(),1);
 await assert.rejects(()=>f.approve(out.review),{code:'REVIEW_STATE_INVALID'});f.known();const result=await f.api.request('receipt',{id:review.id},{actor:a});assert.equal(result.review.state,'completed');assert.equal(f.commits(),1);
});
