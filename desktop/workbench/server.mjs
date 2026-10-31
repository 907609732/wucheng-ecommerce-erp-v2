import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ServiceManager} from '../shared/service-manager.mjs';
import {createWorkbenchGateway} from './gateway.mjs';
import {agentBetaPaths,assertAgentRegistry,guardAgentServices} from '../agent-host/isolation.mjs';
import {createAgentBridgeClient} from '../agent-host/bridge.mjs';

export const defaultWorkbenchStore=()=>path.join(agentBetaPaths().profile,'workbench-server');
export async function runWorkbenchServer({storeDir=defaultWorkbenchStore(),publicOrigin,registryFile,port,registerRoutes,agentRuntime,agentPaths=agentBetaPaths(),...options}={}){
  if(path.resolve(storeDir)!==path.join(agentPaths.profile,'workbench-server')||registryFile&&path.resolve(registryFile)!==path.resolve(agentPaths.registryFile))throw Error('测试版网关必须使用独立配置与账本注册表');
  assertAgentRegistry(agentPaths);
  const configFile=path.join(storeDir,'server-config.json');
  let config={};if(fs.existsSync(configFile))config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  const selectedPort=port??config.port??agentPaths.gatewayPort;if(selectedPort!==agentPaths.gatewayPort)throw Error('测试版网关端口必须为 '+agentPaths.gatewayPort);
  const services=guardAgentServices(new ServiceManager({registryFile:agentPaths.registryFile}),agentPaths);
  const gateway=await createWorkbenchGateway({services,storeDir,publicOrigin:publicOrigin||config.publicOrigin,port:selectedPort,registerRoutes,agentRuntime:agentRuntime||createAgentBridgeClient({storeDir:path.join(agentPaths.profile,'agent-host')}),...options});
  await gateway.start();return gateway;
}
function argumentsOf(argv){const result={};for(let i=0;i<argv.length;i++){const key=argv[i];if(!key.startsWith('--')||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('参数必须使用 --名称 值');result[key.slice(2)]=argv[++i];}return result;}
export function configureWorkbench({storeDir=defaultWorkbenchStore(),publicOrigin,policyFile,registryFile,port=27330}={}){
  const origin=new URL(publicOrigin);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw Error('必须填写 Tailscale HTTPS 源地址');
  if(!Number.isInteger(Number(port))||Number(port)<1024||Number(port)>65535)throw Error('端口无效');
  fs.mkdirSync(storeDir,{recursive:true});
  if(policyFile)throw Object.assign(Error('权限管理配置已移除，所有已登录成员统一使用全部业务功能'),{code:'FEATURE_REMOVED',statusCode:410});
  const config={schemaVersion:1,publicOrigin:origin.origin,host:'127.0.0.1',port:Number(port),...(registryFile?{registryFile:path.resolve(registryFile)}:{})};
  const file=path.join(storeDir,'server-config.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(config,null,2),{mode:0o600});fs.renameSync(tmp,file);return config;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=argumentsOf(process.argv.slice(2)),storeDir=args['store-dir']?path.resolve(args['store-dir']):defaultWorkbenchStore();
    if(args.configure==='true'){configureWorkbench({storeDir,publicOrigin:args.origin,policyFile:args.policy,registryFile:args.registry,port:Number(args.port||27330)});process.stdout.write('工作台本机配置已保存；所有已登录成员统一使用全部业务功能，Tailscale 登录与网络配置保持独立。\n');}
    else{
      let config={};const file=path.join(storeDir,'server-config.json');if(fs.existsSync(file))config=JSON.parse(fs.readFileSync(file,'utf8'));
      const gateway=await runWorkbenchServer({storeDir,publicOrigin:args.origin||config.publicOrigin,registryFile:args.registry||config.registryFile,port:Number(args.port||config.port||27330)});
      process.stdout.write(JSON.stringify({ok:true,service:'wucheng-workbench',host:'127.0.0.1',port:Number(args.port||config.port||27330),serverId:gateway.serverId,dataSetId:gateway.dataSetId})+'\n');
      for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>gateway.stop().then(()=>process.exit(0)));
    }
  }catch(error){process.stderr.write('工作台启动失败：'+error.message+'\n');process.exitCode=1;}
}
