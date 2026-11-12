import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startCollector} from '../server/collector.mjs';
import {CollectorBrowser} from '../server/collector-client.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,run,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collector-shared-'));
 const modules=Object.fromEntries(['sales','overview'].map(id=>[id,{dataDir:path.join(dir,id)}]));
 const helper=await startCollector({modules,native:{dataRoot:dir,browser:{enabled:true,shared:true}}},{...options,factory:async(id,dataDir)=>({dir:path.join(dataDir,'.cainiao-staging'),status:()=>({status:'connected',account:'fixture'}),connect:async()=>({status:'connected'}),disconnect:async()=>{},run:(op,args)=>run(id,op,args)})});
 t.after(async()=>{await helper.stop();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,modules,helper,sales:new CollectorBrowser(modules.sales.dataDir),overview:new CollectorBrowser(modules.overview.dataDir)};
}
test('shared collector serializes complete operations and keeps connected while queued',async t=>{
 const began=deferred(),finish=deferred(),events=[];
 const f=await fixture(t,async(id)=>{events.push(id);if(id==='sales'){began.resolve();await finish.promise;}return id;});
 const a=f.sales.run('tasks');await began.promise;
 const b=f.overview.run('tasks');b.catch(()=>{});await new Promise(r=>setTimeout(r,40));
 const observed=[...events],state=f.overview.status();finish.resolve();
 assert.deepEqual(await Promise.all([a,b]),['sales','overview']);assert.deepEqual(observed,['sales']);assert.equal(state.status,'connected');assert.equal(state.coordination.state,'queued');
});
test('aborted queued HTTP request cannot execute later work',async t=>{
 const began=deferred(),finish=deferred(),events=[];
 const f=await fixture(t,async id=>{events.push(id);if(id==='sales'){began.resolve();await finish.promise;}return id;});
 const a=f.sales.run('tasks');await began.promise;
 const info=f.overview.info(),controller=new AbortController();
 const pending=fetch(info.url,{method:'POST',headers:{authorization:'Bearer '+info.token},body:JSON.stringify({action:'run',args:{op:'tasks',args:{},timeout:90000},deadline:Date.now()+10000}),signal:controller.signal});
 const result=pending.then(r=>r.status,()=>null);await new Promise(r=>setTimeout(r,30));controller.abort();await result;
 await new Promise(r=>setTimeout(r,30));finish.resolve();await a;await new Promise(r=>setTimeout(r,30));assert.deepEqual(events,['sales']);
});
test('submission lease spans RPCs and unresolved submissions block a different item after restart',async t=>{
 const events=[];const f=await fixture(t,async(id,op)=>{events.push(id+':'+op);return [];});
 assert.equal(typeof f.sales.acquireSubmission,'function');
 const release=await f.sales.acquireSubmission({key:'job-a:2026-09:fees',account:'fixture'});
 await f.sales.run('tasks');await f.sales.run('submit');
 let later=false;const query=f.overview.run('tasks').then(()=>{later=true;});await new Promise(r=>setTimeout(r,30));assert.equal(later,false);
 await release({unresolved:true});await query;
 await assert.rejects(f.overview.acquireSubmission({key:'job-b:2026-09:fees',account:'fixture'}),/核对.*任务|任务.*核对/);
 const recovered=await f.sales.acquireSubmission({key:'job-a:2026-09:fees',account:'fixture'});await f.sales.run('tasks');await recovered();
 const next=await f.overview.acquireSubmission({key:'job-b:2026-09:fees',account:'fixture'});await next();
 assert.deepEqual(events,['sales:tasks','sales:submit','overview:tasks','sales:tasks']);
});
test('shared collector rejects submission without its own current lease',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return {};});
 await assert.rejects(f.sales.run('submit'),/提交.*占用|租约|lease/);assert.equal(calls,0);
});
test('expired queued request is removed before any browser action',async t=>{
 const began=deferred(),finish=deferred(),events=[];
 const f=await fixture(t,async id=>{events.push(id);if(id==='sales'){began.resolve();await finish.promise;}return id;});
 const first=f.sales.run('tasks');await began.promise;
 const info=f.overview.info();const response=await fetch(info.url,{method:'POST',headers:{authorization:'Bearer '+info.token},body:JSON.stringify({action:'run',args:{op:'tasks',timeout:90000},deadline:Date.now()+80})});
 finish.resolve();await first;assert.equal(response.status,409);assert.match((await response.json()).error,/尚未开始/);assert.deepEqual(events,['sales']);
});
test('unresolved submission survives helper restart and only the original item can recover',async t=>{
 const f=await fixture(t,async()=>[]);
 const release=await f.sales.acquireSubmission({key:'job-restart:fees',account:'fixture'});await f.sales.run('submit');await release({unresolved:true});await f.helper.stop();
 const second=await startCollector({modules:f.modules,native:{dataRoot:f.dir,browser:{enabled:true,shared:true}}},{factory:async(_id,dir)=>({dir,status:()=>({status:'connected'}),disconnect:async()=>{},run:async()=>[]})});
 try{
  const sales=new CollectorBrowser(f.modules.sales.dataDir),overview=new CollectorBrowser(f.modules.overview.dataDir);
  await assert.rejects(overview.acquireSubmission({key:'job-other:fees',account:'fixture'}),/核对/);
  const recovered=await sales.acquireSubmission({key:'job-restart:fees',account:'fixture'});await sales.run('tasks');await recovered();
  const next=await overview.acquireSubmission({key:'job-other:fees',account:'fixture'});await next();
 }finally{await second.stop();}
});
test('failed adapter isolation blocks the next module before it touches the shared browser',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;throw Object.assign(Error('无法确认浏览器操作停止'),{code:'BROWSER_ISOLATION_FAILED'});},{onError:()=>{}});
 await assert.rejects(f.sales.run('tasks'),/无法确认/);await assert.rejects(f.overview.run('tasks'),/无法确认/);assert.equal(calls,1);assert.equal(f.helper.status().ok,false);
 await f.sales.disconnect();await f.overview.disconnect();
});
test('disconnect during a submitted item permits idempotent cleanup and preserves unresolved reservation',async t=>{
 const f=await fixture(t,async()=>[]);const release=await f.sales.acquireSubmission({key:'job-drain:fees',account:'fixture'});
 await f.sales.run('submit');await f.sales.disconnect();await release({unresolved:true});
 await assert.rejects(f.overview.acquireSubmission({key:'other:fees',account:'fixture'}),/核对/);
});
test('persisted task binding recovers a lost release acknowledgement',async t=>{
 const f=await fixture(t,async()=>[]);
 await f.sales.acquireSubmission({key:'bound-job:fees',account:'fixture'});await f.sales.run('submit');
 const resumed=new CollectorBrowser(f.modules.sales.dataDir);
 assert.equal(typeof resumed.settleSubmission,'function');
 await resumed.settleSubmission({key:'unrelated:fees',account:'fixture',proof:'task-bound'});
 await resumed.settleSubmission({key:'bound-job:fees',account:'fixture',proof:'task-bound'});
 const next=await f.overview.acquireSubmission({key:'next:fees',account:'fixture'});await next();
});
test('recovering an older uncertain job reserves its existing submission before any new RPC submit',async t=>{
 const f=await fixture(t,async()=>[]);const release=await f.sales.acquireSubmission({key:'old-job:fees',account:'fixture',recovering:true});
 await f.sales.run('tasks');await release({unresolved:true});
 await assert.rejects(f.overview.acquireSubmission({key:'new-job:fees',account:'fixture'}),/核对/);
});

