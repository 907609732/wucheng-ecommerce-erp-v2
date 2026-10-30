import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {taskTimeContext,taskPrompt} from '../desktop/agent-runtime/engine-common.mjs';
import {createAgentRuntime} from '../desktop/agent-runtime/index.mjs';

test('ordinary relative dates use the creation day in Shanghai across a UTC day boundary',()=>{
  const createdAt=Date.parse('2026-10-29T16:30:00Z'),executionAt=Date.parse('2026-10-31T03:00:00Z'),context=taskTimeContext({createdAt},executionAt);
  assert.equal(context.timeZone,'Asia/Shanghai');assert.equal(context.anchorSource,'createdAt');assert.equal(context.anchorLocalDate,'2026-10-30');assert.equal(context.anchorLocalDateTime,'2026-10-30T00:30:00');assert.equal(context.executionUtc,'2026-10-31T03:00:00.000Z');assert.match(taskPrompt({goal:'昨天的数据',timeContext:context}),/2026-10-30/);
});

test('late scheduled execution keeps its original occurrence and zone rather than the retry day',()=>{
  const task={createdAt:Date.parse('2026-11-02T23:00:00Z'),scheduledFor:'2026-10-29T23:30:00Z',businessTimezone:'America/New_York'},first=taskTimeContext(task,Date.parse('2026-11-02T23:00:00Z')),resumed=taskTimeContext(task,Date.parse('2026-11-04T07:00:00Z'));
  assert.equal(first.anchorSource,'scheduledFor');assert.equal(first.anchorLocalDate,'2026-10-29');assert.equal(first.anchorLocalDateTime,'2026-10-29T19:30:00');assert.equal(resumed.anchorUtc,first.anchorUtc);assert.equal(resumed.anchorLocalDateTime,first.anchorLocalDateTime);assert.notEqual(resumed.executionUtc,first.executionUtc);
  assert.throws(()=>taskTimeContext({createdAt:task.createdAt,scheduledFor:task.scheduledFor},task.createdAt),{code:'TASK_TIME_CONTEXT_UNAVAILABLE'});assert.throws(()=>taskTimeContext({...task,scheduledFor:'2026-10-29T23:30:00'},task.createdAt),{code:'TASK_TIME_CONTEXT_INVALID'});
});

async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-task-time-'));let clock=Date.parse('2026-10-29T16:30:00Z');const observed=[],actor={id:'synthetic-time-member',enabled:true};
  const engine=id=>({run:async({task})=>{observed.push({engine:id,context:structuredClone(task.timeContext),prompt:taskPrompt(task)});return {text:'此夹具仅观察时间上下文，不伪造业务结果',usage:{totalTokens:1}};}});
  const runtime=createAgentRuntime({storeDir:directory,resolveActor:async id=>id===actor.id?actor:null,engines:{codex:engine('codex'),hermes:engine('hermes')},secretStore:{has:()=>true,get:async()=>'synthetic-time-key'},autoStart:false,now:()=>clock,scheduleNext:async(_cron,_zone,after)=>new Date(after+600000).toISOString()});
  t.after(async()=>{await runtime.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const request=(operation,payload={})=>runtime.request(operation,payload,{actor:{id:actor.id,channel:'ui'},trustedUi:true});await request('settings.save',{company:{model:'synthetic-time-model'}});return {runtime,request,observed,setClock:time=>clock=Date.parse(time)};
}

test('server ignores client time fields and engine switching preserves the original relative-date anchor',async t=>{
  const f=await fixture(t),{task}=await f.request('tasks.create',{goal:'查询昨天的数据',createdAt:0,scheduledFor:'1900-01-01T00:00:00Z',businessTimezone:'UTC',timeContext:{anchorLocalDate:'1900-01-01'},engine:'codex'});
  assert.equal(task.createdAt,Date.parse('2026-10-29T16:30:00Z'));assert.equal(task.businessTimezone,'Asia/Shanghai');assert.equal(task.scheduledFor,null);await f.runtime.run(task.id);
  f.setClock('2026-10-31T20:00:00Z');await f.request('tasks.control',{taskId:task.id,action:'resume',engine:'hermes'});await f.runtime.run(task.id);
  assert.deepEqual(f.observed.map(item=>item.engine),['codex','hermes']);assert.equal(f.observed[0].context.anchorLocalDate,'2026-10-30');assert.equal(f.observed[1].context.anchorLocalDate,'2026-10-30');assert.equal(f.observed[1].context.executionUtc,'2026-10-31T20:00:00.000Z');assert.equal(f.observed[0].context.anchorUtc,f.observed[1].context.anchorUtc);
});

test('scheduled task freezes the real plan zone before later plan edits and missed execution',async t=>{
  const f=await fixture(t);f.setClock('2026-10-29T23:30:00Z');const {schedule}=await f.request('schedules.create',{goal:'昨天的定时查询',cron:'0 9 * * *',timezone:'America/New_York',misfirePolicy:'once'});
  f.setClock('2026-10-30T23:30:00Z');await f.runtime.tick();const task=f.runtime.store.list('task').find(value=>value.scheduleId===schedule.id);assert.equal(task.scheduledFor,'2026-10-29T23:40:00.000Z');assert.equal(task.businessTimezone,'America/New_York');
  const current=(await f.request('schedules.list')).schedules.find(value=>value.id===schedule.id);await f.request('schedules.update',{id:current.id,version:current.version,timezone:'Asia/Shanghai',enabled:false});await f.runtime.run(task.id);
  assert.equal(f.observed[0].context.timeZone,'America/New_York');assert.equal(f.observed[0].context.anchorLocalDate,'2026-10-29');assert.equal(f.observed[0].context.anchorSource,'scheduledFor');assert.equal(f.observed[0].context.executionUtc,'2026-10-30T23:30:00.000Z');
});
