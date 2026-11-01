import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startCloudControl} from '../desktop/modules/cloud-control.mjs';
import {provisionWorkbenchKey,signWorkbenchActor} from '../desktop/workbench/actor.mjs';
import {createWorkbenchMigration} from '../desktop/workbench/warehouse-adapter.mjs';

test('warehouse delegation restricts identity, scope, tasks and retries without touching live data',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-cloud-control-')),calls=[];
  const control=await startCloudControl({root:dir,dataDir:dir,version:'0.7.4',busy:()=>false,activate:async()=>{},open:async()=>{},stop:()=>{},business:{getInventory:async()=>({available:true,items:[{sku:'test-sku',quantity:3}],logPath:'C:/private/log',token:'never-read'}),getMonthlySales:async filters=>({filters}),getTaskState:async()=>({running:false}),startTask:async(type,trigger,options,actor)=>{calls.push({type,trigger,options,actor});return {id:'job-1',running:true};},stopTask:async actor=>({stoppedBy:actor.id}),requestLogin:async actor=>{calls.push({type:'login',actor});return {running:true};},sendLatestValid:async actor=>{calls.push({type:'send-latest-valid',actor});return {sent:true};}}});
  try{
    const runtime=JSON.parse(fs.readFileSync(path.join(dir,'.integration-runtime-cloud.json'),'utf8')),key=provisionWorkbenchKey(dir),token=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
    const request=async(route,{method='GET',body,role='admin',requestId=randomUUID(),canRunTasks=false,actorPatch={}}={})=>{
      const reqPath='/api/integration/v1/workbench'+route,now=Date.now();const actor={v:1,id:'tailscale:owner@example.test',login:'owner@example.test',role,modules:['warehouse'],canRunTasks,sessionId:'session',channel:'ui',requestId,issuedAt:now,expiresAt:now+30000,module:'warehouse',method,path:reqPath,...actorPatch};
      const response=await fetch(runtime.url+reqPath,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor(actor,key)},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};
    };
    assert.equal(runtime.workbench.protocolVersion,1);const inventory=await request('/inventory');assert.equal(inventory.status,200);assert.equal(inventory.body.items[0].quantity,3);assert.equal(inventory.body.token,undefined);assert.equal(inventory.body.logPath,undefined);
    assert.equal((await request('/inventory',{actorPatch:{path:'/other'}})).status,401);
    assert.equal((await request('/jobs',{method:'POST',body:{type:'sync'},role:'viewer'})).status,403);
    assert.equal((await request('/jobs',{method:'POST',body:{type:'sync'},role:'editor'})).status,403);assert.equal(calls.length,0);
    const requestId=randomUUID(),job={type:'monthly-sales',month:'2026-01'};const first=await request('/jobs',{method:'POST',body:job,role:'editor',canRunTasks:true,requestId});const retry=await request('/jobs',{method:'POST',body:job,role:'editor',canRunTasks:true,requestId});assert.equal(first.status,200);assert.deepEqual(retry.body,first.body);assert.equal(calls.length,1);assert.equal(calls[0].actor.id,'tailscale:owner@example.test');assert.equal(calls[0].trigger,'tailscale');
    assert.equal((await request('/jobs',{method:'POST',body:{type:'sync'},requestId})).status,409);
    const login=await request('/host-action',{method:'POST',body:{}});assert.equal(login.body.state,'waiting-host-action');assert.equal(calls.at(-1).type,'login');
    assert.equal((await request('/send-latest-valid',{method:'POST',body:{},role:'admin'})).status,400);assert.equal(calls.filter(c=>c.type==='send-latest-valid').length,0);
    const sendId=randomUUID();assert.equal((await request('/send-latest-valid',{method:'POST',body:{confirmSend:true},requestId:sendId})).status,200);assert.equal((await request('/send-latest-valid',{method:'POST',body:{confirmSend:true},requestId:sendId})).status,200);assert.equal(calls.filter(c=>c.type==='send-latest-valid').length,1);
    const page=await request('/ui');assert.equal(page.status,200);assert.match(page.body,/菜鸟云仓同步/);
    const forged=await fetch(runtime.url+'/api/integration/v1/workbench/inventory',{headers:{'cf-access-authenticated-user-email':'owner@example.test'}});assert.equal(forged.status,401);
  }finally{await control.close();fs.rmSync(dir,{recursive:true,force:true});}
});

