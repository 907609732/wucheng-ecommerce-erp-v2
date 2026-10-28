import {exportOrders} from '../src/core/exporter';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {createExporterAgentAdapter,exporterSchemas,exporterLabels,validateExporterInput} from '../src/main/agent-adapter.mjs';
import {signAgentApproval,agentDigest,approvalHeaders} from '../src/main/agent-approval.mjs';
import {afterEach,describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {Store} from '../src/core/store';
import {installLocalIntegration} from '../src/main/local-integration.mjs';
import {installExporterWorkbench} from '../src/main/workbench-server';
import {createWorkbenchMigration} from '../src/main/workbench-migration';
import {installWorkbenchMigration} from '../src/main/workbench-migration-routes.mjs';
import {provisionWorkbenchKey,signWorkbenchActor,type WorkbenchActor} from '../src/main/workbench-auth.mjs';
const express=createRequire(import.meta.url)('express');
const resources:{dir:string;store:Store;server?:Server}[]=[];
afterEach(async()=>{for(const r of resources.splice(0)){if(r.server)await new Promise<void>(resolve=>r.server!.close(()=>resolve()));r.store.close();fs.rmSync(r.dir,{recursive:true,force:true});}});
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-exporter-workbench-'));const store=new Store(path.join(dir,'orders.sqlite'));const resource={dir,store,server:undefined as Server|undefined};resources.push(resource);return resource;}
async function api({realExport=false}={}){
  const fixtureData=fixture(),{dir,store}=fixtureData,app=express(),calls:string[]=[];
  const getDataSetIdentity=createWorkbenchMigration(store).getDataSetIdentity;
  const integration=installLocalIntegration(app,{id:'lingtu-order-export',root:dir,dataDir:dir,version:'0.2.0',getDataSetIdentity});
  const workbench=installExporterWorkbench(integration.router,store,{dataDir:dir,version:'0.2.0',getDataSetIdentity,handlers:{busy:()=>false,changed:()=>{},invoke:(name,...args)=>{calls.push(name);if(name==='start')return store.create(args[0] as any);if(name==='executionLogs')return [];},exportFile:async(_input,directory)=>{if(realExport)return exportOrders(store.get(_input.taskId),store.orders(_input.taskId),directory,_input.format,_input.images);const file=path.join(directory,'orders.csv');fs.writeFileSync(file,'orderId\n12345678901234567890');return {path:file,count:1,missing:0};},transfer:async(id,actor)=>({batchId:'batch-'+id,route:'/apps/purchase/integration-review.html?batch=test',actor:actor.id})}});
  integration.state.workbench=workbench;installWorkbenchMigration(integration,{db:store.db,dir},(_facade:any,options:any)=>createWorkbenchMigration(store,options),{dataDir:dir,sourceInstance:'target'});integration.finish();const server=app.listen(0,'127.0.0.1');fixtureData.server=server;await new Promise<void>(resolve=>server.once('listening',resolve));
  const port=(server.address() as any).port,base='http://127.0.0.1:'+port,key=provisionWorkbenchKey(dir),token=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
  async function request(route:string,{method='GET',body,role='admin',channel='ui',canRunTasks=false,requestId=randomUUID(),actorPatch={},extraHeaders={}}:any={}){
    const requestPath='/api/integration/v1'+(route.startsWith('/agent/')?'':'/workbench')+route,now=Date.now();
    const actor:WorkbenchActor={v:1,id:'tailscale:tester@example.test',login:'tester@example.test',role,modules:['exporter','purchase'],canRunTasks,channel,sessionId:'session-test',requestId,issuedAt:now,expiresAt:now+30000,module:'exporter',method,path:requestPath,...actorPatch};
    const response=await fetch(base+requestPath,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor(actor,key),...extraHeaders},body:body===undefined?undefined:JSON.stringify(body)});
    const result=response.headers.get('content-type')?.includes('json')?await response.json():await response.text();return {status:response.status,result};
  }
  return {...fixtureData,calls,request,key,base,token};
}
describe('exporter authoritative-server bridge',()=>{
  it('requires signed identity and exact route; never exposes cookie or host paths',async()=>{
    const {store,request}=await api(),task=store.create({platform:'taobao',from:'2026-01-01',to:'2026-01-31'});store.update(task.id,{status:'needs_login',accountCookie:'secret-cookie-name',cursor:'credential-cursor',exportedPath:'C:/private/orders.csv',detailExport:{requestedAt:'now',previous:['C:/private']}});
    const state=await request('/state');expect(state.status).toBe(200);expect(state.result.tasks[0].state).toBe('waiting-host-action');expect(JSON.stringify(state.result)).not.toContain('secret-cookie');expect(JSON.stringify(state.result)).not.toContain('C:/private');expect(JSON.stringify(state.result)).not.toContain('credential-cursor');
    expect((await request('/state',{actorPatch:{path:'/other'}})).status).toBe(403);expect((await request('/state',{actorPatch:{expiresAt:Date.now()-1}})).status).toBe(403);
  });
  it('publishes stable ledger identity/revision and invalidates reviews for a same-content replacement ledger',async()=>{
    const first=fixture(),second=fixture(),a=createWorkbenchMigration(first.store),b=createWorkbenchMigration(second.store);expect(a.getDataSetIdentity().dataSetId).not.toBe(b.getDataSetIdentity().dataSetId);expect(a.getDataSetIdentity().revision).not.toBe(b.getDataSetIdentity().revision);expect(a.getDataSetIdentity()).toEqual(createWorkbenchMigration(first.store).getDataSetIdentity());const {request,store}=await api(),before=(await request('/state')).result;expect(before.dataSetId).toMatch(/^[a-f0-9-]{36}$/);expect(before.revision).toMatch(/^[a-f0-9]{64}$/);store.create({platform:'jd',from:'2026-01-01',to:'2026-01-31'});const after=(await request('/state')).result;expect(after.dataSetId).toBe(before.dataSetId);expect(after.revision).not.toBe(before.revision);
  });
  it('enforces read-only and explicit collection permissions',async()=>{
    const {request,calls}=await api(),body={platform:'taobao',from:'2026-01-01',to:'2026-01-31'};
    expect((await request('/tasks',{method:'POST',body,role:'viewer'})).status).toBe(403);expect((await request('/tasks',{method:'POST',body,role:'editor'})).status).toBe(403);expect(calls).toEqual([]);
    expect((await request('/tasks',{method:'POST',body,role:'editor',canRunTasks:true})).status).toBe(200);expect(calls).toEqual(['start']);
  });
  it('retries the same request once and rejects changed input',async()=>{
    const {request,calls,store}=await api(),requestId=randomUUID(),body={platform:'jd',from:'2026-01-01',to:'2026-01-31'};
    const first=await request('/tasks',{method:'POST',body,requestId}),again=await request('/tasks',{method:'POST',body,requestId});expect(again.result.id).toBe(first.result.id);expect(calls).toEqual(['start']);expect(store.tasks()).toHaveLength(1);
    expect((await request('/tasks',{method:'POST',body:{...body,to:'2026-02-01'},requestId})).status).toBe(409);
  });
  it('exports files by opaque ID and restricts another actor',async()=>{
    const {request,store}=await api(),task=store.create({platform:'jd',from:'2026-01-01',to:'2026-01-31'});const result=await request('/tasks/'+task.id+'/export',{method:'POST',body:{format:'csv'}});expect(result.status).toBe(200);expect(result.result.fileId).toBeTruthy();expect(result.result.path).toBeUndefined();expect((await request('/files/'+result.result.fileId)).status).toBe(200);expect((await request('/files/'+result.result.fileId,{role:'viewer',actorPatch:{id:'tailscale:other@example.test',login:'other@example.test'}})).status).toBe(404);
  });
  it('requests host interaction and rejects CLI history deletion',async()=>{
    const {request,calls}=await api();const result=await request('/host-action',{method:'POST',body:{platform:'taobao'}});expect(result.result.state).toBe('waiting-host-action');expect(calls).toEqual(['login']);expect((await request('/platforms/taobao/clear',{method:'POST',body:{confirm:true},channel:'cli'})).status).toBe(403);
  });
  it('requires persisted maintenance and a short signed two-confirmation migration permit',async()=>{
    const source=fixture(),task=source.store.create({platform:'jd',from:'2026-01-01',to:'2026-01-31'});source.store.update(task.id,{status:'completed',listOutcome:'complete'});const {request,key,dir,store}=await api(),bundle=createWorkbenchMigration(source.store,{sourceInstance:'client-history'}).exportSnapshot();
    const preview=await request('/migration/preview',{method:'POST',body:{bundle}}),plan={migrationId:'fixture-migration',bundle,revision:preview.result.revision,selections:[{kind:'task-history',sourceId:task.id,action:'add'}]};
    expect((await request('/migration/commit',{method:'POST',body:{plan,permit:{}}})).status).toBe(409);expect(store.tasks()).toHaveLength(0);
    expect((await request('/migration/maintenance',{method:'POST',body:{enabled:true,migrationId:'fixture-migration'}})).status).toBe(200);expect(fs.existsSync(path.join(dir,'.workbench-maintenance.json'))).toBe(true);
    const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v,digest=createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex'),expiresAt=Date.now()+30000,signature=createHmac('sha256',key).update('workbench-migration/v1:'+digest+':'+expiresAt+':session-test').digest('hex');
    const result=await request('/migration/commit',{method:'POST',body:{plan,permit:{digest,expiresAt,signature}}});expect(result.status).toBe(200);expect(result.result.verification.ok).toBe(true);expect(store.tasks()).toHaveLength(1);expect((await request('/migration/verify/'+result.result.migrationId)).result.ok).toBe(true);
    expect((await request('/migration/commit',{method:'POST',body:{plan,permit:{digest,expiresAt,signature}},channel:'cli'})).status).toBe(409);
    expect((await request('/migration/maintenance',{method:'POST',body:{enabled:false,migrationId:'fixture-migration'}})).status).toBe(200);expect(fs.existsSync(path.join(dir,'.workbench-maintenance.json'))).toBe(false);
  });
  it('binds maintenance to its batch, preserves the original actor, and permits signed admin recovery in a new session',async()=>{
    const {request,store,key,dir}=await api(),migrationId='owned-batch-a';expect((await request('/migration/maintenance',{method:'POST',body:{enabled:true}})).status).toBe(400);expect((await request('/migration/maintenance',{method:'POST',body:{enabled:true,migrationId}})).status).toBe(200);const first=JSON.parse(fs.readFileSync(path.join(dir,'.workbench-maintenance.json'),'utf8'));expect(first.migrationId).toBe(migrationId);expect(first.actor).toBe('tailscale:tester@example.test');
    const other={id:'tailscale:other@example.test',login:'other@example.test',sessionId:'other-ui-session'};expect((await request('/migration/maintenance',{method:'POST',body:{enabled:true,migrationId:'owned-batch-b'},actorPatch:other})).status).toBe(409);expect((await request('/migration/maintenance',{method:'POST',body:{enabled:false,migrationId:'owned-batch-b'},actorPatch:other})).status).toBe(409);expect((await request('/migration/maintenance',{method:'POST',body:{enabled:true,migrationId},actorPatch:other})).status).toBe(200);expect(JSON.parse(fs.readFileSync(path.join(dir,'.workbench-maintenance.json'),'utf8')).actor).toBe(first.actor);
    const bundle=createWorkbenchMigration(store).exportSnapshot(),plan={migrationId:'owned-batch-b',bundle,revision:createWorkbenchMigration(store).preview(bundle).revision,selections:[]},canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v,digest=createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex'),expiresAt=Date.now()+30000,signature=createHmac('sha256',key).update('workbench-migration/v1:'+digest+':'+expiresAt+':session-test').digest('hex');expect((await request('/migration/commit',{method:'POST',body:{plan,permit:{digest,expiresAt,signature}}})).status).toBe(409);expect((await request('/migration/maintenance',{method:'POST',body:{enabled:false,migrationId},actorPatch:other})).status).toBe(200);expect(fs.existsSync(path.join(dir,'.workbench-maintenance.json'))).toBe(false);
  });
  it('honors a persisted local source-freeze owner and accepts only its own batch on retry',async()=>{
    const {request,dir,calls}=await api(),clientId='fixture-client',migrationId='source-archive-'+clientId,local={id:'local-migration:'+clientId,login:'local-migration',sessionId:clientId};fs.writeFileSync(path.join(dir,'.workbench-maintenance.json'),JSON.stringify({maintenance:true,actor:local.id,migrationId,createdAt:new Date().toISOString()}));expect((await request('/tasks',{method:'POST',body:{platform:'jd',from:'2026-01-01',to:'2026-01-31'}})).status).toBe(503);expect(calls).toEqual([]);expect((await request('/migration/export',{actorPatch:local})).status).toBe(200);expect((await request('/migration/maintenance',{method:'POST',body:{enabled:true,migrationId},actorPatch:local})).status).toBe(200);const held=JSON.parse(fs.readFileSync(path.join(dir,'.workbench-maintenance.json'),'utf8'));expect(held.actor).toBe(local.id);expect(held.migrationId).toBe(migrationId);expect((await request('/migration/maintenance',{method:'POST',body:{enabled:false,migrationId:'source-archive-other'},actorPatch:local})).status).toBe(409);
  });
});
describe('exporter historical migration',()=>{
  it('migrates controlled originals after all source disk paths are removed from the wire bundle',async()=>{
    const source=fixture(),target=fixture(),original=Buffer.from('orderId\n12345678901234567890\n'),file=path.join(source.dir,'source.csv');fs.writeFileSync(file,original);const task=source.store.create({platform:'jd',from:'2026-01-01',to:'2026-01-31'});source.store.update(task.id,{status:'completed',exportedPath:file});const bundle=createWorkbenchMigration(source.store).exportSnapshot();for(const descriptor of bundle.records[0].files){expect(descriptor.filename).toBe('source.csv');delete descriptor.sourcePath;descriptor.stagingId=descriptor.sha256;}expect(JSON.stringify(bundle)).not.toContain(source.dir);
    const migration=createWorkbenchMigration(target.store,{dataDir:target.dir,canCommit:()=>true,resolveFile:async()=>original}),preview=migration.preview(bundle),result=await migration.commit({bundle,revision:preview.revision,selections:[{kind:'task-history',sourceId:task.id,action:'add'}]},{role:'admin',id:'fixture-admin'});expect(result.verification.ok).toBe(true);expect(fs.readFileSync(target.store.tasks()[0].exportedPath)).toEqual(original);
  });
  it('excludes credentials and imports history with provenance and fresh IDs',async()=>{
    const source=fixture(),target=fixture(),task=source.store.create({platform:'taobao',from:'2026-01-01',to:'2026-01-31'});source.store.update(task.id,{status:'completed',listOutcome:'complete',accountCookie:'never-transfer',cursor:'never-copy'});
    const sourceMigration=createWorkbenchMigration(source.store,{sourceInstance:'client-a'}),targetMigration=createWorkbenchMigration(target.store,{sourceInstance:'server',canCommit:()=>true}),bundle=sourceMigration.exportSnapshot();expect(bundle.sourceInstance).not.toBe(targetMigration.exportSnapshot().sourceInstance);expect(createWorkbenchMigration(source.store).exportSnapshot().sourceInstance).toBe(bundle.sourceInstance);expect(JSON.stringify(bundle)).not.toContain('never-transfer');expect(JSON.stringify(bundle)).not.toContain('never-copy');const preview=targetMigration.preview(bundle);expect(preview.rows[0].action).toBe('new');const result=await targetMigration.commit({bundle,revision:preview.revision,selections:[{kind:'task-history',sourceId:task.id,action:'add'}]},{role:'admin',id:'tailscale:admin@example.test'});expect(result.verification.ok).toBe(true);expect(result.verified).toHaveLength(1);const inserted=target.store.tasks()[0];expect(inserted.id).not.toBe(task.id);expect(inserted.historicalOnly).toBe(true);expect(inserted.sourceProvenance?.id).toBe(task.id);expect(targetMigration.preview(bundle).rows[0].action).toBe('duplicate');expect(targetMigration.verify(result.migrationId).ok).toBe(true);target.store.update(inserted.id,{message:'later manual edit'});expect(targetMigration.preview(bundle).rows[0].action).toBe('conflict');expect(targetMigration.verify(result.migrationId).ok).toBe(false);
  });
  it('rejects stale revisions and rolls back failed count verification',async()=>{
    const source=fixture(),target=fixture(),task=source.store.create({platform:'jd',from:'2026-01-01',to:'2026-01-31'});source.store.update(task.id,{count:99,status:'paused'});const migration=createWorkbenchMigration(target.store,{canCommit:()=>true}),bundle=createWorkbenchMigration(source.store).exportSnapshot(),preview=migration.preview(bundle),input={bundle,revision:preview.revision,selections:[{kind:'task-history',sourceId:task.id,action:'add'}]};await expect(migration.commit({...input,revision:'stale'},{role:'admin',id:'tester'})).rejects.toThrow('变化');await expect(migration.commit(input,{role:'admin',id:'tester'})).rejects.toThrow('数量');expect(target.store.tasks()).toHaveLength(0);await expect(createWorkbenchMigration(target.store).commit(input,{role:'admin',id:'tester'})).rejects.toThrow('确认凭据');
  });
});

