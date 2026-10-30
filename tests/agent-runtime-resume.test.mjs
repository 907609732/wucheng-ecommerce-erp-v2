import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentRuntime} from '../desktop/agent-runtime/index.mjs';
import {signAgentApproval} from '../desktop/agent-runtime/approval.mjs';

const actor={id:'resume-admin',role:'admin',enabled:true,canRunTasks:true,modules:['warehouse','purchase','sales','overview','exporter'],channel:'ui'};
const empty={type:'object',additionalProperties:false};
const binding=()=>({dataSetId:'resume-ledger',revision:1});
const capability=(id,kind='query',extra={})=>({id,title:id,kind,inputSchema:empty,...extra});

function fixture(t,{adapters=[],engine,extensions={}}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-resume-'));
  const people=new Map([[actor.id,actor]]);
  const runtime=createAgentRuntime({storeDir:directory,autoStart:false,adapters,engines:engine?{codex:engine}:{},extensions,resolveActor:async id=>people.get(id),secretStore:{has:()=>true,get:async()=>'synthetic-resume-key'},signApproval:async claims=>signAgentApproval(claims,'d'.repeat(64))});
  t.after(async()=>{await runtime.close();fs.rmSync(directory,{recursive:true,force:true});});
  const request=(operation,payload={},meta={})=>runtime.request(operation,payload,{actor,trustedUi:true,...meta});
  const create=async(modules=['sales'])=>(await request('tasks.create',{goal:'续接回归用合成任务',scope:{modules}})).task;
  const invoke=async(task,module,id,input={},kind='query')=>runtime.invokeTool(task.id,kind==='query'?'erp_query':'erp_prepare',{module,capabilityId:id,input});
  const running=task=>runtime.store.update('task',task.id,{status:'running'});
  const approve=async task=>{const {review}=await request('tasks.get',{taskId:task.id});return request('reviews.approve',{taskId:task.id,reviewId:review.id,resultVersion:review.resultVersion,revision:review.revision});};
  return {directory,people,runtime,request,create,invoke,running,approve};
}

const migrationInput=()=>({ownerId:actor.id,sourceId:'warehouse:resume-ledger',sourceRevision:'source-r1',entries:[{legacyKey:'warehouse.legacy.reminder.sweep',goal:'按旧30秒规则检查提醒，发送仍须人审',cron:'*/30 * * * * *',timezone:'Asia/Shanghai',enabled:true}]});

test('migrated 30-second schedules retain their adopter and use the same goal-update validator',async t=>{
  const f=fixture(t,{adapters:[{id:'warehouse',capabilities:[],binding}]}),input=migrationInput();
  await f.runtime.importSchedules(input);
  let schedule=f.runtime.store.list('schedule')[0];
  for(const record of [schedule.origin,f.runtime.store.list('schedule_migration')[0]]){
    assert.equal(record.sourceOwnerId,null);assert.equal(record.adoptedBy,actor.id);
    assert.equal(record.ownerMapping,'legacy-global-host-owner');assert.equal(record.engineMapping,'company-default');
  }
  await assert.rejects(f.request('schedules.create',{goal:'不能新增秒级计划',cron:'*/30 * * * * *',timezone:'Asia/Shanghai'}),{code:'SCHEDULE_INVALID'});
  const task=await f.create(['system']);f.running(task);
  await f.invoke(task,'system','schedules.update',{id:schedule.id,goal:'修改已接管旧计划'},'prepare');
  await f.approve(task);schedule=f.runtime.store.get('schedule',schedule.id);
  assert.equal(schedule.goal,'修改已接管旧计划');assert.equal(schedule.cron,'*/30 * * * * *');
  await f.request('schedules.delete',{id:schedule.id,version:schedule.version});
  const other={...actor,id:'other-admin'};f.people.set(other.id,other);
  assert.equal((await f.runtime.importSchedules({...input,ownerId:other.id})).existing,1);
  assert.equal(f.runtime.store.list('schedule').length,0);
  assert.equal(f.runtime.store.list('schedule_migration')[0].adoptedBy,actor.id);
});

