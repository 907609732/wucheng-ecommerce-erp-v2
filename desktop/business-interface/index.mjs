import fs from 'node:fs';
import path from 'node:path';
import {loadActivatedBusinessAdapter} from './activated-adapters.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {fromJsonSchema} from '@modelcontextprotocol/server';
import {WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {agentDigest,canonicalJson,agentError} from './approval.mjs';
import {createBusinessModuleTransport} from './module-transport.mjs';
import {openBusinessReviewStore} from './store.mjs';
import {startBusinessBridge} from '../business-host/bridge.mjs';

const publicOperations=new Set(['capabilities','query','prepare','receipt','requests.create','attachments.upload','reviews.list','reviews.get']);
const states=new Set(['awaiting_review','committing','completed','rejected','unknown','stale']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message,statusCode=400)=>agentError(code,message,statusCode);
function safeInput(input){
 if(!plain(input)||Buffer.byteLength(JSON.stringify(input))>70*1024*1024)throw fail('BUSINESS_INPUT_INVALID','业务输入必须是有界JSON对象');
 const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(['actor','approval','confirmed','trustedUi','role','commitData','confirmation','review_token'].includes(key))throw fail('IDENTITY_INPUT_DENIED','外部调用不能指定身份、确认凭据或内部提交数据',403);visit(item);}};visit(input);return structuredClone(input);
}
const verified=(response,key)=>['completed','confirmed'].includes(response?.state)&&response.ok!==false&&plain(response.receipt)&&(response.idempotencyKey||response.receipt.idempotencyKey)===key&&['completed','confirmed'].includes(response.receipt.state||response.receipt.status);
const publicReview=value=>{const {prepared,ownerId,approvedBy,approvalId,approvedVersion,idempotencyKey,...rest}=value;return {...rest,canApprove:value.state==='awaiting_review'&&!(value.issues||[]).some(issue=>issue.blocking===true),revision:value.prepared.binding.revision,digest:value.prepared.changeDigest};};

/** Business tools and human review only. No model client, planner, conversation,
 * job queue, autonomous task execution or scheduler is instantiated here. */
