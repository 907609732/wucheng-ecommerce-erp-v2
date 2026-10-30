import {randomUUID} from 'node:crypto';
import {agentDigest,agentError} from './approval.mjs';

const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string',minLength:1,maxLength:20000};
const backupId={type:'string',minLength:1,maxLength:200,pattern:'^[A-Za-z0-9_-]+$'};
const backupModules=['warehouse','purchase','sales','overview','exporter'];
const restoreCopyReceipt=(receipt,expected,key)=>receipt?.kind==='backup-restore-copy'&&receipt.idempotencyKey===key&&receipt.backupId===expected.backupId&&receipt.recoveryId===expected.recoveryId&&receipt.manifestSha256===expected.manifestSha256&&receipt.verified===true&&receipt.activated===false;
export function createSystemAgentAdapter({store,getScheduler,resolveActor,taskFor,extensions={},now=Date.now}){
  if(!store.get('system','identity'))store.insert('system',{id:'identity',ownerId:'system',dataSetId:randomUUID(),revision:1});
  const scheduleProperties={goal:text,cron:{type:'string',minLength:1,maxLength:100},timezone:{type:'string',minLength:1,maxLength:100},engine:{enum:['codex','hermes']},enabled:{type:'boolean'},misfirePolicy:{enum:['once','skip']},scope:{type:'object',properties:{modules:{type:'array',items:{type:'string'}}},additionalProperties:false}};
  const capabilities=[
    {id:'people.assignable',title:'查找可分派员工',description:'根据姓名或目标任务查询真实员工ID。重名或多个匹配时必须调用erp_ask让用户明确选择，不得猜测身份。所有可核验的已启用成员均可执行全部业务。',kind:'query',available:typeof extensions['people.assignable']==='function',inputSchema:object({name:{type:'string',minLength:1,maxLength:100},taskId:text})},
    {id:'schedules.list',title:'查看我的定时任务',description:'cron为五段定时规则；timezone为IANA时区；misfirePolicy once=补一次、skip=略过；noOverlap始终为true；nextRunAt为带时区的下一次执行时间。',kind:'query',inputSchema:object()},
    {id:'schedules.create',title:'安排定时业务任务',kind:'prepare',requiresReview:true,inputSchema:object(scheduleProperties,['goal','cron','timezone'])},
    {id:'schedules.update',title:'调整定时业务任务',kind:'prepare',requiresReview:true,inputSchema:object({id:text,...scheduleProperties},['id'])},
    {id:'schedules.delete',title:'删除定时业务任务',kind:'prepare',requiresReview:true,inputSchema:object({id:text},['id'])},
    {id:'tasks.assign',title:'把任务交给指定员工',kind:'prepare',requiresReview:true,inputSchema:object({taskId:text,assigneeId:text},['taskId','assigneeId'])},
    {id:'backups.create',title:'创建账本备份',kind:'prepare',requiresReview:false,available:typeof extensions['backups.prepare']==='function',inputSchema:object({modules:{type:'array',items:{enum:['warehouse','purchase','sales','overview','exporter']},minItems:1}},['modules'])},
    {id:'backups.list',title:'查看隔离账本备份',kind:'query',available:typeof extensions['backups.list']==='function',inputSchema:object()},
    {id:'backups.verify',title:'核验备份原件与任务资料',kind:'query',available:typeof extensions['backups.verify']==='function',inputSchema:object({backupId},['backupId'])},
    {id:'backups.restore-copy',title:'从备份生成隔离恢复副本',description:'核验备份清单和原件摘要，复核后生成新的隔离恢复目录；不会覆盖正在运行的账本，也不执行正式切换。',kind:'prepare',requiresReview:true,available:['backups.restore.prepare','backups.restore.commit','backups.restore.receipt'].every(id=>typeof extensions[id]==='function'),inputSchema:object({backupId},['backupId'])}
  ];
  const changed=()=>store.update('system','identity',s=>({revision:s.revision+1}));
  return {id:'system',capabilities,changed,
    async binding(ctx){const identity=store.get('system','identity'),revision={system:identity.revision};
      if(ctx?.capabilityId?.startsWith('schedules.')&&ctx.capabilityInput?.id)revision.schedule=store.get('schedule',ctx.capabilityInput.id)?.version??'missing';
      if(ctx?.capabilityId==='tasks.assign'&&ctx.capabilityInput?.taskId)revision.task=store.get('task',ctx.capabilityInput.taskId)?.version??'missing';
      return {dataSetId:identity.dataSetId,revision};},
    async query(capabilityId,input,ctx){
      if(['backups.list','backups.verify'].includes(capabilityId)){
        return extensions[capabilityId](input,ctx);
      }
      if(capabilityId==='people.assignable'){
        const target=input.taskId?taskFor(input.taskId,ctx.actor):taskFor(ctx.taskId,ctx.actor),visible=target.scope.modules.filter(module=>module!=='system'),requested=visible.length?visible:[...backupModules];
        const response=await extensions['people.assignable']({modules:requested,...(input.name?{name:input.name}:{})},ctx);
        if(!Array.isArray(response?.people))throw agentError('PEOPLE_DIRECTORY_UNAVAILABLE','可分派人员目录暂时不可用',503);
        const rows=response.people.filter(person=>typeof person?.id==='string'&&person.id&&typeof person.label==='string').map(person=>({id:person.id,label:person.label,modules:[...requested]}));
        const ambiguous=!!input.name&&rows.length>1;
        return {summary:ambiguous?'找到多个匹配员工，请明确选择后再分派':`找到 ${rows.length} 位可分派员工`,scope:{modules:requested},blocks:[{type:'table',title:'可分派员工',columns:[{key:'id',label:'真实人员编号'},{key:'label',label:'姓名'}],rows}],evidence:[{id:'company-assignable-people',scope:requested}],issues:ambiguous?[{code:'ASSIGNEE_AMBIGUOUS',blocking:true,message:'存在多个匹配人员，请调用erp_ask确认真实人员编号，不得猜测。'}]:[]};
      }
      if(capabilityId!=='schedules.list')throw agentError('CAPABILITY_UNAVAILABLE','公共查询未登记');const rows=store.list('schedule');return {summary:`已读取 ${rows.length} 个定时任务`,blocks:[{type:'table',title:'定时任务',columns:[{key:'id',label:'任务编号'},{key:'goal',label:'目标'},{key:'cron',label:'规则'},{key:'timezone',label:'时区'},{key:'engine',label:'引擎'},{key:'enabled',label:'启用'},{key:'nextRunAt',label:'下次运行'},{key:'misfirePolicy',label:'漏跑处理'}],rows}],evidence:rows.map(s=>({id:s.id,kind:'schedule',version:s.version}))};},
    async prepare(capabilityId,input,ctx){
      let commitData={operation:capabilityId,input},changes=[],summary='公共任务待复核';
      if(capabilityId.startsWith('schedules.')){
        const old=input.id?store.get('schedule',input.id):null;if(input.id&&!old)throw agentError('SCHEDULE_NOT_FOUND','定时任务不存在',404);
        const value={...old,...input};
        const prepared=capabilityId==='schedules.delete'?null:await getScheduler().prepare({...input,...(old?{version:old.version}:{})},ctx.actor),nextRunAt=prepared?.value.nextRunAt??null;commitData={...commitData,expectedVersion:old?.version};changes=[{kind:'schedule',before:old?{goal:old.goal,cron:old.cron,timezone:old.timezone,enabled:old.enabled}:null,after:capabilityId==='schedules.delete'?null:{goal:value.goal,cron:value.cron,timezone:value.timezone,enabled:value.enabled!==false,nextRunAt}}];summary='请复核定时规则、时区和业务范围';
      }else if(capabilityId==='tasks.assign'){
        const target=taskFor(input.taskId,ctx.actor),assignee=await resolveActor(input.assigneeId);
        if(!assignee?.id||assignee.enabled===false)throw agentError('ASSIGNEE_DENIED','无法核验接收成员或该成员已停用',403);
        if(['running','committing','unknown','completed','cancelled'].includes(target.status)||target.review)throw agentError('ASSIGNMENT_STATE_INVALID','请先暂停可分派的任务，处理现有复核或提交状态',409);
        commitData={...commitData,expectedVersion:target.version};changes=[{kind:'assignment',taskId:target.id,before:target.assigneeId||target.ownerId,after:assignee.id}];summary='请确认任务范围和接收员工';
      }else if(capabilityId==='backups.create'){const result=await extensions['backups.prepare'](input,ctx);return {...result,requiresReview:false};}
      else if(capabilityId==='backups.restore-copy'){
        const result=await extensions['backups.restore.prepare'](input,ctx),restore=result?.commitData;
        if(!restore||restore.backupId!==input.backupId||typeof restore.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(restore.manifestSha256)||typeof restore.recoveryId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(restore.recoveryId)||!(result.evidence||[]).some(item=>item.id===restore.backupId&&item.manifestSha256===restore.manifestSha256)||(result.changes||[]).some(change=>change.activated===true))throw agentError('BACKUP_PREPARATION_INVALID','备份恢复草稿缺少一致的清单摘要和隔离目标',502);
        return {...result,requiresReview:true,commitData:{operation:capabilityId,input,restore:{backupId:restore.backupId,manifestSha256:restore.manifestSha256,recoveryId:restore.recoveryId}}};
      }
      else throw agentError('CAPABILITY_UNAVAILABLE','公共能力未登记');
      return {summary,blocks:[{type:'text',text:summary}],changes,evidence:[{id:'system-policy',revision:(await this.binding(ctx)).revision}],commitData};
    },
    async commit(step,ctx){
      if(step.capabilityId?.startsWith('permissions.')||step.commitData?.operation?.startsWith('permissions.'))throw agentError('FEATURE_REMOVED','权限管理已移除，旧修改草稿不可再提交',410);
      if(!ctx.approval||!ctx.idempotencyKey)throw agentError('HUMAN_REVIEW_REQUIRED','公共变更需要有效的结果复核',403);
      const existing=store.get('system_receipt',ctx.idempotencyKey);if(existing)return {receipt:existing.receipt};
      const {operation,input,expectedVersion,restore}=step.commitData;let result,apply;
      if(operation==='backups.restore-copy'){
        store.insert('system_effect',{id:ctx.idempotencyKey,ownerId:ctx.actor.id,operation,restore,startedAt:now()});
        const response=await extensions['backups.restore.commit']({commitData:restore},ctx);
        if(response?.ok===false||!restoreCopyReceipt(response?.receipt,restore,ctx.idempotencyKey))throw agentError('BACKUP_RESTORE_RECEIPT_INVALID','恢复副本尚未取得匹配的实际校验回执',409);
        store.transaction(()=>{store.insert('system_receipt',{id:ctx.idempotencyKey,ownerId:ctx.actor.id,receipt:response.receipt});changed();});
        return {receipt:response.receipt};
      }
      if(operation==='schedules.create'||operation==='schedules.update'){const prepared=await getScheduler().prepare({...input,...(expectedVersion?{version:expectedVersion}:{})},ctx.actor);apply=()=>getScheduler().commit(prepared);}
      else if(operation==='schedules.delete'){apply=()=>{const old=store.get('schedule',input.id);if(!old||old.version!==expectedVersion)throw agentError('AGENT_REVISION_CHANGED','定时任务已变化，请重新查看',409);store.remove('schedule',input.id);return {id:input.id,deleted:true};};}
      else if(operation==='tasks.assign'){
        const target=taskFor(input.taskId,ctx.actor),assignee=await resolveActor(input.assigneeId);if(!assignee?.id||assignee.enabled===false)throw agentError('ASSIGNEE_DENIED','接收成员已停用或无法核验',403);
        apply=()=>store.update('task',target.id,{assigneeId:assignee.id,executionActorId:assignee.id,assignedBy:ctx.actor.id,status:'paused'},{expectedVersion});
      }
      else throw agentError('CAPABILITY_UNAVAILABLE','公共提交能力未登记');
      let receipt;store.transaction(()=>{if(apply)result=apply();receipt={id:randomUUID(),idempotencyKey:ctx.idempotencyKey,state:'completed',actorId:ctx.actor.id,operation,recordId:result?.id||null,revision:result?.revision??result?.version??null,at:now(),resultDigest:agentDigest(result)};store.insert('system_receipt',{id:ctx.idempotencyKey,ownerId:ctx.actor.id,receipt});changed();});return {receipt};
    },
    async receipt(idempotencyKey,ctx){const saved=store.get('system_receipt',idempotencyKey);if(saved)return {state:'completed',idempotencyKey,receipt:saved.receipt};const effect=store.get('system_effect',idempotencyKey);if(effect?.operation==='backups.restore-copy'&&extensions['backups.restore.receipt']){const response=await extensions['backups.restore.receipt']({idempotencyKey},ctx);if(['completed','confirmed'].includes(response?.state)&&restoreCopyReceipt(response.receipt,effect.restore,idempotencyKey))return {...response,idempotencyKey};}return {state:'unknown',idempotencyKey};}
  };
}