describe('Agent exporter review boundary',()=>{
 it('prepares actual task evidence, rejects forged approval and viewer mutations',async()=>{
 const {store,request,key}=await api();const task=store.create({platform:'taobao',from:'2026-01-01',to:'2026-01-31'});
 const prepared=await request('/agent/prepare',{method:'POST',channel:'mcp',body:{capabilityId:'transfer',input:{taskId:task.id}}});
 expect(prepared.status).toBe(200);expect(prepared.result.evidence[0].task.id).toBe(task.id);expect(prepared.result.dataSetId).toBeTruthy();
 const denied=await request('/agent/commit',{method:'POST',channel:'mcp',body:{prepared:prepared.result,preparedId:prepared.result.commitData.id,taskId:'agent-task'}});expect(denied.status).toBe(403);
 const p={...prepared.result,id:'result-1',version:1},now=Date.now(),proof=signAgentApproval({v:1,approvalId:'approval-1',actorId:'tailscale:tester@example.test',module:'exporter',capabilityId:p.capabilityId,taskId:'agent-task',resultId:p.id,resultVersion:p.version,dataSetId:p.dataSetId,revision:p.revision,changeDigest:agentDigest({capabilityId:p.capabilityId,input:p.input,commitData:p.commitData,changes:p.changes}),idempotencyKey:'idem-1',issuedAt:now,expiresAt:now+30000},key);
 const commit=()=>request('/agent/commit',{method:'POST',channel:'mcp',body:{prepared:{...p,id:'runtime-step',version:99},preparedId:p.commitData.id,resultId:'result-1',resultVersion:1,taskId:'agent-task',idempotencyKey:'idem-1'},extraHeaders:approvalHeaders(proof)});
 const committed=await commit();expect(committed.status).toBe(200);expect(committed.result.receipt.state).toBe('completed');expect(committed.result.receipt.result.batchId).toBeTruthy();expect((await commit()).result).toEqual(committed.result);
 store.db.prepare('UPDATE agent_receipts SET payload=? WHERE id=?').run(JSON.stringify({state:'processing',ok:false}),'idem-1');
 const pending=await commit();expect(pending.result).toEqual({state:'processing',ok:false});expect(pending.result.receipt).toBeUndefined();

 expect((await request('/agent/prepare',{method:'POST',role:'viewer',body:{capabilityId:'pause',input:{taskId:task.id}}})).status).toBe(403);
 expect((await request('/agent/prepare',{method:'POST',body:{capabilityId:'clear',input:{platform:'taobao',confirmed:true}}})).status).toBe(400);
 });
});

