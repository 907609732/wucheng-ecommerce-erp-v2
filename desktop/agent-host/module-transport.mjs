import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {signWorkbenchActor,WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {loadOperationManifest,matchOperation,safeRequestPath} from '../workbench/manifest.mjs';
import {hostError} from './common.mjs';

const agentRoute=/^\/api\/(?:integration\/v1\/)?agent\/(?:[a-z0-9_-]+\/)*(?:binding|capabilities|query|prepare|commit|receipt|receipts)(?:\/[a-zA-Z0-9._:-]+)?$/;
function readKey(dataDir,name){const file=path.join(dataDir,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw hostError('MODULE_KEY_INVALID','模块授权文件无效',503);const key=fs.readFileSync(file,'utf8').trim();if(!/^[a-f0-9]{64}$/i.test(key))throw hostError('MODULE_KEY_INVALID','模块授权文件无效',503);return key;}
export function createAgentModuleTransport({services,resolveActor,fetchImpl=fetch,getManifest,signProof,validateApproval,maxResponseBytes=16*1024*1024}={}){
  async function current(id,ctx){
    if(!WORKBENCH_MODULES.includes(id))throw hostError('MODULE_UNKNOWN','模块未登记',404);
    const actor=await resolveActor(ctx?.actor?.id);if(!actor||actor.enabled===false||!actor.modules.includes(id))throw hostError('MODULE_DENIED','当前人员没有此模块权限',403);
    const config=services.config(id);if(config.maintenance)throw hostError('MODULE_MAINTENANCE','模块处于维护窗口',503);
    const cap=await services.ensure(id),url=cap?.url;
    if(typeof url!=='string'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))throw hostError('MODULE_NOT_RUNNING','模块尚未就绪',503);
    return {actor:{...actor,sessionId:ctx.actor.sessionId||actor.sessionId||randomUUID(),channel:'mcp'},config,cap,url,actorKey:readKey(config.dataDir,'.workbench-key'),integrationKey:readKey(config.dataDir,config.keyFile||'.integration-key')};
  }
  async function request(id,route,options={}){
    const {ctx,body,approval=ctx?.approval,idempotencyKey=ctx?.idempotencyKey}=options,method=String(options.method||'GET').toUpperCase();
    if(!safeRequestPath(route)||/[#\r\n]/.test(route)||!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method))throw hostError('MODULE_ROUTE_INVALID','业务接口路径无效');
    if([...new URL(route,'http://127.0.0.1').searchParams.keys()].some(k=>/^(?:path|filePath|directory|root|database|db|sql)$/i.test(k)))throw hostError('ATTACHMENT_ID_REQUIRED','文件访问必须使用受限附件标识',403);
    const upstream=await current(id,ctx),pathname=route.split('?')[0],mutating=!['GET','HEAD'].includes(method),dedicated=agentRoute.test(pathname),commit=/(?:^|\/)commit(?:\/|$)/.test(pathname);
    if(mutating&&upstream.actor.role==='viewer')throw hostError('READ_ONLY','此人员只有只读权限',403);
    if(mutating&&!upstream.actor.canRunTasks)throw hostError('TASK_PERMISSION_REQUIRED','此人员没有任务执行权限',403);
    if(!dedicated){
      const manifest=await loadOperationManifest(id,{config:upstream.config,capabilities:upstream.cap,getManifest,integrationKey:upstream.integrationKey}),match=matchOperation(manifest,method,route);
      if(mutating||!match||match.operation.uiOnly||!['read','download'].includes(match.operation.kind)||match.operation.remote!==true)throw hostError('AGENT_ROUTE_REQUIRED','此操作尚未接入统一任务接口',403);
    }
    if(commit&&(!approval||!idempotencyKey))throw hostError('AGENT_APPROVAL_REQUIRED','正式提交缺少本次结果确认',403);
    if(body!==undefined&&Buffer.byteLength(JSON.stringify(body))>24*1024*1024)throw hostError('MODULE_INPUT_TOO_LARGE','业务请求过大',413);
    const now=Date.now(),headers={Authorization:'Bearer '+upstream.integrationKey,...signWorkbenchActor({...upstream.actor,v:1,module:id,requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,method,path:route},upstream.actorKey),'X-Workbench-Channel':'mcp','Accept':'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{}),...(approval?{'X-Erp-Agent-Approval':Buffer.from(JSON.stringify(approval)).toString('base64url')}:{})};
    const signals=[AbortSignal.timeout(120000),options.signal||ctx?.signal].filter(Boolean),response=await fetchImpl(upstream.url+route,{method,headers,redirect:'error',signal:AbortSignal.any(signals),...(body!==undefined?{body:JSON.stringify(body)}:{})});
    let size=0;const chunks=[];for await(const chunk of response.body||[]){size+=chunk.length;if(size>maxResponseBytes)throw hostError('MODULE_RESPONSE_TOO_LARGE','结果过大，请改用文件产物',502);chunks.push(Buffer.from(chunk));}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw hostError('MODULE_RESPONSE_INVALID','业务接口未返回可核验的结果',502);}
    if(!response.ok||result?.ok===false)throw hostError(result.code||'MODULE_REQUEST_FAILED',result.error||result.message||'业务操作未完成',response.status>=400?response.status:409);return result;
  }
  request.request=request;
  request.binding=async(id,ctx)=>{const {cap}=await current(id,ctx),workbench=cap.workbench||cap.state?.workbench||cap.capabilities?.workbench||{};const dataSetId=cap.dataSetId||workbench.dataSetId,revision=cap.revision??workbench.revision;if(!dataSetId||revision===undefined)throw hostError('DATASET_UNAVAILABLE','模块缺少账本身份与版本',503);return {dataSetId,revision};};
  request.signApproval=async(claims,id)=>{
    if(typeof validateApproval!=='function'||!await validateApproval(claims,id))throw hostError('AGENT_APPROVAL_REQUIRED','没有可核对的已审批任务',403);
    const actor=await resolveActor(claims.actorId);if(!actor||actor.role==='viewer'||!actor.canRunTasks||!actor.modules.includes(id)||claims.module!==id)throw hostError('MODULE_DENIED','提交前人员权限已变化',403);
    const signer=signProof||(await import('../agent-runtime/approval.mjs')).signAgentApproval;
    return signer(claims,readKey(services.config(id).dataDir,'.workbench-key'));
  };
  return request;
}
