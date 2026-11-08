import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {configureNative} from '../server/fnos-native/configure.mjs';
import {nativeRequest} from '../server/fnos-native/supervisor.mjs';
import {loadConfig} from '../server/config.mjs';

const moduleUrl=file=>pathToFileURL(path.resolve(file)).href;
const bounded=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('synthetic child timed out')),ms);timer.unref();})]);
for(const phase of ['drain','startup'])test(`native collector heartbeat failure during ${phase} revokes readiness and drains owned modules`,{skip:process.platform==='linux'&&process.getuid()===0},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-collector-failure-'));
  let file,child,closed;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){
      child.send({action:'cancel-start'});
      await bounded(closed,10000).catch(()=>child.kill());
      await closed;
    }
    fs.rmSync(dir,{recursive:true,force:true});
  });
  file=await configureNative({mode:'fresh',dataRoot:path.join(dir,'data'),releaseRoot:path.resolve('.'),publicOrigin:'https://nas.example.com:5667',allowedOrigins:['https://nas.example.com:5667'],allowedUids:['1000']});
  const config=loadConfig(file);config.fnos={enabled:false};config.tcpEnabled=true;
  fs.writeFileSync(file,JSON.stringify(config));
  const entry=path.join(dir,'child.mjs');
  fs.writeFileSync(entry,`
    import fs from 'node:fs';import path from 'node:path';
    import {runSupervisor} from ${JSON.stringify(moduleUrl('server/fnos-native/supervisor.mjs'))};
    import {createWebRuntime} from ${JSON.stringify(moduleUrl('server/runtime.mjs'))};
    const phase=${JSON.stringify(phase)},target=${JSON.stringify(path.join(config.modules.sales.dataDir,'.web-collector.json'))};
    let armed=false;const rename=fs.renameSync;
    fs.renameSync=function(from,to){if(armed&&to===target)throw Object.assign(Error('private-fixture-path'),{code:'EPERM'});return rename.apply(this,arguments);};
    const wait=()=>new Promise(r=>setTimeout(r,1600));
    runSupervisor(${JSON.stringify(file)},{createRuntime:async(...args)=>{
      const runtime=await createWebRuntime(...args);
      const quiesce=runtime.quiesce.bind(runtime);let draining;
      runtime.quiesce=()=>draining??=(async()=>{if(phase==='drain'){armed=true;process.send({phase:'drain'});await wait();}return quiesce();})();
      if(phase==='startup'){
        const ensure=runtime.services.ensure.bind(runtime.services);let first=true;
        runtime.services.ensure=async(...values)=>{const value=await ensure(...values);if(first){first=false;armed=true;await wait();}return value;};
      }
      return runtime;
    }}).then(owner=>{process.send({ready:true});}).catch(error=>{console.error(error.message);process.exitCode=1;});
  `);
  child=spawn(process.execPath,[entry],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let stderr='',ready=false;child.stderr.on('data',chunk=>stderr+=chunk);child.on('message',message=>{if(message.ready)ready=true;});
  const draining=new Promise(resolve=>child.on('message',message=>{if(message.phase==='drain')resolve();}));
  closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  const first=await bounded(Promise.race([new Promise(resolve=>child.on('message',message=>{if(message.ready)resolve('ready');})),closed.then(()=> 'closed')]),20000);
  if(phase==='startup')assert.equal(first,'closed','failed collector must cancel startup instead of publishing ready');
  if(phase==='drain'){
    assert.equal(first,'ready',stderr);
    // This fixture deliberately injects createRuntime through child.mjs. It is
    // not the CLI supervisor entry checked by Linux lifecycle commandIdentity.
    // Exercise the real authenticated control protocol of this owned child.
    const record=JSON.parse(fs.readFileSync(path.join(config.stateDir,'native-supervisor.json')));
    assert.equal(record.pid,child.pid);assert.equal(record.configFile,file);
    assert.equal((await nativeRequest(config,record)).ok,true,'owned fixture must actually reach ready');
    const stopping=nativeRequest(config,record,'stop',75000).then(()=>({ok:true}),error=>({error:error.message}));
    await bounded(draining,5000);
    // Observe while the controlled drain is still blocked, after one heartbeat.
    await new Promise(r=>setTimeout(r,1150));
    await assert.rejects(nativeRequest(config,record),/采集助手状态写入失败.*EPERM/,'collector failure must never report ready');
    const result=await stopping;
    assert.match(result.error||'',/采集助手状态写入失败/,'stop must report collector failure, not acknowledge false success');
  }
  const outcome=await bounded(closed,15000);
  assert.equal(outcome.code,1,stderr);
  if(phase==='startup')assert.equal(ready,false,'failed collector must prevent initial readiness');
  assert.match(stderr,/采集助手状态写入失败.*EPERM/);
  assert.doesNotMatch(stderr,/private-fixture-path|Timeout\.publish/);
  assert.equal(fs.existsSync(path.join(config.stateDir,'native-supervisor.json')),false,'owned generation must finish cleanup');
  for(const m of Object.values(config.modules)){
    await assert.rejects(fetch(`http://127.0.0.1:${m.port}/api/integration/v1/capabilities`,{signal:AbortSignal.timeout(1000)}));
    assert.equal(fs.existsSync(path.join(m.dataDir,'.web-collector.json')),false);
  }
});
