import {createHash} from 'node:crypto';
import {hostError} from './common.mjs';

/** Only the host calls this reader/importer. A renderer or model cannot supply the source. */
export function createLegacyScheduleTakeover({warehouse,runtime,identity,getCompanyIdentity,onError=()=>{},now=Date.now}={}){
  let state={status:'pending'},nextAttempt=0,pending,closed=false,lastFailure;
  async function migrate(){
    if(closed||state.status==='completed'||now()<nextAttempt)return state;
    nextAttempt=now()+60000;
    if(!warehouse||typeof runtime.importSchedules!=='function')throw hostError('SCHEDULE_MIGRATION_UNAVAILABLE','统一调度迁入能力尚未接好',503);
    const owner=identity.localActor();identity.requireAdmin(owner,true);
    const company=getCompanyIdentity(),taskId='schedule-migration-'+createHash('sha256').update(company.companyId).digest('hex');
    const ctx={actor:{...owner,channel:'migration'},taskId,capabilityId:'schedules.legacy'};
    const binding=await warehouse.binding(ctx),result=await warehouse.query('schedules.legacy',{},ctx),source=result?.data;
    if(source?.schemaVersion!==1||source.module!=='warehouse'||source.dataSetId!==binding.dataSetId||source.schedulingOwner!=='agent'||source.legacyTimersDisabled!==true||typeof source.configurationRevision!=='string'||!source.configurationRevision||!Array.isArray(source.candidates))throw hostError('SCHEDULE_MIGRATION_SOURCE_INVALID','旧调度来源不完整或尚未停止旧计时器，不能迁入',409);
    const entries=source.candidates.map(candidate=>{
      const input=candidate.schedulerInput;
      if(candidate.module!=='warehouse'||candidate.dataSetId!==binding.dataSetId||candidate.sourceRevision!==source.configurationRevision||typeof candidate.migrationKey!=='string'||candidate.enabled!==input?.enabled||typeof input.enabled!=='boolean'||candidate.timezone!==input.timezone||input.scope?.modules?.length!==1||input.scope.modules[0]!=='warehouse'||input.noOverlap!==true)throw hostError('SCHEDULE_MIGRATION_SOURCE_INVALID','旧调度计划与来源记录不一致',409);
      if(candidate.migrationKey==='warehouse.legacy.reminder.sweep'&&(source.source?.reminderIntervalMs!==30000||input.cron!=='*/30 * * * * *'||input.enabled!==(source.source?.autoRemind===true)))throw hostError('SCHEDULE_MIGRATION_CADENCE_INVALID','员工提醒必须保留原30秒节奏和原启用状态',409);
      return {legacyKey:candidate.migrationKey,goal:input.goal,cron:input.cron,timezone:input.timezone,enabled:input.enabled,misfirePolicy:input.misfirePolicy};
    });
    const imported=await runtime.importSchedules({sourceId:'warehouse:'+binding.dataSetId,sourceRevision:source.configurationRevision,ownerId:owner.id,entries});
    state={status:'completed',...imported,ownerMapping:{sourceOwnerId:null,adoptedBy:owner.id,reason:'旧全局计划由真实Windows主机管理员接管'},engineMapping:'company-default',completedAt:new Date(now()).toISOString()};lastFailure=undefined;return state;
  }
  return {status:()=>({...state}),run(){
    if(!pending)pending=Promise.resolve().then(migrate).catch(error=>{state={status:'blocked',code:error.code||'SCHEDULE_MIGRATION_FAILED',message:error.message};if(lastFailure!==state.code){lastFailure=state.code;onError(error);}return state;}).finally(()=>{pending=null;});return pending;
  },async close(){closed=true;await pending;}};
}
