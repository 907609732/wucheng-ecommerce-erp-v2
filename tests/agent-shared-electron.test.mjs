import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {agentBetaPaths,prepareAgentProfile,assertAgentRegistry,guardAgentServices} from '../desktop/agent-host/isolation.mjs';
import {createAgentActivation} from '../desktop/agent-host/activation.mjs';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {withElectronLifecycle} from '../desktop/modules/electron-lifecycle.mjs';

const base=path.resolve('.codex-artifacts/agent-shared-electron-tests'),hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){
 fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),old=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=root;
 t.after(()=>{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;const real=fs.realpathSync.native(root),relative=path.relative(base,real);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(real,{recursive:true,force:true});});
 const paths=agentBetaPaths({localAppData:root,root:path.join(root,'WuchengAgentBeta'),preview:false});paths.sharedElectronExecutable=process.execPath;paths.sharedElectronVersion='44.7.0';prepareAgentProfile(paths);
 const registry=JSON.parse(fs.readFileSync(paths.registryFile));
 for(const id of ['warehouse','exporter'])Object.assign(registry[id],{root:path.join(paths.programs,id,'version','runtime'),exe:process.execPath,version:'1.0.0',sharedElectron:true});
 const save=()=>fs.writeFileSync(paths.registryFile,JSON.stringify(registry));save();
 return {root,paths,registry,save};
}

test('shared native EXEs require a matching trusted path/version and retain program/data fences',t=>{
 const f=fixture(t);assert.doesNotThrow(()=>assertAgentRegistry(f.paths));
 const unbound={...f.paths};delete unbound.sharedElectronExecutable;assert.throws(()=>assertAgentRegistry(unbound),{code:'BETA_REGISTRY_UNSAFE'});
 assert.throws(()=>assertAgentRegistry({...f.paths,sharedElectronVersion:'44.4.5'}),{code:'BETA_REGISTRY_UNSAFE'});
 f.registry.warehouse.exe=path.join(f.root,'arbitrary.exe');f.save();assert.throws(()=>assertAgentRegistry(f.paths),{code:'BETA_REGISTRY_UNSAFE'});f.registry.warehouse.exe=process.execPath;
 f.registry.warehouse.root=path.join(f.root,'outside');f.save();assert.throws(()=>assertAgentRegistry(f.paths),{code:'BETA_REGISTRY_UNSAFE'});f.registry.warehouse.root=path.join(f.paths.programs,'warehouse','version','runtime');
 f.registry.sales.sharedElectron=true;f.registry.sales.exe=process.execPath;f.save();assert.throws(()=>assertAgentRegistry(f.paths),{code:'BETA_REGISTRY_UNSAFE'});delete f.registry.sales.sharedElectron;delete f.registry.sales.exe;
 f.registry.exporter.dataDir=path.join(f.root,'formal');f.save();assert.throws(()=>assertAgentRegistry(f.paths),{code:'BETA_REGISTRY_UNSAFE'});
});

test('service component arguments are fixed and registry flags cannot authorize an executable',t=>{
 const f=fixture(t),unbound=new ServiceManager({registryFile:f.paths.registryFile});assert.throws(()=>unbound.componentArgs('warehouse'),{code:'SHARED_ELECTRON_NOT_BOUND'});
 f.registry.warehouse.args=['--root=arbitrary'];f.save();const manager=guardAgentServices(new ServiceManager({registryFile:f.paths.registryFile}),f.paths);
 assert.deepEqual(manager.componentArgs('warehouse'),['--agent-component=warehouse']);assert.deepEqual(manager.componentArgs('exporter'),['--agent-component=exporter']);assert.deepEqual(manager.componentArgs('purchase'),[]);
});

test('shared native capabilities bind module identity, ASAR root, data, version and recorded PID',async t=>{
 const f=fixture(t),id='exporter',c=f.registry[id];fs.mkdirSync(path.join(c.root,'resources'),{recursive:true});fs.writeFileSync(path.join(c.root,'resources','app.asar'),'public component');fs.mkdirSync(c.dataDir,{recursive:true});
 let response;const server=http.createServer((_q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify(response));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeIdleConnections();server.close(resolve);}));
 const runtime={id:'lingtu-order-export',apiVersion:1,version:c.version,root:path.join(c.root,'resources','app.asar'),dataDir:c.dataDir,pid:process.pid,url:'http://127.0.0.1:'+server.address().port};const file=path.join(c.dataDir,'.integration-runtime.json'),saveRuntime=()=>fs.writeFileSync(file,JSON.stringify(runtime));response={...runtime};saveRuntime();
 const manager=guardAgentServices(new ServiceManager({registryFile:f.paths.registryFile}),f.paths);assert.equal((await manager.capabilities(id)).pid,process.pid);
 response={...runtime,pid:process.pid+1};await assert.rejects(manager.capabilities(id),{code:'SHARED_COMPONENT_IDENTITY_MISMATCH'});
 response={...runtime};runtime.root=path.join(f.root,'foreign','app.asar');saveRuntime();await assert.rejects(manager.capabilities(id),{code:'SHARED_COMPONENT_IDENTITY_MISMATCH'});
 runtime.root=response.root;runtime.version='2.0.0';saveRuntime();await assert.rejects(manager.capabilities(id),{code:'SHARED_COMPONENT_IDENTITY_MISMATCH'});
});

