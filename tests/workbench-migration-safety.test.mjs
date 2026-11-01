import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {MigrationCoordinator,digest} from '../desktop/workbench-migration/coordinator.mjs';
import {migrationRoutes} from '../desktop/workbench-migration/routes.mjs';
import {ConnectionStore,MODULE_IDS} from '../desktop/workbench-client/connection.mjs';
import {inspectLocalLedgers} from '../desktop/workbench-client/inventory.mjs';
import {collectMigrationSource,freezeMigrationSource,releaseMigrationSource} from '../desktop/workbench-client/migration-source.mjs';
import {createWorkbenchGateway} from '../desktop/workbench/gateway.mjs';
import {provisionWorkbenchKey,verifyWorkbenchActor,signWorkbenchActor} from '../desktop/workbench/actor.mjs';
import {startCloudControl} from '../desktop/modules/cloud-control.mjs';

const origin='https://safety.test-tail.ts.net:8443';
const actor={id:'tailscale:safety@example.test',login:'safety@example.test',sessionId:'safety-ui-session',channel:'ui',role:'admin',modules:['purchase','sales'],canRunTasks:false};
function temp(t,label){const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-safety-'+label+'-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function database(file,main,others){fs.mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);try{db.exec('CREATE TABLE "'+main+'"(id TEXT PRIMARY KEY)');for(const table of others){db.exec('CREATE TABLE "'+table+'"(id TEXT PRIMARY KEY)');db.prepare('INSERT INTO "'+table+'" VALUES(?)').run('business-record');}}finally{db.close();}}
function configurations(root){return Object.fromEntries(MODULE_IDS.map(id=>[id,{root:path.join(root,'programs',id),dataDir:path.join(root,'ledgers',id),db:'ledger.sqlite'}]));}

