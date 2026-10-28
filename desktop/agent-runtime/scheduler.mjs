import {randomUUID} from 'node:crypto';
import {agentError} from './approval.mjs';

export async function nextOccurrence(cron,timezone,after,{allowLegacyThirtySeconds=false}={}){
  if(typeof cron!=='string'||cron.trim().split(/\s+/).length!==5&&!(allowLegacyThirtySeconds&&cron==='*/30 * * * * *'))throw agentError('SCHEDULE_INVALID','请使用五段 cron 表达式');
  try{new Intl.DateTimeFormat('zh-CN',{timeZone:timezone}).format();}catch{throw agentError('TIMEZONE_INVALID','请使用有效的 IANA 时区，例如 Asia/Shanghai');}
  try{const {CronExpressionParser}=await import('cron-parser');return CronExpressionParser.parse(cron,{tz:timezone,currentDate:new Date(after)}).next().toISOString();}
  catch(error){throw agentError('SCHEDULE_INVALID',error.code==='ERR_MODULE_NOT_FOUND'?'定时任务解析组件未安装':'定时规则无效或无可运行日期');}
}
export function createAgentScheduler({store,createTask,resolveActor,now=Date.now,next=nextOccurrence}){
  let ticking=false;
  const active=new Set(['queued','running','waiting_input','waiting_review','committing','unknown','paused']);
  const isMigratedThirtySeconds=schedule=>schedule?.cron==='*/30 * * * * *'&&store.list('schedule_migration').some(marker=>marker.scheduleId===schedule.id);
  const api={
    async prepare(input,actor,{allowLegacyThirtySeconds=false,origin}={}){
      if(actor.canRunTasks!==true||actor.role==='viewer')throw agentError('TASK_PERMISSION_REQUIRED','无权维护定时任务',403);
      const old=input.id?store.get('schedule',input.id):null;
      if(input.id&&!old)throw agentError('SCHEDULE_NOT_FOUND','定时任务不存在',404);
      if(old&&old.ownerId!==actor.id&&actor.role!=='admin')throw agentError('SCHEDULE_DENIED','只能维护自己的定时任务',403);
      const value={...old,...input,id:old?.id||randomUUID(),ownerId:old?.ownerId||actor.id,goal:String(input.goal??old?.goal??'').trim(),engine:input.engine||old?.engine||'codex',timezone:input.timezone||old?.timezone||'Asia/Shanghai',noOverlap:true,misfirePolicy:input.misfirePolicy||old?.misfirePolicy||'once',enabled:input.enabled??old?.enabled??true};
      value.origin=old?.origin||origin;
      if(!value.goal||value.goal.length>20000||!['codex','hermes'].includes(value.engine)||!['once','skip'].includes(value.misfirePolicy))throw agentError('SCHEDULE_INVALID','定时任务目标、引擎或漏跑规则无效');
      const selected=value.scope?.modules||[...actor.modules,'system'];
      if(!Array.isArray(selected)||selected.some(m=>m!=='system'&&!actor.modules.includes(m)))throw agentError('MODULE_DENIED','定时任务包含未授权模块',403);
      value.scope={modules:[...new Set(selected)]};
      value.nextRunAt=await next(value.cron,value.timezone,now(),{allowLegacyThirtySeconds:allowLegacyThirtySeconds||isMigratedThirtySeconds(old)});
      if(old&&input.version!==old.version)throw agentError('AGENT_REVISION_CHANGED','定时任务已变化，请重新查看后保存',409);
      return {value,expectedVersion:old?.version};
    },
    commit({value,expectedVersion}){return expectedVersion?store.update('schedule',value.id,value,{expectedVersion}):store.insert('schedule',value);},
    async save(input,actor){return api.commit(await api.prepare(input,actor));},
    async tick(){
      if(ticking)return; ticking=true;
      try{for(const schedule of store.list('schedule')){
        if(!schedule.enabled||Date.parse(schedule.nextRunAt)>now())continue;
        const actor=await resolveActor(schedule.ownerId);
        if(!actor||actor.enabled===false||actor.canRunTasks!==true||actor.role==='viewer'||(schedule.scope?.modules||[]).some(m=>m!=='system'&&!actor.modules?.includes(m))){store.update('schedule',schedule.id,{blockedReason:'permission_revoked'});continue;}
        if(store.list('task',schedule.ownerId).some(t=>t.scheduleId===schedule.id&&active.has(t.status))){store.update('schedule',schedule.id,{blockedReason:'previous_run_pending'});continue;}
        const occurrence=schedule.nextRunAt,late=now()-Date.parse(occurrence)>60000;
        const nextRunAt=await next(schedule.cron,schedule.timezone,now(),{allowLegacyThirtySeconds:isMigratedThirtySeconds(schedule)});
        if(late&&schedule.misfirePolicy==='skip'){
          store.transaction(()=>{store.claimRun(schedule.id,occurrence,null);store.finishRun(schedule.id,occurrence,'skipped');store.update('schedule',schedule.id,{nextRunAt,blockedReason:null});});continue;
        }
        const taskId=randomUUID();
        try{store.transaction(()=>{
          if(!store.claimRun(schedule.id,occurrence,taskId)){store.update('schedule',schedule.id,{nextRunAt});return;}
          const created=createTask({...schedule,id:taskId,scheduleId:schedule.id,scheduledFor:occurrence},actor);
          if(created?.then)throw agentError('SCHEDULE_STORE_CONTRACT','定时任务必须和运行记录在同一个事务内创建',500);
          store.update('schedule',schedule.id,{nextRunAt,lastRunAt:occurrence,blockedReason:null});
        });}
        catch(error){store.update('schedule',schedule.id,{enabled:false,blockedReason:error.code||'run_failed'});}
      }}finally{ticking=false;}
    }
  };return api;
}
