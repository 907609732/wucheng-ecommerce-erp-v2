import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {Transform,Readable,PassThrough} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import Fastify,{LogController} from 'fastify';
import cookie from '@fastify/cookie';
import replyFrom from '@fastify/reply-from';
import {createGatewayStore,digest} from './store.mjs';
import {WORKBENCH_MODULES,signWorkbenchActor} from './actor.mjs';
import {loadOperationManifest,matchOperation,publicManifest,safeRequestPath} from './manifest.mjs';
import {validatePolicy} from './policy.mjs';
import {withCompanyAccess} from './company-access.mjs';

const COOKIE='__Host-workbench-session';
const API='/api/workbench/v1';
const channels=new Set(['ui','cli','mcp']);
const readonly=method=>method==='GET'||method==='HEAD';
const fail=(statusCode,code,message)=>Object.assign(Error(message),{statusCode,code,workbenchPublic:true});
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const cleanLogin=value=>typeof value==='string'?value.trim().toLowerCase():'';
const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const scopedCookie=(id,name)=>'wb_'+id+'_'+name;

function validOrigin(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('工作台入口必须是 Tailscale HTTPS 源地址');return u.origin;}
function localUrl(value){const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw fail(503,'MODULE_IDENTITY_INVALID','模块接口不是受控本机服务');return u.origin;}
function readKey(config,name){let key;try{key=fs.readFileSync(path.join(config.dataDir,name),'utf8').trim();}catch{throw fail(503,'MODULE_KEY_UNAVAILABLE','模块缺少工作台接口凭据，请在主机更新对应模块');}if(!/^[a-f0-9]{64}$/i.test(key))throw fail(503,'MODULE_KEY_INVALID','模块工作台密钥无效');return key;}
function redactedHeaders(headers){
  const result={};for(const key of ['content-type','content-disposition','etag','last-modified','content-range','accept-ranges'])if(headers[key])result[key]=headers[key];return result;
}
function rewriteCookies(headers,id){
  const cookies=headers['set-cookie'];if(!cookies)return undefined;
  return (Array.isArray(cookies)?cookies:[cookies]).map(raw=>{const pieces=raw.split(';');const at=pieces[0].indexOf('=');if(at<1)return null;const name=pieces[0].slice(0,at);if(!/^[\w-]+$/.test(name))return null;const rest=pieces.slice(1).filter(p=>!/^\s*(?:path|domain|samesite|secure)\s*(?:=|$)/i.test(p));return scopedCookie(id,name)+pieces[0].slice(at)+';'+rest.join(';')+'; Path=/apps/'+id+'/; Secure; SameSite=Strict';}).filter(Boolean);
}
function backendCookies(request,id){return Object.entries(request.cookies||{}).filter(([name])=>name.startsWith('wb_'+id+'_')).map(([name,value])=>name.slice(('wb_'+id+'_').length)+'='+encodeURIComponent(value)).join('; ');}

