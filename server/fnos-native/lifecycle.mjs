import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {loadConfig} from '../config.mjs';
import {configureNative,sealStoppedSource,backupNative,physicalPath,withNativeLifecycleLock} from './configure.mjs';
import {nativeRequest,sleep,deadline} from './supervisor.mjs';

function readRecord(c){try{return JSON.parse(fs.readFileSync(path.join(c.stateDir,'native-supervisor.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function commandIdentity(record,file){
 if(!record||!Number.isSafeInteger(record.pid)||record.pid<1||record.configFile!==file||typeof record.token!=='string'||typeof record.generation!=='string')throw Error('原生进程身份 identity 无效');
 if(process.platform==='linux'){
  let argv;try{argv=fs.readFileSync('/proc/'+record.pid+'/cmdline','utf8').split('\0');}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(path.resolve(argv[1]||'')!==path.join(loadConfig(file).releaseRoot,'server','fnos-native','supervisor.mjs')||argv[2]!=='--config'||argv[3]!==file)throw Error('原生进程真实命令身份不符');
  const config=loadConfig(file);
  if(fs.realpathSync('/proc/'+record.pid+'/exe')!==fs.realpathSync(config.native?.nodePath||process.execPath)||fs.statSync('/proc/'+record.pid).uid!==process.getuid())throw Error('原生进程可执行文件或用户身份不符');
 }
 return true;
}
async function status(c,file){
 const r=readRecord(c);if(!r)return {ok:false,status:'stopped'};
 try{
  if(!commandIdentity(r,file))return {ok:false,status:'stopped'};
  const result=await nativeRequest(c,r),identity=JSON.parse(fs.readFileSync(path.join(c.stateDir,'gateway','identity.json'),'utf8'));
  if(result.serverId!==identity.serverId||result.dataSetId!==identity.dataSetId)throw Error('原生 ERP 账本身份与运行实例不符');
  if(c.fnos.enabled&&result.fnos?.state!=='ready')throw Error('飞牛 Unix 入口未就绪');
  return result;
 }catch(error){return {ok:false,status:'unavailable',error:error.message};}
}
export async function nativeLifecycle(action,configFile,{startupTimeoutMs=90000,cancellationTimeoutMs=85000}={}){
 if(!['start','stop','status'].includes(action))throw Error('未知原生生命周期操作');
 if(!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<1||startupTimeoutMs>300000||!Number.isInteger(cancellationTimeoutMs)||cancellationTimeoutMs<1||cancellationTimeoutMs>100000)throw Error('生命周期等待时间必须有界');
 configFile=physicalPath(configFile);let c=loadConfig(configFile);
 if(action==='status')return status(c,configFile);
 fs.mkdirSync(c.stateDir,{recursive:true,mode:0o700});
 const stateDir=c.stateDir;
 return withNativeLifecycleLock(stateDir,async()=>{
  c=loadConfig(configFile);if(c.stateDir!==stateDir)throw Error('生命周期锁目录不能在操作期间改变');
  const current=await status(c,configFile);
  if(action==='stop'){
   const record=readRecord(c);if(!record)return {ok:true,status:'stopped'};
   if(!commandIdentity(record,configFile))return {ok:true,status:'stopped'};
   await nativeRequest(c,record,'stop',75000);
   const end=Date.now()+10000;
   while(fs.existsSync(path.join(c.stateDir,'native-supervisor.json'))&&Date.now()<end)await sleep(100);
   if(fs.existsSync(path.join(c.stateDir,'native-supervisor.json')))throw Error('原生服务未完成停止');return {ok:true,status:'stopped'};
  }
  if(current.ok)return current;
  if(current.status==='unavailable')throw Error('已有未确认身份的原生服务，拒绝重复启动：'+current.error);
  const log=fs.openSync(path.join(c.stateDir,'native-supervisor.log'),'a',0o600);
  let child;
  try{child=spawn(c.native?.nodePath||process.execPath,[path.join(c.releaseRoot,'server','fnos-native','supervisor.mjs'),'--config',configFile],{cwd:c.releaseRoot,env:{...process.env,...(c.native?.home?{HOME:c.native.home}:{})},windowsHide:true,detached:true,stdio:['ignore',log,log,'ipc']});}finally{fs.closeSync(log);}
  let spawnError,exited=false;child.once('error',error=>{spawnError=error;});child.once('exit',()=>{exited=true;});
  const closed=new Promise(resolve=>child.once('close',resolve));child.unref();child.channel?.unref();
  const end=Date.now()+startupTimeoutMs;
  while(Date.now()<end){
   if(spawnError)throw spawnError;if(exited)throw Error('原生服务启动失败，请检查 '+path.join(c.stateDir,'native-supervisor.log'));
   const next=await status(c,configFile);if(next.ok&&next.pid===child.pid){if(child.connected)child.disconnect();return next;}await sleep(200);
  }
  // IPC cancellation is graceful on Windows too; SIGTERM there terminates Node
  // without delivering its JS handler. Confirm this owned generation exits
  // before releasing the lifecycle transaction or claiming timeout cleanup.
  if(child.connected)child.send({action:'cancel-start'},error=>{if(error&&!exited&&process.platform!=='win32')child.kill('SIGTERM');});
  else if(!exited&&process.platform!=='win32')child.kill('SIGTERM');
  await deadline(closed,cancellationTimeoutMs,'原生启动取消后清理尚未确认，已阻止安全重试');
  throw Error('原生服务启动健康检查超时；本代清理已确认');
 });
}
export async function main(argv=process.argv.slice(2)){
 const action=argv.shift(),o={};for(let i=0;i<argv.length;i+=2){if(!argv[i].startsWith('--')||argv[i+1]===undefined)throw Error('参数必须为 --name value');o[argv[i].slice(2)]=argv[i+1];}
 if(action==='seal-source')return {ok:true,manifest:await sealStoppedSource(o.source)};
 if(action==='backup'){
  const c=loadConfig(o.config);await nativeLifecycle('stop',o.config);
  return backupNative(c.native.dataRoot,o.output);
 }
 if(action==='configure'){
  // fnOS wizard values arrive as environment fields. No shell eval or credentials
  // are involved, and the data root remains the dedicated package var directory.
  const requested=o.config?loadConfig(physicalPath(o.config)):undefined;
  const releaseRoot=o.release||process.env.ERP_NATIVE_RELEASE||requested?.releaseRoot,appRoot=path.dirname(releaseRoot||'');
  const split=value=>value?value.split(/[\s,]+/).filter(Boolean):undefined;
  const file=await configureNative({releaseRoot,dataRoot:o.data||process.env.ERP_NATIVE_DATA||requested?.native?.dataRoot,mode:o.mode||process.env.erp_mode||(requested?'existing':undefined),sourceRoot:o.source||process.env.erp_source,publicOrigin:o.origin||process.env.erp_origin,allowedOrigins:split(o.origins||process.env.erp_origins),allowedUids:split(o.uids||process.env.erp_uids),socketPath:o.socket||process.env.ERP_NATIVE_SOCKET,cmPath:o['cm-path']||process.env.ERP_NATIVE_CM_PATH,requireBrowsers:process.env.ERP_NATIVE_PACKAGE==='1'?true:undefined,browser:process.env.ERP_NATIVE_PACKAGE==='1'?{enabled:true,runtimeRoot:path.join(appRoot,'runtime'),chromiumPath:path.join(appRoot,'runtime','chromium','chrome'),novncRoot:path.join(appRoot,'runtime','novnc')}:undefined});
  return {ok:true,config:file};
 }
 const r=await nativeLifecycle(action,o.config);if(action==='status'&&!r.ok)process.exitCode=3;return r;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(error.message);process.exitCode=1;});