it('adapter preserves real query data and separates central result identity from step identity',async()=>{
 const calls:any[]=[];const adapter=createExporterAgentAdapter({transport:async(module:any,route:any,options:any)=>{calls.push({module,route,options});return {orders:[{id:'actual-order'}]};}});
 const result=await adapter.query('orders',{taskId:'collection-1'},{taskId:'agent-task'});expect(result.blocks[0].data.orders[0].id).toBe('actual-order');expect(result.evidence[0].data.orders).toHaveLength(1);
 const proof={payload:Buffer.from(JSON.stringify({resultId:'central-result',resultVersion:7})).toString('base64url')};
 await adapter.commit({id:'step-9',version:1,commitData:{id:'prepared-4'}},{approval:proof,taskId:'agent-task',idempotencyKey:'key'});
 expect(calls[1].options.body).toMatchObject({preparedId:'prepared-4',resultId:'central-result',resultVersion:7});
});

it('automatic collection preparation dispatches once without a review draft',async()=>{
 const {request,store,calls}=await api();const body={capabilityId:'start',input:{platform:'taobao',from:'2026-01-01',to:'2026-01-31'},taskId:'agent-automatic',idempotencyKey:'automatic-1'};
 const first=await request('/agent/prepare',{method:'POST',channel:'mcp',canRunTasks:true,body});expect(first.status).toBe(200);expect(first.result.requiresReview).toBe(false);expect(first.result.commitData).toBeUndefined();expect(first.result.changes).toBeUndefined();expect(first.result.blocks[0].data.id).toBeTruthy();
 const second=await request('/agent/prepare',{method:'POST',channel:'mcp',canRunTasks:true,body});expect(second.result).toEqual(first.result);expect(store.tasks()).toHaveLength(1);expect(calls.filter(x=>x==='start')).toHaveLength(1);
 const exported=await request('/agent/prepare',{method:'POST',channel:'mcp',body:{capabilityId:'export',input:{taskId:store.tasks()[0].id,format:'csv'},taskId:'agent-automatic',idempotencyKey:'auto-export'}});expect(exported.status).toBe(200);const fileId=exported.result.blocks[0].data.fileId;
 const file=await request('/agent/query',{method:'POST',body:{capabilityId:'file',input:{fileId}}});expect(file.status).toBe(200);expect(file.result).toMatchObject({fileId,available:true});expect(JSON.stringify(file.result)).not.toContain('workbench-exports');
 expect((await request('/agent/query',{method:'POST',role:'editor',actorPatch:{id:'other-user'},body:{capabilityId:'file',input:{fileId}}})).status).toBe(404);

 expect((await request('/agent/prepare',{method:'POST',role:'editor',channel:'mcp',body:{...body,idempotencyKey:'denied'}})).status).toBe(403);
});