test('empty main tables retain operations, freight, bills, suppliers and every source module in the migration',async t=>{
 const root=temp(t,'presence'),configs=configurations(root),schema={warehouse:['inventory_snapshots',['monthly_outbound']],purchase:['orders',['supplier_profiles','addresses']],sales:['ledger',['operations','freight_ledger']],overview:['payments',['bills']]};
 for(const [id,[main,others]]of Object.entries(schema)){database(path.join(configs[id].dataDir,configs[id].db),main,others);provisionWorkbenchKey(configs[id].dataDir);fs.writeFileSync(path.join(configs[id].dataDir,'.integration-key'),'a'.repeat(64));}
 const services={config:id=>configs[id]},inventory=inspectLocalLedgers(services);for(const id of Object.keys(schema)){const row=inventory.find(r=>r.module===id);assert(row.present);assert(row.records>0,id+' silently treated as empty');assert.equal(row.counts[schema[id][0]],0);}
 const profile=path.join(root,'profile'),connection=new ConnectionStore(profile);connection.configure({mode:'client',serverUrl:origin},inventory);assert.equal(connection.read().migration.state,'pending');assert.equal(connection.canWrite(),false);
 const exported=[];const server=http.createServer((q,s)=>{try{const id=JSON.parse(Buffer.from(q.headers['x-workbench-actor'],'base64url').toString()).module,key=fs.readFileSync(path.join(configs[id].dataDir,'.workbench-key'),'utf8').trim();verifyWorkbenchActor(q.headers,key,{module:id,method:q.method,path:q.url});assert.equal(q.headers.authorization,'Bearer '+'a'.repeat(64));assert.equal(q.url,'/api/integration/v1/workbench/migration/export');exported.push(id);s.writeHead(200,{'Content-Type':'application/json'});s.end(JSON.stringify({schemaVersion:1,module:id,sourceInstance:'source-'+id,revision:'stable',records:schema[id][1].map(table=>({kind:'evidence',sourceId:table+':1',payload:{table,id:'business-record'},files:[]}))}));}catch(e){s.writeHead(500,{'Content-Type':'application/json'});s.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));services.ensure=async()=>({url:'http://127.0.0.1:'+server.address().port});let staged;
 await collectMigrationSource({services,connection,profile,transport:{request:async(route,options)=>{assert.equal(route,'/migrations');staged=options.body;return {id:'staged'};}}});
 assert.deepEqual(exported.sort(),Object.keys(schema).sort());assert.deepEqual(staged.bundles.map(b=>b.module).sort(),Object.keys(schema).sort());assert(Object.keys(schema).every(id=>connection.read().migration.sourceRevisions[id]));assert.equal(connection.canWrite(),false);
});

test('returning from standalone to the same client URL rechecks newly created local ledgers',t=>{
 const root=temp(t,'reentry'),configs=configurations(root),services={config:id=>configs[id]},connection=new ConnectionStore(path.join(root,'profile'));
 connection.configure({mode:'client',serverUrl:origin},inspectLocalLedgers(services));assert.equal(connection.read().migration.state,'empty');assert.equal(connection.canWrite(),true);
 connection.configure({mode:'standalone'},[]);database(path.join(configs.sales.dataDir,configs.sales.db),'ledger',['operations']);
 connection.configure({mode:'client',serverUrl:origin},inspectLocalLedgers(services));assert.equal(connection.read().migration.state,'pending');assert.equal(connection.canWrite(),false);
 const emptyRoot=path.join(root,'appeared-empty');fs.mkdirSync(emptyRoot);const emptyConfigs=configurations(emptyRoot),emptyServices={config:id=>emptyConfigs[id]},emptyConnection=new ConnectionStore(path.join(emptyRoot,'profile'));emptyConnection.configure({mode:'client',serverUrl:origin},[]);database(path.join(emptyConfigs.purchase.dataDir,emptyConfigs.purchase.db),'orders',[]);emptyConnection.configure({mode:'client',serverUrl:origin},inspectLocalLedgers(emptyServices));assert.equal(emptyConnection.read().migration.state,'pending','an existing empty source still requires explicit staging');
});

function coordinatorFixture(t,label){
 const root=temp(t,label),state={purchase:{revision:1,rows:[],maintenance:false},sales:{revision:1,rows:[],maintenance:false}},actions=[];
 const adapters=Object.fromEntries(['purchase','sales'].map(module=>[module,{
  preview:async bundle=>({revision:String(state[module].revision),rows:bundle.records.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'new',issues:[],proposed:r.payload})),counts:{new:bundle.records.length}}),
  maintenance:async(enabled,_actor,id)=>{actions.push({module,action:enabled?'acquire':'release',id});state[module].maintenance=enabled;},
  backup:async(_actor,id)=>{actions.push({module,action:'backup',id});return structuredClone(state[module]);},
  commit:async(plan,_actor,id)=>{actions.push({module,action:'commit',id});assert.equal(state[module].maintenance,true);state[module].rows.push(...plan.bundle.records.map(r=>r.payload));state[module].revision++;return {verified:true,migrationId:'result-'+module};},
  verify:async()=>{},restore:async(snapshot,_actor,id)=>{actions.push({module,action:'restore',id});state[module]=structuredClone(snapshot);}
 }]));
 const make=()=>new MigrationCoordinator({root,adapters,serverId:'server',dataSetId:'company'}),f={root,state,actions,adapters,make,coordinator:make()};return f;
}
async function approve(f,clientId){const input={clientId,sourceDigest:digest(clientId),bundles:['purchase','sales'].map(module=>({schemaVersion:1,module,sourceInstance:'source-'+module,records:[{kind:'order',sourceId:'order-'+clientId,payload:{amountCents:12345}}]}))};let row=await f.coordinator.stage(input,actor);row=await f.coordinator.select(row.id,{revision:row.revision,selections:Object.fromEntries(input.bundles.map(b=>[b.module,b.records.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'add'}))]))},actor);row=await f.coordinator.confirm(row.id,{revision:row.revision,step:1},actor);return f.coordinator.confirm(row.id,{revision:row.revision,step:2,reviewDigest:row.reviewDigest},actor);}
const commit=(f,row)=>f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},actor);

test('different migration batches cannot share a maintenance window or restore/release its owner',async t=>{
 const f=coordinatorFixture(t,'concurrency'),firstRow=await approve(f,'client-first'),secondRow=await approve(f,'client-second'),original=f.adapters.purchase.maintenance;let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.adapters.purchase.maintenance=async(enabled,a,id)=>{await original(enabled,a,id);if(enabled&&id===firstRow.id){entered();await gate;}};
 const first=commit(f,firstRow);await started;
 try{await assert.rejects(commit(f,secondRow),e=>e.code==='MIGRATION_BUSY');assert.deepEqual(f.actions.filter(a=>a.id===secondRow.id),[],'loser performed maintenance, backup, restore or release');}
 finally{release();await first;}
 assert.equal(f.coordinator.read(firstRow.id).status,'completed');assert.equal(f.state.purchase.rows.length,1);assert.equal(f.state.sales.rows.length,1);
});

