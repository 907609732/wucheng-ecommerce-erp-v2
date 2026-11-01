import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import Fastify from 'fastify';
import {acquireTailnetGuard,tailnetPaths,tailnetStatus,tailnetAtomic,tailnetDescriptor,tailnetMac,tailnetEqual,tailnetFailure} from './tailnet-runtime.mjs';

const operations=new Set(['status','start','login','logout','stop','shutdown']);
const loopback=new Set(['127.0.0.1','::ffff:127.0.0.1']);
function validateInit(input){
 const allowed=['v','profile','origin','brokerId','controlToken','proxyPassword','nonce','sidecarPath'];
 if(!input||input.v!==1||Object.keys(input).some(key=>!allowed.includes(key))||typeof input.brokerId!=='string'||!/^[a-f0-9-]{36}$/.test(input.brokerId)||![input.controlToken,input.proxyPassword,input.nonce].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))||new Set([input.controlToken,input.proxyPassword,input.nonce]).size!==3)throw tailnetFailure('TAILNET_BROKER_INIT_INVALID');
 const paths=tailnetPaths(input.profile,input.origin);
 if(paths.origin!==input.origin||!fs.statSync(input.sidecarPath).isFile())throw tailnetFailure('TAILNET_BROKER_INIT_INVALID');
 return paths;
}

// One private JSONL pipe owns the Go process. Neither argv nor its environment
// carries auth credentials. A timeout is reported, never automatically replayed.
export async function createTailnetStdioEngine(config,{spawnImpl=spawn,timeoutMs=20000}={}){
 const env={...process.env};for(const key of Object.keys(env))if(/^TS_|^TSNET_|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$|^NODE_PATH$|^NODE_EXTRA_CA_CERTS$|^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(key))delete env[key];
 const child=spawnImpl(config.sidecarPath,[],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env});
 let failure=null,exit=false,buffer='',lastStatus,exitResolve;const pending=new Map(),decoder=new StringDecoder('utf8');
 const exited=new Promise(resolve=>{exitResolve=resolve;});
 function fail(code){failure=tailnetFailure(code);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(failure);}pending.clear();}
 child.stdin.on('error',()=>fail('TAILNET_ENGINE_PIPE_CLOSED'));child.stderr.on('data',()=>{});
 child.on('error',()=>fail('TAILNET_ENGINE_START_FAILED'));
 child.once('exit',()=>{exit=true;fail('TAILNET_ENGINE_EXITED');exitResolve();});
 child.stdout.on('data',chunk=>{
  buffer+=decoder.write(chunk);if(Buffer.byteLength(buffer)>65536){fail('TAILNET_ENGINE_PROTOCOL_INVALID');child.stdin.end();return;}
  let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let response;
   try{response=JSON.parse(line);if(response.v!==1||typeof response.id!=='string'||typeof response.ok!=='boolean')throw Error();}catch{fail('TAILNET_ENGINE_PROTOCOL_INVALID');child.stdin.end();return;}
   const item=pending.get(response.id);if(!item)continue;pending.delete(response.id);clearTimeout(item.timer);
   if(!response.ok){const code=/^[A-Z0-9_]{1,64}$/.test(response.error?.code||'')?response.error.code:'TAILNET_ENGINE_OPERATION_FAILED';item.reject(tailnetFailure(code));continue;}
   try{lastStatus=tailnetStatus(response.result,config.origin);item.resolve(lastStatus);}catch(error){item.reject(error);fail('TAILNET_ENGINE_PROTOCOL_INVALID');child.stdin.end();}
  }
 });
 const request=(op,init=false)=>new Promise((resolve,reject)=>{
  if(failure||exit){reject(failure||tailnetFailure('TAILNET_ENGINE_EXITED'));return;}
  const id=randomUUID(),message=init?{v:1,id,op:'init',nonce:config.nonce,proxyPassword:config.proxyPassword,origin:config.origin,stateDir:config.stateDir,hostname:config.hostname}:{v:1,id,nonce:config.nonce,op};
  const timer=setTimeout(()=>{pending.delete(id);reject(tailnetFailure('TAILNET_ENGINE_OUTCOME_UNKNOWN','连接组件未及时返回，请先查询状态'));},timeoutMs);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify(message)+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(tailnetFailure('TAILNET_ENGINE_PIPE_CLOSED'));}});
 });
 let initialStatus;
 try{initialStatus=await request('init',true);}catch(error){child.stdin.end();throw error;}
 return {pid:child.pid,initialStatus,request,
  async shutdown(){
   if(!exit)await request('shutdown');
   let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(tailnetFailure('TAILNET_ENGINE_SHUTDOWN_UNCONFIRMED')),10000);})]);}finally{clearTimeout(timer);}
   return {...lastStatus,state:'stopped'};
  }
 };
}

