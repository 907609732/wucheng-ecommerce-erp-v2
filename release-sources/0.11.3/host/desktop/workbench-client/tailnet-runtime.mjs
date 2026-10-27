import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {serverAddress} from './connection.mjs';

export const tailnetFailure=(code,message=code==='LOGOUT_REQUIRES_START'?'请先启动内置私网连接，再执行退出登录；当前保存的登录身份尚未注销。':code==='TAILNET_BUSY'?'私网仍有正在进行的连接，请等待任务结束后重试':code)=>Object.assign(Error(message),{code});
export const tailnetDigest=value=>createHash('sha256').update(value).digest('hex');
export const tailnetMac=(token,value)=>createHmac('sha256',token).update(value).digest('hex');
export const tailnetEqual=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);};
export const tailnetAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function tailnetPaths(profile,origin){
 const canonical=serverAddress(origin),physical=fs.realpathSync.native(profile);
 if(!fs.statSync(physical).isDirectory())throw tailnetFailure('TAILNET_PROFILE_INVALID');
 const profileKey=tailnetDigest(process.platform==='win32'?physical.toLowerCase():physical),originKey=tailnetDigest(canonical);
 const directory=path.join(physical,'tailnet-runtime',originKey);
 return {profile:physical,origin:canonical,profileKey,originKey,directory,record:path.join(directory,'runtime.dpapi'),ready:path.join(directory,'broker-ready.json'),stateDir:path.join(directory,'node-state')};
}
export function tailnetAtomic(file,bytes){
 const temporary=file+'.'+randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export async function acquireTailnetGuard(paths,kind='acquire',timeoutMs=15000){
 const key=tailnetDigest(paths.profileKey+'\0'+paths.originKey+'\0'+kind).slice(0,40);
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\lingtu-tailnet-'+key:path.join(os.tmpdir(),'lingtu-tailnet-'+key+'.sock');
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.destroy();});
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.removeListener('error',reject);resolve();});});server.unref();return ()=>new Promise(resolve=>server.close(resolve));}
  catch(error){if(error.code!=='EADDRINUSE')throw error;}
  await pause(25);
 }
 throw tailnetFailure('TAILNET_RUNTIME_BUSY','已有私网连接进程正在初始化，请稍后重试');
}
export function tailnetLoopbackURL(value){
 let url;try{url=new URL(value);}catch{throw tailnetFailure('TAILNET_ENDPOINT_INVALID');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!/^\d+$/.test(url.port)||Number(url.port)<1||Number(url.port)>65535||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw tailnetFailure('TAILNET_ENDPOINT_INVALID');
 return url.origin;
}
export function tailnetStatus(value,origin){
 if(!value||value.protocolVersion!==1||value.origin!==origin||!['stopped','starting','needs-login','needs-approval','running','logged-out','error'].includes(value.state)||value.proxyUsername!=='workbench'||!/^LingtuTailnet\/[a-f0-9]{32}$/.test(value.proxyRealm||''))throw tailnetFailure('TAILNET_ENGINE_RESPONSE_INVALID');
 const result={protocolVersion:1,state:value.state,origin,proxyURL:tailnetLoopbackURL(value.proxyURL),proxyUsername:value.proxyUsername,proxyRealm:value.proxyRealm,prototypeOnly:value.prototypeOnly===true};
 if(value.loginURL){let login;try{login=new URL(value.loginURL);}catch{throw tailnetFailure('TAILNET_LOGIN_URL_INVALID');}if(login.protocol!=='https:'||login.hostname!=='login.tailscale.com'||login.port||login.username||login.password||!/^\/a\/[a-zA-Z0-9_-]+$/.test(login.pathname)||login.search||login.hash)throw tailnetFailure('TAILNET_LOGIN_URL_INVALID');result.loginURL=login.href;}
 if(value.nodeIPs!==undefined){if(!Array.isArray(value.nodeIPs)||value.nodeIPs.length>8||value.nodeIPs.some(ip=>typeof ip!=='string'||!net.isIP(ip)))throw tailnetFailure('TAILNET_ENGINE_RESPONSE_INVALID');result.nodeIPs=[...value.nodeIPs];}
 return result;
}
export function tailnetDescriptor(record,body){return {...body,signature:tailnetMac(record.controlToken,JSON.stringify(body))};}
function readDescriptor(paths,record){
 if(!fs.existsSync(paths.ready))return null;
 let value;try{value=JSON.parse(fs.readFileSync(paths.ready,'utf8'));}catch{throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN');}
 const {signature,...body}=value;
 if(body.v!==1||body.brokerId!==record.brokerId||body.profileKey!==paths.profileKey||body.origin!==paths.origin||!tailnetEqual(signature,tailnetMac(record.controlToken,JSON.stringify(body)))||!Number.isSafeInteger(body.pid)||body.pid<=0||body.goPid!==null&&(!Number.isSafeInteger(body.goPid)||body.goPid<=0)||!['ready','stopped'].includes(body.phase))throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','私网连接记录无法验证，已阻止重复启动');
 body.url=tailnetLoopbackURL(body.url);return body;
}
// Node http always addresses this literal loopback endpoint; no system proxy,
// redirects, ambient fetch implementation, or OS hostname resolution is used.
function localRequest(base,route,{method='GET',token,timeoutMs=20000}={}){
 const url=new URL(tailnetLoopbackURL(base)+route);
 return new Promise((resolve,reject)=>{
  const request=http.request(url,{method,agent:false,headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(method==='POST'?{'Content-Type':'application/json','Content-Length':'2'}:{})}},response=>{
   const chunks=[];let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){request.destroy(tailnetFailure('TAILNET_RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);});
   response.on('end',()=>{try{if(!String(response.headers['content-type']||'').startsWith('application/json'))throw tailnetFailure('TAILNET_BROKER_RESPONSE_INVALID');const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200)throw tailnetFailure(body?.error?.code||'TAILNET_BROKER_REJECTED');resolve(body);}catch(error){reject(error);}});
   response.on('error',reject);
  });
  // A stale port must not hold the acquisition guard forever by trickling
  // response bytes just before each socket inactivity timeout.
  const deadline=setTimeout(()=>request.destroy(tailnetFailure('TAILNET_BROKER_TIMEOUT','私网连接请求结果暂无法确认，请先查询状态')),timeoutMs);
  request.once('close',()=>clearTimeout(deadline));
  request.setTimeout(timeoutMs,()=>request.destroy(tailnetFailure('TAILNET_BROKER_TIMEOUT','私网连接请求结果暂无法确认，请先查询状态')));request.once('error',reject);
  request.end(method==='POST'?'{}':undefined);
 });
}
export class TailnetRuntime{
 constructor({profile,origin,sidecarPath,execPath=process.execPath,brokerEntry=fileURLToPath(new URL('./tailnet-broker-entry.mjs',import.meta.url)),encrypt,decrypt,startupTimeoutMs=15000,requestTimeoutMs=45000}={}){
  if(typeof encrypt!=='function'||typeof decrypt!=='function')throw tailnetFailure('TAILNET_SECURE_STORAGE_REQUIRED');
  if(!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<100||startupTimeoutMs>120000||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<100||requestTimeoutMs>120000)throw tailnetFailure('TAILNET_TIMEOUT_INVALID');
  Object.assign(this,{paths:tailnetPaths(profile,origin),sidecarPath:path.resolve(sidecarPath),execPath:path.resolve(execPath),brokerEntry:path.resolve(brokerEntry),encrypt,decrypt,startupTimeoutMs,requestTimeoutMs});this.pending=null;
 }
 async readRecord(){
  if(!fs.existsSync(this.paths.record))return null;
  try{const bytes=fs.readFileSync(this.paths.record);if(bytes.length>131072)throw Error();const decoded=await this.decrypt(bytes),plain=typeof decoded==='string'?decoded:decoded?.result,record=JSON.parse(plain);
   if(record.v!==1||record.profileKey!==this.paths.profileKey||record.origin!==this.paths.origin||record.stateDir!==this.paths.stateDir||typeof record.brokerId!=='string'||!Number.isSafeInteger(record.ownerPid)||![record.controlToken,record.proxyPassword,record.nonce].every(s=>/^[a-f0-9]{64}$/.test(s))||new Set([record.controlToken,record.proxyPassword,record.nonce]).size!==3)throw Error();return record;
  }catch{throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','无法解密或确认私网连接记录，已阻止创建另一节点');}
 }
 async writeRecord(record){
  let encrypted;try{encrypted=await this.encrypt(JSON.stringify(record));}catch{throw tailnetFailure('TAILNET_SECURE_STORAGE_FAILED');}
  if(!(encrypted instanceof Uint8Array)||encrypted.length===0||encrypted.length>131072)throw tailnetFailure('TAILNET_SECURE_STORAGE_FAILED');
  tailnetAtomic(this.paths.record,encrypted);
 }
 async proof(record,descriptor){
  const challenge=randomBytes(32).toString('hex');let proof;
  try{proof=await localRequest(descriptor.url,'/proof?challenge='+challenge,{timeoutMs:Math.min(this.requestTimeoutMs,3000)});}catch{throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','现有私网连接进程无法验证，未发送控制凭据或重复启动');}
  if(proof.v!==1||proof.brokerId!==record.brokerId||proof.profileKey!==this.paths.profileKey||proof.origin!==this.paths.origin||proof.pid!==descriptor.pid||!tailnetEqual(proof.mac,tailnetMac(record.controlToken,challenge)))throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','私网端口身份不符，未发送控制凭据');
 }
 async ensure(){
  if(this.pending)return this.pending;
  this.pending=this.acquire().finally(()=>{this.pending=null;});return this.pending;
 }
 async acquire(){
  fs.mkdirSync(this.paths.directory,{recursive:true,mode:0o700});if(fs.lstatSync(this.paths.directory).isSymbolicLink())throw tailnetFailure('TAILNET_PROFILE_INVALID');
  const release=await acquireTailnetGuard(this.paths,'acquire',this.startupTimeoutMs);
  try{
   let record=await this.readRecord(),descriptor=record?readDescriptor(this.paths,record):null;
   if(descriptor&&descriptor.phase==='ready'&&tailnetAlive(descriptor.pid)){
    await this.proof(record,descriptor);return {record,descriptor};
   }
   if(record){
    if(!descriptor||tailnetAlive(descriptor.pid)||tailnetAlive(descriptor.goPid))throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','旧私网连接尚未确认退出，已阻止重复启动');
   }
   for(const file of [this.execPath,this.brokerEntry,this.sidecarPath])if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw tailnetFailure('TAILNET_RUNTIME_NOT_INSTALLED');
   record={v:1,profileKey:this.paths.profileKey,origin:this.paths.origin,stateDir:this.paths.stateDir,brokerId:randomUUID(),ownerPid:process.pid,controlToken:randomBytes(32).toString('hex'),proxyPassword:randomBytes(32).toString('hex'),nonce:randomBytes(32).toString('hex'),createdAt:new Date().toISOString()};
   await this.writeRecord(record);try{fs.unlinkSync(this.paths.ready);}catch(error){if(error.code!=='ENOENT')throw error;}
   const init={v:1,profile:this.paths.profile,origin:this.paths.origin,brokerId:record.brokerId,controlToken:record.controlToken,proxyPassword:record.proxyPassword,nonce:record.nonce,sidecarPath:this.sidecarPath};
   const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};for(const key of Object.keys(env))if(/^TS_|^TSNET_|^NODE_OPTIONS$|^NODE_PATH$|^NODE_EXTRA_CA_CERTS$|^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(key))delete env[key];
   let child;
   try{child=spawn(this.execPath,[this.brokerEntry],{cwd:this.paths.profile,detached:true,windowsHide:true,shell:false,stdio:['pipe','ignore','ignore'],env});child.stdin.on('error',()=>{});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.stdin.end(JSON.stringify(init)+'\n');child.unref();}
   catch(error){if(!child?.pid){try{fs.unlinkSync(this.paths.record);}catch{}}throw tailnetFailure('TAILNET_BROKER_START_FAILED');}
   const deadline=Date.now()+this.startupTimeoutMs;
   while(Date.now()<deadline){
    if(fs.existsSync(this.paths.ready)){descriptor=readDescriptor(this.paths,record);if(descriptor.phase==='ready'){await this.proof(record,descriptor);return {record,descriptor};}}
    if(child.exitCode!==null)throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','私网代理已退出，启动阶段状态尚需核对');
    await pause(30);
   }
   throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','私网代理启动尚未确认，保留记录且未重复创建节点');
  }finally{await release();}
 }
 async request(record,descriptor,op){
  await this.proof(record,descriptor);
  const response=await localRequest(descriptor.url,'/rpc/'+op,{method:'POST',token:record.controlToken,timeoutMs:this.requestTimeoutMs});
  if(response.v!==1||response.brokerId!==record.brokerId||response.ok!==true)throw tailnetFailure('TAILNET_BROKER_RESPONSE_INVALID');
  return tailnetStatus(response.result,this.paths.origin);
 }
 async operate(op){
  if(!['status','start','login','logout','stop'].includes(op))throw tailnetFailure('TAILNET_OPERATION_INVALID');
  const {record,descriptor}=await this.ensure();return this.request(record,descriptor,op);
 }
 status(){return this.operate('status');}start(){return this.operate('start');}login(){return this.operate('login');}logout(){return this.operate('logout');}stop(){return this.operate('stop');}
 async shutdown(){
  if(this.pending)await this.pending;
  const release=await acquireTailnetGuard(this.paths,'acquire',this.startupTimeoutMs);
  try{
   const record=await this.readRecord();if(!record)return {ok:true,alreadyStopped:true};
   const descriptor=readDescriptor(this.paths,record);
   if(!descriptor)throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN');
   if(!tailnetAlive(descriptor.pid)&&!tailnetAlive(descriptor.goPid))return {ok:true,alreadyStopped:true};
   if(descriptor.phase==='stopped'&&!tailnetAlive(descriptor.goPid))return {ok:true,alreadyStopped:true};
   if(descriptor.phase!=='ready'||!tailnetAlive(descriptor.pid))throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN');
   return this.request(record,descriptor,'shutdown');
  }finally{await release();}
 }
 async connection(){const {record,descriptor}=await this.ensure();const status=await this.request(record,descriptor,'status');return {origin:status.origin,proxyURL:status.proxyURL,proxyUsername:status.proxyUsername,proxyPassword:record.proxyPassword,proxyRealm:status.proxyRealm,brokerId:record.brokerId};}
}

// Enumerate only authenticated, profile-bound existing records. This performs
// no ensure/spawn and never infers ownership from a PID or a listening port.
// Updaters must abort on any uncertain record rather than leave an old owner
// behind or terminate a process that has not proved its identity.
export async function existingTailnetRuntimes(options={}){
 const physical=fs.realpathSync.native(options.profile),base=path.join(physical,'tailnet-runtime');
 if(!fs.statSync(physical).isDirectory())throw tailnetFailure('TAILNET_PROFILE_INVALID');
 const uncertain=()=>{throw tailnetFailure('TAILNET_RUNTIME_UNCERTAIN','已有私网连接记录无法完整核对，已阻止更新；请先处理连接状态');};
 const maybeStat=target=>{try{return fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const baseStat=maybeStat(base);if(!baseStat)return [];if(baseStat.isSymbolicLink()||!baseStat.isDirectory())uncertain();
 const found=[];
 for(const entry of fs.readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const directory=path.join(base,entry.name),stat=fs.lstatSync(directory);
  if(stat.isSymbolicLink()||!stat.isDirectory())uncertain();
  const entries=fs.readdirSync(directory);if(!entries.length)continue;
  if(!/^[a-f0-9]{64}$/.test(entry.name))uncertain();
  const file=path.join(directory,'runtime.dpapi');if(!fs.existsSync(file))uncertain();
  const fileStat=fs.lstatSync(file);if(fileStat.isSymbolicLink()||!fileStat.isFile()||fileStat.size>131072)uncertain();
  let record,origin;
  try{const decoded=await options.decrypt(fs.readFileSync(file)),plain=typeof decoded==='string'?decoded:decoded?.result;record=JSON.parse(plain);origin=serverAddress(record.origin);if(origin!==record.origin||tailnetDigest(origin)!==entry.name)uncertain();}catch{uncertain();}
  const runtime=new TailnetRuntime({...options,profile:physical,origin});
  if(runtime.paths.directory!==directory)uncertain();
  for(const target of [runtime.paths.ready,runtime.paths.stateDir])if(maybeStat(target)?.isSymbolicLink())uncertain();
  const verified=await runtime.readRecord();if(!verified||!readDescriptor(runtime.paths,verified))uncertain();
  found.push(runtime);
 }
 return found;
}
