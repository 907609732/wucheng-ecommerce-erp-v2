import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {configureNative,sealStoppedSource,backupNative} from '../server/fnos-native/configure.mjs';
import {nativeLifecycle} from '../server/fnos-native/lifecycle.mjs';
import {startNativeCollector,deadline} from '../server/fnos-native/supervisor.mjs';
import {loadConfig,validateConfig,developmentConfig,databases} from '../server/config.mjs';
const releaseRoot=path.resolve(import.meta.dirname,'..');
const origin='https://nas.example.com:5667';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnative-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const options=(dataRoot)=>({releaseRoot,dataRoot,mode:'fresh',publicOrigin:origin,allowedOrigins:[origin],allowedUids:['1000'],socketPath:path.join(dataRoot,'socket','app.sock')});
test('fresh is explicit, rejects replaceable data and unconfigured HTTPS, never overwrites books',async t=>{
 const dir=fixture(t),data=path.join(dir,'data');
 await assert.rejects(configureNative({...options(data),mode:undefined}),/mode|模式/);
 await assert.rejects(configureNative({...options(path.join(releaseRoot,'unsafe')),publicOrigin:origin}),/持久|release/);
 await assert.rejects(configureNative({...options(data),publicOrigin:undefined}),/HTTPS|地址/);
 assert.equal(fs.existsSync(data),false);
});
test('fresh creates three real production books, no dev gateway identity, and existing mode preserves identity',async t=>{
 const dir=fixture(t),data=path.join(dir,'instance');
 const file=await configureNative(options(data)),c=loadConfig(file);
 assert.equal(c.mode,'production');assert.equal(c.tcpEnabled,false);assert.equal(c.publicOrigin,origin);
 assert.equal(c.fnos.allowedUids[0],'1000');assert.ok(c.fnos.instanceId);
 assert.equal(fs.existsSync(path.join(c.stateDir,'gateway')),false,'initialization must never start development gateway');
 for(const [id,m] of Object.entries(c.modules)){const db=new DatabaseSync(path.join(m.dataDir,databases[id]),{readOnly:true});assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');db.close();}
 const before=hash(path.join(c.modules.purchase.dataDir,databases.purchase));
 await assert.rejects(configureNative(options(data)),/存在|existing/);
 const file2=await configureNative({...options(data),mode:'existing',allowedUids:['1001']});
 assert.equal(loadConfig(file2).fnos.instanceId,c.fnos.instanceId);
 assert.deepEqual(loadConfig(file2).fnos.allowedUids,['1001']);
 assert.equal(hash(path.join(c.modules.purchase.dataDir,databases.purchase)),before);
});
test('migration requires stopped verified complete source and preserves private identities and locks without source writes',async t=>{
 const dir=fixture(t),source=path.join(dir,'old'),target=path.join(dir,'new');
 const file=await configureNative(options(source));const c=loadConfig(file);
 c.publicOrigin='https://original.example.ts.net';c.tcpEnabled=true;
 fs.writeFileSync(file,JSON.stringify(c));
 fs.mkdirSync(path.join(source,'state','gateway'),{recursive:true});
 fs.writeFileSync(path.join(source,'state','gateway','identity.json'),JSON.stringify({schemaVersion:1,serverId:'original-server-id',dataSetId:'original-dataset-id'}));
 fs.mkdirSync(path.join(source,'state','month-admin'),{recursive:true});
 fs.writeFileSync(path.join(source,'state','month-admin','secret.json'),'PRIVATE ADMIN');
 fs.writeFileSync(path.join(c.modules.sales.dataDir,'month.lock'),'LOCK CONTENT');
 fs.mkdirSync(path.join(source,'browser-profiles','sales'),{recursive:true});
 fs.writeFileSync(path.join(source,'browser-profiles','sales','Preferences'),'PRIVATE PROFILE');
 fs.writeFileSync(path.join(source,'uvcs-home','auth.conf'),'PRIVATE UVCS');
 const ledger=new DatabaseSync(path.join(c.modules.sales.dataDir,databases.sales));
 ledger.exec('CREATE TABLE native_attachment_fixture(original_path TEXT)');
 ledger.prepare('INSERT INTO native_attachment_fixture VALUES(?)').run(path.join(c.modules.sales.dataDir,'originals','invoice.pdf'));ledger.close();
 await assert.rejects(configureNative({...options(target),mode:'migrate',sourceRoot:source}),/校验|manifest/);
 await sealStoppedSource(source);
 const before=hash(file),admin=hash(path.join(source,'state','month-admin','secret.json'));
 const migrated=loadConfig(await configureNative({...options(target),mode:'migrate',sourceRoot:source}));
 assert.equal(migrated.fnos.instanceId,c.fnos.instanceId);assert.equal(migrated.publicOrigin,c.publicOrigin);assert.equal(migrated.tcpEnabled,true);
 assert.deepEqual(migrated.fnos.allowedUids,c.fnos.allowedUids);
 assert.equal(fs.readFileSync(path.join(target,'data','sales','month.lock'),'utf8'),'LOCK CONTENT');
 assert.equal(fs.readFileSync(path.join(target,'state','month-admin','secret.json'),'utf8'),'PRIVATE ADMIN');
 assert.equal(JSON.parse(fs.readFileSync(path.join(target,'state','gateway','identity.json'))).serverId,'original-server-id');
 assert.equal(fs.readFileSync(path.join(target,'uvcs-home','auth.conf'),'utf8'),'PRIVATE UVCS');
 assert.equal(fs.readFileSync(path.join(target,'browser-profiles','sales','Preferences'),'utf8'),'PRIVATE PROFILE');
 const migratedDb=new DatabaseSync(path.join(target,'data','sales',databases.sales),{readOnly:true});
 assert.equal(migratedDb.prepare('SELECT original_path FROM native_attachment_fixture').get().original_path,path.join(target,'data','sales','originals','invoice.pdf'));migratedDb.close();
 assert.equal(hash(file),before);assert.equal(hash(path.join(source,'state','month-admin','secret.json')),admin);
 const sourceIdentity=path.join(source,'state','gateway','identity.json'),savedIdentity=fs.readFileSync(sourceIdentity);
 c.tcpEnabled=false;fs.writeFileSync(file,JSON.stringify(c));await sealStoppedSource(source);
 const unixOnly=loadConfig(await configureNative({...options(path.join(dir,'unix-only')),mode:'migrate',sourceRoot:source}));
 assert.equal(unixOnly.tcpEnabled,false,'migration must retain an explicit TCP-disabled source');
 delete c.tcpEnabled;fs.writeFileSync(file,JSON.stringify(c));await sealStoppedSource(source);
 assert.equal(loadConfig(await configureNative({...options(path.join(dir,'legacy-default')),mode:'migrate',sourceRoot:source})).tcpEnabled,true);
 fs.unlinkSync(sourceIdentity);await sealStoppedSource(source);
 await assert.rejects(configureNative({...options(path.join(dir,'missing-identity')),mode:'migrate',sourceRoot:source}),/身份|identity/);
 fs.writeFileSync(sourceIdentity,savedIdentity);await sealStoppedSource(source);
 fs.rmSync(path.join(source,'data','sales',databases.sales));
 await assert.rejects(configureNative({...options(path.join(dir,'missing')),mode:'migrate',sourceRoot:source}),/账本|完整|校验/);
});
test('existing configure waits for the lifecycle transaction and merges independent updates after reload',async t=>{
 const dir=fixture(t),data=path.join(dir,'instance'),file=await configureNative(options(data)),c=loadConfig(file);
 const lock=new DatabaseSync(path.join(c.stateDir,'native-lifecycle.sqlite'));lock.exec('BEGIN EXCLUSIVE');
 let finished=0;const first=configureNative({...options(data),mode:'existing',allowedOrigins:undefined,allowedUids:['1002']}).then(v=>{finished++;return v;});
 const second=configureNative({...options(data),mode:'existing',allowedUids:undefined,allowedOrigins:['https://second-nas.example.com']}).then(v=>{finished++;return v;});
 let early;try{await new Promise(r=>setTimeout(r,100));early=finished;}finally{lock.close();}
 await Promise.all([first,second]);
 assert.equal(early,0,'configuration may not commit inside a start/stop critical section');
 const updated=loadConfig(file);assert.deepEqual(updated.fnos.allowedUids,['1002']);assert.deepEqual(updated.fnos.allowedOrigins,['https://second-nas.example.com']);
});
test('existing configure refuses the ownership window before the supervisor publishes a PID record',async t=>{
 const dir=fixture(t),data=path.join(dir,'instance'),file=await configureNative(options(data)),c=loadConfig(file);
 const lock=new DatabaseSync(path.join(c.stateDir,'native-ownership.sqlite'));lock.exec('BEGIN EXCLUSIVE');
 try{await assert.rejects(configureNative({...options(data),mode:'existing',allowedUids:['9999']}),/运行|启动|ownership/);}finally{lock.close();}
 assert.deepEqual(loadConfig(file).fnos.allowedUids,['1000']);
});
test('interrupting a blocked startup drains its already-owned module before supervisor exit',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnative-interrupt-')),file=await configureNative(options(path.join(dir,'data'))),c=loadConfig(file);
 c.fnos={enabled:false};c.tcpEnabled=true;c.port=45000+Math.floor(Math.random()*1000);
 for(const [i,m] of Object.values(c.modules).entries()){m.port=c.port+i+1;if(m.mobilePort)m.mobilePort=c.port+4;}
 fs.writeFileSync(file,JSON.stringify(c));const marker=path.join(dir,'owned-child.json');
 const source=`import fs from 'node:fs';import {runSupervisor} from ${JSON.stringify(pathToFileURL(path.join(releaseRoot,'server/fnos-native/supervisor.mjs')).href)};import {createWebRuntime} from ${JSON.stringify(pathToFileURL(path.join(releaseRoot,'server/runtime.mjs')).href)};process.on('message',m=>{if(m==='interrupt')process.emit('SIGTERM');});runSupervisor(${JSON.stringify(file)},{createRuntime:async(config,options)=>{const runtime=await createWebRuntime(config,options),ensure=runtime.services.ensure.bind(runtime.services);runtime.services.ensure=async id=>{const cap=await ensure(id);if(id==='purchase'){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:cap.pid}));await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}return cap;};return runtime;}}).then(()=>{}).catch(e=>{console.error(e.message);process.disconnect?.();process.exitCode=1;});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let exited=false;child.once('exit',()=>{exited=true;});
 const closed=new Promise(resolve=>child.once('close',resolve));
 t.after(async()=>{
  if(!exited&&child.connected)child.send('interrupt');
  for(const id of ['purchase','sales','overview'])try{const m=c.modules[id],cap=await(await fetch('http://127.0.0.1:'+m.port+'/api/integration/v1/capabilities',{signal:AbortSignal.timeout(1000)})).json();if(path.resolve(cap.dataDir)===path.resolve(m.dataDir)){const key=fs.readFileSync(path.join(m.dataDir,'.integration-key'),'utf8').trim();await fetch('http://127.0.0.1:'+m.port+'/api/integration/v1/stop',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({confirm:true})});}}catch{}
  if(!exited){child.kill();await closed;}
  fs.rmSync(dir,{recursive:true,force:true});
 });
 const end=Date.now()+15000;while(!fs.existsSync(marker)&&Date.now()<end&&!exited)await new Promise(r=>setTimeout(r,50));
 assert.equal(fs.existsSync(marker),true,'startup must reach a real owned child before interruption');
 await assert.rejects(configureNative({...options(path.join(dir,'data')),mode:'existing',allowedUids:['9999']}),/运行|启动|ownership/);
 const owned=JSON.parse(fs.readFileSync(marker));child.send('interrupt');
 await deadline(closed,40000,'blocked startup failed to stop');
 assert.throws(()=>process.kill(owned.pid,0),e=>e.code==='ESRCH','owned module must exit before the supervisor');
 assert.equal(fs.existsSync(path.join(c.stateDir,'native-supervisor.json')),false);
});
test('sealing refuses live owner and migration refuses changed or linked files',async t=>{
 const dir=fixture(t),source=path.join(dir,'old');await configureNative(options(source));
 fs.writeFileSync(path.join(source,'state','web-runtime.json'),JSON.stringify({pid:process.pid}));
 await assert.rejects(sealStoppedSource(source),/运行|停止/);
 fs.unlinkSync(path.join(source,'state','web-runtime.json'));await sealStoppedSource(source);
 fs.writeFileSync(path.join(source,'data','sales','unexpected-secret'),'extra');
 await assert.rejects(configureNative({...options(path.join(dir,'target')),mode:'migrate',sourceRoot:source}),/校验|完整/);
});
test('TCP-disabled configuration requires fnOS and retains backwards compatible default',()=>{
 const c=developmentConfig({root:releaseRoot,stateDir:path.join(os.tmpdir(),'fnative-config')});
 assert.equal(validateConfig(c).tcpEnabled,true);
 assert.throws(()=>validateConfig({...c,tcpEnabled:false}),/飞牛|fnOS/);
 assert.throws(()=>validateConfig({...c,tcpEnabled:'false'}),/TCP/);
});
test('lifecycle starts one generation, validates PID identity and stops only its supervisor',async t=>{
 let file;t.after(async()=>{if(file)await nativeLifecycle('stop',file).catch(()=>{});});
 const dir=fixture(t),data=path.join(dir,'instance');file=await configureNative(options(data));
 const c=loadConfig(file);c.fnos={enabled:false};c.tcpEnabled=true;c.port=48000+Math.floor(Math.random()*1000);
 for(const [i,m] of Object.values(c.modules).entries()){m.port=c.port+i+1;if(m.mobilePort)m.mobilePort=c.port+4;}
 fs.writeFileSync(file,JSON.stringify(c));
 const starts=await Promise.all([nativeLifecycle('start',file),nativeLifecycle('start',file)]);
 assert.equal(starts[0].generation,starts[1].generation);
 const status=await nativeLifecycle('status',file);assert.equal(status.status,'running');assert.ok(status.serverId);assert.ok(status.dataSetId);
 const identityFile=path.join(c.stateDir,'gateway','identity.json'),identity=fs.readFileSync(identityFile,'utf8');
 fs.writeFileSync(identityFile,JSON.stringify({...JSON.parse(identity),serverId:'replacement-server-id'}));
 let identityStatus;try{identityStatus=await nativeLifecycle('status',file);}finally{fs.writeFileSync(identityFile,identity);}
 assert.equal(identityStatus.ok,false,'status binds the running ERP identity to this ledger');
 const record=path.join(c.stateDir,'native-supervisor.json'),actual=fs.readFileSync(record,'utf8');
 fs.writeFileSync(record,JSON.stringify({...JSON.parse(actual),pid:process.pid}));
 try{
  assert.equal((await nativeLifecycle('status',file)).ok,false);
  await assert.rejects(nativeLifecycle('stop',file),/身份|identity/);
 }finally{fs.writeFileSync(record,actual);}
 fs.writeFileSync(identityFile,JSON.stringify({...JSON.parse(identity),serverId:'replacement-server-id'}));
 try{await nativeLifecycle('stop',file);}finally{fs.writeFileSync(identityFile,identity);}
 assert.equal((await nativeLifecycle('status',file)).status,'stopped');
 await assert.rejects(nativeLifecycle('start',file,{startupTimeoutMs:1}),/超时.*清理已确认/);
 assert.equal(fs.existsSync(record),false,'timeout must wait for the partial generation to finish cleanup');
 for(const m of Object.values(c.modules))await assert.rejects(fetch('http://127.0.0.1:'+m.port+'/api/integration/v1/capabilities',{signal:AbortSignal.timeout(1000)}));
});
test('Linux package user: Unix-only native instance reports real identity over private IPC with no TCP listener',{skip:process.platform!=='linux'||process.getuid?.()===0},async t=>{
 let file;t.after(async()=>{if(file)await nativeLifecycle('stop',file).catch(()=>{});});
 const dir=fixture(t);file=await configureNative(options(path.join(dir,'instance')));const c=loadConfig(file);
 c.port=49000+Math.floor(Math.random()*1000);for(const [i,m] of Object.values(c.modules).entries()){m.port=c.port+i+1;if(m.mobilePort)m.mobilePort=c.port+4;}
 fs.writeFileSync(file,JSON.stringify(c));
 const ready=await nativeLifecycle('start',file),identity=JSON.parse(fs.readFileSync(path.join(c.stateDir,'gateway','identity.json')));
 assert.equal(ready.serverId,identity.serverId);assert.equal(ready.dataSetId,identity.dataSetId);assert.equal(ready.fnos.state,'ready');
 await assert.rejects(fetch('http://127.0.0.1:'+c.port+'/api/workbench/v1/health',{signal:AbortSignal.timeout(1000)}));
 await nativeLifecycle('stop',file);assert.equal((await nativeLifecycle('status',file)).status,'stopped');
});
test('missing required browsers fail startup instead of a false ready status',async t=>{
 const dir=fixture(t),file=await configureNative(options(path.join(dir,'data'))),c=loadConfig(file);
 c.fnos={enabled:false};c.tcpEnabled=true;c.native.requireBrowsers=true;fs.writeFileSync(file,JSON.stringify(c));
 await assert.rejects(nativeLifecycle('start',file),/启动失败/);
 assert.equal((await nativeLifecycle('status',file)).ok,false);
});
test('stopped full backup retains credentials, validates restore, and cannot recurse into its source',async t=>{
 const dir=fixture(t),data=path.join(dir,'data'),file=await configureNative(options(data));
 fs.writeFileSync(path.join(data,'uvcs-home','private-auth'),'PRIVATE UVCS');
 await assert.rejects(backupNative(data,path.join(data,'backups','unsafe')),/源|内部/);
 const result=await backupNative(data,path.join(dir,'backup'));
 assert.equal(result.ok,true);assert.equal(hash(path.join(result.target,'config','web.json')),hash(file));
 assert.equal(fs.readFileSync(path.join(result.target,'uvcs-home','private-auth'),'utf8'),'PRIVATE UVCS');
 await assert.rejects(backupNative(data,result.target),/存在/);
});
test('production native paths cannot redirect a module outside the retained data root',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnative-path-'));
 try{
  const c=developmentConfig({root:releaseRoot,stateDir:dir});c.native={dataRoot:dir,home:path.join(dir,'home')};
  assert.throws(()=>validateConfig({...c,native:{...c.native,dataRoot:releaseRoot}}),/持久|native|原生/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('native collector stays direct with inherited collector flag while module browsers delegate to it',async t=>{
 const dir=fixture(t),config={modules:Object.fromEntries(['sales','overview'].map(id=>[id,{root:path.join(releaseRoot,'apps',id),dataDir:path.join(dir,id)}]))};
 const previous=process.env.LINGTU_WEB_COLLECTOR;process.env.LINGTU_WEB_COLLECTOR='1';let collector;
 try{
  collector=await startNativeCollector(config);
  const record=JSON.parse(fs.readFileSync(path.join(dir,'sales','.web-collector.json')));
  assert.equal(record.state.status,'disconnected','helper must own a direct browser, not a recursive CollectorBrowser');
  const {CainiaoBrowser}=await import('../apps/sales/lib/agent-cainiao-browser.mjs');
  const moduleBrowser=new CainiaoBrowser(config.modules.sales.dataDir);
  const altered={...record,state:{...record.state,account:'HELPER STATE'}};
  fs.writeFileSync(path.join(dir,'sales','.web-collector.json'),JSON.stringify(altered));
  assert.equal(moduleBrowser.status().account,'HELPER STATE','module reads helper state rather than owning another browser');
 }finally{if(collector)await collector.stop();if(previous===undefined)delete process.env.LINGTU_WEB_COLLECTOR;else process.env.LINGTU_WEB_COLLECTOR=previous;}
});