test('reimport fills legacy provenance without resetting schedule behavior or its original owner',async t=>{
  const f=fixture(t,{adapters:[{id:'warehouse',capabilities:[],binding}]}),input=migrationInput();
  await f.runtime.importSchedules(input);
  const schedule=f.runtime.store.list('schedule')[0],marker=f.runtime.store.list('schedule_migration')[0];
  const {sourceOwnerId,adoptedBy,ownerMapping,engineMapping,...oldOrigin}=schedule.origin;
  f.runtime.store.update('schedule',schedule.id,{goal:'用户后来已改的目标',enabled:false,origin:oldOrigin});
  f.runtime.store.update('schedule_migration',marker.id,{sourceOwnerId:undefined,adoptedBy:undefined,ownerMapping:undefined,engineMapping:undefined});
  await f.runtime.importSchedules(input);
  const updated=f.runtime.store.get('schedule',schedule.id);
  assert.equal(updated.goal,'用户后来已改的目标');assert.equal(updated.enabled,false);
  assert.equal(updated.origin.adoptedBy,actor.id);assert.equal(updated.origin.sourceOwnerId,null);
  assert.equal(f.runtime.store.get('schedule_migration',marker.id).adoptedBy,actor.id);
});

test('job completion resolves only its own module and persistent ID while preserving result history',async t=>{
  const states=new Map([['job-a','processing'],['job-b','processing']]);
  const makeAdapter=module=>({id:module,binding,capabilities:[capability('status','query',{inputSchema:{type:'object',properties:{jobId:{type:'string'}},required:['jobId'],additionalProperties:false}})],query:(_,input)=>{
    const status=states.get(input.jobId)||'unknown',complete=status==='completed';
    return {summary:'后台任务状态',blocks:[{id:'same-explicit-id',type:'job',jobId:input.jobId,status}],evidence:[{jobId:input.jobId,status,complete}],issues:complete?[]:[{code:'BACKGROUND_PROCESSING',blocking:true,jobId:input.jobId,status,queryCapability:module+'.cainiao-job'}]};
  }});
  const f=fixture(t,{adapters:[makeAdapter('sales'),makeAdapter('overview')]}),task=await f.create(['sales','overview']);f.running(task);
  const initial=await f.invoke(task,'sales','status',{jobId:'job-a'});
  await f.invoke(task,'sales','status',{jobId:'job-b'});
  states.set('job-a','completed');await f.invoke(task,'overview','status',{jobId:'job-a'});
  let current=(await f.request('tasks.get',{taskId:task.id})).result;
  assert.equal(current.issues.find(issue=>issue.jobId==='job-a').blocking,true);
  const done=await f.invoke(task,'sales','status',{jobId:'job-a'});
  const resolved=done.result.issues.find(issue=>issue.jobId==='job-a');
  assert.equal(resolved.resolved,true);assert.equal(resolved.blocking,false);assert.equal(resolved.originalBlocking,true);
  assert.equal(resolved.resolution.module,'sales');assert.match(resolved.resolution.evidenceDigest,/^[a-f0-9]{64}$/);
  assert.equal(done.result.issues.find(issue=>issue.jobId==='job-b').blocking,true);
  assert.equal(new Set(done.result.blocks.map(block=>block.id)).size,done.result.blocks.length);
  const historical=(await f.request('tasks.get',{taskId:task.id,resultVersion:initial.result.version})).result;
  assert.equal(historical.issues[0].blocking,true);assert.equal(historical.issues[0].resolved,undefined);
});

test('unknown, failed and unverified terminal job responses do not release a saved blocker',async t=>{
  let state='processing',complete=false;
  const f=fixture(t,{adapters:[{id:'purchase',binding,capabilities:[capability('ocr.status')],query:()=>({summary:'识别状态',blocks:[{type:'job',jobId:'ocr-a',status:state}],evidence:[{jobId:'ocr-a',status:state,complete}],issues:state==='processing'?[{id:'purchase:ocr:ocr-a',code:'OCR_JOB_INCOMPLETE',blocking:true,jobId:'ocr-a'}]:[]})}]}),task=await f.create(['purchase']);f.running(task);
  await f.invoke(task,'purchase','ocr.status');
  for(const status of ['unknown','failed','completed']){
    state=status;const output=await f.invoke(task,'purchase','ocr.status');assert.equal(output.result.issues[0].blocking,true,status);
  }
  state='done';complete=true;const output=await f.invoke(task,'purchase','ocr.status');assert.equal(output.result.issues[0].blocking,false);
});