export async function createBusinessInterface({paths,services,identity,storeDir=path.join(paths.profile,'business-interface'),adapters:providedAdapters,transport:providedTransport,startBridge=true,now=Date.now}={}){
 if(!paths?.profile||!services||typeof identity?.resolveActor!=='function')throw TypeError('Business paths, services and trusted identity are required');
 const store=openBusinessReviewStore(storeDir,{now});let active=0,closed=false;
 async function actorFor(actor){const value=actor?.id&&await identity.resolveActor(actor.id);if(!value?.id||value.enabled===false)throw fail('IDENTITY_REQUIRED','请先登录公司工作台',401);return {...value,role:'admin',modules:[...WORKBENCH_MODULES],canRunTasks:true,sessionId:actor.sessionId||value.sessionId,channel:actor.channel||'mcp'};}
 const validApproval=claims=>{const row=store.get('review',claims.resultId);return !!row&&row.state==='committing'&&row.approvedBy===claims.actorId&&row.approvalId===claims.approvalId&&row.approvedVersion===claims.resultVersion&&row.requestId===claims.taskId&&row.module===claims.module&&row.capabilityId===claims.capabilityId&&row.prepared.changeDigest===claims.changeDigest&&row.prepared.binding.dataSetId===claims.dataSetId&&canonicalJson(row.prepared.binding.revision)===canonicalJson(claims.revision)&&row.idempotencyKey===claims.idempotencyKey;};
 const transport=providedTransport||createBusinessModuleTransport({services,resolveActor:id=>identity.resolveActor(id),validateApproval:validApproval,artifactRoot:path.join(storeDir,'requests')});
 const factories={
  warehouse:async()=>{if(services.prepareComponent)return loadActivatedBusinessAdapter('warehouse',services,transport);return (await import('../workbench/warehouse-agent.mjs')).createWarehouseAgentAdapter({transport});},
  purchase:()=>loadActivatedBusinessAdapter('purchase',services,transport),
  sales:()=>loadActivatedBusinessAdapter('sales',services,transport),
  overview:()=>loadActivatedBusinessAdapter('overview',services,transport),
  exporter:async()=>{if(services.prepareComponent)return loadActivatedBusinessAdapter('exporter',services,transport);return (await import('../../apps/exporter/src/main/agent-adapter.mjs')).createExporterAgentAdapter({transport});}
 };
 const adapters=providedAdapters||[],modules=new Map(adapters.map(adapter=>[adapter.id,adapter])),loading=new Map();
 async function loadAdapter(id){
  if(modules.has(id))return modules.get(id);
  if(providedAdapters||!Object.hasOwn(factories,id))throw fail('CAPABILITY_UNAVAILABLE','业务模块未登记',409);
  if(!loading.has(id))loading.set(id,Promise.resolve().then(factories[id]).then(adapter=>{adapters.push(adapter);modules.set(id,adapter);return adapter;}).finally(()=>loading.delete(id)));
  return loading.get(id);
 }
 if(!providedAdapters&&!services.prepareComponent)await Promise.all(WORKBENCH_MODULES.map(loadAdapter));
 function requestScope(id,actor){const row=id?store.get('request',id):store.insert('request',{ownerId:actor.id});if(!row||row.ownerId!==actor.id)throw fail('REQUEST_SCOPE_DENIED','请求关联标识不属于当前人员',403);return row;}
 function regularFile(file,root){const relative=path.relative(root,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||path.relative(file,fs.realpathSync.native(file))!==''||fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())throw fail('BUSINESS_FILE_CHANGED','业务原件路径或类型已变化',409);return file;}
 function context(scope,actor,capabilityId,capabilityInput){
  return {actor,taskId:scope.id,capabilityId,capabilityInput,emit:()=>{},
   resolveAttachment:id=>{const item=store.get('attachment',id);if(!item||item.ownerId!==actor.id||item.requestId!==scope.id)throw fail('ATTACHMENT_DENIED','附件不属于当前请求',403);regularFile(item.path,path.join(storeDir,'attachments'));if(createHash('sha256').update(fs.readFileSync(item.path)).digest('hex')!==item.sha256)throw fail('ATTACHMENT_CHANGED','附件内容已变化',409);return item;},
   registerArtifact:item=>{const file=regularFile(path.resolve(item.path),path.join(storeDir,'requests',scope.id)),bytes=fs.readFileSync(file),saved=store.insert('artifact',{ownerId:actor.id,requestId:scope.id,path:file,name:item.name||path.basename(file),mimeType:item.mimeType||'application/octet-stream',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sourceModule:capabilityId?.split('.')[0],sourceCapabilityId:capabilityId});const {path:privatePath,ownerId,...metadata}=saved;return metadata;},
   resolveTaskArtifact:async id=>{const item=store.get('artifact',id);if(!item||item.ownerId!==actor.id||item.requestId!==scope.id)throw fail('ARTIFACT_DENIED','业务原件不属于当前请求',403);regularFile(item.path,path.join(storeDir,'requests',scope.id));if(createHash('sha256').update(fs.readFileSync(item.path)).digest('hex')!==item.sha256)throw fail('ARTIFACT_CHANGED','原件内容已变化',409);return {...item,taskId:scope.id};}
  };
 }
 function review(id){const row=store.get('review',id);if(!row||!states.has(row.state))throw fail('REVIEW_NOT_FOUND','业务复核不存在',404);return row;}
 async function reconcile(row,actor){if(!['unknown','committing'].includes(row.state))return row;const adapter=await loadAdapter(row.module),scope=requestScope(row.requestId,{id:row.ownerId}),result=await adapter.receipt(row.idempotencyKey,{...context(scope,actor,row.capabilityId,row.prepared.input),idempotencyKey:row.idempotencyKey});if(verified(result,row.idempotencyKey))return store.update('review',row.id,{state:'completed',receipt:result.receipt,error:null},{expectedVersion:row.version});return row;}
 async function invoke(operation,payload={},meta={}){
  if(closed)throw fail('BUSINESS_INTERFACE_CLOSED','业务接口已关闭',503);
  if(typeof operation!=='string'||!publicOperations.has(operation)&&!['reviews.approve','reviews.reject'].includes(operation))throw fail('BUSINESS_OPERATION_UNKNOWN','未登记的业务接口',404);
  const input=safeInput(payload),actor=await actorFor(meta.actor);
  if(operation==='requests.create'){const scope=requestScope(undefined,actor);return {requestId:scope.id};}
  if(operation==='capabilities'){
   await Promise.all((input.module?[input.module]:providedAdapters?providedAdapters.map(a=>a.id):WORKBENCH_MODULES).map(loadAdapter));
   const rows=adapters.filter(a=>!input.module||a.id===input.module).flatMap(a=>a.capabilities.map(({roles,requiresTaskPermission,dataAccessModules,...cap})=>({...cap,module:a.id})));
   if(input.capabilityId){const capability=rows.find(c=>c.id===input.capabilityId);if(!capability)throw fail('CAPABILITY_UNKNOWN','业务能力未登记',404);return {capability};}
   const offset=Number.isSafeInteger(input.cursor)&&input.cursor>=0?input.cursor:0,limit=Number.isSafeInteger(input.limit)?Math.max(1,Math.min(20,input.limit)):10;return {capabilities:rows.slice(offset,offset+limit),total:rows.length,nextCursor:offset+limit<rows.length?offset+limit:null};
  }
  if(operation==='reviews.list'){const summary=store.summary('review');if(input.summary===true)return summary;const limit=Number.isSafeInteger(input.limit)?Math.max(1,Math.min(100,input.limit)):50,offset=Number.isSafeInteger(input.cursor)&&input.cursor>=0?input.cursor:0;if(input.state!==undefined&&!states.has(input.state))throw fail('REVIEW_STATE_INVALID','业务复核状态无效',400);const selected=store.list('review',{state:input.state,limit,offset}),total=input.state?store.count('review',input.state):summary.total;return {...summary,reviews:selected.map(publicReview),nextCursor:offset+limit<total?offset+limit:null};}
  if(operation==='reviews.get'){const row=review(input.id);return {review:publicReview(row)};}
  if(operation==='receipt'){const row=review(input.id||input.reviewId);return {review:publicReview(await reconcile(row,actor))};}
  if(operation==='reviews.approve'||operation==='reviews.reject'){
   if(meta.trustedUi!==true||actor.channel!=='ui')throw fail('HUMAN_REVIEW_REQUIRED','请在工作台业务复核界面确认',403);
   let row=review(input.id);if(row.ownerId!==actor.id)throw fail('REVIEW_OWNER_MISMATCH','请由发起本次业务请求的人员复核，不能代替他人确认',403);if(row.version!==input.version||canonicalJson(row.prepared.binding.revision)!==canonicalJson(input.revision)||row.prepared.changeDigest!==input.digest)throw fail('REVIEW_STALE','结果、账本版本或变更摘要已变化，请重新查看',409);
   if(row.state!=='awaiting_review')throw fail('REVIEW_STATE_INVALID','当前结果不能重复审批；提交未知时请查询回执',409);
   if(operation==='reviews.reject')return {review:publicReview(store.update('review',row.id,{state:'rejected',rejectedBy:actor.id,reason:String(input.reason||'').slice(0,2000)},{expectedVersion:row.version}))};
   if(!publicReview(row).canApprove)throw fail('BLOCKING_ISSUES','结果存在待处理异常，不能正式提交',409);

   const adapter=await loadAdapter(row.module),scope=requestScope(row.requestId,{id:row.ownerId}),ctx=context(scope,actor,row.capabilityId,row.prepared.input),actual=await adapter.binding(ctx);
   if(canonicalJson(actual)!==canonicalJson(row.prepared.binding)){store.update('review',row.id,{state:'stale',error:'账本已变化，请重新生成草稿'},{expectedVersion:row.version});throw fail('REVIEW_DATA_CHANGED','账本已变化，请重新生成草稿',409);}
   row=store.update('review',row.id,{state:'committing',approvedBy:actor.id,approvedVersion:row.version,approvalId:randomUUID()},{expectedVersion:row.version});
   let sent=false;
   try{const issuedAt=now(),claims={v:1,approvalId:row.approvalId,actorId:actor.id,module:row.module,capabilityId:row.capabilityId,taskId:row.requestId,resultId:row.id,resultVersion:row.approvedVersion,...row.prepared.binding,changeDigest:row.prepared.changeDigest,idempotencyKey:row.idempotencyKey,issuedAt,expiresAt:issuedAt+60000},proof=await transport.signApproval(claims,row.module);sent=true;await adapter.commit(row.prepared,{...ctx,approval:proof,idempotencyKey:row.idempotencyKey});const receipt=await adapter.receipt(row.idempotencyKey,{...ctx,idempotencyKey:row.idempotencyKey});if(!verified(receipt,row.idempotencyKey))throw fail('COMMIT_READBACK_PENDING','提交回执尚未核实，请查询回执',409);row=store.update('review',row.id,{state:'completed',receipt:receipt.receipt,error:null},{expectedVersion:row.version});}
   catch(error){row=store.update('review',row.id,{state:sent?'unknown':'awaiting_review',error:error.message},{expectedVersion:row.version});}
   return {review:publicReview(row)};
  }
  const scope=requestScope(input.requestId,actor);fs.mkdirSync(path.join(storeDir,'requests',scope.id),{recursive:true,mode:0o700});
  if(operation==='attachments.upload'){
   if(typeof input.name!=='string'||!input.name||input.name!==path.basename(input.name)||/[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(input.name)||input.name.length>180||typeof input.dataBase64!=='string')throw fail('ATTACHMENT_INPUT_INVALID','附件名称或内容无效');
   const bytes=Buffer.from(input.dataBase64,'base64');if(!bytes.length||bytes.length>50*1024*1024||bytes.toString('base64')!==input.dataBase64||input.sha256&&createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw fail('ATTACHMENT_INPUT_INVALID','附件大小、编码或摘要无效');
   const id=randomUUID(),directory=path.join(storeDir,'attachments',id);fs.mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,input.name);fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});const item=store.insert('attachment',{id,ownerId:actor.id,requestId:scope.id,path:file,name:input.name,mimeType:input.mimeType||'application/octet-stream',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});const {path:privatePath,ownerId,...attachment}=item;return {requestId:scope.id,attachment};
  }
  const adapter=await loadAdapter(input.module),cap=adapter?.capabilities.find(c=>c.id===input.capabilityId);if(!cap||cap.kind!==operation||cap.available===false)throw fail('CAPABILITY_UNAVAILABLE','业务能力未登记、类型不符或尚未开通',409);
  const params=safeInput(input.input||{}),validation=await fromJsonSchema(cap.inputSchema)['~standard'].validate(params);if(validation.issues)throw fail('CAPABILITY_INPUT_INVALID','业务参数不符合能力约定');
  const ctx=context(scope,actor,cap.id,params),before=operation==='prepare'?await adapter.binding(ctx):null,output=await adapter[operation](cap.id,params,ctx);if(!plain(output)||output.ok===false)throw fail('BUSINESS_RESULT_INVALID','业务模块未返回可核验结果',502);
  if(operation==='query'||output.requiresReview===false){if(operation==='prepare'&&(cap.requiresReview!==false||output.commitData!==undefined||(output.changes||[]).length))throw fail('AUTOMATIC_SIDE_EFFECT_DENIED','此草稿必须经过业务复核',403);const {commitData,...result}=output;return {requestId:scope.id,requiresReview:false,result};}
  if(output.commitData===undefined)throw fail('PREPARATION_INVALID','业务模块未返回可核验提交草稿',502);
  const after=await adapter.binding(ctx);if(canonicalJson(before)!==canonicalJson(after))throw fail('DATASET_CHANGED','准备期间业务数据已变化，请重新生成',409);
  const prepared={id:randomUUID(),module:adapter.id,capabilityId:cap.id,input:params,commitData:output.commitData,changes:output.changes||[],binding:before};prepared.changeDigest=agentDigest({capabilityId:cap.id,input:params,commitData:prepared.commitData,changes:prepared.changes});
  const id=randomUUID(),row=store.insert('review',{id,requestId:scope.id,ownerId:actor.id,module:adapter.id,capabilityId:cap.id,summary:output.summary||cap.title||'业务变更复核',scope:output.scope||{module:adapter.id},blocks:output.blocks||[],evidence:output.evidence||[],changes:output.changes||[],issues:output.issues||[],state:'awaiting_review',prepared,idempotencyKey:agentDigest({reviewId:id,requestId:scope.id,digest:prepared.changeDigest}),environment:paths.environment});
  return {requestId:scope.id,requiresReview:true,review:publicReview(row)};
 }
 const request=async(...args)=>{active++;try{return await invoke(...args);}finally{active--;}};
 const bridge=startBridge?await startBusinessBridge({storeDir,request}):null;
 return {request,isBusy:()=>active>0||store.count('review','committing')>0,close:async()=>{if(active)throw fail('BUSINESS_BUSY','仍有业务请求执行，不能关闭',409);closed=true;await bridge?.close();store.close();}};
}
