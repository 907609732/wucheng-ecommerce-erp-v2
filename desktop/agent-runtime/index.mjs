import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {agentError,agentDigest,canonicalJson} from './approval.mjs';
import {createAgentStore} from './store.mjs';
import {createAgentSettings} from './settings.mjs';
import {createAgentScheduler} from './scheduler.mjs';
import {fromJsonSchema} from '@modelcontextprotocol/server';
import {createSystemAgentAdapter} from './system-adapter.mjs';

const live=new Set(['queued','running','committing']);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const modules=['warehouse','purchase','sales','overview','exporter','system'];
const forbidden=new Set(['actor','approval','confirmed','trustedUi','role','commitData']);
function safeInput(value){if(!plain(value)||Buffer.byteLength(JSON.stringify(value))>1024*1024)throw agentError('INPUT_INVALID','业务参数必须是小于 1 MiB 的对象');for(const key of Object.keys(value))if(forbidden.has(key))throw agentError('IDENTITY_INPUT_DENIED','调用参数不能指定身份或确认凭据',403);return structuredClone(value);}
const publicTask=t=>{const {prepared,engineSession,review,...rest}=t;return {...rest,review:review?{...review,canApprove:false}:null};};
const publicResult=r=>{if(!r)return null;const {prepared,...rest}=r;return rest;};
const tokenCount=usage=>{if(!usage)return null;const n=usage.totalTokens??usage.total_tokens??(typeof usage.inputTokens==='number'&&typeof usage.outputTokens==='number'?usage.inputTokens+usage.outputTokens:null)??(typeof usage.input_tokens==='number'&&typeof usage.output_tokens==='number'?usage.input_tokens+usage.output_tokens:null);return Number.isSafeInteger(n)&&n>=0?n:null;};
const verifiedReceipt=(response,key)=>['completed','confirmed'].includes(response?.state)&&response?.ok!==false&&plain(response?.receipt)&&!['pending','processing','partial','unknown','failed'].includes(response.receipt.state)&&(response.idempotencyKey||response.receipt.idempotencyKey)===key;

