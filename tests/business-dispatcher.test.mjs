import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createBusinessInterface} from '../desktop/business-interface/index.mjs';
import {parseCliRequest} from '../desktop/shared/ai-interface.mjs';
import {createWorkbenchDispatcher} from '../desktop/shared/workbench-dispatcher.mjs';
test('CLI parser and dispatcher invoke the real business review interface without a legacy fallback',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'business-dispatch-')),actor={id:'windows:test',channel:'cli'};const api=await createBusinessInterface({paths:{profile:root},services:{},identity:{resolveActor:id=>id===actor.id?actor:null},startBridge:false,transport:{},adapters:[{id:'purchase',capabilities:[{id:'orders.list',kind:'query',inputSchema:{type:'object',additionalProperties:false}}],query:async()=>({rows:[{id:'copied-order',amountCents:125}]})}]});t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true});});
 const dispatch=createWorkbenchDispatcher({executeLegacy:()=>{throw Error('unexpected legacy fallback');},executeBusiness:r=>api.request(r.action,{...r.params,...(r.module?{module:r.module}:{})},{actor,trustedUi:false})});
 const capabilities=await dispatch(parseCliRequest(['business','capabilities','--module=purchase']));assert.equal(capabilities.capabilities[0].id,'orders.list');
 const response=await dispatch(parseCliRequest(['business','query','--module=purchase','--params-json={"capabilityId":"orders.list","input":{}}']));assert.equal(response.result.rows[0].amountCents,125);
 assert.throws(()=>parseCliRequest(['business','reviews.approve']),/不允许审批/);
 await assert.rejects(()=>dispatch({command:'business',action:'reviews.approve',params:{}}),{code:'HUMAN_REVIEW_REQUIRED'});
 await assert.rejects(()=>dispatch({command:'business',action:'prepare',params:{confirmed:true}}),{code:'IDENTITY_INPUT_DENIED'});
});
