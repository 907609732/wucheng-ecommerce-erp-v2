import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentRuntime} from '../desktop/agent-runtime/index.mjs';
import {taskPrompt} from '../desktop/agent-runtime/engine-common.mjs';

const definition=(change={})=>({schemaVersion:1,kind:'skill',name:'合成只读流程',description:'仅用于运行时测试',modules:['sales'],platforms:[],instructions:'旧流程版本一：查询后展示真实结果。',inputSchema:{type:'object',properties:{period:{type:'string',minLength:1}},required:['period'],additionalProperties:false},toolBindings:[{module:'sales',capabilityId:'read'}],outputRequirements:'保留来源',...change});
async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-skills-'));let clock=Date.now(),member={id:'synthetic-member',enabled:true};const observed=[];
  const read={id:'read',title:'合成查询',kind:'query',inputSchema:{type:'object',properties:{},additionalProperties:false}},pending={...read,id:'pending',available:false,unavailableReason:'待开通'};
  const adapter={id:'sales',capabilities:[read,pending],binding:async()=>({dataSetId:'synthetic-ledger',revision:1}),query:async()=>({summary:'合成记录查询完成',blocks:[{type:'table',title:'结果',rows:[]}],evidence:[{id:'synthetic-source'}]})};
  const engine=id=>({run:async({task,invoke})=>{observed.push({id,task:structuredClone(task),prompt:taskPrompt(task)});await invoke('erp_query',{module:'sales',capabilityId:'read',input:{}});return {text:'已取得实际查询结果',usage:{totalTokens:3}};}});
  const config={storeDir:directory,adapters:[adapter],engines:{codex:engine('codex'),hermes:engine('hermes')},resolveActor:async id=>id===member.id?member:null,secretStore:{has:()=>true,get:async()=>'synthetic-company-key'},autoStart:false,now:()=>clock,scheduleNext:async(_cron,_timezone,after)=>new Date(after+1000).toISOString()};let runtime=createAgentRuntime(config);
  t.after(async()=>{await runtime.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const request=(operation,payload={},trustedUi=true)=>runtime.request(operation,payload,{actor:{id:member.id,channel:trustedUi?'ui':'mcp'},trustedUi});
  await request('settings.save',{company:{model:'synthetic-company-model'}});
  return {get runtime(){return runtime;},request,adapter,read,observed,advance:n=>clock+=n,setMember:next=>member=next,async reopen(){await runtime.close();runtime=createAgentRuntime(config);}};
}
const save=f=>f.request('skills.save',{definition:definition(),changeNote:'创建合成流程'});
const enable=(f,value,number=value.revision.number)=>f.request('skills.setEnabled',{id:value.skill.id,version:value.skill.version,enabled:true,revision:number});
const taskInput=(value,extra={})=>({goal:'执行合成流程',scope:{modules:['sales']},skill:{id:value.skill.id,revision:value.revision.number},skillInputs:{period:'2026-10'},...extra});

test('skills persist immutable revisions with CAS, explicit activation and shared-member audit',async t=>{
  const f=await fixture(t);assert.deepEqual((await f.request('skills.list',{includeDisabled:true})).skills,[]);const first=await save(f);assert.equal(first.skill.enabled,false);assert.equal(first.skill.activeRevision,null);assert.equal(first.revision.number,1);assert.equal((await f.request('skills.list')).skills.length,0);
  const active=await enable(f,first),second=await f.request('skills.save',{id:first.skill.id,version:active.skill.version,definition:definition({instructions:'新流程版本二'}),changeNote:'修改流程'});
  assert.equal(second.revision.number,2);assert.equal(second.skill.activeRevision,1);assert.equal(second.skill.enabled,true);assert.notEqual(second.revision.sha256,first.revision.sha256);
  await assert.rejects(f.request('skills.save',{id:first.skill.id,version:active.skill.version,definition:definition()}),{code:'AGENT_REVISION_CHANGED'});
  const old=await f.request('skills.get',{id:first.skill.id,revision:1});assert.equal(old.revision.definition.instructions,first.revision.definition.instructions);assert.equal(old.revision.sha256,first.revision.sha256);assert.equal(old.revisions.length,2);assert.equal(old.skill.actualRun,null);
  await f.reopen();assert.equal((await f.request('skills.get',{id:first.skill.id})).revision.number,2);assert.ok(f.runtime.store.list('skill_audit').every(item=>item.actorId==='synthetic-member'));
});

test('portable import uses server preview hashes, rejects status injection and never overwrites by name',async t=>{
  const f=await fixture(t),first=await save(f),exported=await f.request('skills.export',{id:first.skill.id});assert.deepEqual(Object.keys(exported.document).sort(),['changeNote','definition','format','formatVersion']);assert.equal(exported.mimeType,'application/json');
  const preview=await f.request('skills.import',{document:exported.document,dryRun:true});assert.equal(preview.import.sha256,exported.sha256);assert.equal(preview.import.canImport,true);
  assert.equal((await f.request('skills.import',{document:exported.document,dryRun:true},false)).import.sha256,preview.import.sha256);await assert.rejects(f.request('skills.import',{document:exported.document,dryRun:false,expectedSha256:preview.import.sha256},false),{code:'HUMAN_SETTINGS_REQUIRED'});
  await assert.rejects(f.request('skills.import',{document:exported.document,dryRun:false,expectedSha256:'0'.repeat(64)}),{code:'SKILL_IMPORT_CHANGED'});
  await assert.rejects(f.request('skills.import',{document:{...exported.document,verified:true},dryRun:true}),{code:'SKILL_DEFINITION_INVALID'});
  const imported=await f.request('skills.import',{document:exported.document,dryRun:false,expectedSha256:preview.import.sha256});assert.notEqual(imported.skill.id,first.skill.id);assert.equal(imported.skill.enabled,false);assert.equal((await f.request('skills.list',{includeDisabled:true})).skills.length,2);
  await assert.rejects(f.request('skills.import',{document:exported.document,dryRun:false,expectedSha256:preview.import.sha256,targetId:first.skill.id}),{code:'AGENT_REVISION_CHANGED'});
});

test('activation checks live bindings and rejects unsupported schemas, remote references and executable extensions',async t=>{
  const f=await fixture(t);
  for(const extra of [{script:'run'},{mcpServerUrl:'https://untrusted.invalid'},{verified:true}])await assert.rejects(f.request('skills.save',{definition:definition(extra)}),{code:'SKILL_DEFINITION_INVALID'});
  for(const schema of [{type:'object',$ref:'https://untrusted.invalid/schema'},{type:'object',properties:{value:{type:'string',pattern:'(a+)+$'}}}])await assert.rejects(f.request('skills.save',{definition:definition({inputSchema:schema})}),{code:'SKILL_DEFINITION_INVALID'});
  await assert.rejects(f.request('skills.save',{definition:definition({toolBindings:[{module:'sales',capabilityId:'unregistered'}]})}),{code:'SKILL_BINDING_UNAVAILABLE'});
  const waiting=await f.request('skills.save',{definition:definition({toolBindings:[{module:'sales',capabilityId:'pending'}]})});await assert.rejects(enable(f,waiting),{code:'SKILL_BINDING_UNAVAILABLE'});
  const prompt=await f.request('skills.save',{definition:definition({kind:'prompt',toolBindings:[]})});assert.equal((await enable(f,prompt)).skill.enabled,true);
});

test('task creation validates active revision, scope and inputs without accepting client snapshots',async t=>{
  const f=await fixture(t),first=await save(f);await assert.rejects(f.request('tasks.create',taskInput(first)),{code:'SKILL_DISABLED'});await enable(f,first);
  await assert.rejects(f.request('tasks.create',taskInput(first,{skill:{id:first.skill.id,revision:2}})),{code:'SKILL_REVISION_CHANGED'});
  await assert.rejects(f.request('tasks.create',taskInput(first,{skillInputs:{period:10}})),{code:'SKILL_INPUT_INVALID'});
  await assert.rejects(f.request('tasks.create',taskInput(first,{scope:{modules:['system']}})),{code:'SKILL_BINDING_UNAVAILABLE'});
  await assert.rejects(f.request('tasks.create',taskInput(first,{skillSnapshot:{definition:definition()}})),{code:'SKILL_DEFINITION_INVALID'});
  const created=await f.request('tasks.create',taskInput(first));assert.equal(created.task.skill.revision,1);assert.equal(created.task.skillSnapshot,undefined);assert.equal(created.task.skill.definition,undefined);assert.deepEqual(created.task.skillInputs,{period:'2026-10'});assert.equal(f.runtime.store.get('task',created.task.id).skillSnapshot.definition.instructions,first.revision.definition.instructions);
});

test('both engines use the same persisted snapshot despite edits, activation changes and later disablement',async t=>{
  const f=await fixture(t),first=await save(f),active=await enable(f,first),codex=(await f.request('tasks.create',taskInput(first,{engine:'codex'}))).task,hermes=(await f.request('tasks.create',taskInput(first,{engine:'hermes'}))).task;
  const second=await f.request('skills.save',{id:first.skill.id,version:active.skill.version,definition:definition({instructions:'新流程版本二'})}),newActive=await enable(f,second);await f.request('skills.setEnabled',{id:first.skill.id,version:newActive.skill.version,enabled:false});
  await f.reopen();f.advance(1);await f.runtime.run(codex.id);f.advance(1);await f.runtime.run(hermes.id);
  assert.equal(f.observed.length,2);for(const observed of f.observed){assert.match(observed.prompt,/旧流程版本一/);assert.doesNotMatch(observed.prompt,/新流程版本二/);assert.equal(observed.task.skillSnapshot.revision,1);assert.deepEqual(observed.task.skillInputs,{period:'2026-10'});}
  assert.equal((await f.request('tasks.get',{taskId:hermes.id})).task.status,'completed');const history=await f.request('skills.get',{id:first.skill.id,revision:1});assert.equal(history.skill.actualRun.state,'completed');assert.equal(history.skill.actualRun.engine,'hermes');assert.equal(history.skill.actualRun.model,'synthetic-company-model');
  await assert.rejects(f.request('tasks.create',taskInput(first)),{code:'SKILL_DISABLED'});
});

test('changed dependency schemas pause frozen tasks and configuration writes stay outside MCP',async t=>{
  const f=await fixture(t),first=await save(f);await enable(f,first);const {task}=await f.request('tasks.create',taskInput(first));f.read.inputSchema={type:'object',properties:{newField:{type:'string'}}};await f.runtime.run(task.id);
  const paused=await f.request('tasks.get',{taskId:task.id});assert.equal(paused.task.status,'paused');assert.equal(paused.task.pauseReason,'SKILL_BINDING_UNAVAILABLE');assert.equal(f.observed.length,0);
  await assert.rejects(f.request('skills.save',{definition:definition()},false),{code:'HUMAN_SETTINGS_REQUIRED'});await assert.rejects(f.request('skills.setEnabled',{id:first.skill.id,version:2,enabled:false},false),{code:'HUMAN_SETTINGS_REQUIRED'});
  const free=(await f.request('tasks.create',{goal:'检查配置边界'})).task;f.runtime.store.update('task',free.id,{status:'running'});await assert.rejects(f.runtime.invokeTool(free.id,'skills.save',{definition:definition()}),{code:'TOOL_DENIED'});
  f.setMember({id:'synthetic-member',enabled:false});await assert.rejects(f.request('skills.list',{includeDisabled:true}),{code:'MEMBER_DENIED'});
});

test('schedules pin skill references and block new occurrences after the active version changes',async t=>{
  const f=await fixture(t),first=await save(f),active=await enable(f,first);
  const {schedule}=await f.request('schedules.create',{goal:'定时合成查询',cron:'0 9 * * *',timezone:'Asia/Shanghai',engine:'hermes',scope:{modules:['sales']},skill:{id:first.skill.id,revision:1},skillInputs:{period:'2026-10'}});assert.deepEqual(schedule.skill,{id:first.skill.id,revision:1});assert.equal(schedule.skillSnapshot,undefined);
  f.advance(1000);await f.runtime.tick();const firstRun=f.runtime.store.list('task').find(task=>task.scheduleId===schedule.id);assert.equal(firstRun.skillSnapshot.revision,1);await f.runtime.run(firstRun.id);
  const second=await f.request('skills.save',{id:first.skill.id,version:active.skill.version,definition:definition({instructions:'另一流程'})});await enable(f,second);f.advance(1000);await f.runtime.tick();const blocked=f.runtime.store.get('schedule',schedule.id);assert.equal(blocked.enabled,false);assert.equal(blocked.blockedReason,'SKILL_REVISION_CHANGED');assert.equal(f.runtime.store.runs(schedule.id).length,1);
  const free=(await f.request('schedules.create',{goal:'原有自由目标计划',cron:'0 9 * * *',timezone:'Asia/Shanghai',scope:{modules:['sales']}})).schedule;f.advance(1000);await f.runtime.tick();assert.equal(f.runtime.store.list('task').find(task=>task.scheduleId===free.id).skillSnapshot,undefined);
});