test('a failed second release during recovery cannot cause another restore over later human edits',async t=>{
 const f=coordinatorFixture(t,'recover'),row=await approve(f,'client-recovery'),baseCommit=f.adapters.sales.commit,baseRestore=f.adapters.sales.restore;
 f.adapters.sales.commit=async(...args)=>{await baseCommit(...args);throw Error('fixture commit failure');};f.adapters.sales.restore=async()=>{throw Error('fixture initial restore failure');};
 assert.equal((await commit(f,row)).status,'recovery-required');f.adapters.sales.restore=baseRestore;const originalRelease=f.adapters.sales.maintenance;let failRelease=true;
 f.adapters.sales.maintenance=async(enabled,...args)=>{if(!enabled&&failRelease)throw Error('fixture second release failure');return originalRelease(enabled,...args);};
 await assert.rejects(f.coordinator.recover(row.id,actor),/second release failure/);assert.equal(f.state.purchase.maintenance,false);assert.equal(f.coordinator.read(row.id).recoveryMode,'release-only');const restores=f.actions.filter(a=>a.action==='restore').length;
 f.state.purchase.rows.push({note:'human edit after first ledger reopened'});failRelease=false;f.coordinator=f.make();const recovered=await f.coordinator.recover(row.id,actor);
 assert.equal(recovered.status,'rolled-back');assert.equal(f.actions.filter(a=>a.action==='restore').length,restores,'recovery restored a ledger after publishing writes');assert.equal(f.state.purchase.rows.at(-1).note,'human edit after first ledger reopened');assert.equal(f.state.purchase.maintenance,false);assert.equal(f.state.sales.maintenance,false);
});

test('migration assets require an upload by the same person and session even when a global hash exists',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-safety-assets-')),users=['alice@example.test','bob@example.test'],services={config:id=>({root:path.join(root,'modules',id),dataDir:path.join(root,'data',id)}),capabilities:async()=>null,ensure:async()=>{throw Error('stage must not start a business service');}};let gateway;t.after(async()=>{await gateway?.stop();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 gateway=await createWorkbenchGateway({services,storeDir:path.join(root,'gateway'),publicOrigin:origin,port:0,accessPolicy:{schemaVersion:1,users:Object.fromEntries(users.map(login=>[login,{enabled:true,role:'editor',modules:['purchase'],canRunTasks:false}]))},registerRoutes:migrationRoutes(services)});
 async function session(login){const headers={host:new URL(origin).host,'tailscale-user-login':login},response=await gateway.app.inject({url:'/api/workbench/v1/session',headers});assert.equal(response.statusCode,200);return {...headers,cookie:[response.headers['set-cookie']].flat()[0].split(';')[0],origin,'x-workbench-csrf':response.json().csrfToken,'idempotency-key':randomUUID()};}
 const alice=await session(users[0]),bob=await session(users[1]),bytes=Buffer.from('private immutable original'),sha=createHash('sha256').update(bytes).digest('hex'),asset='/api/workbench/v1/migrations/assets/'+sha;
 assert.equal((await gateway.app.inject({url:asset,method:'POST',headers:{...alice,'content-type':'application/octet-stream'},payload:bytes})).statusCode,200);
 const input={clientId:'client-assets',sourceDigest:digest('source-assets'),bundles:[{schemaVersion:1,module:'purchase',sourceInstance:'source-assets',records:[{kind:'order',sourceId:'source-order',payload:{amountCents:123},files:[{id:'attachment-1',filename:'original.txt',sha256:sha,bytes:bytes.length,role:'attachment'}]}]}]};
 const denied=await gateway.app.inject({url:'/api/workbench/v1/migrations',method:'POST',headers:bob,payload:structuredClone(input)});assert.equal(denied.statusCode,403,denied.body);assert.equal(denied.json().code,'ASSET_SCOPE_DENIED');
 const aliceNewSession=await session(users[0]);assert.equal((await gateway.app.inject({url:'/api/workbench/v1/migrations',method:'POST',headers:aliceNewSession,payload:structuredClone(input)})).statusCode,403,'a fresh session inherited another session upload');
 assert.equal((await gateway.app.inject({url:asset,method:'POST',headers:{...bob,'content-type':'application/octet-stream'},payload:bytes})).statusCode,200);
 const accepted=await gateway.app.inject({url:'/api/workbench/v1/migrations',method:'POST',headers:bob,payload:structuredClone(input)});assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().status,'staged');
});

