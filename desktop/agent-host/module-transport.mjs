import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {signWorkbenchActor,WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {loadOperationManifest,matchOperation,safeRequestPath} from '../workbench/manifest.mjs';
import {hostError,inside} from './common.mjs';

const agentRoute=/^\/api\/(?:integration\/v1\/)?agent\/(?:[a-z0-9_-]+\/)*(?:binding|capabilities|query|prepare|commit|receipt|receipts)(?:\/[a-zA-Z0-9._:-]+)?$/;
const readPost=/^\/api\/(?:integration\/v1\/)?agent\/(?:query|binding|receipts?(?:\/[a-zA-Z0-9._:-]+)?)$/;
const prepareRoute=/^\/api\/(?:integration\/v1\/)?agent\/prepare$/;
const selfService=(id,capabilityId,actor)=>id==='warehouse'&&['attendance.check-in','attendance.complete'].includes(capabilityId)&&actor.id.startsWith('tailscale:')&&['admin','editor'].includes(actor.role);
export const moduleTimeoutBudget=(route,method='GET')=>method==='POST'&&prepareRoute.test(route.split('?')[0])?30*60*1000:120000;
function readKey(dataDir,name){const file=path.join(dataDir,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw hostError('MODULE_KEY_INVALID','模块授权文件无效',503);const key=fs.readFileSync(file,'utf8').trim();if(!/^[a-f0-9]{64}$/i.test(key))throw hostError('MODULE_KEY_INVALID','模块授权文件无效',503);return key;}
function assertArtifactDirectory(directory){let current=path.parse(path.resolve(directory)).root;for(const part of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw hostError('ARTIFACT_PATH_DENIED','任务产物目录被重定向',403);}}
export function createAgentModuleTransport({services,resolveActor,fetchImpl=fetch,getManifest,signProof,verifyProof,validateApproval,artifactRoot,maxArtifactBytes=64*1024*1024,maxResponseBytes=16*1024*1024}={}){
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
    const upstream=await current(id,ctx),pathname=route.split('?')[0],mutating=!['GET','HEAD'].includes(method)&&!(method==='POST'&&readPost.test(pathname)),dedicated=agentRoute.test(pathname),commit=/(?:^|\/)commit(?:\/|$)/.test(pathname);
    if(mutating&&upstream.actor.role==='viewer')throw hostError('READ_ONLY','此人员只有只读权限',403);
    let capabilityId=ctx?.capabilityId;
    if(commit){
      if(!approval||!idempotencyKey||!ctx?.taskId||!capabilityId)throw hostError('AGENT_APPROVAL_REQUIRED','正式提交缺少本次结果确认',403);
      let claims;try{claims=JSON.parse(Buffer.from(approval.payload,'base64url').toString('utf8'));}catch{throw hostError('AGENT_APPROVAL_REQUIRED','人审凭据格式无效',403);}
      const verify=verifyProof||(await import('../agent-runtime/approval.mjs')).verifyAgentApproval;
      verify(approval,upstream.actorKey,{actorId:upstream.actor.id,module:id,taskId:ctx?.taskId,capabilityId:capabilityId||claims.capabilityId,resultId:claims.resultId,resultVersion:claims.resultVersion,dataSetId:claims.dataSetId,revision:claims.revision,changeDigest:claims.changeDigest,idempotencyKey});
      if(typeof validateApproval!=='function'||!await validateApproval(claims,id))throw hostError('AGENT_APPROVAL_REQUIRED','提交结果已变化或不属于当前已审批任务',403);
      capabilityId=claims.capabilityId;
    }
    if(mutating&&!upstream.actor.canRunTasks&&!selfService(id,capabilityId,upstream.actor))throw hostError('TASK_PERMISSION_REQUIRED','此人员没有任务执行权限',403);
    if(mutating&&!commit&&body?.capabilityId&&body.capabilityId!==capabilityId)throw hostError('CAPABILITY_CONTEXT_REQUIRED','业务能力与可信任务上下文不一致',403);
    if(!dedicated){
      const manifest=await loadOperationManifest(id,{config:upstream.config,capabilities:upstream.cap,getManifest,integrationKey:upstream.integrationKey}),match=matchOperation(manifest,method,route);
      if(mutating||!match||match.operation.uiOnly||!['read','download'].includes(match.operation.kind)||match.operation.remote!==true)throw hostError('AGENT_ROUTE_REQUIRED','此操作尚未接入统一任务接口',403);
    }
    if(body!==undefined&&Buffer.byteLength(JSON.stringify(body))>80*1024*1024)throw hostError('MODULE_INPUT_TOO_LARGE','业务请求过大',413);
    const now=Date.now(),headers={Authorization:'Bearer '+upstream.integrationKey,...signWorkbenchActor({...upstream.actor,v:1,module:id,requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,method,path:route},upstream.actorKey),'X-Workbench-Channel':'mcp','Accept':'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{}),...(approval?{'X-Erp-Agent-Approval':Buffer.from(JSON.stringify(approval)).toString('base64url')}:{})};
    const signals=[AbortSignal.timeout(moduleTimeoutBudget(route,method)),options.signal||ctx?.signal].filter(Boolean),response=await fetchImpl(upstream.url+route,{method,headers,redirect:'error',signal:AbortSignal.any(signals),...(body!==undefined?{body:JSON.stringify(body)}:{})});
    let size=0;const chunks=[];for await(const chunk of response.body||[]){size+=chunk.length;if(size>maxResponseBytes)throw hostError('MODULE_RESPONSE_TOO_LARGE','结果过大，请改用文件产物',502);chunks.push(Buffer.from(chunk));}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw hostError('MODULE_RESPONSE_INVALID','业务接口未返回可核验的结果',502);}
    if(!response.ok||result?.ok===false)throw hostError(result.code||'MODULE_REQUEST_FAILED',result.error||result.message||'业务操作未完成',response.status>=400?response.status:409);return result;
  }
  request.request=request;
  request.download=async(id,route,{ctx,expectedSha256,filename='download.bin',maxBytes=maxArtifactBytes,signal}={})=>{
    if(!artifactRoot||!ctx?.taskId||!/^[A-Za-z0-9_-]{1,160}$/.test(ctx.taskId)||typeof ctx.registerArtifact!=='function')throw hostError('ARTIFACT_CONTEXT_REQUIRED','下载必须属于具体任务产物',403);
    if(!safeRequestPath(route)||/[#\r\n]/.test(route)||[...new URL(route,'http://127.0.0.1').searchParams.keys()].some(k=>/^(?:path|filePath|directory|root|database|db|sql|url|sourceUrl|href)$/i.test(k)))throw hostError('MODULE_ROUTE_INVALID','下载必须使用已登记的模块文件标识',403);
    if(typeof filename!=='string'||!filename||filename.length>180||filename!==path.basename(filename)||/[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(filename)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename))throw hostError('ARTIFACT_NAME_INVALID','下载文件名无效');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>maxArtifactBytes||expectedSha256!==undefined&&!/^[a-f0-9]{64}$/i.test(expectedSha256))throw hostError('ARTIFACT_LIMIT_INVALID','下载范围或摘要无效');
    const directory=path.join(artifactRoot,ctx.taskId);assertArtifactDirectory(directory);
    const upstream=await current(id,ctx),manifest=await loadOperationManifest(id,{config:upstream.config,capabilities:upstream.cap,getManifest,integrationKey:upstream.integrationKey}),matched=matchOperation(manifest,'GET',route);
    if(!matched||matched.operation.kind!=='download'||matched.operation.remote!==true||matched.operation.uiOnly)throw hostError('DOWNLOAD_UNLISTED','此文件接口未登记为允许的下载能力',403);
    const target=matched.upstreamPath,now=Date.now(),combined=AbortSignal.any([AbortSignal.timeout(120000),signal||ctx.signal].filter(Boolean));
    const response=await fetchImpl(upstream.url+target,{method:'GET',redirect:'error',signal:combined,headers:{Authorization:'Bearer '+upstream.integrationKey,...signWorkbenchActor({...upstream.actor,v:1,module:id,requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,method:'GET',path:target},upstream.actorKey),'X-Workbench-Channel':'mcp'}});
    if(!response.ok){await response.body?.cancel();throw hostError('MODULE_DOWNLOAD_FAILED','模块文件下载未完成',response.status);}
    if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw hostError('ARTIFACT_TOO_LARGE','文件超过任务产物大小上限',413);}
    assertArtifactDirectory(directory);fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const realRoot=fs.realpathSync(artifactRoot),realDirectory=fs.realpathSync(directory);if(!inside(realRoot,realDirectory)||fs.lstatSync(directory).isSymbolicLink())throw hostError('ARTIFACT_PATH_DENIED','任务产物目录被重定向',403);
    const file=path.join(directory,randomUUID()+path.extname(filename)),hash=createHash('sha256');let size=0;
    const meter=new Transform({transform(chunk,_encoding,done){size+=chunk.length;if(size>maxBytes)return done(hostError('ARTIFACT_TOO_LARGE','文件超过任务产物大小上限',413));hash.update(chunk);done(null,chunk);}});
    try{await pipeline(Readable.from(response.body||[]),meter,fs.createWriteStream(file,{flags:'wx',mode:0o600}),{signal:combined});combined.throwIfAborted();const sha256=hash.digest('hex');if(expectedSha256&&sha256!==expectedSha256.toLowerCase())throw hostError('ARTIFACT_HASH_MISMATCH','文件摘要不一致，请重新获取',409);const mimeType=response.headers.get('content-type')||'application/octet-stream',artifact=await ctx.registerArtifact({path:file,name:filename,mimeType});if(!artifact?.id)throw hostError('ARTIFACT_REGISTRATION_FAILED','任务产物未成功登记',500);return {id:artifact.id,artifactId:artifact.id,taskId:ctx.taskId,name:filename,size,mimeType,sha256};}catch(error){fs.rmSync(file,{force:true});throw error;}
  };
  request.binding=async(id,ctx)=>{const {cap}=await current(id,ctx),workbench=cap.workbench||cap.state?.workbench||cap.capabilities?.workbench||{};const dataSetId=cap.dataSetId||workbench.dataSetId,revision=cap.revision??workbench.revision;if(!dataSetId||revision===undefined)throw hostError('DATASET_UNAVAILABLE','模块缺少账本身份与版本',503);return {dataSetId,revision};};
  request.signApproval=async(claims,id)=>{
    if(typeof validateApproval!=='function'||!await validateApproval(claims,id))throw hostError('AGENT_APPROVAL_REQUIRED','没有可核对的已审批任务',403);
    const actor=await resolveActor(claims.actorId);if(!actor||actor.role==='viewer'||!actor.canRunTasks&&!selfService(id,claims.capabilityId,actor)||!actor.modules.includes(id)||claims.module!==id)throw hostError('MODULE_DENIED','提交前人员权限已变化',403);
    const signer=signProof||(await import('../agent-runtime/approval.mjs')).signAgentApproval;
    return signer(claims,readKey(services.config(id).dataDir,'.workbench-key'));
  };
  return request;
}
