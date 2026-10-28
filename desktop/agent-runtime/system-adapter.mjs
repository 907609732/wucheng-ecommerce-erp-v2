import {randomUUID} from 'node:crypto';
import {agentDigest,agentError} from './approval.mjs';
import {nextOccurrence} from './scheduler.mjs';

const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string',minLength:1,maxLength:20000};
const policySchema=object({schemaVersion:{const:1},users:{type:'object',propertyNames:{type:'string',minLength:1,maxLength:254,pattern:'^[^A-Z\\s,]+$'},additionalProperties:object({role:{enum:['admin','editor','viewer']},modules:{type:'array',items:{enum:['warehouse','purchase','sales','overview','exporter']},uniqueItems:true},canRunTasks:{type:'boolean',description:'允许执行写入类业务任务；查询不受此标记限制'},enabled:{type:'boolean'}},['role','modules','canRunTasks','enabled'])}},['schemaVersion','users']);
export function createSystemAgentAdapter({store,getScheduler,resolveActor,taskFor,extensions={},now=Date.now}){
  if(!store.get('system','identity'))store.insert('system',{id:'identity',ownerId:'system',dataSetId:randomUUID(),revision:1});
  const scheduleProperties={goal:text,cron:{type:'string',minLength:1,maxLength:100},timezone:{type:'string',minLength:1,maxLength:100},engine:{enum:['codex','hermes']},enabled:{type:'boolean'},misfirePolicy:{enum:['once','skip']},scope:{type:'object',properties:{modules:{type:'array',items:{type:'string'}}},additionalProperties:false}};
  const capabilities=[
    {id:'people.assignable',title:'查找可分派员工',description:'根据姓名或目标任务查询真实可分派员工ID。重名或多个匹配时必须调用erp_ask让用户明确选择，不得猜测身份。只返回当前业务范围内的可用人员，不是完整权限配置。',kind:'query',roles:['admin','editor'],requiresTaskPermission:true,available:typeof extensions['people.assignable']==='function',inputSchema:object({name:{type:'string',minLength:1,maxLength:100},taskId:text})},
    {id:'schedules.list',title:'查看我的定时任务',description:'cron为五段定时规则；timezone为IANA时区；misfirePolicy once=补一次、skip=略过；noOverlap始终为true；nextRunAt为带时区的下一次执行时间。',kind:'query',inputSchema:object()},
    {id:'schedules.create',title:'安排定时业务任务',kind:'prepare',requiresReview:true,inputSchema:object(scheduleProperties,['goal','cron','timezone'])},
    {id:'schedules.update',title:'调整定时业务任务',kind:'prepare',requiresReview:true,inputSchema:object({id:text,...scheduleProperties},['id'])},
    {id:'schedules.delete',title:'删除定时业务任务',kind:'prepare',requiresReview:true,inputSchema:object({id:text},['id'])},
    {id:'tasks.assign',title:'把任务交给指定员工',kind:'prepare',requiresReview:true,inputSchema:object({taskId:text,assigneeId:text},['taskId','assigneeId'])},
    {id:'permissions.list',title:'查询人员权限',kind:'query',roles:['admin'],available:typeof extensions['permissions.inspect']==='function',inputSchema:object()},
    {id:'permissions.update',title:'维护人员权限',description:'先读取权限清单，再提交完整策略；users键是可信登录身份的原值，不得用显示名称代替。',kind:'prepare',requiresReview:true,roles:['admin'],available:typeof extensions['permissions.inspect']==='function'&&typeof extensions['permissions.save']==='function',inputSchema:object({policy:policySchema},['policy'])},
    {id:'backups.create',title:'创建账本备份',kind:'prepare',requiresReview:false,roles:['admin'],available:typeof extensions['backups.prepare']==='function',inputSchema:object({modules:{type:'array',items:{enum:['warehouse','purchase','sales','overview','exporter']},minItems:1}},['modules'])}
  ];
  const changed=()=>store.update('system','identity',s=>({revision:s.revision+1}));
  return {id:'system',capabilities,changed,
    async binding(ctx){const identity=store.get('system','identity'),revision={system:identity.revision};
      if(ctx?.capabilityId?.startsWith('permissions.')&&extensions['permissions.inspect'])revision.policy=(await extensions['permissions.inspect']({},ctx)).revision;
      if(ctx?.capabilityId?.startsWith('schedules.')&&ctx.capabilityInput?.id)revision.schedule=store.get('schedule',ctx.capabilityInput.id)?.version??'missing';
      if(ctx?.capabilityId==='tasks.assign'&&ctx.capabilityInput?.taskId)revision.task=store.get('task',ctx.capabilityInput.taskId)?.version??'missing';
      return {dataSetId:identity.dataSetId,revision};},
    async query(capabilityId,input,ctx){
      if(capabilityId==='people.assignable'){
        if(!['admin','editor'].includes(ctx.actor.role)||!ctx.actor.canRunTasks)throw agentError('TASK_PERMISSION_REQUIRED','无权分派业务任务',403);
        const target=input.taskId?taskFor(input.taskId,ctx.actor):taskFor(ctx.taskId,ctx.actor),visible=target.scope.modules.filter(module=>module!=='system'&&ctx.actor.modules.includes(module)),requested=visible.length?visible:[...ctx.actor.modules];
        const response=await extensions['people.assignable']({modules:requested,...(input.name?{name:input.name}:{})},ctx);
        if(!Array.isArray(response?.people))throw agentError('PEOPLE_DIRECTORY_UNAVAILABLE','可分派人员目录暂时不可用',503);
        const rows=response.people.filter(person=>typeof person?.id==='string'&&person.id&&typeof person.label==='string'&&Array.isArray(person.modules)&&requested.every(module=>person.modules.includes(module))).map(person=>({id:person.id,label:person.label,modules:person.modules.filter(module=>requested.includes(module))}));
        const ambiguous=!!input.name&&rows.length>1;
        return {summary:ambiguous?'找到多个匹配员工，请明确选择后再分派':`找到 ${rows.length} 位可分派员工`,scope:{modules:requested},blocks:[{type:'table',title:'可分派员工',columns:[{key:'id',label:'真实人员编号'},{key:'label',label:'姓名'},{key:'modules',label:'当前业务范围'}],rows}],evidence:[{id:'company-assignable-people',scope:requested}],issues:ambiguous?[{code:'ASSIGNEE_AMBIGUOUS',blocking:true,message:'存在多个匹配人员，请调用erp_ask确认真实人员编号，不得猜测。'}]:[]};
      }
      if(capabilityId==='permissions.list'){if(ctx.actor.role!=='admin')throw agentError('ADMIN_REQUIRED','需要管理员权限',403);const current=await extensions['permissions.inspect']({},ctx),rows=Object.entries(current.policy.users).map(([login,value])=>({login,...value}));return {summary:`已读取 ${rows.length} 位成员权限`,blocks:[{type:'table',title:'人员权限',columns:[{key:'login',label:'登录身份'},{key:'role',label:'角色'},{key:'modules',label:'业务模块'},{key:'canRunTasks',label:'写入任务'},{key:'enabled',label:'启用'}],rows}],evidence:[{id:'permissions',revision:current.revision,schemaVersion:current.policy.schemaVersion}]};}
      if(capabilityId!=='schedules.list')throw agentError('CAPABILITY_UNAVAILABLE','公共查询未登记');const rows=store.list('schedule',ctx.actor.role==='admin'?undefined:ctx.actor.id);return {summary:`已读取 ${rows.length} 个定时任务`,blocks:[{type:'table',title:'定时任务',columns:[{key:'id',label:'任务编号'},{key:'goal',label:'目标'},{key:'cron',label:'规则'},{key:'timezone',label:'时区'},{key:'engine',label:'引擎'},{key:'enabled',label:'启用'},{key:'nextRunAt',label:'下次运行'},{key:'misfirePolicy',label:'漏跑处理'}],rows}],evidence:rows.map(s=>({id:s.id,kind:'schedule',version:s.version}))};},
    async prepare(capabilityId,input,ctx){
      let commitData={operation:capabilityId,input},changes=[],summary='公共任务待复核';
      if(capabilityId.startsWith('schedules.')){
        const old=input.id?store.get('schedule',input.id):null;if(input.id&&(!old||old.ownerId!==ctx.actor.id&&ctx.actor.role!=='admin'))throw agentError('SCHEDULE_DENIED','无权调整该定时任务',403);
        const value={...old,...input};if((value.scope?.modules||ctx.actor.modules).some(m=>m!=='system'&&!ctx.actor.modules.includes(m)))throw agentError('MODULE_DENIED','定时任务包含未授权模块',403);
        const nextRunAt=capabilityId==='schedules.delete'?null:await nextOccurrence(value.cron,value.timezone,now());commitData={...commitData,expectedVersion:old?.version};changes=[{kind:'schedule',before:old?{goal:old.goal,cron:old.cron,timezone:old.timezone,enabled:old.enabled}:null,after:capabilityId==='schedules.delete'?null:{goal:value.goal,cron:value.cron,timezone:value.timezone,enabled:value.enabled!==false,nextRunAt}}];summary='请复核定时规则、时区和业务范围';
      }else if(capabilityId==='tasks.assign'){
        const target=taskFor(input.taskId,ctx.actor),assignee=await resolveActor(input.assigneeId);
        if(!assignee||assignee.enabled===false||!assignee.canRunTasks||assignee.role==='viewer'||target.scope.modules.some(m=>m!=='system'&&!assignee.modules.includes(m)))throw agentError('ASSIGNEE_DENIED','接收人员未启用或没有所需模块权限',403);
        if(['running','committing','unknown','completed','cancelled'].includes(target.status)||target.review)throw agentError('ASSIGNMENT_STATE_INVALID','请先暂停可分派的任务，处理现有复核或提交状态',409);
        commitData={...commitData,expectedVersion:target.version};changes=[{kind:'assignment',taskId:target.id,before:target.assigneeId||target.ownerId,after:assignee.id}];summary='请确认任务范围和接收员工';
      }else if(capabilityId==='permissions.update'){
        if(ctx.actor.role!=='admin')throw agentError('ADMIN_REQUIRED','需要管理员权限',403);const current=await extensions['permissions.inspect']({},ctx);commitData={...commitData,expectedVersion:current.revision};changes=[{kind:'permissions',before:current.policy,after:input.policy}];summary='请复核人员权限变更';
      }else if(capabilityId==='backups.create'){const result=await extensions['backups.prepare'](input,ctx);return {...result,requiresReview:false};}
      else throw agentError('CAPABILITY_UNAVAILABLE','公共能力未登记');
      return {summary,blocks:[{type:'text',text:summary}],changes,evidence:[{id:'system-policy',revision:(await this.binding(ctx)).revision}],commitData};
    },
    async commit(step,ctx){
      if(!ctx.approval||!ctx.idempotencyKey)throw agentError('HUMAN_REVIEW_REQUIRED','公共变更需要有效的结果复核',403);
      const existing=store.get('system_receipt',ctx.idempotencyKey);if(existing)return {receipt:existing.receipt};
      const {operation,input,expectedVersion}=step.commitData;let result,apply;
      if(operation==='schedules.create'||operation==='schedules.update'){const prepared=await getScheduler().prepare({...input,...(expectedVersion?{version:expectedVersion}:{})},ctx.actor);apply=()=>getScheduler().commit(prepared);}
      else if(operation==='schedules.delete'){apply=()=>{const old=store.get('schedule',input.id);if(!old||old.version!==expectedVersion||old.ownerId!==ctx.actor.id&&ctx.actor.role!=='admin')throw agentError('AGENT_REVISION_CHANGED','定时任务已变化，请重新查看',409);store.remove('schedule',input.id);return {id:input.id,deleted:true};};}
      else if(operation==='tasks.assign'){
        const target=taskFor(input.taskId,ctx.actor),assignee=await resolveActor(input.assigneeId);if(!assignee||assignee.enabled===false||!assignee.canRunTasks||assignee.role==='viewer'||target.scope.modules.some(m=>m!=='system'&&!assignee.modules.includes(m)))throw agentError('ASSIGNEE_DENIED','接收人员权限已经变化',403);
        apply=()=>store.update('task',target.id,{assigneeId:assignee.id,executionActorId:assignee.id,status:'paused'},{expectedVersion});
      }else if(operation==='permissions.update'){
        store.insert('system_effect',{id:ctx.idempotencyKey,ownerId:ctx.actor.id,operation,expectedVersion,targetPolicyHash:agentDigest(input.policy),startedAt:now()});
        result=await extensions['permissions.save']({policy:input.policy,revision:expectedVersion,idempotencyKey:ctx.idempotencyKey},{...ctx,trustedUi:true});
      }
      else throw agentError('CAPABILITY_UNAVAILABLE','公共提交能力未登记');
      let receipt;store.transaction(()=>{if(apply)result=apply();receipt={id:randomUUID(),idempotencyKey:ctx.idempotencyKey,state:'completed',operation,recordId:result?.id||null,revision:result?.revision??result?.version??null,at:now(),resultDigest:agentDigest(result)};store.insert('system_receipt',{id:ctx.idempotencyKey,ownerId:ctx.actor.id,receipt});changed();});return {receipt};
    },
    async receipt(idempotencyKey,ctx){const saved=store.get('system_receipt',idempotencyKey);if(saved)return {state:'completed',idempotencyKey,receipt:saved.receipt};const effect=store.get('system_effect',idempotencyKey);if(effect?.operation==='permissions.update'&&extensions['permissions.receipt'])return extensions['permissions.receipt']({idempotencyKey},ctx);return {state:'unknown',idempotencyKey};}
  };
}