const draftAdapter=()=>({id:'sales',binding,capabilities:[capability('draft','prepare',{resultEditFields:['amountCents'],inputSchema:{type:'object',properties:{amountCents:{type:'integer',minimum:0}},required:['amountCents'],additionalProperties:false}})],prepare:(_,input)=>({summary:'待复核草稿',blocks:[{id:'sales-draft',type:'table',rowKey:'id',editableFields:['amountCents'],sourceModule:'forged',sourceCapabilityId:'forged',rows:[{id:'line-a',amountCents:input.amountCents}]}],evidence:[{id:'synthetic-source'}],commitData:{amountCents:input.amountCents},changes:[{amountCents:input.amountCents}]})});
const correctionPayload=(task,result)=>({taskId:task.id,corrections:{resultId:result.id,resultVersion:result.version,edits:[{blockId:result.blocks[0].id,rowKey:'line-a',field:'amountCents',before:100,after:250}]}});

test('human row corrections invalidate approval and preserve the old draft without editing ledger payloads',async t=>{
  const f=fixture(t,{adapters:[draftAdapter()]}),task=await f.create();f.running(task);
  const {result}=await f.invoke(task,'sales','draft',{amountCents:100},'prepare');
  assert.equal(result.blocks[0].sourceModule,'sales');assert.equal(result.blocks[0].sourceCapabilityId,'draft');
  const before=await f.request('tasks.get',{taskId:task.id}),payload=correctionPayload(task,result);
  await assert.rejects(f.request('tasks.input',payload,{trustedUi:false}),{code:'HUMAN_REVIEW_REQUIRED'});
  await assert.rejects(f.request('tasks.input',{...payload,corrections:{...payload.corrections,resultVersion:0}}),{code:'RESULT_STALE'});
  const changed=await f.request('tasks.input',payload);
  assert.equal(changed.task.status,'queued');assert.equal(changed.task.review,null);
  assert.equal(changed.task.corrections[0].actorId,actor.id);assert.equal(changed.task.corrections[0].edits[0].after,250);
  const original=f.runtime.store.get('result',result.id);
  assert.equal(original.blocks[0].rows[0].amountCents,100);assert.equal(original.prepared[0].commitData.amountCents,100);
  assert.equal(f.runtime.store.get('task',task.id).resultId,null);
  await assert.rejects(f.request('reviews.approve',{taskId:task.id,reviewId:before.review.id,resultVersion:before.review.resultVersion,revision:before.review.revision}),{code:'REVIEW_STALE'});
  f.running(task);const fresh=await f.invoke(task,'sales','draft',{amountCents:250},'prepare');
  assert.notEqual(fresh.result.id,result.id);assert.equal(fresh.result.blocks[0].rows[0].amountCents,250);
});

test('editing a visible draft stops its live engine before resetting and can execute the next turn', {timeout:5000},async t=>{
  let entered,turns=0;const started=new Promise(resolve=>entered=resolve);
  const f=fixture(t,{adapters:[draftAdapter()],engine:{run:async({task,invoke,signal})=>{
    turns++;const amountCents=task.corrections?.at(-1)?.edits[0].after??100;
    await invoke('erp_prepare',{module:'sales',capabilityId:'draft',input:{amountCents}});
    if(turns===1){entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason||Error('cancelled')),{once:true}));}
    return {usage:{totalTokens:1}};
  }}});
  await f.request('settings.save',{company:{model:'synthetic-resume'}});const task=await f.create();
  const firstRun=f.runtime.run(task.id);await started;
  const {result}=await f.request('tasks.get',{taskId:task.id});await f.request('tasks.input',correctionPayload(task,result));await firstRun;
  assert.equal(f.runtime.store.get('task',task.id).status,'queued');
  await f.runtime.run(task.id);assert.equal(turns,2);
  const after=await f.request('tasks.get',{taskId:task.id});assert.equal(after.task.status,'waiting_review');assert.equal(after.result.blocks[0].rows[0].amountCents,250);
});

