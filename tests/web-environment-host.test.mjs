import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {configureNative} from '../server/fnos-native/configure.mjs';
import {nativeLifecycle} from '../server/fnos-native/lifecycle.mjs';
import {loadConfig} from '../server/config.mjs';
import {nativeEndpoint} from '../server/fnos-native/supervisor.mjs';
import {captureNativeSetupFailure} from './fnos-native-setup-diagnostics.mjs';

const releaseRoot=path.resolve(import.meta.dirname,'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'environment host spaces-'));
 captureNativeSetupFailure(t,root,{fixtureRoot:true});
 return root;
}
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
  const timer=setTimeout(()=>reject(Error('environment.mjs serve child did not exit')),timeoutMs);
  const onError=error=>finish(error),onExit=(code,signal)=>finish(null,{code,signal});
  function finish(error,result){clearTimeout(timer);child.off('error',onError);child.off('exit',onExit);error?reject(error):resolve(result);}
  child.once('error',onError);child.once('exit',onExit);
 });
}
async function waitForReady(state,file){
 const until=Date.now()+60000;let last;
 while(Date.now()<until){
  if(state.error)throw state.error;
  if(state.exit)throw Error('serve exited before ready: '+JSON.stringify(state.exit));
  last=await nativeLifecycle('status',file);
  if(last.ok)return last;
  await delay(100);
 }
 throw Error('serve did not become ready: '+JSON.stringify(last));
}

test('foreground environment serve reports its identity, stops cleanly, and restarts on the same isolated DATA',async t=>{
 const root=fixture(t),dataRoot=path.join(root,'isolated ERP data'),runtimeDir=path.join(root,'private runtime');
 let file,config,cleanupError;
  const children=[];
 try{
  file=await configureNative({releaseRoot,dataRoot,mode:'fresh',entry:'tailscale',publicOrigin:'https://environment-host.tailnet-123.ts.net',runtimeDir,requireBrowsers:false});
  config=loadConfig(file);
  assert.equal(config.fnos.enabled,false);assert.equal(config.tcpEnabled,true);
  const endpoint=nativeEndpoint(config.stateDir),record=path.join(config.stateDir,'native-supervisor.json');
  const starts=[];
  for(let generation=0;generation<2;generation++){
   if(generation===1){
    assert.equal(fs.existsSync(record),false,'previous supervisor record must be gone before restart');
    if(process.platform==='linux')assert.equal(fs.lstatSync(endpoint).isSocket(),true,'restart must clean the previous stale control socket');
   }
   const child=spawn(process.execPath,[path.join(releaseRoot,'server/environment.mjs'),'serve','--config',file],{cwd:releaseRoot,env:process.env,stdio:['ignore','pipe','pipe']});
   const childState=monitorChild(child);children.push({child,state:childState});
   let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>{stdout=(stdout+chunk).slice(-4096);});child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
   const status=await waitForReady(childState,file);
   assert.equal(status.pid,child.pid,'status must authenticate the actual foreground serve PID');
   assert.equal(status.fnos.enabled,false);assert.deepEqual(Object.keys(status.browser),['enabled']);
   const response=await fetch(`http://127.0.0.1:${config.port}/api/workbench/v1/health`);
   assert.equal(response.status,200);assert.equal((await response.json()).fnos.enabled,false);
   starts.push({pid:status.pid,generation:status.generation});
   const stop=await nativeLifecycle('stop',file);
   assert.deepEqual(stop,{ok:true,status:'stopped'});
   const exit=await waitForChildExit(child,childState,10000);assert.equal(exit.code,0,stderr||stdout);assert.equal(exit.signal,null);
   assert.equal((await nativeLifecycle('status',file)).status,'stopped');
   assert.equal(fs.existsSync(record),false,'supervisor record must be removed after stop');
   if(process.platform==='linux'){
    const socket=fs.lstatSync(endpoint);assert.equal(socket.isSocket(),true);assert.equal(socket.uid,process.getuid());
   }else assert.equal(fs.existsSync(endpoint),false);
  }
  assert.notEqual(starts[0].pid,starts[1].pid);assert.notEqual(starts[0].generation,starts[1].generation);
  assert.equal((await nativeLifecycle('status',file)).status,'stopped');
 }finally{
  if(file)try{await nativeLifecycle('stop',file);}catch(error){cleanupError=error;}
  for(const {child,state} of children){
   if(!state.exit&&!state.error){
    try{await waitForChildExit(child,state,3000);}catch{
     child.kill('SIGTERM');
     try{await waitForChildExit(child,state,15000);}catch(error){cleanupError??=error;}
    }
   }
   if(!state.exit)cleanupError??=state.error||Error('Foreground serve child exit was not confirmed');
  }
  if(file)try{if((await nativeLifecycle('status',file)).status!=='stopped')throw Error('Supervisor record remains after cleanup');}catch(error){cleanupError??=error;}
  if(!cleanupError)fs.rmSync(root,{recursive:true,force:true});
  else console.error('[environment host test preserved isolated DATA]',root,cleanupError.message);
 }
 if(cleanupError)throw cleanupError;
});