async function spoolBody(request,dir,maxBytes){
  if(readonly(request.method))return {file:null,bytes:0,hash:digest('')};
  if(Number(request.headers['content-length'])>maxBytes)throw fail(413,'BODY_TOO_LARGE','上传内容超过允许大小');
  const file=path.join(dir,randomUUID()+'.request');let bytes=0;const hash=createHash('sha256');
  const meter=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>maxBytes)return done(fail(413,'BODY_TOO_LARGE','上传内容超过允许大小'));hash.update(chunk);done(null,chunk);}});
  const payload=request.body&&typeof request.body.pipe==='function'?request.body:Readable.from(request.body===undefined?[]:[Buffer.from(typeof request.body==='string'?request.body:JSON.stringify(request.body))]);
  // Keep request.socket outside pipeline's destroy chain so a bounded upload can receive a clear 413 response.
  const source=new PassThrough(),inputError=e=>source.destroy(e);payload.once('error',inputError);
  try{const saving=pipeline(source,meter,fs.createWriteStream(file,{flags:'wx',mode:0o600}));payload.pipe(source);await saving;return {file,bytes,hash:hash.digest('hex')};}
  catch(e){payload.unpipe(source);payload.resume();fs.rmSync(file,{force:true});throw e;}
  finally{payload.removeListener('error',inputError);}
}
async function boundedResponse(response,limit){let size=0;const chunks=[];for await(const chunk of response.body||[]){size+=chunk.length;if(size>limit)throw fail(502,'MODULE_RESPONSE_TOO_LARGE','模块返回结果超过允许大小，请使用文件下载接口');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}

export async function createWorkbenchGateway(options={}) {
  const {services,storeDir,getManifest,registerRoutes,logger=false,maxUploadBytes=128*1024*1024,maxResponseBytes=16*1024*1024,sessionTtlMs=12*60*60*1000}=options;
  if(!services||!storeDir)throw Error('缺少工作台服务注册表或存储目录');
  const publicOrigin=validOrigin(options.publicOrigin),publicHost=new URL(publicOrigin).host;
  const host=options.host||'127.0.0.1',port=options.port??17330;
  if(host!=='127.0.0.1')throw Error('工作台只能绑定 127.0.0.1，由 Tailscale Serve 提供 HTTPS');
  const store=createGatewayStore(storeDir);
  const spoolDir=path.join(storeDir,'requests');fs.mkdirSync(spoolDir,{recursive:true,mode:0o700});
  // Request spools contain uploads; clean only our own private leftover request files.
  for(const name of fs.readdirSync(spoolDir))if(/^[a-f0-9-]{36}\.request$/.test(name))fs.rmSync(path.join(spoolDir,name),{force:true});
  const app=Fastify({logger,bodyLimit:maxUploadBytes,requestTimeout:120000,trustProxy:false,logController:new LogController({disableRequestLogging:true})});
  await app.register(cookie);
  await app.register(replyFrom,{disableRequestLogging:true,retriesCount:0,undici:{connections:32,pipelining:1}});
  // JSON keeps Fastify's strict parser for business and migration hooks; binary/multipart uploads stream to a bounded private spool.
  app.addContentTypeParser('*',(req,payload,done)=>done(null,payload));
  app.setErrorHandler((error,request,reply)=>{if(reply.sent)return;reply.code(error.statusCode||500).send({ok:false,code:error.code||'WORKBENCH_ERROR',error:error.workbenchPublic||error.statusCode&&error.statusCode<500?error.message:'工作台请求失败，请检查本机服务状态',requestId:request.id});});
  function loginOf(request){
    if(!loopback(request.ip))throw fail(403,'LOOPBACK_REQUIRED','只能由本机 Tailscale Serve 转发');
    if(request.headers.host!==publicHost)throw fail(421,'INVALID_HOST','入口地址与本机配置不一致');
    const raw=request.raw.rawHeaders||[];if(raw.filter((v,i)=>i%2===0&&v.toLowerCase()==='tailscale-user-login').length!==1)throw fail(401,'IDENTITY_REQUIRED','缺少唯一的 Tailscale 用户身份');
    const login=cleanLogin(request.headers['tailscale-user-login']);if(!login||login.length>254||/[\s,\r\n]/.test(login))throw fail(401,'IDENTITY_REQUIRED','缺少 Tailscale 用户身份');
    if(Object.keys(request.headers).some(k=>k==='x-workbench-actor'||k==='x-workbench-actor-signature'||k==='x-workbench-prefix'||k==='x-workbench-api-base'))throw fail(400,'SPOOFED_ACTOR','客户端不得提供模块代理身份');
    if(request.headers.origin&&request.headers.origin!==publicOrigin)throw fail(403,'ORIGIN_DENIED','请求来源不受信任');
    if(['cross-site','same-site'].includes(request.headers['sec-fetch-site']))throw fail(403,'ORIGIN_DENIED','请求来源不受信任');
    return login;
  }
  function resolveActor(request,{csrf=!readonly(request.method)}={}){
    const login=loginOf(request),session=store.session(request.cookies[COOKIE]);
    if(!session||session.login!==login)throw fail(401,'SESSION_REQUIRED','请先连接工作台以建立会话');
    const channel=request.headers['x-workbench-channel'];if(channel&&channel!==session.channel)throw fail(403,'CHANNEL_DENIED','本次会话不能切换调用通道');
    if(csrf&&(!equal(request.headers['x-workbench-csrf'],session.csrf)||request.headers.origin!==publicOrigin))throw fail(403,'CSRF_DENIED','本次修改缺少有效的界面确认来源');
    store.observeMember(login);
    return withCompanyAccess({v:1,id:'tailscale:'+login,login,label:login,sessionId:session.session_id,channel:session.channel});
  }
  const requireSession=async(request,reply)=>{try{request.workbenchActor=resolveActor(request);}catch(e){reply.code(e.statusCode||500).send({ok:false,code:e.code,error:e.message});}};
  const requireAdmin=requireSession; // Legacy route name; all authenticated company members have equal access.
  const writeAudit=entry=>store.audit(entry);
  const bindModule=(actor,id,cap)=>store.bindModule(actor.sessionId,id,cap?.dataSetId||cap?.workbench?.dataSetId||cap?.state?.workbench?.dataSetId||cap?.capabilities?.workbench?.dataSetId);
  async function metadata(actor){return Promise.all(actor.modules.map(async id=>{try{const cap=await services.capabilities(id),c=services.config(id),workbench=cap?.workbench||cap?.state?.workbench||cap?.capabilities?.workbench;return {id,version:cap?.version||c.version||null,status:cap?.url?(workbench?.protocolVersion===1?'running':'incompatible'):cap?.installed===false?'missing':'stopped',dataSetId:cap?.dataSetId||workbench?.dataSetId||null,revision:cap?.revision??workbench?.revision??null};}catch{return {id,status:'unavailable',version:null,dataSetId:null,revision:null};}}));}
  async function backend(id,{start=true}={}){
    if(!WORKBENCH_MODULES.includes(id))throw fail(404,'MODULE_UNKNOWN','未登记的模块');
    const config=services.config(id);let cap;
    if(start&&config.maintenance)throw fail(503,'MODULE_MAINTENANCE','模块处于维护或恢复窗口，请稍后重试');
    try{cap=start?await services.ensure(id):await services.capabilities(id);}
    catch(error){
      if(error.code==='EADDRINUSE'||/端口/.test(error.message))throw fail(503,'MODULE_PORT_CONFLICT','模块端口已有其他服务占用，请在主机设置中核对');
      if(/版本|旧版/.test(error.message))throw fail(503,'MODULE_VERSION_MISMATCH','运行服务与已安装模块版本不同，请在主机更新并重新打开');
      if(/账本|目录/.test(error.message))throw fail(503,'MODULE_DATA_UNAVAILABLE','模块原数据位置不一致或账本不可用，已阻止创建空账本');
      throw fail(503,'MODULE_UNAVAILABLE','模块尚未就绪，请由主机管理员检查安装与服务状态');
    }
    if(!cap?.url&&start)cap=await services.capabilities(id);
    if(!cap?.url)throw fail(503,'MODULE_NOT_RUNNING','模块未安装或尚未就绪，请在服务器本机管理');
    const url=localUrl(cap.url),integrationKey=readKey(config,config.keyFile||'.integration-key'),actorKey=readKey(config,'.workbench-key');
    const manifest=await loadOperationManifest(id,{config,capabilities:cap,getManifest,integrationKey});
    return {config,cap,url,integrationKey,actorKey,manifest};
  }
  function responseHeaders(headers,id,upstream,ui){
    const result=redactedHeaders(headers);const cookies=rewriteCookies(headers,id);if(cookies?.length)result['set-cookie']=cookies;
    if(headers.location){const location=new URL(headers.location,upstream.url);if(location.origin!==upstream.url)throw fail(502,'MODULE_REDIRECT_DENIED','模块返回了外部重定向');result.location='/apps/'+id+location.pathname+location.search;}
    result['cache-control']='no-store';result['x-content-type-options']='nosniff';result['referrer-policy']='same-origin';
    if(ui)result['content-security-policy']=headers['content-security-policy']||"frame-ancestors 'self'; object-src 'none'; base-uri 'self'";
    return result;
  }
  function outboundHeaders(request,id,upstream,actor,target,requestId){
    const h={authorization:'Bearer '+upstream.integrationKey,'accept-encoding':'identity','x-workbench-prefix':'/apps/'+id,'x-workbench-api-base':API+'/modules/'+id,...signWorkbenchActor({...actor,requestId,issuedAt:Date.now(),expiresAt:Date.now()+30000,module:id,method:request.method,path:target},upstream.actorKey)};
    for(const key of ['content-type','accept','if-none-match','if-modified-since','range','x-integration-review-nonce','x-review-token','idempotency-key'])if(request.headers[key])h[key]=request.headers[key];
    const cookies=backendCookies(request,id);if(cookies)h.cookie=cookies;return h;
  }
  async function proxy(request,reply,ui=false){
    const actor=resolveActor(request),id=request.params.id;
    if(!safeRequestPath(request.raw.url))throw fail(400,'UNSAFE_PATH','接口路径无效');
    const urlQuery=new URL(request.raw.url,publicOrigin).searchParams;
    if([...urlQuery.keys()].some(k=>/^(?:path|filePath|directory|root|database|db|sql|query_sql)$/i.test(k)))throw fail(400,'UNSAFE_FILE_QUERY','远程文件访问必须使用已登记文件标识');
    const upstream=await backend(id);bindModule(actor,id,upstream.cap);const raw=request.params['*']||'',query=request.raw.url.includes('?')?request.raw.url.slice(request.raw.url.indexOf('?')):'';
    let requestPath='/'+raw;
    if(ui&&!requestPath.startsWith('/api/'))requestPath=requestPath==='/'?upstream.manifest.ui.indexPath:(upstream.manifest.ui.prefix||'')+requestPath;
    const matched=matchOperation(upstream.manifest,request.method,requestPath+query);
    if(!matched)throw fail(404,'OPERATION_UNLISTED','此接口未登记为工作台业务功能');
    const {operation,upstreamPath:target}=matched;
    if(!operation.remote)throw fail(403,'HOST_ONLY','此操作只能在服务器本机执行');
    if(!ui&&operation.kind==='ui')throw fail(404,'OPERATION_UNLISTED','请通过模块页面入口打开');
    if((operation.uiOnly||operation.kind==='confirmation')&&actor.channel!=='ui')throw fail(403,'UI_CONFIRMATION_REQUIRED','此操作必须在界面完成两次确认');
    const requestId=randomUUID();
    if(readonly(request.method))return reply.from(upstream.url+target,{rewriteRequestHeaders:()=>outboundHeaders(request,id,upstream,actor,target,requestId),rewriteHeaders:h=>responseHeaders(h,id,upstream,ui),retriesCount:0,timeout:60000});
    const key=request.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw fail(400,'IDEMPOTENCY_KEY_REQUIRED','修改请求必须带有唯一操作标识');
    const body=await spoolBody(request,spoolDir,maxUploadBytes);
    try{
      const currentActor=resolveActor(request);
      const operationKey=digest(actor.id+'\0'+id+'\0'+key),fingerprint=digest(request.method+'\0'+target+'\0'+body.hash+'\0'+(operation.uiOnly?actor.sessionId:''));
      const existing=store.get(operationKey);
      if(existing){if(existing.fingerprint!==fingerprint)throw fail(409,'IDEMPOTENCY_CONFLICT','此操作标识对应的内容已变化');if(existing.state!=='completed')throw fail(409,'OPERATION_OUTCOME_UNKNOWN','上次操作结果仍需核对，已阻止重复写入');reply.code(existing.status);for(const [k,v] of Object.entries(existing.headers))reply.header(k,v);return reply.send(existing.body);}
      store.begin(operationKey,fingerprint,actor,requestId);writeAudit({requestId,actorId:actor.id,module:id,operation:operation.operationId,outcome:'started',details:{bodyDigest:body.hash,bytes:body.bytes}});
      try{
        // Upload spooling can outlive a short delegation signature. Revalidate
        // login session and sign immediately before the local business request.
        const headers=outboundHeaders(request,id,upstream,currentActor,target,requestId);
        const response=await fetch(upstream.url+target,{method:request.method,headers,...(body.bytes?{body:fs.createReadStream(body.file),duplex:'half'}:{}),redirect:'manual',signal:AbortSignal.timeout(120000)});
        const result=await boundedResponse(response,maxResponseBytes),rawHeaders=Object.fromEntries(response.headers);if(response.headers.getSetCookie)rawHeaders['set-cookie']=response.headers.getSetCookie();
        const safeHeaders=responseHeaders(rawHeaders,id,upstream,ui);
        store.finish(operationKey,{status:response.status,headers:safeHeaders,body:result});writeAudit({requestId,actorId:actor.id,module:id,operation:operation.operationId,outcome:response.ok?'completed':'rejected',details:{status:response.status}});
        reply.code(response.status);for(const [k,v] of Object.entries(safeHeaders))reply.header(k,v);return reply.send(result);
      }catch(error){store.finish(operationKey,{state:'unknown',status:502});writeAudit({requestId,actorId:actor.id,module:id,operation:operation.operationId,outcome:'unknown',details:{code:error.code||'UPSTREAM_UNCERTAIN'}});throw fail(502,'OPERATION_OUTCOME_UNKNOWN','连接中断，操作可能已完成；请查询结果后再处理，系统已阻止重复写入');}
    }finally{if(body.file)fs.rmSync(body.file,{force:true});}
  }
  app.get(API+'/health',async()=>({ok:true,service:'wucheng-workbench',protocolVersion:1,serverId:store.serverId,dataSetId:store.dataSetId}));
  app.get(API+'/session',async(request,reply)=>{
    const login=loginOf(request),channel=request.headers['x-workbench-channel']||'ui';if(!channels.has(channel))throw fail(400,'CHANNEL_INVALID','调用通道无效');
    let session=store.session(request.cookies[COOKIE]),token=request.cookies[COOKIE];
    if(!session||session.login!==login||session.channel!==channel){token=randomBytes(32).toString('base64url');const s={sessionId:randomUUID(),login,channel,csrfToken:randomBytes(32).toString('base64url'),expiresAt:Date.now()+sessionTtlMs};store.saveSession(token,s);session=store.session(token);}
    reply.setCookie(COOKIE,token,{secure:true,httpOnly:true,sameSite:'strict',path:'/',maxAge:Math.floor((session.expires_at-Date.now())/1000)}).header('cache-control','no-store');
    store.observeMember(login);
    const actor=withCompanyAccess({id:'tailscale:'+login,login,label:login,channel});
    return {ok:true,protocolVersion:1,serverId:store.serverId,dataSetId:store.dataSetId,actor,sessionId:session.session_id,csrfToken:session.csrf,expiresAt:session.expires_at,modules:await metadata(actor)};
  });
  app.get(API+'/modules',{preHandler:requireSession},async request=>({ok:true,serverId:store.serverId,dataSetId:store.dataSetId,modules:await metadata(request.workbenchActor)}));
  app.get(API+'/modules/:id/connection',{preHandler:requireSession},async request=>{
    const actor=request.workbenchActor,id=request.params.id;
    const {cap}=await backend(id),workbench=cap.workbench||cap.state?.workbench||cap.capabilities?.workbench;bindModule(actor,id,cap);
    return {ok:true,id,status:'running',version:cap.version||null,dataSetId:cap.dataSetId||workbench?.dataSetId||null,revision:cap.revision??workbench?.revision??null,protocolVersion:1};
  });
  app.get(API+'/operations/:idempotencyKey',{preHandler:requireSession},async(request,reply)=>{
    const actor=request.workbenchActor,id=request.query.module,key=request.params.idempotencyKey;
    if(!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw fail(400,'IDEMPOTENCY_KEY_INVALID','操作标识无效');
    const operation=store.get(digest(actor.id+'\0'+id+'\0'+key));if(!operation)throw fail(404,'OPERATION_NOT_FOUND','未找到此成员的操作记录');
    reply.header('cache-control','no-store');
    let result=null;if(operation.state==='completed'){try{result=JSON.parse(operation.body.toString('utf8'));}catch{result={encoding:'base64',content:operation.body.toString('base64')};}}
    return {ok:true,serverId:store.serverId,dataSetId:store.dataSetId,module:id,idempotencyKey:key,requestId:operation.request_id,state:operation.state,status:operation.status,result,requiresReconciliation:operation.state!=='completed'};
  });
  app.get(API+'/capabilities',{preHandler:requireSession},async request=>{
    const operationManifest=[];for(const id of request.workbenchActor.modules){try{operationManifest.push(publicManifest((await backend(id,{start:false})).manifest));}catch{operationManifest.push({module:id,available:false,operations:[]});}}
    return {ok:true,protocolVersion:1,serverId:store.serverId,dataSetId:store.dataSetId,modules:await metadata(request.workbenchActor),operationManifest};
  });
  const methods=['GET','HEAD','POST','PUT','PATCH','DELETE'];
  app.route({method:methods,url:API+'/modules/:id/*',handler:(req,reply)=>proxy(req,reply,false)});
  app.route({method:methods,url:'/apps/:id/',handler:(req,reply)=>proxy(req,reply,true)});
  app.route({method:methods,url:'/apps/:id/*',handler:(req,reply)=>proxy(req,reply,true)});
  const context={requireSession,requireAdmin,resolveActor,writeAudit,operationStore:store,storeDir,serverId:store.serverId,dataSetId:store.dataSetId,publicOrigin};
  if(options.agentRuntime){const {registerAgentRoutes}=await import('../agent-host/routes.mjs');await registerAgentRoutes(app,context,options.agentRuntime);}
  if(registerRoutes)await registerRoutes(app,context);
  app.addHook('onClose',async()=>store.close());
  return {app,...context,async start(){try{return await app.listen({host,port});}catch(error){await app.close();throw error;}},async stop(){await app.close();}};
}

export {validatePolicy};

