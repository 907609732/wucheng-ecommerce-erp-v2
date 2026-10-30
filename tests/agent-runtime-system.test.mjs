import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createAgentRuntime} from '../desktop/agent-runtime/index.mjs';
import {createAgentStore} from '../desktop/agent-runtime/store.mjs';
import {signAgentApproval} from '../desktop/agent-runtime/approval.mjs';
import {exactEngineVersion} from '../desktop/agent-runtime/engine-common.mjs';
import {restrictedModelCatalog,codexProfile} from '../desktop/agent-runtime/codex-engine.mjs';

const admin={id:'admin',role:'admin',modules:['sales'],canRunTasks:true,channel:'ui'},worker={id:'worker',role:'editor',modules:['sales'],canRunTasks:true,channel:'ui'};
async function setup(t,{engine,extensions={},adapter}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-system-'));const people=new Map([[admin.id,admin],[worker.id,worker]]);let clock=Date.now();
  const runtime=createAgentRuntime({storeDir:directory,autoStart:false,adapters:adapter?[adapter]:[],engines:engine?{codex:engine}:{},resolveActor:async id=>people.get(id),secretStore:{has:()=>true,get:async()=>'synthetic-test-key'},signApproval:async claims=>signAgentApproval(claims,'c'.repeat(64),{now:clock}),extensions,now:()=>clock});
  t.after(async()=>{await runtime.close();fs.rmSync(directory,{recursive:true,force:true});});
  const request=(operation,payload={},actor=admin)=>runtime.request(operation,payload,{actor,trustedUi:true});
  const create=async(scope=['system'])=>(await request('tasks.create',{goal:'合成业务任务',scope:{modules:scope}})).task;
  const prepare=async(task,capabilityId,input)=>{runtime.store.update('task',task.id,{status:'running'});return runtime.invokeTool(task.id,'erp_prepare',{module:'system',capabilityId,input});};
  const approve=async(task)=>{const {review}=await request('tasks.get',{taskId:task.id});return request('reviews.approve',{taskId:task.id,reviewId:review.id,resultVersion:review.resultVersion,revision:review.revision});};
  return {runtime,directory,people,request,create,prepare,approve,advance:value=>clock=value};
}

test('goal-created schedule has human-bound receipt, one persisted run and revocation checks',async t=>{
  const f=await setup(t),task=await f.create();await f.prepare(task,'schedules.create',{goal:'每天查询销售数据',cron:'0 9 * * *',timezone:'Asia/Shanghai',scope:{modules:['sales','system']}});
  assert.equal(f.runtime.store.list('schedule').length,0);const approved=await f.approve(task);assert.equal(approved.task.status,'completed');assert.equal(approved.result.receipt.receipts[0].operation,'schedules.create');
  const schedule=f.runtime.store.list('schedule')[0];f.advance(Date.parse(schedule.nextRunAt));await f.runtime.tick();assert.equal(f.runtime.store.runs(schedule.id).length,1);assert.ok(f.runtime.store.get('task',f.runtime.store.runs(schedule.id)[0].taskId));await f.runtime.tick();assert.equal(f.runtime.store.runs(schedule.id).length,1);
  f.people.set('admin',{...admin,modules:[]});f.advance(Date.parse(f.runtime.store.get('schedule',schedule.id).nextRunAt));await f.runtime.tick();assert.equal(f.runtime.store.get('schedule',schedule.id).blockedReason,'permission_revoked');
});

