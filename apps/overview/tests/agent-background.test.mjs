import test from 'node:test';
import assert from 'node:assert/strict';
import {settleBackgroundJob,backgroundResult,existingDownload} from '../lib/agent-background.mjs';
import {createOverviewAgentAdapter} from '../lib/agent-adapter.mjs';

test('processing, paused, unknown and cancelled jobs remain blocking with their persistent ID',async()=>{
 for(const status of ['running','processing','paused','cancelled','partial','unknown']){
  const result=await settleBackgroundJob({module:'overview',jobId:'persisted',queryCapability:'overview.cainiao-job',query:async()=>({id:'persisted',status,items:[]}),waitMs:0});
  assert.equal(result.issues[0].blocking,true);assert.equal(result.blocks[0].jobId,'persisted');
 }
 assert.equal(backgroundResult({module:'overview',job:{id:'bad',status:'completed',items:[{status:'completed',fileIds:['missing'],verification:{verified:true}}],files:[]}}).issues[0].blocking,true);
});

test('wait queries the same ID until verified originals exist and supports cancellation',async()=>{
 const ids=[];let count=0;
 const result=await settleBackgroundJob({module:'overview',jobId:'persisted',queryCapability:'overview.cainiao-job',query:async id=>{ids.push(id);return ++count===1?{id,status:'processing'}:{id,status:'completed',items:[{status:'completed',fileIds:['original'],verification:{verified:true}}],files:[{id:'original'}]};},waitMs:1000,pollMs:1});
 assert.deepEqual(ids,['persisted','persisted']);assert.deepEqual(result.issues,[]);
 const controller=new AbortController();controller.abort();await assert.rejects(settleBackgroundJob({module:'overview',jobId:'persisted',query:async()=>({}),ctx:{signal:controller.signal}}),{name:'AbortError'});
});

test('host adapter reuses an unfinished job without issuing another start request',async()=>{
 let starts=0;const transport=async(_module,route)=>{if(route==='/api/integration/v1/agent/prepare'){starts++;throw Error('must not restart');}const capability=new URL(route,'http://localhost').searchParams.get('capabilityId');return capability==='overview.cainiao-jobs'?{data:[{id:'persisted',account:'account',months:['2026-09'],status:'paused'}]}:{id:'persisted',status:'paused',message:'需要登录',items:[],files:[]};};
 const adapter=createOverviewAgentAdapter({transport,backgroundWaitMs:0});const output=await adapter.prepare('overview.cainiao-start',{account:'account',from:'2026-09'},{taskId:'task'});
 assert.equal(starts,0);assert.equal(output.issues[0].blocking,true);assert.equal(output.blocks[0].jobId,'persisted');
 assert.equal(existingDownload([{id:'done',account:'account',months:['2026-09'],status:'completed'}],{account:'account',from:'2026-09'}).id,'done');
});
