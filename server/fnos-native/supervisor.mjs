import {assertNativeUvcsPrepared,assertNativeUvcsRegistration} from './uvcs-registration.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {loadConfig,moduleIds} from '../config.mjs';
import {createWebRuntime} from '../runtime.mjs';
import {startCollector} from '../collector.mjs';
import {atomicJson,physicalPath} from './configure.mjs';
import {nativeBrowserSpecs} from './browsers.mjs';

export const nativeEndpoint=stateDir=>process.platform==='win32'?'\\\\.\\pipe\\wucheng-native-'+createHash('sha256').update(stateDir).digest('hex').slice(0,32):path.join(stateDir,'native.sock');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function startNativeCollector(config,{onError}={}){
 const browserSpecs=nativeBrowserSpecs(config);
 process.env.LINGTU_SALES_CDP_ENDPOINT=browserSpecs.sales?.cdpEndpoint||'http://127.0.0.1:19222';
 process.env.LINGTU_OVERVIEW_CDP_ENDPOINT=browserSpecs.overview?.cdpEndpoint||'http://127.0.0.1:19223';
 // Module children use CollectorBrowser; the owner must instantiate the real
 // adapters with the inherited forwarding flag absent, avoiding self-recursion.
 delete process.env.LINGTU_WEB_COLLECTOR;
 try{return await startCollector(config,{onError});}finally{process.env.LINGTU_WEB_COLLECTOR='1';}
}
export function deadline(task,ms,message){let timer;return Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));}
export async function nativeRequest(config,record,action='status',timeout=3000){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(nativeEndpoint(config.stateDir));let buffer='';
  socket.setTimeout(timeout,()=>socket.destroy(Error('原生控制响应超时')));
  socket.once('error',reject);socket.once('connect',()=>socket.write(JSON.stringify({token:record.token,generation:record.generation,pid:record.pid,action})+'\n'));
  socket.on('data',chunk=>{
   buffer+=chunk;if(buffer.length>65536){socket.destroy(Error('原生控制响应过大'));return;}
   if(!buffer.includes('\n'))return;
   try{const r=JSON.parse(buffer.split('\n')[0]);socket.end();if(r.pid!==record.pid||r.generation!==record.generation)throw Error('原生进程身份 identity 不符');if(!r.ok)throw Error(r.error||'原生服务未就绪');resolve(r);}catch(error){reject(error);socket.destroy();}
  });socket.once('end',()=>{if(!buffer.includes('\n'))reject(Error('原生控制连接提前关闭'));});
 });
}
async function cleanEndpoint(endpoint){
 if(process.platform==='win32'||!fs.existsSync(endpoint))return;
 const before=fs.lstatSync(endpoint);if(!before.isSocket()||before.uid!==process.getuid())throw Error('原生控制路径不是本用户 socket');
 await new Promise((resolve,reject)=>{const s=net.createConnection(endpoint);s.setTimeout(1000,()=>s.destroy(Error('不能确认原生控制状态')));s.once('connect',()=>{s.destroy();reject(Error('原生控制端口已占用'));});s.once('error',error=>error.code==='ECONNREFUSED'?resolve():reject(error));});
 const now=fs.lstatSync(endpoint);if(now.ino!==before.ino||now.dev!==before.dev)throw Error('原生控制路径已改变');fs.unlinkSync(endpoint);
}
function terminateDescendants(){
 if(process.platform!=='linux')return;
 // Snapshot actual descendants, not arbitrary PIDs from persisted files.
 const parents=new Map();for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)))try{
  const s=fs.readFileSync('/proc/'+name+'/stat','utf8'),fields=s.slice(s.lastIndexOf(')')+2).split(' ');parents.set(Number(name),{parent:Number(fields[1]),start:fields[19]});
 }catch{}
 const owned=[];for(const pid of parents.keys()){let parent=pid,seen=new Set();while(parents.has(parent)&&!seen.has(parent)){seen.add(parent);parent=parents.get(parent).parent;if(parent===process.pid){owned.push(pid);break;}}}
 for(const pid of owned.reverse())try{
  const file='/proc/'+pid+'/stat',s=fs.readFileSync(file,'utf8'),fields=s.slice(s.lastIndexOf(')')+2).split(' ');
  if(fields[19]===parents.get(pid).start&&fs.statSync(file).uid===process.getuid())process.kill(pid,'SIGKILL');
 }catch{}
}
export async function runSupervisor(configFile,{createRuntime=createWebRuntime}={}){
 configFile=physicalPath(configFile);
 // This first snapshot only locates the stable lock; it is never runtime input.
 const ownershipStateDir=physicalPath(loadConfig(configFile).stateDir);
 if(process.platform==='linux'&&process.getuid()===0)throw Error('长期服务必须使用专用 package 用户，不能以 root 运行');
 fs.mkdirSync(ownershipStateDir,{recursive:true,mode:0o700});
 const lock=new DatabaseSync(path.join(ownershipStateDir,'native-ownership.sqlite'));try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch(error){lock.close();throw Error('原生实例已有 supervisor，拒绝重复启动');}
 let config;
 try{
  config=loadConfig(configFile);
  if(physicalPath(config.stateDir)!==ownershipStateDir)throw Error('原生配置状态/所有权锁绑定已改变，拒绝启动');
  assertNativeUvcsPrepared(config);
  if(config.mode!=='production'||!config.native)throw Error('原生 supervisor 需要正式配置');
 }catch(error){lock.close();throw error;}
 const record={schemaVersion:1,pid:process.pid,generation:randomUUID(),token:randomUUID()+randomUUID(),configFile,startedAt:new Date().toISOString()};
 const recordFile=path.join(config.stateDir,'native-supervisor.json'),endpoint=nativeEndpoint(config.stateDir);
 let resolveStopped;const stopped=new Promise(resolve=>{resolveStopped=resolve;});
 let runtime,collector,browsers,server,monitor,startupTask,collectorFailure,stopping=null,ready=false,closed=false,monitoring=false;
 const cancellation=new AbortController();
 const checkCancellation=()=>{if(cancellation.signal.aborted)throw cancellation.signal.reason;};
 const health=()=>({ok:ready&&!stopping&&!collectorFailure,pid:process.pid,generation:record.generation,status:collectorFailure?'failed':stopping?'stopping':ready?'running':'starting',error:collectorFailure?.message,serverId:runtime?.gateway.serverId,dataSetId:runtime?.gateway.dataSetId,fnos:runtime?.gateway.fnosStatus(),browser:browsers?.status()||{enabled:false}});
 async function cleanup(){
  if(closed)return;closed=true;ready=false;clearInterval(monitor);
  try{await deadline((async()=>{
   // Startup may still be acquiring resources. Its cancellation checks prevent
   // another launch; wait for the in-flight acquisition before final teardown.
   await startupTask?.catch(()=>{});
   if(runtime)await runtime.quiesce();await collector?.stop();await browsers?.stop();await runtime?.stop();
  })(),75000,'原生服务停止超时');}
  catch(error){console.error(error.message);terminateDescendants();throw error;}
  finally{
   if(server)await new Promise(r=>{server.close(r);server.closeAllConnections?.();});
   try{if(JSON.parse(fs.readFileSync(recordFile)).generation===record.generation)fs.unlinkSync(recordFile);}catch{}
   lock.close();
   for(const signal of ['SIGTERM','SIGINT'])process.off(signal,onInterrupted);
   process.off('message',onParentMessage);process.off('disconnect',onParentDisconnect);
   if(process.connected){process.send?.({type:'native-stopped',pid:process.pid,generation:record.generation});process.disconnect();}
   resolveStopped();
  }
 }
 const shutdown=()=>{
  if(!stopping){cancellation.abort(collectorFailure||Error('原生启动已取消'));runtime?.services.drain();stopping=cleanup();}
  return stopping;
 };
 const onInterrupted=()=>void shutdown().catch(error=>{console.error(error.message);terminateDescendants();process.exit(1);});
 const onParentMessage=message=>{if(message?.action==='cancel-start')onInterrupted();};
 const onParentDisconnect=()=>{if(!ready)onInterrupted();};
 // Install control before the first await or launch, including partial startup.
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,onInterrupted);
 process.on('message',onParentMessage);process.once('disconnect',onParentDisconnect);
 startupTask=(async()=>{
  atomicJson(recordFile,record);
  process.send?.({type:'native-starting',pid:process.pid,generation:record.generation});
  if(config.native.home){physicalPath(config.native.home);process.env.HOME=config.native.home;}
  await assertNativeUvcsRegistration(config,{signal:cancellation.signal});
  checkCancellation();
  await cleanEndpoint(endpoint);
  checkCancellation();
  runtime=await createRuntime(config,{watch:false,superviseMs:5000,signal:cancellation.signal});
  checkCancellation();
  if(config.native.browser?.enabled){
   // Absence of the Task 2 payload must fail the real package, never silently
   // report ready with a missing browser service.
   const {createNativeBrowsers}=await import('./browsers.mjs');browsers=await createNativeBrowsers(config,{logger:runtime.logger,signal:cancellation.signal});await browsers.start();
  }else if(config.native.requireBrowsers)throw Error('原生 FPK 必须配置可运行的浏览器');
  checkCancellation();
  collector=await startNativeCollector(config,{onError:error=>{
   collectorFailure=error;ready=false;
   // Notify without awaiting: cleanup may itself be waiting for startup or the
   // active stop request. Module disconnects still use the collector until drain.
   void shutdown().catch(error=>{console.error(error.message);terminateDescendants();process.exit(1);});
  }});
  checkCancellation();
  await runtime.start();
  checkCancellation();
  if(config.fnos.enabled&&runtime.gateway.fnosStatus().state!=='ready')throw Error('飞牛可信 Unix 入口未就绪');
  for(const id of moduleIds){checkCancellation();await runtime.services.ensure(id);checkCancellation();}
  if(browsers){const b=browsers.status();if(b.ready===false||b.state==='degraded'||b.state==='failed')throw Error('原生浏览器未就绪');}
  server=net.createServer(socket=>{
   let buffer='',handled=false;socket.setTimeout(80000,()=>socket.destroy());socket.on('error',()=>{});
   socket.on('data',async chunk=>{
    if(handled)return;buffer+=chunk;if(buffer.length>4096){socket.destroy();return;}if(!buffer.includes('\n'))return;handled=true;
    try{
     const r=JSON.parse(buffer.split('\n')[0]);if(!equal(r.token,record.token)||r.generation!==record.generation||r.pid!==process.pid)throw Error('原生控制身份无效');
     if(r.action==='status'){
      const caps=await Promise.all(moduleIds.map(id=>runtime.services.capabilities(id)));
      if(caps.some(cap=>!cap))throw Error('原生 ERP 模块未全部就绪');
      socket.end(JSON.stringify(health())+'\n');
     }
     else if(r.action==='stop'){
      // Acknowledge only after writes and collectors have drained. Close this
      // connection before closing the listener to avoid waiting on ourselves.
      ready=false;await deadline((async()=>{await runtime.quiesce();await collector.stop();await browsers?.stop();await runtime.stop();})(),70000,'停写排空超时');
      if(collectorFailure)throw collectorFailure;
      socket.end(JSON.stringify({...health(),ok:true,status:'stopped'})+'\n',()=>{void shutdown().catch(()=>{process.exitCode=1;});});
     }else throw Error('未知原生控制操作');
    }catch(error){socket.end(JSON.stringify({...health(),ok:false,error:error.message})+'\n');}
   });
  });
  const oldMask=process.umask(0o177);try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});}finally{process.umask(oldMask);}
  if(process.platform!=='win32')fs.chmodSync(endpoint,0o600);
  checkCancellation();
  ready=true;atomicJson(recordFile,record);
  let failures=0;
  monitor=setInterval(async()=>{
   if(monitoring||stopping)return;monitoring=true;
   try{
    const caps=await Promise.all(moduleIds.map(id=>runtime.services.capabilities(id)));
    const state=browsers?.status();if(caps.some(c=>!c)||state?.ready===false||['failed','degraded'].includes(state?.state))failures++;else failures=0;
    if(failures>=3){runtime.logger.error('原生服务连续三次健康检查失败，停止恢复循环');await shutdown();process.exitCode=1;}
   }catch(error){console.error(error.message);if(++failures>=3){await shutdown().catch(()=>{terminateDescendants();process.exit(1);});process.exitCode=1;}}
   finally{monitoring=false;}
  },5000);monitor.unref();
  return {status:health,stop:shutdown};
 })();
 try{const started=await startupTask;return {...started,wait:stopped};}catch(error){await shutdown().catch(()=>{});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config'){console.error('需要 --config <absolute>');process.exitCode=1;}
 else runSupervisor(args[1]).catch(error=>{console.error(error.stack);terminateDescendants();process.exit(1);});
}
