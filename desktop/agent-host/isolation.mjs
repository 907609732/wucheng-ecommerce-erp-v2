import fs from 'node:fs';
import path from 'node:path';
import {WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {atomicJson,hostError,inside} from './common.mjs';
import {withBetaServiceStartFence} from './data-maintenance.mjs';

function noLinks(target){let current=path.parse(target).root;for(const part of target.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw hostError('BETA_PATH_REDIRECTED','测试目录不能使用链接或目录重定向',409);}}
export function agentBetaPaths({localAppData=process.env.LOCALAPPDATA,root=process.env.LINGTU_AGENT_BETA_ROOT}={}){
  if(!localAppData||!path.isAbsolute(localAppData))throw hostError('BETA_LOCATION_REQUIRED','缺少独立测试版数据目录',503);
  root=root?path.resolve(root):path.join(localAppData,'WuchengAgentBeta');
  if(!/^WuchengAgentBeta(?:-[a-z0-9_-]+)?$/i.test(path.basename(root)))throw hostError('BETA_LOCATION_INVALID','测试版必须使用独立 WuchengAgentBeta 目录',409);
  noLinks(root);return {root,profile:path.join(root,'profile'),data:path.join(root,'data'),registryFile:path.join(root,'registry.json'),programs:path.join(root,'programs'),gatewayPort:27330,appId:'com.wucheng.ecommerce.erp.v2.agentbeta',environment:{mode:'test',label:'测试账本'}};
}
export function assertBetaServerAddress(value){
  let url;try{url=new URL(value);}catch{throw hostError('BETA_SERVER_INVALID','请填写测试版私网 HTTPS 地址');}
  if(url.protocol!=='https:'||!url.hostname.endsWith('.ts.net')||url.port!=='9443'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw hostError('BETA_SERVER_INVALID','测试版只连接独立私网入口 9443，不能连接正式服务',403);
  return url.origin;
}
export function assertAgentRegistry(paths,{allowMissing=false}={}){
  noLinks(paths.root);let registry;
  try{registry=JSON.parse(fs.readFileSync(paths.registryFile,'utf8'));}catch(error){if(allowMissing&&error.code==='ENOENT')return null;throw hostError('TEST_LEDGER_NOT_READY','测试账本尚未准备，请完成副本迁移',409);}
  const ports=new Set();for(const id of WORKBENCH_MODULES){const c=registry[id],root=path.join(paths.programs,id);
    if(!c||c.managed!==true||c.allowInitialize!==false||c.dataDir!==path.join(paths.data,id)||c.authProfileDir)throw hostError('BETA_REGISTRY_UNSAFE','测试版模块数据配置不完整或越界',409);
    for(const item of [c.root,c.exe].filter(Boolean)){if(!path.isAbsolute(item)||item!==root&&!inside(root,item))throw hostError('BETA_REGISTRY_UNSAFE','测试版程序不能指向正式安装目录',409);noLinks(item);}
    if(!c.root&&!c.exe)throw hostError('BETA_REGISTRY_UNSAFE','测试版模块程序目录未登记',409);
    if(c.nodePath&&(!path.isAbsolute(c.nodePath)||!inside(path.join(paths.programs,'node-runtime'),c.nodePath)))throw hostError('BETA_REGISTRY_UNSAFE','共享运行环境不属于测试版',409);
    if(['purchase','sales','overview'].includes(id)&&(!Number.isInteger(c.port)||c.port<27331||c.port>27379))throw hostError('BETA_PORT_INVALID','测试版端口不在独立范围',409);
    if(id==='purchase'&&c.mobilePort!==27380)throw hostError('BETA_PORT_INVALID','测试版采购移动端必须使用独立端口 27380',409);
    if(Number.isInteger(c.port)){if(ports.has(c.port)||c.port===paths.gatewayPort)throw hostError('BETA_PORT_INVALID','测试版端口重复',409);ports.add(c.port);}
    noLinks(c.dataDir);
  }return registry;
}
export function prepareAgentProfile(paths){
  fs.mkdirSync(paths.profile,{recursive:true,mode:0o700});
  if(!fs.existsSync(paths.registryFile)){
    const registry=Object.fromEntries(WORKBENCH_MODULES.map((id,index)=>[id,{root:path.join(paths.programs,id),dataDir:path.join(paths.data,id),managed:true,allowInitialize:false,port:27331+index,...(id==='purchase'?{mobilePort:27380}:{}),...(['warehouse','exporter'].includes(id)?{exe:path.join(paths.programs,id,'module.exe')}:{}),nodePath:path.join(paths.programs,'node-runtime','node.exe')}]));
    atomicJson(paths.registryFile,registry);
  }
  assertAgentRegistry(paths);return {profile:paths.profile,registryFile:paths.registryFile,source:'agent-beta'};
}
export function guardAgentServices(services,paths){
  services.agentManaged=true;
  const config=services.config.bind(services),ensure=services.ensure.bind(services),start=services.start.bind(services);
  if(path.resolve(services.registryFile)!==path.resolve(paths.registryFile))throw hostError('BETA_REGISTRY_UNSAFE','运行服务没有绑定独立测试注册表',409);
  services.config=id=>{assertAgentRegistry(paths);return config(id);};
  const verify=id=>{const c=services.config(id),database=path.join(c.dataDir,id==='warehouse'?'workspace/data/erp.sqlite':id==='exporter'?'orders.sqlite':c.db);
    if(!fs.existsSync(database))throw hostError('TEST_LEDGER_NOT_READY','测试账本尚未准备，请先完成副本迁移',409);
    noLinks(database);
  };
  // Keep the fence until asynchronous startup has actually finished. Queue local
  // starts so two modules do not mistake each other's startup for maintenance.
  let startTail=Promise.resolve();
  services.ensure=id=>{verify(id);return ensure(id);};
  services.start=id=>{const pending=startTail.then(()=>withBetaServiceStartFence(paths,async()=>{verify(id);return start(id);}));startTail=pending.catch(()=>{});return pending;};
  return services;
}