it('all exporter capabilities have closed Chinese schemas enforced by real HTTP',async()=>{
 for(const [id,schema] of Object.entries(exporterSchemas) as any){expect(schema.additionalProperties).toBe(false);expect(schema.properties).toBeTruthy();expect(schema.required).toBeInstanceOf(Array);expect(exporterLabels[id][0]).toMatch(/[\u4e00-\u9fff]/);expect(()=>validateExporterInput(id,{unknownField:1})).toThrow();}
 for(const input of [{platform:'unknown',from:'2026-01-01',to:'2026-01-31'},{platform:'taobao',from:'2026-02-30',to:'2026-03-02'},{platform:'taobao',from:'2026-02-02',to:'2026-02-01'},{platform:'taobao',from:'2026-01-01',to:'2026-01-31',plan:{granularity:'year',segments:[]}}])expect(()=>validateExporterInput('start',input)).toThrow();
 const {request,store}=await api();const t=store.create({platform:'jd',from:'2026-01-01',to:'2026-01-31'});store.update(t.id,{cursor:'C:/private/cursor',plan:{buckets:[{cursor:'C:/private/token'}]} as any});
 for(const input of [{taskId:t.id,limit:501},{taskId:t.id,offset:-1},{taskId:t.id,limit:1.5},{taskId:t.id,extra:true}])expect((await request('/agent/query',{method:'POST',body:{capabilityId:'orders',input}})).status).toBe(400);
 const page=await request('/agent/query',{method:'POST',body:{capabilityId:'orders',input:{taskId:t.id,limit:1,offset:0}}});expect(page.status).toBe(200);expect(page.result).toMatchObject({taskId:t.id,moneyUnit:'fen',dateBasis:'order-created-at',limit:1,total:0,nextOffset:null});expect(JSON.stringify(page.result)).not.toContain('private');
 expect((await request('/agent/query',{method:'POST',body:{capabilityId:'file',input:{fileId:'C:/private/file'}}})).status).toBe(400);
});