test('actual cloud source freeze retains its owner after changed-source rejection and can resume or explicitly release',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-safety-source-freeze-')),configs=configurations(root),profile=path.join(root,'profile'),source=configs.warehouse,databasePath=path.join(source.dataDir,source.db);let cloud,taskWrites=0;
 t.after(async()=>{await cloud?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 fs.mkdirSync(source.dataDir,{recursive:true});let db=new DatabaseSync(databasePath);db.exec('CREATE TABLE inventory_snapshots(sku TEXT,warehouse_id TEXT,snapshot_date TEXT,quantity INTEGER);INSERT INTO inventory_snapshots VALUES(\'source-sku\',\'source-warehouse\',\'2026-10-01\',1)');db.close();
 cloud=await startCloudControl({root:path.resolve('.'),dataDir:source.dataDir,version:'1.0.0-isolated',busy:()=>false,activate:async()=>{},open:async()=>{},stop:async()=>{},migration:{databasePath,dataDir:source.dataDir},business:{startTask:async(type,from,options,owner)=>{taskWrites++;return {ok:true,type,from,actor:owner.id};}}});
 const runtime=JSON.parse(fs.readFileSync(path.join(source.dataDir,'.integration-runtime-cloud.json'),'utf8')),capabilities=async()=>{const response=await fetch(runtime.url+'/api/integration/v1/capabilities');assert.equal(response.status,200);return response.json();};
 const services={registryFile:path.join(root,'source-registry.json'),config:id=>configs[id],ensure:async id=>{assert.equal(id,'warehouse');return capabilities();},capabilities};fs.writeFileSync(services.registryFile,JSON.stringify(configs));
 const connection=new ConnectionStore(profile);connection.configure({mode:'client',serverUrl:origin},inspectLocalLedgers(services));const staged=[];const transport={request:async(route,options)=>{assert.equal(route,'/migrations');staged.push(structuredClone(options.body));return {id:'staged-'+staged.length};}};
 await collectMigrationSource({services,connection,profile,transport});const sourceInstance=staged[0].bundles[0].sourceInstance,firstDigest=connection.read().migration.sourceDigest;assert.equal((await capabilities()).dataSetId,sourceInstance);
 db=new DatabaseSync(databasePath);db.prepare('UPDATE inventory_snapshots SET quantity=2 WHERE sku=?').run('source-sku');db.close();
 await assert.rejects(freezeMigrationSource(services,connection,profile),/本机旧账本仍有变化/);
 const marker=path.join(source.dataDir,'.workbench-maintenance.json'),owner=JSON.parse(fs.readFileSync(marker,'utf8')),expectedActor='local-migration:'+connection.read().clientId,expectedMigration='source-archive-'+connection.read().clientId;assert.equal(owner.actor,expectedActor);assert.equal(owner.migrationId,expectedMigration);assert.equal((await capabilities()).maintenance,true);
 const task=async()=>{const requestPath='/api/integration/v1/workbench/jobs',key=fs.readFileSync(path.join(source.dataDir,'.workbench-key'),'utf8').trim(),token=fs.readFileSync(path.join(source.dataDir,'.integration-key'),'utf8').trim(),now=Date.now(),delegated={v:1,id:'tailscale:isolated-task@example.test',login:'isolated-task@example.test',role:'editor',modules:['warehouse'],canRunTasks:true,sessionId:'isolated-task-session',channel:'ui',requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,module:'warehouse',method:'POST',path:requestPath};return fetch(runtime.url+requestPath,{method:'POST',headers:{...signWorkbenchActor(delegated,key),Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({type:'sync'})});};
 const blocked=await task();assert.equal(blocked.status,409);assert.equal((await blocked.json()).code,'MODULE_MAINTENANCE');assert.equal(taskWrites,0);
 await collectMigrationSource({services,connection,profile,transport});assert.equal(staged.length,2);assert.equal(staged[1].bundles[0].sourceInstance,sourceInstance);assert.notEqual(connection.read().migration.sourceDigest,firstDigest);await freezeMigrationSource(services,connection,profile);assert.equal(JSON.parse(fs.readFileSync(marker,'utf8')).actor,expectedActor);assert.equal((await capabilities()).dataSetId,sourceInstance);
 await releaseMigrationSource(services,connection,profile);assert.equal(fs.existsSync(marker),false);assert.equal((await capabilities()).maintenance,false);assert.equal(connection.read().migration.state,'pending');const accepted=await task();assert.equal(accepted.status,200,await accepted.clone().text());assert.equal(taskWrites,1,'only the isolated mock task callback may run');
});