test('shared lifecycle ignores unrelated same-EXE host but blocks a recorded live component PID',async t=>{
 const f=fixture(t),config=f.registry.exporter;fs.mkdirSync(config.dataDir,{recursive:true});let recorded=null,requests=0;
 const services={registryFile:f.paths.registryFile,config:()=>config,componentArgs:()=>['--agent-component=exporter'],capabilities:async()=>recorded||{running:false},request:async()=>{requests++;}};
 const lifecycle=withElectronLifecycle({}, {services,backupRoot:path.join(f.root,'backups')});const backup=await lifecycle.backup('exporter');assert.deepEqual(backup.entries,[]);
 recorded={running:false,pid:process.pid};await assert.rejects(lifecycle.backup('exporter'),{code:'LEGACY_APP_RUNNING'});
 recorded={running:true,pid:process.pid};await assert.rejects(lifecycle.backup('exporter'),{code:'PROCESS_CHECK_FAILED'});assert.equal(requests,0);
});

test('v2 activation copies native ASARs and records only the trusted shared host',async t=>{
 const f=fixture(t),resources=path.join(f.root,'resources');fs.mkdirSync(resources);const payloadHashes={},put=(rel,bytes)=>{const file=path.join(resources,...rel.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);payloadHashes[rel]=hash(file);return file;};
 const modules={};for(const id of ['warehouse','purchase','sales','overview','exporter']){modules[id]={version:'1.0.0'};if(['warehouse','exporter'].includes(id)){const app='runtime/resources/app.asar',file=put('apps/'+id+'/'+app,'public-'+id);modules[id].runtime={kind:'shared-electron',app,sha256:hash(file)};}else put('apps/'+id+'/server.mjs','export const fixture=true;');}
 const components=[];for(const [id,name]of [['node-runtime','node.exe'],['browser-runtime','chrome.exe']]){const archive=id+'.zip',file=path.join(resources,'vendor',archive);fs.mkdirSync(path.dirname(file),{recursive:true});const zip=new yazl.ZipFile();zip.addBuffer(Buffer.from('public fixture runtime'),name);zip.end();await pipeline(zip.outputStream,fs.createWriteStream(file));const sha256=hash(file);payloadHashes['vendor/'+archive]=sha256;components.push({id,archive,sha256});}
 const manifest={format:'agent-beta-resources/v2',sharedElectron:{version:'44.7.0',components:['warehouse','exporter']},purchaseMobilePort:27380,modules,vendor:{components},payloadHashes},manifestFile=path.join(resources,'agent-beta-resources.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));const options={paths:f.paths,resourcesDir:resources,expectedManifestSha256:hash(manifestFile),isBusy:async()=>false};
 const first=await createAgentActivation(options)();assert.equal(first.ready,true);const registry=assertAgentRegistry(f.paths);
 for(const id of ['warehouse','exporter']){assert.equal(registry[id].exe,process.execPath);assert.equal(registry[id].sharedElectron,true);assert.ok(registry[id].root.startsWith(path.join(f.paths.programs,id)+path.sep));assert.equal(fs.existsSync(path.join(registry[id].root,'resources','app.asar')),true);assert.equal(fs.existsSync(path.join(registry[id].root,'WuchengAgentBeta'+(id==='warehouse'?'Warehouse':'Exporter')+'.exe')),false);}
 assert.equal((await createAgentActivation(options)()).reused,true);const before=fs.readFileSync(f.paths.registryFile);
 await assert.rejects(createAgentActivation({...options,paths:{...f.paths,sharedElectronVersion:'44.4.5'}})(),/共享 Electron/);assert.deepEqual(fs.readFileSync(f.paths.registryFile),before);
 const appFile=path.join(resources,'apps','warehouse','runtime','resources','app.asar');fs.writeFileSync(appFile,'tampered');await assert.rejects(createAgentActivation(options)(),/摘要不符/);assert.deepEqual(fs.readFileSync(f.paths.registryFile),before);
});