export async function createTailnetBroker(init,{engineFactory=createTailnetStdioEngine,ownerTimeoutMs=1000}={}){
 const paths=validateInit(init),releaseOwner=await acquireTailnetGuard(paths,'owner',ownerTimeoutMs);
 let engine,app,descriptor,closing=false,closed=false,queue=Promise.resolve();
 const record={controlToken:init.controlToken};
 try{
  engine=await engineFactory({...init,stateDir:paths.stateDir,hostname:'lingtu-'+paths.originKey.slice(0,16)});
  if(!Number.isSafeInteger(engine.pid)||engine.pid<=0||typeof engine.request!=='function'||typeof engine.shutdown!=='function')throw tailnetFailure('TAILNET_ENGINE_RESPONSE_INVALID');
  let status=tailnetStatus(engine.initialStatus||await engine.request('status'),paths.origin);
  app=Fastify({logger:false,bodyLimit:4096,requestTimeout:25000,connectionTimeout:5000,trustProxy:false});
  app.setErrorHandler((error,_q,r)=>r.status(error.statusCode||500).send({v:1,ok:false,error:{code:/^[A-Z0-9_]{1,64}$/.test(error.code||'')?error.code:'TAILNET_BROKER_FAILED'}}));
  app.addHook('onRequest',async(q,r)=>{
   if(!loopback.has(q.raw.socket.remoteAddress)||Object.hasOwn(q.headers,'origin')||q.headers.host!==new URL(descriptor?.url||'http://127.0.0.1:1').host){r.code(403).send({v:1,ok:false,error:{code:'TAILNET_BROKER_SOURCE_DENIED'}});return;}
   r.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
  });
  app.get('/proof',async(q,r)=>{
   if(Object.keys(q.query||{}).length!==1||!/^[a-f0-9]{64}$/.test(q.query?.challenge||''))return r.code(400).send({v:1,ok:false,error:{code:'TAILNET_PROOF_INVALID'}});
   return {v:1,brokerId:init.brokerId,profileKey:paths.profileKey,origin:paths.origin,pid:process.pid,mac:tailnetMac(init.controlToken,q.query.challenge)};
  });
  app.post('/rpc/:op',async(q,r)=>{
   if(!tailnetEqual(q.headers.authorization,'Bearer '+init.controlToken))return r.code(401).send({v:1,ok:false,error:{code:'TAILNET_BROKER_UNAUTHORIZED'}});
   const op=q.params.op;if(!operations.has(op)||Object.keys(q.query||{}).length||!q.body||Array.isArray(q.body)||typeof q.body!=='object'||Object.keys(q.body).length)return r.code(400).send({v:1,ok:false,error:{code:'TAILNET_OPERATION_INVALID'}});
   if(closing)return r.code(503).send({v:1,ok:false,error:{code:'TAILNET_BROKER_CLOSING'}});
   const run=queue.then(async()=>{
    if(closing)throw tailnetFailure('TAILNET_BROKER_CLOSING');
    if(op==='shutdown'){
     closing=true;try{status=tailnetStatus(await engine.shutdown(),paths.origin);}catch(error){closing=false;throw error;}
     descriptor={...descriptor,phase:'stopped'};tailnetAtomic(paths.ready,JSON.stringify(tailnetDescriptor(record,descriptor)));
     r.raw.once('finish',()=>{void close(false).catch(()=>{});});
    }else status=tailnetStatus(await engine.request(op),paths.origin);
    return {v:1,brokerId:init.brokerId,ok:true,result:status};
   });queue=run.catch(()=>{});return run;
  });
  const url=await app.listen({host:'127.0.0.1',port:0});
  descriptor={v:1,phase:'ready',brokerId:init.brokerId,profileKey:paths.profileKey,origin:paths.origin,url,pid:process.pid,goPid:engine.pid};
  tailnetAtomic(paths.ready,JSON.stringify(tailnetDescriptor(record,descriptor)));
  async function close(shutdownEngine=true){
   if(closed)return;closing=true;
   if(shutdownEngine){await queue;status=tailnetStatus(await engine.shutdown(),paths.origin);descriptor={...descriptor,phase:'stopped'};tailnetAtomic(paths.ready,JSON.stringify(tailnetDescriptor(record,descriptor)));}
   await app.close();closed=true;await releaseOwner();
  }
  return {url,brokerId:init.brokerId,close,enginePid:engine.pid};
 }catch(error){try{if(engine)await engine.shutdown();}catch{}try{if(app)await app.close();}finally{await releaseOwner();}throw error;}
}