it('real exporter CSV reaches registered task artifact by signed HTTP streaming, file query and receipt recovery',async()=>{
 const {store,request,dir,base,key,token}=await api({realExport:true}),task=store.create({platform:'taobao',from:'2026-01-01',to:'2026-01-31'});
 store.add(task.id,[{platform:'taobao',account:'synthetic-account',id:'12345678901234567890',createdAt:'2026-01-05 10:00:00',paidAt:'2026-01-05',shippedAt:'',completedAt:'',status:'交易成功',shop:'合成供应商',sellerId:'seller',paidFen:1234,freightFen:0,refundFen:0,refundStatus:'无退款',receiver:'收货人',phone:'13800000000',address:'合成地址',logistics:'',tracking:'',remark:'',detailUrl:'',items:[{id:'item',title:'螺丝',spec:'M3',quantity:1,unitPriceFen:1234,imageUrl:'',productUrl:''}],extra:{},missing:[],source:'response',capturedAt:new Date().toISOString()}]);
 const taskDir=path.join(dir,'runtime','tasks','artifact-task');fs.mkdirSync(taskDir,{recursive:true});const registered:any[]=[],ctx:any={taskId:'artifact-task',idempotencyKey:'artifact-export-once',registerArtifact:({path:file,name,mimeType}:any)=>{expect(path.relative(taskDir,file)).not.toMatch(/^\.\./);const buffer=fs.readFileSync(file),item={id:randomUUID(),taskId:'artifact-task',path:file,name,mimeType,size:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')};registered.push(item);return item;}};
 const transport:any=async(_module:any,route:any,options:any)=>{const out=await request(route.replace('/api/integration/v1',''),{method:options.method,body:options.body,channel:'mcp',canRunTasks:true});if(out.status!==200)throw Error(out.result.error);return out.result;};
 transport.download=async(module:any,route:any,options:any)=>{expect(module).toBe('exporter');expect(route).toMatch(/^\/api\/integration\/v1\/workbench\/files\/[a-f0-9-]+$/);const now=Date.now(),actor:WorkbenchActor={v:1,id:'tailscale:tester@example.test',login:'tester@example.test',role:'editor',modules:['exporter'],canRunTasks:true,channel:'mcp',sessionId:'download-session',requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,module,method:'GET',path:route};const response=await fetch(base+route,{headers:{Authorization:'Bearer '+token,...signWorkbenchActor(actor,key)}});expect(response.status).toBe(200);const target=path.join(taskDir,randomUUID()+'.csv');await pipeline(Readable.fromWeb(response.body as any),fs.createWriteStream(target));expect(fs.statSync(target).size).toBeLessThan(options.maxBytes);return options.ctx.registerArtifact({path:target,name:options.filename,mimeType:response.headers.get('content-type')});};
 const adapter=createExporterAgentAdapter({transport}),result=await adapter.prepare('export',{taskId:task.id,format:'csv',images:false},ctx),file=result.blocks[0].data,fileBlock=result.blocks.find((b:any)=>b.type==='files');expect(fileBlock.files[0].artifactId).toBe(registered[0].id);expect(fileBlock.files[0].sha256).toBe(registered[0].sha256);expect(fs.readFileSync(registered[0].path,'utf8')).toContain('12345678901234567890');expect(fs.readFileSync(registered[0].path,'utf8')).toContain('12.34');expect(JSON.stringify(result)).not.toContain(taskDir);
 const queried=await adapter.query('file',{fileId:file.fileId},ctx);expect(queried.blocks.find((b:any)=>b.type==='files').files[0].artifactId).toBeTruthy();const recovered=await adapter.receipt('artifact-export-once',ctx);expect(recovered.blocks.find((b:any)=>b.type==='files').files[0].artifactId).toBeTruthy();expect(registered).toHaveLength(3);expect(store.db.prepare('SELECT count(*) n FROM workbench_files').get()!.n).toBe(1);expect(new Set(registered.map(x=>x.sha256)).size).toBe(1);
 const invalidTransport:any=async()=>({fileId:file.fileId,filename:'orders.csv',available:true});invalidTransport.download=async()=>({id:'fake-link'});await expect(createExporterAgentAdapter({transport:invalidTransport}).query('file',{fileId:file.fileId},ctx)).rejects.toMatchObject({code:'ARTIFACT_RESULT_INVALID'});
 const missing=createExporterAgentAdapter({transport:async()=>({})});await expect(missing.prepare('export',{taskId:task.id,format:'csv'},ctx)).rejects.toMatchObject({code:'ARTIFACT_TRANSPORT_UNAVAILABLE'});
});
