import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import net from 'node:net';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const portOpen=port=>new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});const done=value=>{socket.destroy();resolve(value);};socket.setTimeout(1000,()=>done(true));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
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
  constructor({registryFile=process.env.LINGTU_REGISTRY_PATH||path.join(process.env.APPDATA||os.homedir(),'LingtuIntegrations','registry.json')}={}){
    this.registryFile=registryFile;this.pending=new Map();this.errors=new Map();
  }
  config(id){
    const base=defaults();let custom={};if(fs.existsSync(this.registryFile))custom=JSON.parse(fs.readFileSync(this.registryFile,'utf8'));
    if(!base[id])throw Error('未登记的扩展');
    const c={...base[id],...custom[id]};
    if(id==='sales'){try{const p=Number(fs.readFileSync(path.join(c.dataDir,'server.port'),'utf8'));if(p>=17869&&p<=17889)c.port=p;}catch{}}
    if(!Number.isInteger(c.port)&&!['exporter','warehouse'].includes(id))throw Error('扩展端口配置无效');return c;
  }
  async capabilities(id){
    const c=this.config(id);if(['exporter','warehouse'].includes(id)){
      const installed={id:c.id,installed:fs.existsSync(c.exe),root:c.root,dataDir:c.dataDir,exe:c.exe};
      let runtime;try{runtime=JSON.parse(fs.readFileSync(path.join(c.dataDir,c.runtimeFile||'.integration-runtime.json'),'utf8'));}catch{return installed;}
      if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url||''))throw Error('导出台本机接口地址无效');
      let cap;try{const response=await fetch(runtime.url+'/api/integration/v1/capabilities',{signal:AbortSignal.timeout(1500),redirect:'error'});cap=await response.json();}catch{return installed;}
      if(cap.id!==c.id||cap.apiVersion!==1||path.resolve(cap.dataDir).toLowerCase()!==path.resolve(c.dataDir).toLowerCase())throw Error('扩展服务身份或数据目录不符');
      if(c.managed&&path.resolve(cap.root).toLowerCase()!==path.resolve(c.root,'resources','app.asar').toLowerCase())throw Error('扩展进程来自其他安装目录');
      const version=c.managed?c.version:JSON.parse(fs.readFileSync(path.join(c.root,'package.json'),'utf8')).version;
      if(cap.version!==version)throw Error('导出台运行版本与工作区不符，请退出后安装本次更新包');
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
    if(['exporter','warehouse'].includes(id)){
      if(!fs.existsSync(c.exe))throw Error('未找到订单导出台安装版，请安装本次提供的更新包');
      const live=await this.capabilities(id);if(live?.running)return live;
      const env={...process.env,LINGTU_REGISTRY_PATH:this.registryFile,LINGTU_MAINTENANCE:c.maintenance?'1':'0',LINGTU_MANAGED_MODULE:c.managed?'1':'0'};
      if(id==='exporter'&&c.managed)env.LINGTU_EXPORTER_DATA_DIR=c.dataDir;
      if(id==='warehouse'&&c.browserPath)env.LINGTU_BROWSER_PATH=c.browserPath;
      delete env.ELECTRON_RUN_AS_NODE;
      const args=id==='warehouse'?[`--user-data-dir=${c.dataDir}`,...(c.maintenance?['--hidden']:[])]:[];
      const child=spawn(c.exe,args,{detached:true,stdio:'ignore',windowsHide:true,shell:false,env});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
      if(!c.managed)return {id:c.id,opened:true};
      for(let i=0;i<100;i++){await wait(200);const cap=await this.capabilities(id);if(cap?.running)return cap;}
      throw Error('扩展进程启动超时，请检查安装包与数据目录');
    }
    const live=await this.capabilities(id);if(live)return live;
    const manifest=JSON.parse(fs.readFileSync(path.join(c.root,'package.json'),'utf8'));
    if(manifest.name!==c.package)throw Error('工作区不是对应扩展');
    if(!fs.existsSync(path.join(c.dataDir,c.db))&&!(c.managed&&c.allowInitialize===true))throw Error('原账本不存在，已阻止创建空账本');
    if(!fs.existsSync(path.join(c.root,'node_modules','express')))throw Error('该扩展缺少依赖，请在对应工作区执行 npm.cmd ci');
    const node=c.managed?c.nodePath:process.env.LINGTU_NODE_PATH||path.join(process.env.ProgramFiles||'C:\\Program Files','nodejs','node.exe');
    if(!node)throw Error('MODULE_NOT_INSTALLED：请先安装此模块需要的共享运行环境');
    if(!fs.existsSync(node))throw Error('缺少系统 Node.js 24，请先安装系统运行环境');
    if(c.managed&&c.allowInitialize===true)fs.mkdirSync(c.dataDir,{recursive:true});
    const lock=path.join(c.dataDir,'.integration-start.lock');
    let owned=false;
    try{
      try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true;}
      catch{
        let alive=true;try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);}catch{alive=false;}
        if(!alive){fs.unlinkSync(lock);fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true;}
      }
      if(owned){
        const appeared=await this.capabilities(id);if(appeared)return appeared;
        if(await portOpen(c.port))throw Error(`端口 ${c.port} 已被其他程序占用，已停止启动；请在设置中核对服务`);
        const mobilePort=c.mobilePort||Number(process.env.PURCHASE_MOBILE_PORT)||17869;
        if(id==='purchase'&&await portOpen(mobilePort))throw Error(`采购手机入口端口 ${mobilePort} 已被其他程序占用，已停止启动`);
        const log=fs.openSync(path.join(c.dataDir,'integration-service.log'),'a');
        const env={...process.env,[c.env]:String(c.port),PURCHASE_DATA_DIR:id==='purchase'?c.dataDir:process.env.PURCHASE_DATA_DIR||'',SALES_DATA_DIR:id==='sales'?c.dataDir:process.env.SALES_DATA_DIR||'',OVERVIEW_DATA_DIR:id==='overview'?c.dataDir:process.env.OVERVIEW_DATA_DIR||'',LINGTU_REGISTRY_PATH:this.registryFile};
        env.LINGTU_MAINTENANCE=c.maintenance?'1':'0';
        if(id==='purchase')env.PURCHASE_MOBILE_PORT=String(mobilePort);
        delete env.ELECTRON_RUN_AS_NODE;
        if(id==='overview'){
          env.OVERVIEW_PURCHASE_DB=path.join(this.config('purchase').dataDir,'purchases.sqlite');
          env.OVERVIEW_SALES_DB=path.join(this.config('sales').dataDir,'sales.sqlite');
        }
        const child=spawn(node,[path.join(c.root,'server.mjs')],{cwd:c.root,detached:true,windowsHide:true,shell:false,stdio:['ignore',log,log],env});
        try{await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}finally{fs.closeSync(log);}
      }
      for(let i=0;i<80;i++){await wait(250);const cap=await this.capabilities(id);if(cap){
        if(c.managed&&c.allowInitialize===true){
          const registry=JSON.parse(fs.readFileSync(this.registryFile,'utf8'));
          if(registry[id]?.root!==c.root)throw Error('启动期间模块配置发生变化');
          registry[id].allowInitialize=false;
          const temp=this.registryFile+'.'+process.pid+'.tmp';
          fs.writeFileSync(temp,JSON.stringify(registry,null,2));fs.renameSync(temp,this.registryFile);
        }
        return cap;
      }}
      throw Error('服务启动超时，请查看扩展设置中的运行日志');
    }finally{if(owned)try{fs.unlinkSync(lock);}catch{}}
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
