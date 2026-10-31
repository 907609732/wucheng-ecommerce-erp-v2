import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {getWorkbenchLocation} from './workbench-location.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const portOpen=port=>new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});const done=value=>{socket.destroy();resolve(value);};socket.setTimeout(1000,()=>done(true));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const startError=(message,code='SERVICE_START_FAILED')=>Object.assign(Error(message),{code});
function sharedNative(id,config,trustedExecutable,trustedVersion){
 if(config.sharedElectron!==true)return false;
 if(!['warehouse','exporter'].includes(id)||config.managed!==true||trustedVersion!=='44.7.0'||typeof trustedExecutable!=='string'||!path.isAbsolute(trustedExecutable)||config.exe!==trustedExecutable)throw startError('共享 Electron 未绑定可信打包宿主','SHARED_ELECTRON_NOT_BOUND');
 return true;
}
function nativeRuntimeIdentity(id,config,record){
 if(record?.id!==config.id||record.apiVersion!==1||record.version!==config.version||typeof record.root!=='string'||path.resolve(record.root).toLowerCase()!==path.resolve(config.root,'resources','app.asar').toLowerCase()||typeof record.dataDir!=='string'||path.resolve(record.dataDir).toLowerCase()!==path.resolve(config.dataDir).toLowerCase()||!Number.isSafeInteger(record.pid)||record.pid<=0)throw startError('共享组件进程身份、版本或数据目录不符','SHARED_COMPONENT_IDENTITY_MISMATCH');
 return record.pid;
}
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
const defaults=()=>{
  const docs=path.join(os.homedir(),'Documents','ChatGPT'),purchase=path.join(docs,'采购');
  return {
    warehouse:{id:'lingtu-warehouse',package:'wucheng-ecommerce-erp-v2',root:path.join(process.env.LOCALAPPDATA||'', 'Programs','wucheng-ecommerce-erp-v2'),dataDir:path.join(process.env.APPDATA||os.homedir(),'wucheng-ecommerce-erp-v2'),db:'workspace/data/erp.sqlite',exe:path.join(process.env.LOCALAPPDATA||'', 'Programs','wucheng-ecommerce-erp-v2','云仓库存同步.exe'),runtimeFile:'.integration-runtime-cloud.json'},
    purchase:{id:'purchase-desk',package:'purchase-desk',root:purchase,dataDir:path.join(purchase,'data'),port:17868,db:'purchases.sqlite',env:'PORT'},
    sales:{id:'wucheng-sales-desk',package:'wucheng-sales-desk',root:path.join(docs,'销售台'),dataDir:path.join(docs,'销售台','data'),port:17870,db:'sales.sqlite',env:'SALES_PORT'},
    overview:{id:'lingtu-business-overview',package:'lingtu-business-overview',root:path.join(purchase,'采购台和销售额台聚合'),dataDir:path.join(purchase,'采购台和销售额台聚合','data'),port:17890,db:'overview.sqlite',env:'OVERVIEW_PORT'},
    exporter:{id:'lingtu-order-export',root:path.join(docs,'复刻买家历史订单导出软件'),dataDir:path.join(process.env.APPDATA||os.homedir(),'买家订单导出台'),exe:path.join(process.env.LOCALAPPDATA||'', 'Programs','lingtu-order-export','灵兔 AI 电商平台买家订单导出工具.exe')}
  };
};
export class ServiceManager{
  constructor({registryFile,policyFile=process.env.LINGTU_WORKBENCH_POLICY_FILE,startupTimeoutMs=90000,startupPollMs=250,agentManaged=false,sharedElectronExecutable,sharedElectronVersion}={}){
    if(!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<50||startupTimeoutMs>300000||!Number.isInteger(startupPollMs)||startupPollMs<10||startupPollMs>1000)throw Error('扩展启动等待配置无效');
    this.startupTimeoutMs=startupTimeoutMs;this.startupPollMs=startupPollMs;this.agentManaged=agentManaged===true;
    this.sharedElectronExecutable=sharedElectronExecutable;
    this.sharedElectronVersion=sharedElectronVersion;
    const explicitRegistry=registryFile||process.env.LINGTU_REGISTRY_PATH,location=explicitRegistry?null:getWorkbenchLocation();
    this.registryFile=explicitRegistry||location.registryFile;this.pending=new Map();this.errors=new Map();
    this.policyFile=policyFile||(!explicitRegistry?path.join(location.profile,'workbench-server','access-policy.json'):undefined);
  }
  config(id){
    const base=defaults();let custom={};if(fs.existsSync(this.registryFile))custom=JSON.parse(fs.readFileSync(this.registryFile,'utf8'));
    if(!base[id])throw Error('未登记的扩展');
    const c={...base[id],...custom[id]};
    if(c.sharedElectron!==undefined&&typeof c.sharedElectron!=='boolean')throw startError('共享 Electron 标记无效','SHARED_ELECTRON_NOT_BOUND');
    sharedNative(id,c,this.sharedElectronExecutable,this.sharedElectronVersion);
    if(id==='sales'){try{const p=Number(fs.readFileSync(path.join(c.dataDir,'server.port'),'utf8'));if(p>=17869&&p<=17889)c.port=p;}catch{}}
    if(!Number.isInteger(c.port)&&!['exporter','warehouse'].includes(id))throw Error('扩展端口配置无效');return c;
  }
  componentArgs(id){const c=this.config(id);return sharedNative(id,c,this.sharedElectronExecutable,this.sharedElectronVersion)?['--agent-component='+id]:[];}
  async capabilities(id){
    const c=this.config(id);if(['exporter','warehouse'].includes(id)){
      const shared=sharedNative(id,c,this.sharedElectronExecutable,this.sharedElectronVersion),installed={id:c.id,installed:fs.existsSync(c.exe)&&(!shared||fs.existsSync(path.join(c.root,'resources','app.asar'))),root:c.root,dataDir:c.dataDir,exe:c.exe,...(shared?{sharedElectron:true,component:id}:{})};
      let runtime;try{runtime=JSON.parse(fs.readFileSync(path.join(c.dataDir,c.runtimeFile||'.integration-runtime.json'),'utf8'));}catch(error){if(shared&&error.code!=='ENOENT')throw startError('共享组件运行记录损坏','SHARED_COMPONENT_IDENTITY_MISMATCH');return installed;}
      if(shared)installed.pid=nativeRuntimeIdentity(id,c,runtime);
      if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url||''))throw Error('导出台本机接口地址无效');
      let cap;try{const response=await fetch(runtime.url+'/api/integration/v1/capabilities',{signal:AbortSignal.timeout(1500),redirect:'error'});cap=await response.json();}catch{return installed;}
      if(cap.id!==c.id||cap.apiVersion!==1||path.resolve(cap.dataDir).toLowerCase()!==path.resolve(c.dataDir).toLowerCase())throw Error('扩展服务身份或数据目录不符');
      if(c.managed&&path.resolve(cap.root).toLowerCase()!==path.resolve(c.root,'resources','app.asar').toLowerCase())throw Error('扩展进程来自其他安装目录');
      const version=c.managed?c.version:JSON.parse(fs.readFileSync(path.join(c.root,'package.json'),'utf8')).version;
      if(cap.version!==version)throw Error('导出台运行版本与工作区不符，请退出后安装本次更新包');
      if(shared&&nativeRuntimeIdentity(id,c,cap)!==runtime.pid)throw startError('共享组件运行记录与接口 PID 不符','SHARED_COMPONENT_IDENTITY_MISMATCH');
      return {...installed,...cap,running:true};
    }
    let response;try{response=await fetch(`http://127.0.0.1:${c.port}/api/integration/v1/capabilities`,{signal:AbortSignal.timeout(1500),redirect:'error'});}catch{return null;}
    if(!response.ok)throw Error('该端口已有旧版或其他服务，请先在设置中核对并重启对应服务');
    const cap=await response.json();
    if(cap.id!==c.id||cap.apiVersion!==1||path.resolve(cap.dataDir).toLowerCase()!==path.resolve(c.dataDir).toLowerCase()||path.resolve(cap.root).toLowerCase()!==path.resolve(c.root).toLowerCase())throw Error('服务身份或数据目录不符，已阻止连接');
    const version=c.managed?c.version:JSON.parse(fs.readFileSync(path.join(c.root,'package.json'),'utf8')).version;
    if(cap.version!==version)throw Error(`后台版本 ${cap.version} 与当前源码 ${version} 不符，请停止该服务后重新打开`);
    return cap;
  }
  async status({includeWarehouse=false}={}){
    return Promise.all([...(includeWarehouse?['warehouse']:[]),'purchase','sales','overview','exporter'].map(async id=>{
      const c=this.config(id);try{const info=await this.capabilities(id);return {extension:id,...c,status:['exporter','warehouse'].includes(id)?(info.running?'running':info.installed?'installed':'missing'):info?'running':'stopped',version:info?.version||c.version,busy:info?.busy||false,error:this.errors.get(id)||''};}
      catch(e){return {extension:id,...c,status:'error',error:e.message};}
    }));
  }
  async ensure(id){
    if(this.pending.has(id))return this.pending.get(id);
    const promise=this.start(id).catch(e=>{this.errors.set(id,e.message);throw e;}).finally(()=>this.pending.delete(id));
    this.pending.set(id,promise);return promise;
  }
  async start(id){
    const c=this.config(id);this.errors.delete(id);
    const native=['exporter','warehouse'].includes(id),deadline=Date.now()+this.startupTimeoutMs;
    let executable,args,env,log,exitInfo,childExited;
    if(native){
      if(!fs.existsSync(c.exe))throw Error('功能程序文件缺失，请重新安装完整工作台');
      const live=await this.capabilities(id);if(live?.running)return live;
      const nativeLedger=path.join(c.dataDir,id==='warehouse'?'workspace/data/erp.sqlite':'orders.sqlite');
      if(c.managed&&c.allowInitialize!==true&&!fs.existsSync(nativeLedger))throw startError('原账本不存在，已阻止创建空账本','MISSING_LEDGER');
      env={...process.env,LINGTU_REGISTRY_PATH:this.registryFile,LINGTU_MAINTENANCE:c.maintenance?'1':'0',LINGTU_MANAGED_MODULE:c.managed?'1':'0'};
      env.LINGTU_ALLOW_INITIALIZE=c.allowInitialize===true?'1':'0';
      if(c.authProfileDir)env.LINGTU_AUTH_PROFILE_DIR=c.authProfileDir;
      if(id==='exporter'&&c.managed)env.LINGTU_EXPORTER_DATA_DIR=c.dataDir;
      if(id==='warehouse'&&c.browserPath)env.LINGTU_BROWSER_PATH=c.browserPath;
      delete env.ELECTRON_RUN_AS_NODE;
      const shared=sharedNative(id,c,this.sharedElectronExecutable,this.sharedElectronVersion);
      executable=c.exe;args=shared?['--agent-component='+id,...(id==='warehouse'&&c.maintenance?['--hidden']:[])]:id==='warehouse'?[`--user-data-dir=${c.dataDir}`,...(c.maintenance?['--hidden']:[])]:[];
    }else{
      const live=await this.capabilities(id);if(live)return live;
      const manifest=JSON.parse(fs.readFileSync(path.join(c.root,'package.json'),'utf8'));
      if(manifest.name!==c.package)throw Error('工作区不是对应扩展');
      if(!fs.existsSync(path.join(c.dataDir,c.db))&&!(c.managed&&c.allowInitialize===true))throw Error('原账本不存在，已阻止创建空账本');
      if(!fs.existsSync(path.join(c.root,'node_modules','express')))throw Error(c.managed?'功能运行组件缺失，请重新安装完整工作台':'该扩展缺少依赖，请在对应工作区执行 npm.cmd ci');
      executable=c.managed?c.nodePath:process.env.LINGTU_NODE_PATH||path.join(process.env.ProgramFiles||'C:\\Program Files','nodejs','node.exe');
      if(!executable)throw Error('MODULE_NOT_INSTALLED：请先安装此模块需要的共享运行环境');
      if(!fs.existsSync(executable))throw Error(c.managed?'共享运行组件缺失，请重新安装完整工作台':'缺少系统 Node.js 24，请先安装系统运行环境');
      args=[path.join(c.root,'server.mjs')];
    }
    if(native||c.managed&&c.allowInitialize===true)fs.mkdirSync(c.dataDir,{recursive:true});
    const lock=path.join(c.dataDir,'.integration-start.lock');
    const fingerprint=createHash('sha256').update(JSON.stringify({id,root:path.resolve(c.root),executable:path.resolve(executable),version:c.version||'',port:c.port||null,mobilePort:id==='purchase'?c.mobilePort||Number(process.env.PURCHASE_MOBILE_PORT)||17869:null})).digest('hex');
    let record;
    const release=await startGuard(lock,deadline);
    try{
      const appeared=await this.capabilities(id);if(native?appeared?.running:appeared)return appeared;
      record=readStartLock(lock);
      if(activeStart(record)){
        if(!record.legacy&&record.fingerprint!==fingerprint)throw startError('另一个版本或配置的扩展仍在启动，已阻止重复启动；请等待并核对扩展设置');
      }else{
        if(!native&&await portOpen(c.port))throw Error(`端口 ${c.port} 已被其他程序占用，已停止启动；请在设置中核对服务`);
        const mobilePort=c.mobilePort||Number(process.env.PURCHASE_MOBILE_PORT)||17869;
        if(id==='purchase'&&await portOpen(mobilePort))throw Error(`采购手机入口端口 ${mobilePort} 已被其他程序占用，已停止启动`);
        if(!native){
          log=fs.openSync(path.join(c.dataDir,'integration-service.log'),'a');
          env={...process.env,[c.env]:String(c.port),PURCHASE_DATA_DIR:id==='purchase'?c.dataDir:process.env.PURCHASE_DATA_DIR||'',SALES_DATA_DIR:id==='sales'?c.dataDir:process.env.SALES_DATA_DIR||'',OVERVIEW_DATA_DIR:id==='overview'?c.dataDir:process.env.OVERVIEW_DATA_DIR||'',LINGTU_REGISTRY_PATH:this.registryFile,...(this.policyFile?{LINGTU_WORKBENCH_POLICY_FILE:this.policyFile}:{})};
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
          const child=spawn(executable,args,{...(!native?{cwd:c.root}:{}),detached:true,windowsHide:true,shell:false,stdio:native?'ignore':['ignore',log,log],env});
          const spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});spawned.catch(()=>{});
          childExited=new Promise(resolve=>child.once('exit',(code,signal)=>{exitInfo={code,signal};resolve();}));
          if(child.pid){record.childPid=child.pid;writeStartLock(lock,record);}
          await spawned;
          child.unref();
        }catch(e){if(!record.childPid||!processAlive(record.childPid))try{fs.unlinkSync(lock);}catch{}throw e;}
      }
    }finally{if(log!==undefined)fs.closeSync(log);await release();}
    if(native&&!c.managed)return {id:c.id,opened:true};
    while(Date.now()<deadline){
      const cap=await this.capabilities(id);if(native?cap?.running:cap){
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
    if(['exporter','warehouse'].includes(id)){for(let i=0;i<80;i++){cap=await this.capabilities(id);if(cap.url)break;await wait(250);}if(!cap.url)throw Error('扩展接口未就绪，请确认已安装本次更新');}
    const key=fs.readFileSync(path.join(c.dataDir,c.keyFile||'.integration-key'),'utf8').trim();
    const response=await fetch(`${cap.url}/api/integration/v1${route}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000),redirect:'error'});
    const result=await response.json();if(!response.ok)throw Error(result.error||'扩展请求失败');return result;
  }
  async stop(id){
    if(id==='exporter'&&!this.config(id).managed)throw Error('请在订单导出台窗口结束采集后退出');
    const cap=await this.capabilities(id);if(!cap||(['exporter','warehouse'].includes(id)&&!cap.running))return {ok:true,alreadyStopped:true};
    if(cap.busy)throw Error('扩展正在执行任务，请等待完成');
    return this.request(id,'/stop',{method:'POST',body:{confirm:true}});
  }
}