export function createAgentRuntime({storeDir,adapters=[],engines={},resolveActor,secretStore,signApproval,environment={mode:'test',label:'测试账本'},extensions={},now=Date.now,scheduleNext,autoStart=true}={}){
  if(!storeDir||typeof resolveActor!=='function')throw TypeError('storeDir and resolveActor are required');
  const store=createAgentStore(storeDir,{now}),settings=createAgentSettings(store,{secretStore});
  const adapterMap=new Map(adapters.map(a=>[a.id,a])),sessions=new Map(),jobs=new Map();let closed=false;
  async function identity(actor){if(!actor?.id)throw agentError('IDENTITY_REQUIRED','请先登录公司工作台',401);const fresh=await resolveActor(actor.id);if(!fresh||fresh.enabled===false||!Array.isArray(fresh.modules))throw agentError('MEMBER_DENIED','人员权限已停用或撤销',403);return {...fresh,sessionId:actor.sessionId,channel:actor.channel};}
  const allowedModule=(actor,id)=>id==='system'||actor.modules.includes(id);
  function taskFor(id,actor){const task=store.get('task',id);if(!task)throw agentError('TASK_NOT_FOUND','任务不存在',404);if(task.ownerId!==actor.id&&task.assigneeId!==actor.id&&actor.role!=='admin')throw agentError('TASK_DENIED','无权查看此任务',403);if(task.scope.modules.some(m=>!allowedModule(actor,m)))throw agentError('MODULE_DENIED','任务包含未授权业务数据',403);return task;}
  function canRun(actor){if(actor.role==='viewer'||actor.canRunTasks!==true)throw agentError('TASK_PERMISSION_REQUIRED','当前人员没有执行任务权限',403);}
  const selfService=(module,id)=>module==='warehouse'&&['attendance.check-in','attendance.complete'].includes(id);
  function canUse(actor,module,cap){return !!cap&&allowedModule(actor,module)&&(!cap.roles||cap.roles.includes(actor.role))&&(!cap.requiresTaskPermission||actor.canRunTasks===true)&&(cap.kind==='query'||['admin','editor'].includes(actor.role)&&(actor.canRunTasks===true||selfService(module,cap.id)));}
  function canReview(task,actor){const prepared=resultState(task.id)?.prepared||[];return prepared.length>0&&prepared.every(step=>canUse(actor,step.module,adapterMap.get(step.module)?.capabilities.find(cap=>cap.id===step.capabilityId))&&(!selfService(step.module,step.capabilityId)||actor.id===(task.executionActorId||task.ownerId)));}
  function emit(id,type,data){const task=store.get('task',id);if(task?.scheduleId&&task.scheduledFor)store.finishRun(task.scheduleId,task.scheduledFor,task.status);return store.event(id,type,data);}
  function scopeOf(input,actor){const selected=input?.modules||[...actor.modules,'system'];if(!Array.isArray(selected)||selected.some(m=>!modules.includes(m)||!allowedModule(actor,m)))throw agentError('MODULE_DENIED','任务范围包含未授权模块',403);return {...input,modules:[...new Set(selected)]};}
  function attachment(id,actor){const item=store.get('attachment',id);if(!item||item.ownerId!==actor.id)throw agentError('ATTACHMENT_DENIED','附件不存在或不属于当前人员',403);return item;}
  function checkAttachments(ids,actor){if(!Array.isArray(ids)||ids.length>20)throw agentError('ATTACHMENT_LIMIT','一次最多附加 20 个文件');return ids.map(id=>attachment(id,actor).id);}
  function attachmentMetadata(ids){return ids.map(id=>{const item=store.get('attachment',id);return item?{id:item.id,name:item.name,size:item.size,mimeType:item.mimeType,sha256:item.sha256}:null;}).filter(Boolean);}
  async function capabilities(actor){return [...adapterMap.values()].filter(a=>allowedModule(actor,a.id)).flatMap(a=>(a.capabilities||[]).filter(c=>canUse(actor,a.id,c)).map(c=>({...c,module:a.id})));}
  async function binding(adapter,ctx){const b=await adapter.binding(ctx);if(!b?.dataSetId||b.revision===undefined)throw agentError('DATASET_UNAVAILABLE','模块未返回可核验的账本版本',503);return {dataSetId:b.dataSetId,revision:b.revision};}
  function context(task,actor,signal){return {actor,taskId:task.id,signal,emit:(type,data)=>emit(task.id,type,data),resolveAttachment:id=>{if(!task.attachmentIds.includes(id))throw agentError('ATTACHMENT_DENIED','附件未绑定本次任务',403);const item=store.get('attachment',id);if(!item)throw agentError('ATTACHMENT_DENIED','任务附件不存在',404);const real=fs.realpathSync(item.path),relative=path.relative(fs.realpathSync(path.join(storeDir,'attachments',id)),real);if(relative.startsWith('..')||path.isAbsolute(relative)||createHash('sha256').update(fs.readFileSync(real)).digest('hex')!==item.sha256)throw agentError('ATTACHMENT_CHANGED','任务附件已经变化，请重新上传',409);return item;},registerArtifact:input=>registerArtifact(task,actor,input)};}
  function registerArtifact(task,actor,{path:inputPath,name,mimeType}){
    const allowed=path.resolve(storeDir,'tasks',task.id),file=path.resolve(inputPath||'');const relative=path.relative(allowed,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||fs.lstatSync(file).isSymbolicLink())throw agentError('ARTIFACT_PATH_DENIED','产物必须位于本次任务的专属目录',403);
    const real=fs.realpathSync(file),root=fs.realpathSync(allowed),realRelative=path.relative(root,real);if(realRelative.startsWith('..')||path.isAbsolute(realRelative))throw agentError('ARTIFACT_PATH_DENIED','产物路径越界',403);
    const bytes=fs.readFileSync(file),saved=store.insert('artifact',{id:randomUUID(),ownerId:task.ownerId,taskId:task.id,path:file,name:name||path.basename(file),mimeType:mimeType||'application/octet-stream',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});const {path:privatePath,ownerId,...publicArtifact}=saved;return publicArtifact;
  }
  function resultState(taskId){const task=store.get('task',taskId);return store.get('result',task.resultId);}
  function snapshotResult(saved){store.insert('result_version',{...publicResult(saved),id:saved.id+':'+saved.version,resultId:saved.id,resultVersion:saved.version,createdAt:now()});return saved;}
  function updateResult(id,value){return store.transaction(()=>snapshotResult(store.update('result',id,value)));}
  function appendResult(task,output,step){
    const previous=task.resultId?store.get('result',task.resultId):null;
    const result={id:previous?.id||randomUUID(),ownerId:task.ownerId,taskId:task.id,summary:output.summary||previous?.summary||'处理结果',scope:output.scope||task.scope,blocks:[...(previous?.blocks||[]),...(output.blocks||[])],evidence:[...(previous?.evidence||[]),...(output.evidence||[])],changes:[...(previous?.changes||[]),...(output.changes||[])],issues:[...(previous?.issues||[]),...(output.issues||[])],environment,prepared:[...(previous?.prepared||[]),...(step?[step]:[])]};
    const saved=previous?store.update('result',result.id,result):store.insert('result',result);
    snapshotResult(saved);
    const review=saved.prepared.length?{id:randomUUID(),resultVersion:saved.version,revision:agentDigest(saved.prepared.map(s=>({module:s.module,binding:s.binding,digest:s.changeDigest}))),canApprove:!saved.issues.some(i=>i.blocking===true)}:null;
    store.update('task',task.id,{resultId:saved.id,review,status:review?'waiting_review':'running'});emit(task.id,'result.updated',{resultId:saved.id,resultVersion:saved.version});return saved;
  }
  async function invokeTool(taskId,name,input){
    const original=store.get('task',taskId),actor=await identity({id:original?.executionActorId||original?.ownerId,channel:'mcp'}),task=taskFor(taskId,actor);
    if(!['running','waiting_review'].includes(task.status))throw agentError('TASK_NOT_RUNNING','该任务当前不接受工具调用',409);
    if(name==='erp_capabilities')return {capabilities:(await capabilities(actor)).filter(c=>task.scope.modules.includes(c.module))};
    if(name==='erp_ask'){const question=String(input.question||'').trim();if(!question)throw agentError('QUESTION_INVALID','补充问题不能为空');store.update('task',taskId,{status:'waiting_input',question});emit(taskId,'input.required',{question});return {waitingForUser:true};}
    if(name==='erp_task_result')return {result:publicResult(resultState(taskId))};
    if(!['erp_query','erp_prepare'].includes(name))throw agentError('TOOL_DENIED','此工具不在公司业务能力清单中',403);
    const value=safeInput(input),adapter=adapterMap.get(value.module),cap=adapter?.capabilities.find(c=>c.id===value.capabilityId);
    if(!adapter||!cap||!task.scope.modules.includes(adapter.id)||!canUse(actor,adapter.id,cap))throw agentError('CAPABILITY_DENIED','当前人员或任务不能调用此能力',403);
    if(cap.available===false)throw agentError('CAPABILITY_UNAVAILABLE',cap.unavailableReason||'此平台暂未开通',409);
    const kind=name==='erp_query'?'query':'prepare';if(cap.kind!==kind)throw agentError('CAPABILITY_KIND_MISMATCH','操作类型与登记能力不一致',403);
    const params=safeInput(value.input||{});
    if(!cap.inputSchema)throw agentError('CAPABILITY_SCHEMA_MISSING','业务能力缺少输入校验契约',503);
    const validated=await fromJsonSchema(cap.inputSchema)['~standard'].validate(params);
    if(validated.issues)throw agentError('CAPABILITY_INPUT_INVALID','业务参数不符合能力输入约定',400);
    const ctx={...context(task,actor,jobs.get(taskId)?.controller.signal),capabilityId:cap.id,capabilityInput:params},before=await binding(adapter,ctx);
    emit(taskId,'step.started',{module:adapter.id,capabilityId:cap.id,title:cap.title});
    const output=await adapter[kind](cap.id,params,ctx);
    const latest=store.get('task',taskId);if(!['running','waiting_review'].includes(latest.status))throw agentError('TASK_INTERRUPTED','任务已暂停或取消，结果未自动提交',409);
    if(!plain(output))throw agentError('RESULT_INVALID','模块未返回结构化结果',502);
    if(output.ok===false)throw agentError(output.code||'MODULE_FAILED',output.error||'模块处理失败',409);
    if(typeof output.summary!=='string'||!output.summary.trim()||!Array.isArray(output.blocks)&&!Array.isArray(output.evidence))throw agentError('RESULT_CONTRACT_INVALID','模块必须返回带摘要、结果内容或证据的结构化结果',502);
    if(kind==='prepare'){
      if(output.requiresReview===false){
        if(cap.requiresReview!==false||(output.changes||[]).length||output.commitData!==undefined)throw agentError('AUTOMATIC_SIDE_EFFECT_DENIED','自动准备不能携带正式变更或提交载荷',403);
        const saved=appendResult(latest,output);emit(taskId,'step.completed',{module:adapter.id,capabilityId:cap.id,automatic:true});return {result:publicResult(saved),requiresReview:false};
      }
      if(output.commitData===undefined)throw agentError('PREPARATION_INVALID','业务模块未返回可核验的提交草稿',502);
      const after=await binding(adapter,ctx);if(canonicalJson(before)!==canonicalJson(after))throw agentError('DATASET_CHANGED','准备期间业务数据变化，请重新生成结果',409);
      const step={id:randomUUID(),module:adapter.id,capabilityId:cap.id,input:params,commitData:output.commitData,changes:output.changes||[],binding:before};step.changeDigest=agentDigest({capabilityId:step.capabilityId,input:params,commitData:step.commitData,changes:step.changes});
      const saved=appendResult(latest,output,step);emit(taskId,'review.required',{resultId:saved.id,resultVersion:saved.version});return {result:publicResult(saved),requiresReview:true};
    }
    const saved=appendResult(latest,output);emit(taskId,'step.completed',{module:adapter.id,capabilityId:cap.id});return {result:publicResult(saved)};
  }
  function createTask(input,actor,{internalId}={}){
    const goal=String(input.goal||'').trim();if(!goal||goal.length>20000)throw agentError('GOAL_INVALID','请输入 1 至 20000 字的工作目标');
    const engine=input.engine||settings.get().defaultEngine;if(!['codex','hermes'].includes(engine))throw agentError('ENGINE_INVALID','未知执行引擎');
    const model=settings.get().company.model;if(model&&engines[engine]?.supportedModels&&!engines[engine].supportedModels.includes(model))throw agentError('ENGINE_MODEL_UNSUPPORTED','公司模型不在该引擎的兼容清单中，请管理员调整模型设置',409);
    const task=store.insert('task',{id:internalId||randomUUID(),ownerId:actor.id,goal,scope:scopeOf(input.scope,actor),engine,attachmentIds:checkAttachments(input.attachmentIds||[],actor),status:'queued',createdAt:now(),updatedAt:now(),resultId:null,review:null,environment,scheduleId:internalId?input.scheduleId:null,scheduledFor:internalId?input.scheduledFor:null});
    fs.mkdirSync(path.join(storeDir,'tasks',task.id),{recursive:true,mode:0o700});emit(task.id,'task.created',{goal,engine});
    if(autoStart)queueMicrotask(()=>run(task.id).catch(()=>{}));return {task:publicTask(task)};
  }
  async function run(taskId){
    if(closed||jobs.has(taskId))return;
    const task=store.get('task',taskId);if(!task||!['queued','paused'].includes(task.status))return;
    const controller=new AbortController();let resolveDone;const done=new Promise(resolve=>resolveDone=resolve);jobs.set(taskId,{controller,done});let usageId;
    try{
      const actor=await identity({id:task.executionActorId||task.ownerId});taskFor(taskId,actor);
      const engine=engines[task.engine];if(!engine?.run)throw agentError('ENGINE_UNAVAILABLE','公司主机尚未配置此执行引擎',409);
      const credentials=await settings.credentials(),month=new Date(now()).toISOString().slice(0,7);
      usageId=randomUUID();store.transaction(()=>{
        const records=store.list('usage').filter(u=>u.month===month),used=records.reduce((sum,u)=>sum+(u.totalTokens||0),0);
        if(credentials.budgetLimit>0&&records.some(u=>u.state==='unknown'))throw agentError('COMPANY_USAGE_UNKNOWN','存在计费结果未知的调用，请管理员核对后再运行限额任务',409);
        if(credentials.budgetLimit>0&&(used>=credentials.budgetLimit||records.some(u=>u.state==='pending')))throw agentError('COMPANY_BUDGET_RESERVED','公司 token 额度已用完或正由另一任务预留，进度已保存',409);
        store.insert('usage',{id:usageId,ownerId:task.ownerId,taskId,engine:task.engine,month,totalTokens:0,state:'pending',reservedTokens:credentials.budgetLimit>0?credentials.budgetLimit-used:null,budgetMode:'admission_control',startedAt:now()});
      });
      store.update('task',taskId,{status:'running',pauseReason:null});emit(taskId,'task.running',{engine:task.engine});
      const onUsage=value=>{const count=tokenCount(value);if(count!==null){const current=store.get('usage',usageId);store.update('usage',usageId,{totalTokens:Math.max(current.totalTokens,count),details:value});if(current.reservedTokens!==null&&count>=current.reservedTokens)controller.abort();}};
      const result=await engine.run({task:{...publicTask(task),attachments:attachmentMetadata(task.attachmentIds)},session:task.engineSession,credentials,workingDirectory:path.join(storeDir,'tasks',taskId),profileDirectory:path.join(storeDir,'engines',task.engine),signal:controller.signal,invoke:(name,input)=>invokeTool(taskId,name,input),emit:(type,value)=>emit(taskId,type,value),onUsage,checkpoint:session=>store.update('task',taskId,{engineSession:session}),onSession:session=>sessions.set(taskId,session)});
      onUsage(result?.usage);store.update('usage',usageId,{state:tokenCount(result?.usage)!==null?'known':'unknown',finishedAt:now()});
      const current=store.get('task',taskId);
      if(current.status==='running'){
        const evidence=resultState(taskId);const status=evidence&&!evidence.issues?.some(issue=>issue.blocking)?'completed':'waiting_input';
        store.update('task',taskId,{status,question:status==='completed'?null:evidence?'结果仍有待处理异常，请补充缺失信息。':'执行引擎尚未提供业务结果，请补充范围或检查平台连接。'});
        emit(taskId,'task.'+status,{message:result?.text||'',hasVerifiedResult:!!evidence});
      }
    }catch(error){
      if(usageId&&store.get('usage',usageId))store.update('usage',usageId,{state:'unknown',finishedAt:now()});
      const current=store.get('task',taskId);if(current&&!['cancelled','paused','waiting_review','waiting_input','unknown'].includes(current.status)){store.update('task',taskId,{status:'paused',pauseReason:error.code||'ENGINE_FAILED',error:error.message});emit(taskId,'task.paused',{code:error.code||'ENGINE_FAILED',message:error.message});}
    }finally{jobs.delete(taskId);sessions.delete(taskId);resolveDone();}
  }
  async function control(taskId,action,actor,{engine}={}){
    const task=taskFor(taskId,actor);
    if(action==='resume'){
      if(task.status==='unknown')return reconcile(task,actor);
      if(!['paused','failed','waiting_input'].includes(task.status))throw agentError('TASK_STATE_INVALID','当前任务不能继续执行',409);
      if(engine!==undefined&&engine!==task.engine){if(!['codex','hermes'].includes(engine))throw agentError('ENGINE_INVALID','未知执行引擎');const model=settings.get().company.model;if(model&&engines[engine]?.supportedModels&&!engines[engine].supportedModels.includes(model))throw agentError('ENGINE_MODEL_UNSUPPORTED','此模型不兼容选定引擎',409);store.update('task',task.id,{engine,engineSession:null});emit(task.id,'engine.changed',{from:task.engine,to:engine,restoredFrom:'erp-checkpoint'});}
      if(task.review&&resultState(task.id)?.prepared?.length){store.update('task',task.id,{status:'waiting_review'});return {task:publicTask(store.get('task',task.id)),result:publicResult(resultState(task.id)),review:{...task.review,canApprove:task.review.canApprove&&canReview(task,actor)}};}
      store.update('task',task.id,{status:'queued'});if(autoStart)queueMicrotask(()=>run(task.id).catch(()=>{}));return {task:publicTask(store.get('task',task.id))};
    }
    if(!['pause','cancel'].includes(action))throw agentError('CONTROL_INVALID','未知任务控制操作');
    if(task.status==='committing'||task.status==='unknown')throw agentError('OUTCOME_UNKNOWN','提交中的结果须先核对回执，不能取消成未发生',409);
    if(['completed','cancelled'].includes(task.status))return {task:publicTask(task)};
    store.update('task',task.id,{status:action==='pause'?'paused':'cancelled',...(action==='cancel'?{review:null}:{})});const job=jobs.get(task.id);job?.controller.abort();await sessions.get(task.id)?.cancel?.();await job?.done;emit(task.id,'task.'+(action==='pause'?'paused':'cancelled'));return {task:publicTask(store.get('task',task.id))};
  }
  async function approve(input,actor,trustedUi){
    if(!trustedUi||actor.channel&&actor.channel!=='ui')throw agentError('HUMAN_REVIEW_REQUIRED','请在结果页由有权限的人员确认',403);
    const task=taskFor(input.taskId,actor),result=resultState(task.id),review=task.review;
    if(task.status!=='waiting_review'||!review||review.id!==input.reviewId||review.resultVersion!==input.resultVersion||review.revision!==input.revision||result.version!==input.resultVersion)throw agentError('REVIEW_STALE','结果已变化，请重新查看后确认',409);
    if(!review.canApprove)throw agentError('BLOCKING_ISSUES','结果仍有待处理异常，不能正式提交',409);
    if(!canReview(task,actor))throw agentError('TASK_PERMISSION_REQUIRED','当前人员没有批准这些业务操作的权限',403);
    if(typeof signApproval!=='function')throw agentError('APPROVAL_UNAVAILABLE','主机尚未配置受控提交签名',503);
    for(const step of result.prepared){const adapter=adapterMap.get(step.module),actual=await binding(adapter,{...context(task,actor),capabilityId:step.capabilityId,capabilityInput:step.input});if(canonicalJson(actual)!==canonicalJson(step.binding)){store.update('task',task.id,{status:'waiting_input',review:null,question:'账本已变化，请重新生成结果后复核'});emit(task.id,'review.invalidated',{reason:'source_changed'});throw agentError('REVIEW_DATA_CHANGED','账本已变化，请重新生成结果',409);}}
    // Compare-and-swap before the first asynchronous submission. Only one reviewer wins.
    store.update('task',task.id,{status:'committing',approvedBy:actor.id},{expectedVersion:task.version});
    return commitSteps(task.id,result,actor);
  }
  async function commitSteps(taskId,result,actor){
    const task=store.get('task',taskId),receipts=[];
    for(const step of result.prepared){
      const key=agentDigest({taskId,resultId:result.id,version:result.version,stepId:step.id}),old=store.effect(key);
      if(old?.state==='completed'){receipts.push(old.receipt);continue;}
      if(old){store.update('task',taskId,{status:'unknown'});return {task:publicTask(store.get('task',taskId))};}
      try{
        const fresh=await identity(actor);taskFor(taskId,fresh);if(!canReview(task,fresh))throw agentError('TASK_PERMISSION_REQUIRED','业务操作权限已经撤销',403);
        const adapter=adapterMap.get(step.module),ctx={...context(task,fresh),capabilityId:step.capabilityId,capabilityInput:step.input},actual=await binding(adapter,ctx);
        if(canonicalJson(actual)!==canonicalJson(step.binding))throw agentError('REVIEW_DATA_CHANGED','账本在提交前变化，请重新复核',409);
        const issuedAt=now(),claims={v:1,approvalId:task.review.id,actorId:fresh.id,module:step.module,capabilityId:step.capabilityId,taskId,resultId:result.id,resultVersion:result.version,...step.binding,changeDigest:step.changeDigest,idempotencyKey:key,issuedAt,expiresAt:issuedAt+60000};
        const proof=await signApproval(claims,step.module);
        if(!store.beginEffect(key,taskId,step.id,{module:step.module}))throw agentError('COMMIT_ALREADY_STARTED','正在核对既有提交结果',409);
        const output=await adapter.commit(step,{...ctx,approval:proof,idempotencyKey:key});
        if(!output?.receipt||output.ok===false)throw agentError('COMMIT_RECEIPT_MISSING','提交结果尚未核实，请检查业务回执',409);
        const verified=await adapter.receipt(key,{...ctx,idempotencyKey:key});
        if(!verifiedReceipt(verified,key))throw agentError('COMMIT_READBACK_PENDING','提交已返回，但业务回读尚未确认',409);
        store.finishEffect(key,'completed',{receipt:verified.receipt,module:step.module});receipts.push(verified.receipt);emit(taskId,'commit.verified',{module:step.module,receipt:verified.receipt});
      }catch(error){
        if(!store.effect(key)&&receipts.length&&error.code==='REVIEW_DATA_CHANGED'){
          const remaining=result.prepared.slice(result.prepared.indexOf(step)).map(s=>({module:s.module,capabilityId:s.capabilityId,input:s.input}));
          updateResult(result.id,{receipt:{state:'partial',receipts,verifiedAt:now()},issues:[...(result.issues||[]),{blocking:true,code:'REPREPARE_REQUIRED',message:'前序提交改变了账本，剩余操作需重新生成结果并复核。'}]});
          store.update('task',taskId,{status:'waiting_input',review:null,completedStages:receipts,remainingOperations:remaining,question:'已核实前序提交。请继续生成剩余操作的新版本结果。'});emit(taskId,'review.invalidated',{reason:'preceding_commit_changed_revision',remainingOperations:remaining});return {task:publicTask(store.get('task',taskId)),result:publicResult(resultState(taskId))};
        }
        if(store.effect(key))store.finishEffect(key,'unknown',{module:step.module,code:error.code});
        store.update('task',taskId,{status:store.effect(key)||receipts.length?'unknown':'waiting_review',error:error.message});emit(taskId,'commit.blocked',{code:error.code,message:error.message});return {task:publicTask(store.get('task',taskId)),result:publicResult(resultState(taskId))};
      }
    }
    updateResult(result.id,{receipt:{state:'verified',receipts,verifiedAt:now()}});store.update('task',taskId,{status:'completed',review:null});emit(taskId,'task.completed',{receiptCount:receipts.length});return {task:publicTask(store.get('task',taskId)),result:publicResult(resultState(taskId))};
  }
  async function reconcile(task,actor){
    const result=resultState(task.id);if(!result)throw agentError('RESULT_NOT_FOUND','缺少待核对结果',409);
    let unknown=false;const receipts=[];
    for(const step of result.prepared){const key=agentDigest({taskId:task.id,resultId:result.id,version:task.review?.resultVersion||result.version,stepId:step.id}),effect=store.effect(key);if(!effect){unknown=true;continue;}if(effect.state==='completed'){receipts.push(effect.receipt);continue;}const response=await adapterMap.get(step.module).receipt(key,context(task,actor));if(verifiedReceipt(response,key)){store.finishEffect(key,'completed',{receipt:response.receipt,module:step.module});receipts.push(response.receipt);}else unknown=true;}
    if(!unknown){updateResult(result.id,{receipt:{state:'verified',receipts,verifiedAt:now()}});store.update('task',task.id,{status:'completed',review:null});emit(task.id,'task.completed',{reconciled:true});}
    return {task:publicTask(store.get('task',task.id)),result:publicResult(resultState(task.id))};
  }
  const scheduler=createAgentScheduler({store,createTask:(input,actor)=>createTask(input,actor,{internalId:input.id}),resolveActor,now,next:scheduleNext});
  const systemAdapter=createSystemAgentAdapter({store,getScheduler:()=>scheduler,resolveActor,taskFor,extensions,now});adapterMap.set('system',systemAdapter);
  let importingSchedules=Promise.resolve();
  function importSchedules(input){
    const operation=importingSchedules.then(async()=>{
      if(closed)throw agentError('AGENT_CLOSED','任务中心已关闭',503);
      if(!plain(input)||typeof input.sourceId!=='string'||input.sourceId.length>400||!input.sourceId.startsWith('warehouse:')||typeof input.sourceRevision!=='string'||!input.sourceRevision||input.sourceRevision.length>500||typeof input.ownerId!=='string'||!Array.isArray(input.entries)||input.entries.length>50)throw agentError('SCHEDULE_MIGRATION_INVALID','旧调度来源、版本或清单无效',400);
      const actor=await identity({id:input.ownerId,channel:'migration'});canRun(actor);if(!actor.modules.includes('warehouse'))throw agentError('MODULE_DENIED','旧云仓调度创建者没有云仓权限',403);
      const warehouse=adapterMap.get('warehouse');if(!warehouse)throw agentError('SCHEDULE_MIGRATION_UNAVAILABLE','云仓业务模块尚未准备好',503);
      const migrationTaskId='schedule-migration-'+agentDigest(input.sourceId),source=await binding(warehouse,{actor,taskId:migrationTaskId,capabilityId:'legacy-schedule-migration'});if(input.sourceId!=='warehouse:'+source.dataSetId)throw agentError('SCHEDULE_MIGRATION_SOURCE_CHANGED','旧调度来源与当前云仓账本不一致',409);
      const prepared=[],seen=new Set();let existing=0;
      for(const entry of input.entries){
        if(!plain(entry)||typeof entry.legacyKey!=='string'||!entry.legacyKey||entry.legacyKey.length>200||seen.has(entry.legacyKey)||typeof entry.enabled!=='boolean'||typeof entry.timezone!=='string'||!entry.timezone||typeof entry.goal!=='string'||!entry.goal.trim()||typeof entry.cron!=='string')throw agentError('SCHEDULE_MIGRATION_INVALID','旧调度必须逐项提供唯一来源、目标、规则、时区和原启用状态',400);
        seen.add(entry.legacyKey);const markerId=agentDigest({sourceId:input.sourceId,legacyKey:entry.legacyKey});
        if(store.get('schedule_migration',markerId)){existing++;continue;}
        const value=await scheduler.prepare({goal:entry.goal,cron:entry.cron,timezone:entry.timezone,engine:entry.engine||settings.get().defaultEngine,misfirePolicy:entry.misfirePolicy||'once',enabled:entry.enabled,scope:{modules:['warehouse']}},actor,{allowLegacyThirtySeconds:entry.cron==='*/30 * * * * *',origin:{type:'legacy-migration',sourceId:input.sourceId,sourceRevision:input.sourceRevision,legacyKey:entry.legacyKey,sourceEnabled:entry.enabled,creator:'unknown',migrationOwnerId:actor.id}});
        prepared.push({markerId,legacyKey:entry.legacyKey,sourceEnabled:entry.enabled,value});
      }
      // Refresh after asynchronous schedule validation, then persist every
      // schedule and its non-resurrecting migration marker in one transaction.
      const fresh=await identity({id:actor.id,channel:'migration'});canRun(fresh);if(!fresh.modules.includes('warehouse'))throw agentError('MODULE_DENIED','旧调度创建者权限已经撤销',403);
      const currentSource=await binding(warehouse,{actor:fresh,taskId:migrationTaskId,capabilityId:'legacy-schedule-migration'});if(currentSource.dataSetId!==source.dataSetId)throw agentError('SCHEDULE_MIGRATION_SOURCE_CHANGED','云仓账本在迁入期间发生切换',409);
      store.transaction(()=>{for(const entry of prepared){const schedule=scheduler.commit(entry.value);store.insert('schedule_migration',{id:entry.markerId,ownerId:actor.id,sourceId:input.sourceId,sourceRevision:input.sourceRevision,legacyKey:entry.legacyKey,sourceEnabled:entry.sourceEnabled,scheduleId:schedule.id,importedAt:now()});}if(prepared.length)systemAdapter.changed();});
      return {imported:prepared.length,existing,disabled:prepared.filter(entry=>!entry.sourceEnabled).length,sourceId:input.sourceId,sourceRevision:input.sourceRevision};
    });importingSchedules=operation.catch(()=>{});return operation;
  }
  async function request(operation,payload={},meta={}){
    const actor=await identity(meta.actor);if(!plain(payload))throw agentError('INPUT_INVALID','请求参数无效');
    if(operation==='status')return {actor:{...actor,label:actor.label||actor.login||actor.id,canCreateTasks:true,canManageSettings:actor.role==='admin'},environment,engines:await Promise.all(['codex','hermes'].map(async id=>({id,...await engines[id]?.check?.(),configured:settings.get().company.hasKey}))),capabilities:await capabilities(actor)};
    if(operation==='tasks.create'){if(payload.id!==undefined||payload.scheduleId!==undefined)throw agentError('TASK_ID_FORBIDDEN','任务编号由服务端生成');return createTask(payload,actor);}
    if(operation==='tasks.list')return {tasks:store.list('task').filter(t=>(actor.role==='admin'||t.ownerId===actor.id||t.assigneeId===actor.id)&&t.scope.modules.every(m=>allowedModule(actor,m))).map(publicTask)};
    if(operation==='tasks.get'){const task=taskFor(payload.taskId,actor);const versions=store.list('result_version').filter(r=>r.taskId===task.id);let result=publicResult(resultState(task.id));const historical=payload.resultVersion!==undefined;if(historical){result=versions.find(r=>r.resultVersion===payload.resultVersion&&(!payload.resultId||r.resultId===payload.resultId));if(!result)throw agentError('RESULT_NOT_FOUND','此结果版本不存在',404);result={...result,id:result.resultId,version:result.resultVersion};}const review=!historical&&task.review?{...task.review,canApprove:task.review.canApprove&&canReview(task,actor)}:null;return {task:{...publicTask(task),review},events:store.events(task.id,payload.afterSequence),result,review,resultVersions:versions.map(r=>({id:r.resultId,version:r.resultVersion,createdAt:r.createdAt,summary:r.summary}))};}
    if(operation==='tasks.control')return control(payload.taskId,payload.action,actor,payload);
    if(operation==='tasks.input'){
      const task=taskFor(payload.taskId,actor);if(task.status==='unknown')throw agentError('OUTCOME_UNKNOWN','请先核对提交回执，再补充新的要求',409);if(live.has(task.status))throw agentError('TASK_BUSY','请先暂停任务再补充要求',409);
      const text=String(payload.text||payload.goal||'').trim();if(!text||text.length>20000)throw agentError('INPUT_INVALID','请补充有效要求');
      const ids=checkAttachments(payload.attachmentIds||[],actor),receipts=resultState(task.id)?.receipt?.receipts||[];store.update('task',task.id,{goal:task.goal+'\n用户补充：'+text,attachmentIds:[...new Set([...task.attachmentIds,...ids])],completedStages:[...(task.completedStages||[]),...receipts],status:'paused',review:null,resultId:null});emit(task.id,'user.input',{text,attachmentIds:ids});return control(task.id,'resume',actor);
    }
    if(operation==='reviews.approve')return approve(payload,actor,meta.trustedUi===true);
    if(operation==='reviews.reject'){if(!meta.trustedUi)throw agentError('HUMAN_REVIEW_REQUIRED','请在结果页处理复核',403);const task=taskFor(payload.taskId,actor);if(task.status!=='waiting_review'||task.review?.id!==payload.reviewId)throw agentError('REVIEW_STALE','复核结果已变化',409);store.update('task',task.id,{status:'waiting_input',review:null,question:payload.reason||'请补充修改要求'});emit(task.id,'review.rejected',{reason:payload.reason||''});return {task:publicTask(store.get('task',task.id))};}
    if(operation==='settings.get')return {settings:{...settings.get(),usage:actor.role==='admin'?store.list('usage'):[],budgetNotice:'本地 token 额度用于任务准入和执行中中止；API 厂商账单和硬额度以公司 API 服务端为准。取消或断网造成未知用量时，不按零计算。'}};
    if(operation==='settings.save'){if(!meta.trustedUi)throw agentError('HUMAN_SETTINGS_REQUIRED','请在公司设置中修改模型配置',403);const input=payload.settings||payload,current=settings.get(),engine=input.defaultEngine||current.defaultEngine,model=input.company?.model??current.company.model;if(model&&engines[engine]?.supportedModels&&!engines[engine].supportedModels.includes(model))throw agentError('ENGINE_MODEL_UNSUPPORTED','请选择该引擎兼容清单中的模型',409);return {settings:await settings.save(input,actor)};}
    if(operation==='schedules.list')return {schedules:store.list('schedule',actor.role==='admin'?undefined:actor.id).map(s=>({...s,runs:store.runs(s.id)}))};
    if(['schedules.create','schedules.update'].includes(operation)){if(!meta.trustedUi)throw agentError('HUMAN_SCHEDULE_REQUIRED','定时任务需由实际人员创建',403);const schedule=await scheduler.save(payload,actor);systemAdapter.changed();return {schedule};}
    if(operation==='schedules.delete'){if(!meta.trustedUi)throw agentError('HUMAN_SCHEDULE_REQUIRED','请在定时任务设置中删除',403);canRun(actor);const s=store.get('schedule',payload.id);if(!s||s.ownerId!==actor.id&&actor.role!=='admin')throw agentError('SCHEDULE_DENIED','无权删除此定时任务',403);if(payload.version!==s.version)throw agentError('AGENT_REVISION_CHANGED','定时任务已变化，请重新查看后删除',409);store.transaction(()=>{store.remove('schedule',s.id);systemAdapter.changed();});return {deleted:true};}
    if(operation==='attachments.upload'){
      if(!meta.trustedUi)throw agentError('UPLOAD_DENIED','附件需要通过工作台上传',403);const name=String(payload.name||''),bytes=Buffer.from(String(payload.bytes||''),'base64');if(!name||name.length>200||/[\\/:*?"<>|\x00-\x1f]/.test(name)||/[. ]$/.test(name)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)||bytes.length===0||bytes.length>50*1024*1024)throw agentError('UPLOAD_INVALID','附件名无效、内容为空或超过 50 MiB');const id=randomUUID(),directory=path.join(storeDir,'attachments',id);fs.mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,name);fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});store.insert('attachment',{id,ownerId:actor.id,name,size:bytes.length,mimeType:String(payload.type||'application/octet-stream'),path:file,sha256:createHash('sha256').update(bytes).digest('hex')});return {id,name,size:bytes.length,mimeType:payload.type||'application/octet-stream'};
    }
    if(operation==='artifacts.open'){const item=store.get('artifact',payload.id);if(!item)throw agentError('ARTIFACT_NOT_FOUND','产物不存在',404);taskFor(item.taskId,actor);if(!meta.trustedUi||!extensions[operation])throw agentError('ARTIFACT_OPEN_UNAVAILABLE','此终端暂不支持打开产物',409);return extensions[operation]({...item},{...meta,actor});}
    if(['permissions.inspect','permissions.receipt','people.assignable'].includes(operation)||operation.startsWith('backups.'))throw agentError('INTERNAL_OPERATION','此操作仅供受控业务工具调用',403);
    if(extensions[operation]){if(operation.endsWith('.save')&&(!meta.trustedUi||actor.role!=='admin'))throw agentError('ADMIN_REQUIRED','仅管理员能修改公司配置',403);return extensions[operation](payload,{...meta,actor});}
    throw agentError('OPERATION_UNAVAILABLE','此操作尚未接入当前工作台',404);
  }
  return {request,store,run,invokeTool,importSchedules,tick:()=>scheduler.tick(),async close(){closed=true;await importingSchedules;const pending=[...jobs.values()];for(const job of pending)job.controller.abort();for(const session of sessions.values())await session.cancel?.();await Promise.allSettled(pending.map(job=>job.done));store.close();}};
}