test('private artifact handoff binds source to the invoking capability and rejects cross-task or changed files',async t=>{
  let f,source,consumerContext;
  const producer={id:'overview',binding,capabilities:[capability('original')],query:(_,input,ctx)=>{
    const file=path.join(f.directory,'tasks',ctx.taskId,'source.txt');fs.writeFileSync(file,'source-a');
    source=ctx.registerArtifact({path:file,name:'source.txt',mimeType:'text/plain',sourceModule:'purchase',sourceCapabilityId:'forged'});
    return {summary:'官方原件',blocks:[{type:'files',files:[{artifactId:source.id}]}],evidence:[{artifactId:source.id,sha256:source.sha256}]};
  }};
  const consumer={id:'sales',binding,capabilities:[capability('handoff','query',{inputSchema:{type:'object',properties:{artifactId:{type:'string'}},required:['artifactId'],additionalProperties:false}})],query:async(_,input,ctx)=>{
    consumerContext=ctx;const item=await ctx.resolveTaskArtifact(input.artifactId);
    assert.equal(item.sourceModule,'overview');assert.equal(item.sourceCapabilityId,'original');
    return {summary:'原件已核验',blocks:[{type:'text',text:fs.readFileSync(item.path,'utf8')}],evidence:[{artifactId:item.id,sha256:item.sha256}]};
  }};
  f=fixture(t,{adapters:[producer,consumer]});const task=await f.create(['overview','sales']);f.running(task);
  await f.invoke(task,'overview','original');assert.equal(source.sourceModule,'overview');
  await f.invoke(task,'sales','handoff',{artifactId:source.id});const accepted=source;
  const other=await f.create(['overview','sales']);f.running(other);
  await assert.rejects(f.invoke(other,'sales','handoff',{artifactId:accepted.id}),{code:'ARTIFACT_DENIED'});
  await f.invoke(task,'sales','handoff',{artifactId:accepted.id});
  f.people.set(actor.id,{...actor,modules:['sales']});await assert.rejects(consumerContext.resolveTaskArtifact(accepted.id),{code:'MODULE_DENIED'});
  f.people.set(actor.id,actor);
  const saved=f.runtime.store.get('artifact',accepted.id);fs.writeFileSync(saved.path,'source-b');
  await assert.rejects(f.invoke(task,'sales','handoff',{artifactId:accepted.id}),{code:'ARTIFACT_CHANGED'});
  fs.writeFileSync(saved.path,'source-a');
  const outside=path.join(f.directory,'outside-task.txt');fs.writeFileSync(outside,'source-a');
  f.runtime.store.update('artifact',accepted.id,{path:outside});
  await assert.rejects(f.invoke(task,'sales','handoff',{artifactId:accepted.id}),{code:'ARTIFACT_CHANGED'});
  f.runtime.store.update('artifact',accepted.id,{path:saved.path});
  f.runtime.store.update('artifact',accepted.id,{sourceModule:undefined,sourceCapabilityId:undefined});
  await assert.rejects(f.invoke(task,'sales','handoff',{artifactId:accepted.id}),{code:'ARTIFACT_SOURCE_UNKNOWN'});
});

function backupHooks({lost=false,mismatched=false}={}){
  const restore={backupId:'backup-source',recoveryId:'recovery-copy',manifestSha256:'e'.repeat(64)};
  let writes=0,receipt;
  return {restore,get writes(){return writes;},extensions:{
    'backups.list':async()=>({summary:'备份目录',blocks:[{type:'table',rows:[{backupId:restore.backupId}]}],evidence:[],issues:[]}),
    'backups.verify':async()=>({summary:'副本核验通过',blocks:[{type:'text',text:'已核验'}],evidence:[{id:restore.backupId,manifestSha256:restore.manifestSha256}],issues:[]}),
    'backups.restore.prepare':async()=>({summary:'待复核隔离恢复副本',blocks:[{type:'text',text:'不会覆盖当前账本'}],changes:[{kind:'restore-copy',...restore,activated:false}],evidence:[{id:restore.backupId,manifestSha256:restore.manifestSha256}],commitData:{...restore}}),
    'backups.restore.commit':async({commitData},ctx)=>{assert.deepEqual(commitData,restore);assert.ok(ctx.approval);writes++;receipt={kind:'backup-restore-copy',idempotencyKey:ctx.idempotencyKey,...restore,verified:true,activated:false,...(mismatched?{manifestSha256:'f'.repeat(64)}:{})};if(lost)throw Error('response lost after recovery copy');return {receipt};},
    'backups.restore.receipt':async({idempotencyKey})=>receipt?{state:'completed',idempotencyKey,receipt}:{state:'unknown',idempotencyKey}
  }};
}