test('assignment shares only bound attachments and executes under the assignee current permissions',async t=>{
  let invokedActor;
  const adapter={id:'sales',capabilities:[{id:'read',title:'读取附件',kind:'query',inputSchema:{type:'object',additionalProperties:false}}],binding:()=>({dataSetId:'synthetic',revision:1}),query:async(id,input,ctx)=>{invokedActor=ctx.actor.id;const item=ctx.resolveAttachment(attachmentId);assert.equal(fs.readFileSync(item.path,'utf8'),'synthetic attachment');return {summary:'附件已核验',blocks:[{type:'text',text:'查询结果'}],evidence:[{id:item.id,sha256:item.sha256}]};}};
  const f=await setup(t,{adapter,engine:{run:async({invoke})=>{await invoke('erp_query',{module:'sales',capabilityId:'read',input:{}});return {usage:{totalTokens:5}};}}});
  await f.request('settings.save',{company:{model:'synthetic'}});const uploaded=await f.request('attachments.upload',{name:'source.txt',bytes:Buffer.from('synthetic attachment').toString('base64')});const attachmentId=uploaded.id;
  const target=(await f.request('tasks.create',{goal:'核验附件',attachmentIds:[attachmentId],scope:{modules:['sales']}})).task;await f.request('tasks.control',{taskId:target.id,action:'pause'});
  const assign=await f.create();await f.prepare(assign,'tasks.assign',{taskId:target.id,assigneeId:worker.id});await f.approve(assign);
  assert.equal((await f.request('tasks.get',{taskId:target.id},worker)).task.assigneeId,worker.id);await f.request('tasks.control',{taskId:target.id,action:'resume'},worker);await f.runtime.run(target.id);
  assert.equal(invokedActor,worker.id);assert.equal(f.runtime.store.get('task',target.id).status,'completed');
  f.people.set(worker.id,{...worker,modules:[]});await assert.rejects(f.request('tasks.get',{taskId:target.id},worker),{code:'MODULE_DENIED'});
});

test('permission preparation uses an admin-only internal read and rejects public access',async t=>{
  let saved=false;
  const extensions={'permissions.inspect':async(_,ctx)=>{assert.equal(ctx.actor.id,'admin');assert.notEqual(ctx.trustedUi,true);return {revision:'old',policy:{schemaVersion:1,users:{}}};},'permissions.save':async(input,ctx)=>{assert.ok(ctx.approval);assert.equal(ctx.trustedUi,true);assert.equal(input.idempotencyKey,ctx.idempotencyKey);saved=true;return {revision:'new',policy:input.policy};}};
  const f=await setup(t,{extensions}),task=await f.create();await f.prepare(task,'permissions.update',{policy:{schemaVersion:1,users:{worker:{role:'viewer',modules:['sales'],canRunTasks:false,enabled:true}}}});assert.equal(saved,false);await f.approve(task);assert.equal(saved,true);
  await assert.rejects(f.request('permissions.inspect'),{code:'INTERNAL_OPERATION'});await assert.rejects(f.request('permissions.receipt'),{code:'INTERNAL_OPERATION'});
});

test('automatic backup prepares verified results without inventing a formal commit',async t=>{
  const f=await setup(t,{extensions:{'backups.prepare':async()=>({summary:'已校验合成备份',blocks:[{type:'text',text:'备份已生成'}],evidence:[{id:'synthetic-backup'}]})}});f.people.set(admin.id,{...admin,modules:['warehouse','purchase','sales','overview','exporter']});const task=await f.create();const result=await f.prepare(task,'backups.create',{modules:['sales']});assert.ok(result.result);assert.equal(f.runtime.store.get('task',task.id).review,null);assert.equal(f.runtime.store.list('system_receipt').length,0);
});

test('budget reservation serializes concurrent tasks, error usage remains unknown',async t=>{
  let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let calls=0;
  const f=await setup(t,{engine:{run:async({onUsage})=>{calls++;onUsage({totalTokens:12});entered();await hold;throw Error('connection lost after provider consumption');}}});await f.request('settings.save',{company:{model:'synthetic',budgetLimit:100}});const first=await f.create(),second=await f.create();const running=f.runtime.run(first.id);await started;await f.runtime.run(second.id);assert.equal(calls,1);assert.equal(f.runtime.store.get('task',second.id).pauseReason,'COMPANY_BUDGET_RESERVED');release();await running;
  const usage=f.runtime.store.list('usage')[0];assert.equal(usage.totalTokens,12);assert.equal(usage.state,'unknown');await f.request('tasks.control',{taskId:second.id,action:'resume'});await f.runtime.run(second.id);assert.equal(f.runtime.store.get('task',second.id).pauseReason,'COMPANY_USAGE_UNKNOWN');
});