const schema=`PRAGMA foreign_keys=ON;CREATE TABLE warehouses(id TEXT PRIMARY KEY,name TEXT NOT NULL);CREATE TABLE skus(sku TEXT PRIMARY KEY,name TEXT NOT NULL,barcode TEXT NOT NULL DEFAULT '');CREATE TABLE inventory_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,sku TEXT NOT NULL REFERENCES skus(sku),warehouse_id TEXT NOT NULL REFERENCES warehouses(id),snapshot_date TEXT NOT NULL,quantity REAL NOT NULL,UNIQUE(sku,warehouse_id,snapshot_date));`;
test('a pending delegated send is busy and prevents lifecycle stop until it finishes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-cloud-busy-'));let release,started;const running=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const control=await startCloudControl({root:dir,dataDir:dir,version:'0.7.4',busy:()=>false,activate:async()=>{},open:async()=>{},stop:()=>{throw Error('must not stop');},business:{sendLatestValid:async()=>{started();await gate;return {sent:true};}}});
  try{const runtime=JSON.parse(fs.readFileSync(path.join(dir,'.integration-runtime-cloud.json'),'utf8')),key=provisionWorkbenchKey(dir),token=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim(),target='/api/integration/v1/workbench/send-latest-valid',now=Date.now(),actor={v:1,id:'tailscale:owner@example.test',login:'owner@example.test',role:'admin',modules:['warehouse'],canRunTasks:true,sessionId:'busy-session',channel:'ui',requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,module:'warehouse',method:'POST',path:target};
    const pending=fetch(runtime.url+target,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor(actor,key)},body:JSON.stringify({confirmSend:true})});await running;
    assert.equal((await (await fetch(runtime.url+'/api/integration/v1/capabilities')).json()).busy,true);const stop=await fetch(runtime.url+'/api/integration/v1/stop',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});assert.equal(stop.status,409);release();assert.equal((await pending).status,200);assert.equal((await (await fetch(runtime.url+'/api/integration/v1/capabilities')).json()).busy,false);
  }finally{release();await control.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('warehouse migration uses natural keys, preserves provenance and verifies an atomic transaction',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-cloud-migration-')),sourcePath=path.join(dir,'client.sqlite'),targetPath=path.join(dir,'server.sqlite');let source,target;
  try{
    for(const file of [sourcePath,targetPath]){const db=new DatabaseSync(file);db.exec(schema);db.close();}
    const db=new DatabaseSync(sourcePath);db.prepare('INSERT INTO warehouses VALUES(?,?)').run('cainiao','菜鸟');db.prepare('INSERT INTO skus VALUES(?,?,?)').run('long-sku','测试商品','12345678901234567890');db.prepare('INSERT INTO inventory_snapshots(sku,warehouse_id,snapshot_date,quantity) VALUES(?,?,?,?)').run('long-sku','cainiao','2026-01-01',17);db.close();
    source=createWorkbenchMigration({databasePath:sourcePath,sourceInstance:'client-a'});target=createWorkbenchMigration({databasePath:targetPath,sourceInstance:'server',canCommit:()=>true});const bundle=source.exportSnapshot(),plan=target.preview(bundle),selections=plan.rows.map(row=>({kind:row.kind,sourceId:row.sourceId,action:'add'}));assert.equal(plan.rows.length,3);assert.notEqual(bundle.sourceInstance,target.exportSnapshot().sourceInstance);const beforeIdentity=target.exportSnapshot().sourceInstance;assert.equal(target.exportSnapshot().sourceInstance,beforeIdentity);const result=await target.commit({bundle,revision:plan.revision,selections},{role:'admin',id:'tailscale:owner@example.test'});assert.equal(result.verification.ok,true);assert.equal(Object.keys(result.idMap).length,3);assert.ok(target.preview(bundle).rows.every(row=>row.action==='duplicate'));
    const reader=new DatabaseSync(targetPath);assert.equal(reader.prepare('SELECT quantity FROM inventory_snapshots').get().quantity,17);assert.equal(reader.prepare('SELECT COUNT(*) n FROM workbench_migration_evidence').get().n,3);reader.prepare('UPDATE skus SET name=? WHERE sku=?').run('later manual edit','long-sku');reader.close();assert.equal(target.preview(bundle).rows.find(row=>row.kind==='skus').action,'conflict');assert.equal(target.verify(result.migrationId).ok,false);
    await assert.rejects(target.commit({bundle,revision:'stale',selections},{role:'admin',id:'owner'}),/变化/);await assert.rejects(target.commit({bundle,revision:result.revision,selections},{role:'viewer',id:'viewer'}),/确认凭据/);
  }finally{source?.close();target?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('warehouse migration rolls back the entire batch when dependencies fail',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-cloud-rollback-')),file=path.join(dir,'server.sqlite'),sourceFile=path.join(dir,'client.sqlite');let migration,source;
  try{const db=new DatabaseSync(file);db.exec(schema);db.close();const client=new DatabaseSync(sourceFile);client.exec(schema+'PRAGMA foreign_keys=OFF;');client.prepare('INSERT INTO warehouses VALUES(?,?)').run('cainiao','菜鸟');client.prepare('INSERT INTO inventory_snapshots(sku,warehouse_id,snapshot_date,quantity) VALUES(?,?,?,?)').run('missing-sku','cainiao','2026-01-01',3);client.close();
    migration=createWorkbenchMigration({databasePath:file,canCommit:()=>true});source=createWorkbenchMigration({databasePath:sourceFile,sourceInstance:'incomplete-client'});const bundle=source.exportSnapshot(),plan=migration.preview(bundle),selections=plan.rows.map(row=>({kind:row.kind,sourceId:row.sourceId,action:'add'}));await assert.rejects(migration.commit({bundle,revision:plan.revision,selections},{role:'admin',id:'owner'}),/FOREIGN KEY/);const check=new DatabaseSync(file);assert.equal(check.prepare('SELECT COUNT(*) n FROM warehouses').get().n,0);assert.equal(check.prepare('SELECT COUNT(*) n FROM workbench_migration_sources').get().n,0);check.close();
  }finally{migration?.close();source?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('warehouse HTTP migration requires a signed permit, preserves maintenance and makes a verified online backup',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-cloud-migration-http-')),targetFile=path.join(dir,'erp.sqlite'),clientFile=path.join(dir,'client.sqlite');let control,source;
  try{
    for(const file of [targetFile,clientFile]){const db=new DatabaseSync(file);db.exec(schema);if(file===clientFile)db.prepare('INSERT INTO warehouses VALUES(?,?)').run('cainiao','迁移测试');db.close();}
    source=createWorkbenchMigration({databasePath:clientFile,sourceInstance:'isolated-client'});const bundle=source.exportSnapshot();
    const options={root:dir,dataDir:dir,version:'0.7.4',busy:()=>false,activate:async()=>{},open:async()=>{},stop:()=>{},migration:{databasePath:targetFile,dataDir:dir},business:{startTask:()=>{throw Error('real collection forbidden in this test');}}};
    control=await startCloudControl(options);
    const key=provisionWorkbenchKey(dir),token=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
    const request=async(route,{method='POST',body={}}={})=>{
      const runtime=JSON.parse(fs.readFileSync(path.join(dir,'.integration-runtime-cloud.json'),'utf8')),target='/api/integration/v1/workbench'+route,now=Date.now(),actor={v:1,id:'tailscale:owner@example.test',login:'owner@example.test',role:'admin',modules:['warehouse'],canRunTasks:true,sessionId:'migration-session',channel:'ui',requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,module:'warehouse',method,path:target};const response=await fetch(runtime.url+target,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor(actor,key)},...(method==='GET'?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};
    };
    const runtimeBefore=JSON.parse(fs.readFileSync(path.join(dir,'.integration-runtime-cloud.json'),'utf8')),capsBefore=await(await fetch(runtimeBefore.url+'/api/integration/v1/capabilities')).json();assert.match(capsBefore.dataSetId,/^[a-f0-9-]{36}$/);assert.match(capsBefore.revision,/^[a-f0-9]{64}$/);const preview=await request('/migration/preview',{body:{bundle}}),plan={migrationId:'cloud-fixture-migration',bundle,revision:preview.body.revision,selections:preview.body.rows.map(row=>({kind:row.kind,sourceId:row.sourceId,action:'add'}))};assert.equal((await request('/migration/commit',{body:{plan,permit:{}}})).status,409);
    assert.equal((await request('/migration/maintenance',{body:{enabled:true,migrationId:'cloud-fixture-migration'}})).status,200);await control.close();control=await startCloudControl(options);assert.equal((await request('/jobs',{body:{type:'sync'}})).status,409);
    const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(key=>[key,canonical(v[key])])):v,digest=createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex'),expiresAt=Date.now()+30000,signature=createHmac('sha256',key).update('workbench-migration/v1:'+digest+':'+expiresAt+':migration-session').digest('hex');
    const result=await request('/migration/commit',{body:{plan,permit:{digest,expiresAt,signature}}});assert.equal(result.status,200);assert.equal(result.body.verification.ok,true);assert.equal((await request('/migration/verify/'+result.body.migrationId,{method:'GET'})).body.ok,true);const runtimeAfter=JSON.parse(fs.readFileSync(path.join(dir,'.integration-runtime-cloud.json'),'utf8')),capsAfter=await(await fetch(runtimeAfter.url+'/api/integration/v1/capabilities')).json();assert.equal(capsAfter.dataSetId,capsBefore.dataSetId);assert.notEqual(capsAfter.revision,capsBefore.revision);
    const saved=await request('/migration/backup');assert.equal(saved.status,200);assert.equal(saved.body.requiresStoppedRestore,true);assert.equal(createHash('sha256').update(fs.readFileSync(saved.body.path)).digest('hex'),saved.body.sha256);assert.equal((await request('/migration/restore')).status,409);assert.equal((await request('/migration/maintenance',{body:{enabled:false,migrationId:'cloud-fixture-migration'}})).status,200);
  }finally{await control?.close();source?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
