import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {isAllowedRuntimeLibrary,verifySandboxResult} from '../fnos/smoke-checks.mjs';

function monitorChild(child){
 const state={exit:null,error:null};
 child.once('error',error=>{state.error=error;});
 child.once('exit',(code,signal)=>{state.exit={code,signal};});
 return state;
}
function waitForChildExit(child,state,timeoutMs){
 if(state.error)return Promise.reject(state.error);
 if(state.exit)return Promise.resolve(state.exit);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>finish(Error('Foreground package service did not exit')),timeoutMs);
  const onExit=(code,signal)=>finish(null,{code,signal});
  const onError=error=>finish(error);
  function finish(error,result){clearTimeout(timer);child.off('exit',onExit);child.off('error',onError);error?reject(error):resolve(result);}
  child.once('exit',onExit);child.once('error',onError);
 });
}

const [packageRoot,evidenceDir,metadataFile]=process.argv.slice(2).map(value=>path.resolve(value));
if(!packageRoot||!evidenceDir||!metadataFile)throw Error('usage: smoke-environment.mjs <package-root> <evidence-dir> <environment-build.json>');
const metadata=JSON.parse(fs.readFileSync(metadataFile,'utf8'));
if(metadata.target!=='linux-x64')throw Error('Linux package metadata target mismatch');
if(process.getuid()===0)throw Error('Linux smoke must run as a non-root package user');
const expectedNode=path.join(packageRoot,'runtime/node/bin/node');
assert.equal(process.version,'v'+metadata.nodeVersion,'Smoke must run with the pinned package Node version');
assert.equal(fs.realpathSync(process.execPath),fs.realpathSync(expectedNode),'Smoke executable must be the unpacked package Node');
fs.mkdirSync(evidenceDir,{recursive:true});
const release=path.join(packageRoot,'erp'),runtime=path.join(packageRoot,'runtime');
const {configureNative}=await import(pathToFileURL(path.join(release,'server/fnos-native/configure.mjs')));
const {nativeLifecycle}=await import(pathToFileURL(path.join(release,'server/fnos-native/lifecycle.mjs')));
let temp,data,file,stopped=false,checks=[];
let runError,cleanupError,cdp,cdpPage,foregroundChild,foregroundState;const browserReservations=[];
try{
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'wucheng-linux-accept-'));fs.chmodSync(temp,0o700);
 data=path.join(temp,'data');const privateRuntime=path.join(temp,'runtime-state');
 const reserve=async()=>{const s=net.createServer();await new Promise((r,j)=>s.once('error',j).listen(0,'127.0.0.1',r));browserReservations.push(s);return s.address().port;};
 const ports=[];while(ports.length<4){const p=await reserve();if(!ports.includes(p))ports.push(p);}
 const browserConfig={enabled:true,runtimeRoot:runtime,chromiumPath:path.join(runtime,'chromium/chrome'),novncRoot:path.join(runtime,'novnc'),instances:{sales:{cdpPort:ports[0],vncPort:ports[1],display:710},overview:{cdpPort:ports[2],vncPort:ports[3],display:711}}};
 file=await configureNative({releaseRoot:release,dataRoot:data,mode:'fresh',entry:'tailscale',publicOrigin:'https://linux-acceptance.test',runtimeDir:privateRuntime,requireBrowsers:true,browser:browserConfig});
 await Promise.all(browserReservations.splice(0).map(s=>new Promise(r=>s.close(r))));
 checks.push('fresh isolated Tailscale configuration without fnOS identity');
 for(let i=0;i<2;i++){
  let result,service;
  if(i===0){
   service=foregroundChild=spawn(path.join(packageRoot,'erp.sh'),['serve','--config',file],{env:process.env,stdio:'ignore'});
   foregroundState=monitorChild(service);
   const until=Date.now()+120000;
   while(Date.now()<until){
    if(foregroundState.error)throw foregroundState.error;
    if(foregroundState.exit)throw Error('Foreground package entry exited before readiness: '+JSON.stringify(foregroundState.exit));
    const current=await nativeLifecycle('status',file);if(current.ok){result=current;break;}await new Promise(r=>setTimeout(r,200));
   }
   assert(result,'Foreground package entry did not become ready');assert.equal(result.pid,service.pid);
  }else result=await nativeLifecycle('start',file,{startupTimeoutMs:120000});
  assert(result.ok&&result.browser?.ready===true,'three modules and both browser services must be ready');
  assert.equal(result.fnos?.enabled,false);checks.push(`start ${i+1}: three business modules and Chromium/Xvfb/noVNC browsers ready`);
  if(i===0){
   const require=createRequire(path.join(release,'apps/sales/package.json')),{chromium}=require('playwright-core');
   cdp=await chromium.connectOverCDP('http://127.0.0.1:'+ports[0],{noDefaults:true,timeout:15000});
   const contexts=cdp.contexts();cdpPage=contexts.length?await contexts[0].newPage():await cdp.newPage();await cdpPage.goto('chrome://sandbox/');const sandbox=await cdpPage.locator('body').innerText();verifySandboxResult('### Result\n'+JSON.stringify(sandbox));
   fs.writeFileSync(path.join(evidenceDir,'chrome-sandbox.txt'),sandbox+'\n');
   checks.push('Chromium namespace, PID, network, and seccomp sandbox confirmed through chrome://sandbox');
   await cdpPage.close();cdpPage=undefined;await cdp.close();cdp=undefined;
   const observed=[],unreadable=[],unexpected=[];
   for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))){
    const proc='/proc/'+name;let exe;try{if(fs.statSync(proc).uid!==process.getuid())continue;exe=fs.readlinkSync(proc+'/exe').replace(/ \(deleted\)$/,'');}catch{continue;}
    if(!exe.startsWith(runtime+path.sep)&&!exe.startsWith(release+path.sep))continue;
    let maps;try{maps=fs.readFileSync(proc+'/maps','utf8');}catch(e){if(['EACCES','EPERM'].includes(e.code)){unreadable.push({pid:Number(name),exe});continue;}if(e.code==='ENOENT')continue;throw e;}
    const libs=[...new Set(maps.split('\n')
     .map(row=>row.trim().split(/\s+/).slice(5).join(' ').replace(/ \(deleted\)$/,''))
     .filter(f=>f.startsWith('/')&&(/\.so(?:\.|$)/.test(f)||path.basename(f).startsWith('ld-linux'))))];
    for(const lib of libs)if(!isAllowedRuntimeLibrary(lib,runtime,release))unexpected.push({pid:Number(name),exe,library:lib});
    observed.push({pid:Number(name),exe,libraries:libs});
   }
   assert(observed.some(p=>p.exe===fs.realpathSync(browserConfig.chromiumPath))||unreadable.some(p=>p.exe===fs.realpathSync(browserConfig.chromiumPath)),'No packaged Chromium process was inspected');
   assert(observed.length>0,'No package-owned process library maps were inspected');assert.deepEqual(unexpected,[],'Package process loaded host libraries outside the approved glibc set');
   fs.writeFileSync(path.join(evidenceDir,'loaded-libraries.json'),JSON.stringify({observed,unreadable,unexpected},null,2)+'\n');
   checks.push('Package-owned Node and Chromium maps use package runtime dependencies or the approved Debian 12 glibc base');
  }
  await nativeLifecycle('stop',file);assert.equal((await nativeLifecycle('status',file)).status,'stopped');
  if(service){const exited=await waitForChildExit(service,foregroundState,10000);assert.equal(exited.code,0);checks.push('systemd-style Type=simple foreground service stopped cleanly');}
 }
 stopped=true;checks.push('two clean lifecycle stops');
}catch(error){runError=error;}
finally{
 for(const socket of browserReservations.splice(0))try{await new Promise(r=>socket.close(r));}catch(error){cleanupError??=error;}
 try{if(cdpPage&& !cdpPage.isClosed())await cdpPage.close();}catch(error){cleanupError??=error;}
 try{if(cdp)await cdp.close();}catch(error){cleanupError??=error;}
 if(file)try{await nativeLifecycle('stop',file);}catch(error){cleanupError??=error;}
 if(foregroundChild&&foregroundState&&!foregroundState.exit){
  try{foregroundChild.kill('SIGTERM');await waitForChildExit(foregroundChild,foregroundState,15000);}catch(error){cleanupError??=error;}
 }
 if(file)try{if((await nativeLifecycle('status',file)).status!=='stopped')throw Error('Supervisor remains after stop');}catch(error){cleanupError??=error;}
 if(!cleanupError&&temp){try{fs.rmSync(temp,{recursive:true,force:true});}catch(error){cleanupError=error;}}
}
const report={schemaVersion:1,ok:!runError&&!cleanupError&&stopped,cleanupComplete:!cleanupError&&(!temp||!fs.existsSync(temp)),target:metadata.target,version:metadata.version,commit:metadata.commit,runId:metadata.runId,nodeVersion:metadata.nodeVersion,checks,...(runError?{error:runError.message}:{}),...(cleanupError?{cleanupError:cleanupError.message,retainedDataRoot:temp}:{})};
fs.writeFileSync(path.join(evidenceDir,'environment-acceptance.json'),JSON.stringify(report,null,2)+'\n');
if(!report.ok){console.error(report.error||report.cleanupError||'Linux environment smoke failed');process.exitCode=1;}
