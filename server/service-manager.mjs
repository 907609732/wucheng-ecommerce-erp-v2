import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

import net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const portOpen=port=>new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});const done=value=>{socket.destroy();resolve(value);};socket.setTimeout(1000,()=>done(true));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const startError=(message,code='SERVICE_START_FAILED')=>Object.assign(Error(message),{code});
const readStartLock=file=>{try{const text=fs.readFileSync(file,'utf8').trim();if(/^\d+$/.test(text))return {legacy:true,ownerPid:Number(text)};const value=JSON.parse(text);if(value.schemaVersion!==1||typeof value.token!=='string'||!Number.isSafeInteger(value.ownerPid)||value.childPid!==null&&!Number.isSafeInteger(value.childPid))throw Error();return value;}catch(e){if(e.code==='ENOENT')return null;throw startError('扩展启动记录损坏，已阻止重复启动；请检查运行日志和启动记录');}};
const activeStart=record=>record&&(record.childPid?processAlive(record.childPid):processAlive(record.ownerPid));
const writeStartLock=(file,record)=>{const temporary=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(record),{flag:'wx'});fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch{}}};
// Windows releases this named-pipe critical section when its process exits. It keeps
// stale-record reclamation and child-PID publication atomic across launchers.
async function startGuard(file,deadline){
 const physical=path.join(fs.realpathSync.native(path.dirname(file)),path.basename(file));
 const key=createHash('sha256').update(process.platform==='win32'?physical.toLowerCase():physical).digest('hex').slice(0,40);
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\lingtu-module-start-'+key:path.join(os.tmpdir(),'lingtu-start-'+key+'.sock');
 while(Date.now()<deadline){
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.destroy();});
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.removeListener('error',reject);resolve();});});server.unref();return ()=>new Promise(resolve=>server.close(resolve));}
  catch(e){if(e.code!=='EADDRINUSE')throw e;}
  await wait(Math.min(50,Math.max(1,deadline-Date.now())));
 }
 throw startError('另一个扩展启动操作仍在进行，请稍后重试；未重复启动进程','SERVICE_START_TIMEOUT');
}
const defaults=()=>({purchase:{id:'purchase-desk',package:'purchase-desk',db:'purchases.sqlite',env:'PORT'},sales:{id:'wucheng-sales-desk',package:'wucheng-sales-desk',db:'sales.sqlite',env:'SALES_PORT'},overview:{id:'lingtu-business-overview',package:'lingtu-business-overview',db:'overview.sqlite',env:'OVERVIEW_PORT'}});
export class ServiceManager{
  constructor({registryFile,policyFile=process.env.LINGTU_WORKBENCH_POLICY_FILE,startupTimeoutMs=90000,startupPollMs=250,agentManaged=false,environment={}}={}){
    if(!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<50||startupTimeoutMs>300000||!Number.isInteger(startupPollMs)||startupPollMs<10||startupPollMs>1000)throw Error('扩展启动等待配置无效');
    this.startupTimeoutMs=startupTimeoutMs;this.startupPollMs=startupPollMs;this.agentManaged=agentManaged===true;
    this.environment=environment;
    if(!registryFile||!path.isAbsolute(registryFile))throw Error('必须显式指定完整注册表路径');
    this.registryFile=registryFile;this.policyFile=policyFile;this.pending=new Map();this.errors=new Map();
  }
  config(id){
    const base=defaults();let custom={};if(fs.existsSync(this.registryFile))custom=JSON.parse(fs.readFileSync(this.registryFile,'utf8'));
    if(!base[id])throw Error('未登记的扩展');
    const c={...base[id],...custom[id]};
    if(!Number.isInteger(c.port)||!path.isAbsolute(c.root||'')||!path.isAbsolute(c.dataDir||''))throw Error('业务服务配置无效');return c;
  }
  async capabilities(id){
    const c=this.config(id);
    let response;try{response=await fetch(`http://127.0.0.1:${c.port}/api/integration/v1/capabilities`,{signal:AbortSignal.timeout(1500),redirect:'error'});}catch{return null;}
    if(!response.ok)throw Error('该端口已有旧版或其他服务，请先在设置中核对并重启对应服务');
    const cap=await response.json();
    if(cap.id!==c.id||cap.apiVersion!==1||path.resolve(cap.dataDir).toLowerCase()!==path.resolve(c.dataDir).toLowerCase()||path.resolve(cap.root).toLowerCase()!==path.resolve(c.root).toLowerCase())throw Error('服务身份或数据目录不符，已阻止连接');
    const version=c.managed?c.version:JSON.parse(fs.readFileSync(path.join(c.root,'package.json'),'utf8')).version;
    if(cap.version!==version)throw Error(`后台版本 ${cap.version} 与当前源码 ${version} 不符，请停止该服务后重新打开`);
    return cap;
  }
  async status(){return Promise.all(Object.keys(defaults()).map(async id=>{const c=this.config(id);try{const cap=await this.capabilities(id);return {extension:id,...c,status:cap?'running':'stopped',busy:cap?.busy||false,error:this.errors.get(id)||''};}catch(e){return {extension:id,...c,status:'error',error:e.message};}}));}
  async ensure(id){
    if(this.pending.has(id))return this.pending.get(id);
    const promise=this.start(id).catch(e=>{this.errors.set(id,e.message);throw e;}).finally(()=>this.pending.delete(id));
    this.pending.set(id,promise);return promise;
  }
  async start(id){
    const c=this.config(id);this.errors.delete(id);
    const deadline=Date.now()+this.startupTimeoutMs;
    let executable,args,env,log,exitInfo,childExited;
      const live=await this.capabilities(id);if(live)return live;
      const manifest=JSON.parse(fs.readFileSync(path.join(c.root,'package.json'),'utf8'));
      if(manifest.name!==c.package)throw Error('工作区不是对应扩展');
      if(!fs.existsSync(path.join(c.dataDir,c.db))&&!(c.managed&&c.allowInitialize===true))throw Error('原账本不存在，已阻止创建空账本');
      if(!fs.existsSync(path.join(c.root,'node_modules','express')))throw Error(c.managed?'功能运行组件缺失，请重新安装完整工作台':'该扩展缺少依赖，请在对应工作区执行 npm.cmd ci');
      executable=c.nodePath||process.execPath;
      if(!executable)throw Error('MODULE_NOT_INSTALLED：请先安装此模块需要的共享运行环境');
      if(!fs.existsSync(executable))throw Error(c.managed?'共享运行组件缺失，请重新安装完整工作台':'缺少系统 Node.js 24，请先安装系统运行环境');
      args=[path.join(c.root,'server.mjs')];
    if(c.managed&&c.allowInitialize===true)fs.mkdirSync(c.dataDir,{recursive:true});
    const lock=path.join(c.dataDir,'.integration-start.lock');
    const fingerprint=createHash('sha256').update(JSON.stringify({id,root:path.resolve(c.root),executable:path.resolve(executable),version:c.version||'',port:c.port||null,mobilePort:id==='purchase'?c.mobilePort||Number(process.env.PURCHASE_MOBILE_PORT)||17869:null})).digest('hex');
    let record;
    const release=await startGuard(lock,deadline);
    try{
      const appeared=await this.capabilities(id);if(appeared)return appeared;
      record=readStartLock(lock);
      if(activeStart(record)){
        if(!record.legacy&&record.fingerprint!==fingerprint)throw startError('另一个版本或配置的扩展仍在启动，已阻止重复启动；请等待并核对扩展设置');
      }else{
        if(await portOpen(c.port))throw Error(`端口 ${c.port} 已被其他程序占用，已停止启动；请在设置中核对服务`);
        const mobilePort=c.mobilePort||Number(process.env.PURCHASE_MOBILE_PORT)||17869;
        if(id==='purchase'&&await portOpen(mobilePort))throw Error(`采购手机入口端口 ${mobilePort} 已被其他程序占用，已停止启动`);
        {
          log=fs.openSync(path.join(c.dataDir,'integration-service.log'),'a');
          env={...process.env,...this.environment,[c.env]:String(c.port),PURCHASE_DATA_DIR:id==='purchase'?c.dataDir:process.env.PURCHASE_DATA_DIR||'',SALES_DATA_DIR:id==='sales'?c.dataDir:process.env.SALES_DATA_DIR||'',OVERVIEW_DATA_DIR:id==='overview'?c.dataDir:process.env.OVERVIEW_DATA_DIR||'',LINGTU_REGISTRY_PATH:this.registryFile,...(this.policyFile?{LINGTU_WORKBENCH_POLICY_FILE:this.policyFile}:{})};
          env.LINGTU_MAINTENANCE=c.maintenance?'1':'0';
          if(id==='purchase')env.PURCHASE_MOBILE_PORT=String(mobilePort);
          delete env.ELECTRON_RUN_AS_NODE;
          if(id==='overview'){
            env.OVERVIEW_PURCHASE_DB=path.join(this.config('purchase').dataDir,'purchases.sqlite');
            env.OVERVIEW_SALES_DB=path.join(this.config('sales').dataDir,'sales.sqlite');
          }
        }
        record={schemaVersion:1,token:randomUUID(),ownerPid:process.pid,childPid:null,module:id,fingerprint,createdAt:new Date().toISOString()};
        writeStartLock(lock,record);
        try{
          if(this.agentManaged){env.LINGTU_AGENT_MANAGED='1';delete env.LINGTU_WORKBENCH_POLICY_FILE;}
          if(this.businessOnly)env.LINGTU_BUSINESS_ONLY='1';
          if(this.testLedger)env.LINGTU_TEST_LEDGER='1';
          env.LINGTU_MODULE_ROOT=c.root;
          const child=spawn(executable,args,{cwd:c.root,detached:true,windowsHide:true,shell:false,stdio:['ignore',log,log],env});
          const spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});spawned.catch(()=>{});
          childExited=new Promise(resolve=>child.once('exit',(code,signal)=>{exitInfo={code,signal};resolve();}));
          if(child.pid){record.childPid=child.pid;writeStartLock(lock,record);}
          await spawned;
          child.unref();
        }catch(e){if(!record.childPid||!processAlive(record.childPid))try{fs.unlinkSync(lock);}catch{}throw e;}
      }
    }finally{if(log!==undefined)fs.closeSync(log);await release();}
    while(Date.now()<deadline){
      const cap=await this.capabilities(id);if(cap){
        if(c.managed&&c.allowInitialize===true){
          const registry=JSON.parse(fs.readFileSync(this.registryFile,'utf8'));
          if(registry[id]?.root!==c.root)throw Error('启动期间模块配置发生变化');
          registry[id].allowInitialize=false;
          const temp=this.registryFile+'.'+process.pid+'.tmp';
          fs.writeFileSync(temp,JSON.stringify(registry,null,2));fs.renameSync(temp,this.registryFile);
        }
        return cap;
      }
      if(exitInfo||!activeStart(record)){
        if(!exitInfo&&childExited)await Promise.race([childExited,wait(100)]);
        throw startError('扩展启动进程已退出'+(exitInfo?'（退出码 '+(exitInfo.code??exitInfo.signal)+'）':'')+'，请查看运行日志后重试');
      }
      await wait(Math.min(this.startupPollMs,Math.max(1,deadline-Date.now())));
    }
    // Retain the child PID even if this caller stops waiting or exits. Other
    // launchers must reuse that live child instead of spawning a second one.
    throw startError('服务启动仍未就绪，已保留现有启动进程；请查看运行日志后重试','SERVICE_START_TIMEOUT');
  }
  async request(id,route,{method='GET',body}={}){
    if(!/^\/[a-z0-9/_-]+(?:\?[a-zA-Z0-9%=&._-]*)?$/.test(route)||route.includes('..'))throw Error('接口路径无效');
    const c=this.config(id);let cap=await this.ensure(id);
    const key=fs.readFileSync(path.join(c.dataDir,c.keyFile||'.integration-key'),'utf8').trim();
    const response=await fetch(`${cap.url}/api/integration/v1${route}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000),redirect:'error'});
    const result=await response.json();if(!response.ok)throw Error(result.error||'扩展请求失败');return result;
  }
  async stop(id){
    const cap=await this.capabilities(id);if(!cap)return {ok:true,alreadyStopped:true};
    if(cap.busy)throw Error('扩展正在执行任务，请等待完成');
    return this.request(id,'/stop',{method:'POST',body:{confirm:true}});
  }
}