test('host crash converts pending usage to unknown instead of zero or reusable reservation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-usage-'));let store=createAgentStore(dir);store.insert('usage',{id:'attempt',ownerId:'admin',state:'pending',totalTokens:17});store.close();store=createAgentStore(dir);try{assert.equal(store.get('usage','attempt').state,'unknown');assert.equal(store.get('usage','attempt').totalTokens,17);}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('catalog and profile disable native execution and version checks use full semver',()=>{
  assert.equal(exactEngineVersion('codex/0.150.1 (windows)','0.150.1'),true);assert.equal(exactEngineVersion('codex/0.150.10 (windows)','0.150.1'),false);assert.equal(exactEngineVersion('v0.21.0-rc1','0.21.0'),false);
  const catalog=restrictedModelCatalog('gpt-5.4');assert.equal(catalog.models[0].apply_patch_tool_type,null);assert.equal(catalog.models[0].shell_type,'disabled');assert.throws(()=>restrictedModelCatalog('unverified'),{code:'CODEX_MODEL_UNSUPPORTED'});
  const config=codexProfile({model:'gpt-5.4',baseUrl:'http://127.0.0.1:1/v1',bridge:{url:'u',token:'t'},nodeExecutable:process.execPath,catalogPath:'x'});assert.equal((config.match(/approval_mode = "approve"/g)||[]).length,5);assert.match(config,/supports_websockets = false/);
});

test('viewer can run query goals but never prepares or approves formal writes',async t=>{
  const adapter={id:'sales',capabilities:[{id:'read',kind:'query',inputSchema:{type:'object'}},{id:'write',kind:'prepare',inputSchema:{type:'object'}}],binding:()=>({dataSetId:'test',revision:1}),query:()=>({summary:'只读核验结果',blocks:[{type:'text',text:'safe'}],evidence:[]})};
  const f=await setup(t,{adapter});const viewer={...worker,role:'viewer',canRunTasks:false};f.people.set(worker.id,viewer);const {task}=await f.request('tasks.create',{goal:'查询我的账单',scope:{modules:['sales']}},viewer);f.runtime.store.update('task',task.id,{status:'running'});
  const catalog=await f.runtime.invokeTool(task.id,'erp_capabilities',{});assert.deepEqual(catalog.capabilities.map(c=>c.id),['read']);await f.runtime.invokeTool(task.id,'erp_query',{module:'sales',capabilityId:'read',input:{}});await assert.rejects(f.runtime.invokeTool(task.id,'erp_prepare',{module:'sales',capabilityId:'write',input:{}}),{code:'CAPABILITY_DENIED'});
  await assert.rejects(f.request('schedules.create',{goal:'query',cron:'0 9 * * *',timezone:'Asia/Shanghai'},viewer),{code:'TASK_PERMISSION_REQUIRED'});
});