test('backup queries are admin-only and a recovery copy requires exact human-bound evidence',async t=>{
  const hooks=backupHooks(),f=fixture(t,{extensions:hooks.extensions}),task=await f.create(['system']);f.running(task);
  await f.invoke(task,'system','backups.list');await f.invoke(task,'system','backups.verify',{backupId:hooks.restore.backupId});
  const draft=await f.invoke(task,'system','backups.restore-copy',{backupId:hooks.restore.backupId},'prepare');
  assert.equal(draft.requiresReview,true);assert.equal(hooks.writes,0);
  const before=await f.request('tasks.get',{taskId:task.id});
  await assert.rejects(f.request('reviews.approve',{taskId:task.id,reviewId:before.review.id,resultVersion:before.review.resultVersion,revision:before.review.revision},{trustedUi:false}),{code:'HUMAN_REVIEW_REQUIRED'});
  const done=await f.approve(task);assert.equal(done.task.status,'completed');assert.equal(hooks.writes,1);
  assert.equal(done.result.receipt.receipts[0].manifestSha256,hooks.restore.manifestSha256);
  assert.equal(done.result.receipt.receipts[0].recoveryId,hooks.restore.recoveryId);assert.equal(done.result.receipt.receipts[0].activated,false);
  const other=await f.create(['system']);f.running(other);f.people.set(actor.id,{...actor,role:'viewer',canRunTasks:false});
  await assert.rejects(f.invoke(other,'system','backups.list'),{code:'CAPABILITY_DENIED'});
});

test('lost recovery-copy responses reconcile their receipt without copying twice',async t=>{
  const hooks=backupHooks({lost:true}),f=fixture(t,{extensions:hooks.extensions}),task=await f.create(['system']);f.running(task);
  await f.invoke(task,'system','backups.restore-copy',{backupId:hooks.restore.backupId},'prepare');
  assert.equal((await f.approve(task)).task.status,'unknown');assert.equal(hooks.writes,1);
  const reconciled=await f.request('tasks.control',{taskId:task.id,action:'resume'});
  assert.equal(reconciled.task.status,'completed');assert.equal(hooks.writes,1);
  assert.equal(reconciled.result.receipt.receipts[0].activated,false);
});

test('a completed response with a different manifest never verifies a recovery copy',async t=>{
  const hooks=backupHooks({mismatched:true}),f=fixture(t,{extensions:hooks.extensions}),task=await f.create(['system']);f.running(task);
  await f.invoke(task,'system','backups.restore-copy',{backupId:hooks.restore.backupId},'prepare');
  assert.equal((await f.approve(task)).task.status,'unknown');
  assert.equal((await f.request('tasks.control',{taskId:task.id,action:'resume'})).task.status,'unknown');assert.equal(hooks.writes,1);
});

test('role or module revocation removes sensitive system histories and all artifact entry points',async t=>{
  let f,artifact,previewed=0;
  f=fixture(t,{extensions:{
    'backups.verify':async(input,ctx)=>{
      const file=path.join(f.directory,'tasks',ctx.taskId,'backup-proof.txt');fs.writeFileSync(file,'backup-proof');
      artifact=ctx.registerArtifact({path:file,name:'backup-proof.txt',mimeType:'text/plain'});
      return {summary:'跨模块备份校验结果',blocks:[{type:'files',files:[{artifactId:artifact.id}]}],evidence:[{id:input.backupId}]};
    },
    'artifacts.open':async()=>{previewed++;return {opened:true};},
    'artifacts.preview':async()=>{previewed++;return {preview:{name:'synthetic'}};}
  }});
  const task=await f.create(['system']);f.running(task);
  const first=await f.invoke(task,'system','backups.verify',{backupId:'backup-source'});
  const requirements=f.runtime.store.get('task',task.id).dataAccessRequirements;
  assert.deepEqual(requirements[0].roles,['admin']);assert.equal(requirements[0].modules.length,5);
  await f.request('artifacts.preview',{id:artifact.id,taskId:task.id});assert.equal(previewed,1);
  const other=await f.create(['system']);
  await assert.rejects(f.request('artifacts.preview',{id:artifact.id,taskId:other.id}),{code:'ARTIFACT_TASK_MISMATCH'});
  await assert.rejects(f.request('artifacts.preview',{id:artifact.id}),{code:'ARTIFACT_TASK_MISMATCH'});
  f.people.set(actor.id,{...actor,role:'editor'});
  assert.equal((await f.request('tasks.list')).tasks.some(item=>item.id===task.id),false);
  for(const payload of [{taskId:task.id},{taskId:task.id,resultVersion:first.result.version}])await assert.rejects(f.request('tasks.get',payload),{code:'TASK_DATA_DENIED'});
  await assert.rejects(f.request('artifacts.open',{id:artifact.id}),{code:'TASK_DATA_DENIED'});
  await assert.rejects(f.request('artifacts.preview',{id:artifact.id,taskId:task.id}),{code:'TASK_DATA_DENIED'});assert.equal(previewed,1);
  f.people.set(actor.id,{...actor,modules:actor.modules.filter(module=>module!=='overview')});
  assert.equal((await f.request('tasks.list')).tasks.some(item=>item.id===task.id),false);
  await assert.rejects(f.request('tasks.get',{taskId:task.id}),{code:'MODULE_DENIED'});
  await assert.rejects(f.request('artifacts.preview',{id:artifact.id,taskId:task.id}),{code:'MODULE_DENIED'});
});

