import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startCloudControl} from '../desktop/modules/cloud-control.mjs';
import {provisionWorkbenchKey,signWorkbenchActor} from '../desktop/workbench/actor.mjs';

test('native cloud maintenance is owned by a persistent batch; another batch cannot enter, release or commit',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-cloud-maintenance-owner-')),dbFile=path.join(dir,'erp.sqlite'),marker=path.join(dir,'.workbench-maintenance.json');let control;
  try{
    const db=new DatabaseSync(dbFile);db.exec('CREATE TABLE warehouses(id TEXT PRIMARY KEY,name TEXT NOT NULL);');db.close();
    const options={root:dir,dataDir:dir,version:'0.8.0',busy:()=>false,activate:async()=>{},open:async()=>{},stop:()=>{},migration:{databasePath:dbFile,dataDir:dir},business:{startTask:()=>{throw Error('collector forbidden in ownership test');}}};control=await startCloudControl(options);
    const key=provisionWorkbenchKey(dir),token=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
    const request=async(route,{method='POST',body={},actorPatch={}}={})=>{const runtime=JSON.parse(fs.readFileSync(path.join(dir,'.integration-runtime-cloud.json'),'utf8')),target='/api/integration/v1/workbench'+route,now=Date.now(),actor={v:1,id:'tailscale:owner@example.test',login:'owner@example.test',role:'admin',modules:['warehouse'],canRunTasks:true,sessionId:'owner-session',channel:'ui',requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,module:'warehouse',method,path:target,...actorPatch};const response=await fetch(runtime.url+target,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor(actor,key)},...(method==='GET'?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
    const migrationId='native-batch-a',other={id:'tailscale:recovery@example.test',login:'recovery@example.test',sessionId:'recovery-session'};
    assert.equal((await request('/migration/maintenance',{body:{enabled:true}})).status,400);assert.equal((await request('/migration/maintenance',{body:{enabled:true,migrationId}})).status,200);const owner=JSON.parse(fs.readFileSync(marker,'utf8'));assert.equal(owner.actor,'tailscale:owner@example.test');assert.equal(owner.migrationId,migrationId);
    assert.equal((await request('/migration/maintenance',{body:{enabled:true,migrationId:'native-batch-b'},actorPatch:other})).status,409);assert.equal((await request('/migration/maintenance',{body:{enabled:false,migrationId:'native-batch-b'},actorPatch:other})).status,409);
    const bundle=(await request('/migration/export',{method:'GET'})).body,preview=(await request('/migration/preview',{body:{bundle}})).body,plan={migrationId:'native-batch-b',bundle,revision:preview.revision,selections:[]},canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v,digest=createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex'),expiresAt=Date.now()+30000,signature=createHmac('sha256',key).update('workbench-migration/v1:'+digest+':'+expiresAt+':owner-session').digest('hex');assert.equal((await request('/migration/commit',{body:{plan,permit:{digest,expiresAt,signature}}})).status,409);
    assert.equal((await request('/migration/maintenance',{body:{enabled:true,migrationId},actorPatch:other})).status,200);assert.equal(JSON.parse(fs.readFileSync(marker,'utf8')).actor,owner.actor);await control.close();control=await startCloudControl(options);assert.equal((await request('/migration/maintenance',{body:{enabled:false,migrationId:'native-batch-b'},actorPatch:other})).status,409);assert.equal((await request('/migration/maintenance',{body:{enabled:false,migrationId},actorPatch:other})).status,200);
    const clientId='local-source-fixture',local={id:'local-migration:'+clientId,login:'local-migration',sessionId:clientId},sourceId='source-archive-'+clientId;fs.writeFileSync(marker,JSON.stringify({maintenance:true,actor:local.id,migrationId:sourceId,createdAt:new Date().toISOString()}));assert.equal((await request('/jobs',{body:{type:'sync'}})).status,409);assert.equal((await request('/migration/export',{method:'GET',actorPatch:local})).status,200);assert.equal((await request('/migration/maintenance',{body:{enabled:true,migrationId:sourceId},actorPatch:local})).status,200);assert.equal(JSON.parse(fs.readFileSync(marker,'utf8')).actor,local.id);assert.equal((await request('/migration/maintenance',{body:{enabled:false,migrationId:sourceId},actorPatch:other})).status,200);
  }finally{await control?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