test('only exact warehouse self-service capabilities permit editor without task execution permission',async t=>{
  let key,commits=0;
  const adapter={id:'warehouse',capabilities:[{id:'attendance.complete',kind:'prepare',inputSchema:{type:'object',additionalProperties:false}},{id:'inventory.apply',kind:'prepare',inputSchema:{type:'object'}}],binding:()=>({dataSetId:'warehouse-test',revision:1}),prepare:()=>({summary:'本人签到复核',blocks:[{type:'text',text:'本人记录'}],evidence:[],changes:[{employeeId:'worker'}],commitData:{employeeId:'worker'}}),commit:(step,ctx)=>{assert.equal(ctx.actor.id,'worker');assert.equal(ctx.capabilityId,'attendance.complete');key=ctx.idempotencyKey;commits++;return {receipt:{id:'attendance'}};},receipt:()=>({state:'completed',idempotencyKey:key,receipt:{id:'attendance'}})};
  const f=await setup(t,{adapter}),self={...worker,modules:['warehouse'],canRunTasks:false};f.people.set(worker.id,self);f.people.set(admin.id,{...admin,modules:['warehouse']});const {task}=await f.request('tasks.create',{goal:'完成本人签到',scope:{modules:['warehouse']}},self);f.runtime.store.update('task',task.id,{status:'running'});
  await assert.rejects(f.runtime.invokeTool(task.id,'erp_prepare',{module:'warehouse',capabilityId:'inventory.apply',input:{}}),{code:'CAPABILITY_DENIED'});await f.runtime.invokeTool(task.id,'erp_prepare',{module:'warehouse',capabilityId:'attendance.complete',input:{}});
  const {review}=await f.request('tasks.get',{taskId:task.id},self);assert.equal(review.canApprove,true);const args={taskId:task.id,reviewId:review.id,resultVersion:review.resultVersion,revision:review.revision};await assert.rejects(f.request('reviews.approve',args),{code:'TASK_PERMISSION_REQUIRED'});assert.equal((await f.request('reviews.approve',args,self)).task.status,'completed');assert.equal(commits,1);
});

test('paused engine finishes shutdown before resume and permits an explicit engine switch',async t=>{
  let entered,executions=0;const started=new Promise(r=>entered=r);
  const f=await setup(t,{engine:{run:async({signal})=>{executions++;entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>setTimeout(()=>reject(Error('interrupted')),20),{once:true}));}}});await f.request('settings.save',{company:{model:'synthetic'}});const task=await f.create(),running=f.runtime.run(task.id);await started;
  await f.request('tasks.control',{taskId:task.id,action:'pause'});await running;const resumed=await f.request('tasks.control',{taskId:task.id,action:'resume',engine:'hermes'});assert.equal(resumed.task.status,'queued');assert.equal(resumed.task.engine,'hermes');assert.equal(f.runtime.store.get('task',task.id).engineSession,null);assert.equal(executions,1);
});

test('lost permission save response reconciles from host receipt without writing twice',async t=>{
  let writes=0,receipt;
  const extensions={'permissions.inspect':async()=>({revision:'old',policy:{schemaVersion:1,users:{}}}),'permissions.save':async(input,ctx)=>{writes++;receipt={idempotencyKey:ctx.idempotencyKey,revision:'new'};throw Error('response lost after atomic policy write');},'permissions.receipt':async({idempotencyKey})=>({state:'completed',idempotencyKey,receipt})};
  const f=await setup(t,{extensions}),task=await f.create();await f.prepare(task,'permissions.update',{policy:{schemaVersion:1,users:{}}});const pending=await f.approve(task);assert.equal(pending.task.status,'unknown');await assert.rejects(f.request('tasks.input',{taskId:task.id,text:'重新执行'}),{code:'OUTCOME_UNKNOWN'});const result=await f.request('tasks.control',{taskId:task.id,action:'resume'});assert.equal(result.task.status,'completed');assert.equal(writes,1);
});

test('system schedule write rolls back when its receipt cannot be saved',async t=>{
  const f=await setup(t),task=await f.create();await f.prepare(task,'schedules.create',{goal:'查询',cron:'0 9 * * *',timezone:'Asia/Shanghai'});const insert=f.runtime.store.insert;f.runtime.store.insert=(kind,value)=>{if(kind==='system_receipt')throw Error('simulated crash before receipt');return insert(kind,value);};await f.approve(task);assert.equal(f.runtime.store.list('schedule').length,0);assert.equal(f.runtime.store.list('system_receipt').length,0);
});