test('ordinary draft history stays readable to a viewer without turning implicit write permission into a read gate',async t=>{
  const f=fixture(t,{adapters:[draftAdapter()]}),task=await f.create(['sales']);f.running(task);
  const first=await f.invoke(task,'sales','draft',{amountCents:100},'prepare');
  f.people.set(actor.id,{...actor,role:'viewer',canRunTasks:false,modules:['sales']});
  assert.equal((await f.request('tasks.get',{taskId:task.id,resultVersion:first.result.version})).result.blocks[0].rows[0].amountCents,100);
  assert.equal((await f.request('tasks.list')).tasks.some(item=>item.id===task.id),true);
  // Legacy tasks can recover ordinary access from their registered block/step.
  f.runtime.store.update('task',task.id,{dataAccessRequirements:undefined});
  assert.equal((await f.request('tasks.get',{taskId:task.id})).result.blocks[0].rows[0].amountCents,100);
});

test('unattributed legacy system results fail closed instead of exposing their history after downgrade',async t=>{
  const f=fixture(t,{extensions:{'permissions.inspect':async()=>({revision:'policy-r1',policy:{schemaVersion:1,users:{}}})}}),task=await f.create(['system']);f.running(task);
  await f.invoke(task,'system','permissions.list');
  f.runtime.store.update('task',task.id,{dataAccessRequirements:undefined});
  for(const kind of ['result','result_version'])for(const value of f.runtime.store.list(kind).filter(value=>value.taskId===task.id))f.runtime.store.update(kind,value.id,{blocks:value.blocks.map(({sourceModule,sourceCapabilityId,...block})=>block)});
  f.people.set(actor.id,{...actor,role:'viewer',canRunTasks:false});
  await assert.rejects(f.request('tasks.get',{taskId:task.id}),{code:'TASK_DATA_DENIED'});
  assert.equal((await f.request('tasks.list')).tasks.some(value=>value.id===task.id),false);
  f.people.set(actor.id,actor);assert.ok((await f.request('tasks.get',{taskId:task.id})).result);
});

test('sensitive tool failures still retain access requirements before emitting files or events',async t=>{
  let f,artifact;
  f=fixture(t,{extensions:{'backups.verify':async(_,ctx)=>{
    const file=path.join(f.directory,'tasks',ctx.taskId,'partial-proof.txt');fs.writeFileSync(file,'partial');
    artifact=ctx.registerArtifact({path:file,name:'partial-proof.txt'});ctx.emit('partial-proof',{artifactId:artifact.id});
    throw Error('failed after registering evidence');
  },'artifacts.open':async()=>({opened:true})}});
  const task=await f.create(['system']);f.running(task);await assert.rejects(f.invoke(task,'system','backups.verify',{backupId:'backup-source'}));
  assert.equal(f.runtime.store.get('task',task.id).resultId,null);
  f.people.set(actor.id,{...actor,role:'viewer',canRunTasks:false});
  await assert.rejects(f.request('tasks.get',{taskId:task.id}),{code:'TASK_DATA_DENIED'});
  await assert.rejects(f.request('artifacts.open',{id:artifact.id}),{code:'TASK_DATA_DENIED'});
});
