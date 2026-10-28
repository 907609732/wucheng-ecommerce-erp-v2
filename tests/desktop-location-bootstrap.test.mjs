import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {getWorkbenchLocation,workbenchLocationFile} from '../desktop/shared/workbench-location.mjs';
import {requestedUserDataPath} from '../desktop/shared/user-data-path.mjs';

const source=fs.readFileSync(new URL('../desktop/main.mjs',import.meta.url),'utf8');
const start=source.indexOf('let startupLocation;'),end=source.indexOf('const desktopDir =');
assert(start>=0&&end>start,'Standalone desktop location bootstrap must precede app initialization');
// Execute only the actual pre-initialization location block with a fake Electron
// app. This cannot initialize the application, ledger, scheduler, CLI or MCP.
const bootstrap=new vm.Script('(async()=>{'+source.slice(start,end)+';return {profile:stableUserDataPath,registry:process.env.LINGTU_REGISTRY_PATH};})()');
function fixture(t){
  const created=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-location-bootstrap-')),root=fs.realpathSync.native(created);t.after(()=>{assert(path.basename(root).startsWith('desktop-location-bootstrap-'));assert.equal(fs.realpathSync.native(root),root);fs.rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});});
  const home=path.join(root,'home'),appData=path.join(root,'classic-appdata'),profile=path.join(root,'physical-profile'),registry=path.join(home,'Documents','LingtuWorkbench','registry.json'),identity={schemaVersion:1,serverId:randomUUID(),dataSetId:randomUUID()};
  fs.mkdirSync(path.join(profile,'workbench-server'),{recursive:true});fs.mkdirSync(path.dirname(registry),{recursive:true});fs.writeFileSync(registry,'{}');fs.writeFileSync(path.join(profile,'workbench-server','identity.json'),JSON.stringify(identity));fs.writeFileSync(workbenchLocationFile(home),JSON.stringify({schemaVersion:1,profile,registryFile:registry,serverId:identity.serverId,dataSetId:identity.dataSetId}));
  return {root,home,appData,profile,registry,identity};
}
async function run(f,{args=[],env={}}={}){
  const calls={mkdir:[],setPath:[],dialogs:[],errors:[]},context={
    path,fs:{mkdirSync:(file,options)=>{calls.mkdir.push(file);return fs.mkdirSync(file,options);}},
    app:{getPath:name=>{assert.equal(name,'appData');return f.appData;},whenReady:async()=>{},setPath:(name,file)=>calls.setPath.push({name,file})},
    dialog:{showErrorBox:(...args)=>calls.dialogs.push(args)},
    process:{argv:['fixture.exe',...args],env:{...env},stderr:{write:text=>calls.errors.push(text)},exit:code=>{throw Object.assign(Error('fixture app exited'),{code:'APP_EXIT',exitCode:code,calls});}},
    requestedUserDataPath,getWorkbenchLocation:(appData,options)=>getWorkbenchLocation(appData,{...options,home:f.home})
  };
  const result=await bootstrap.runInNewContext(context);return {result,calls,env:context.process.env};
}

test('original standalone GUI resolves the adopted physical host profile and registry',async t=>{
  const f=fixture(t),r=await run(f);assert.equal(r.result.profile,f.profile);assert.equal(r.result.registry,f.registry);assert.deepEqual(r.calls.setPath,[{name:'userData',file:f.profile}]);assert.equal(fs.existsSync(f.appData),false);
});

test('original source CLI and MCP inherit the same adopted host location',async t=>{
  const f=fixture(t);for(const mode of ['--cli','--mcp-stdio']){const r=await run(f,{args:[mode]});assert.equal(r.result.profile,f.profile);assert.equal(r.env.LINGTU_REGISTRY_PATH,f.registry);assert.equal(r.calls.errors.length,0);assert.equal(r.calls.dialogs.length,0);}
});

test('managed warehouse explicit profile and explicit registry keep precedence over an unrelated invalid marker',async t=>{
  const f=fixture(t),managed=path.join(f.root,'managed-data'),explicitRegistry=path.join(f.root,'explicit-registry.json');fs.mkdirSync(managed);fs.writeFileSync(workbenchLocationFile(f.home),'{bad');
  const r=await run(f,{args:['--managed-module=warehouse','--user-data-dir='+managed],env:{LINGTU_REGISTRY_PATH:explicitRegistry}});assert.equal(r.result.profile,managed);assert.equal(r.env.LINGTU_REGISTRY_PATH,explicitRegistry);assert.equal(r.calls.dialogs.length,0);assert.equal(r.calls.errors.length,0);
});

test('invalid or changed bound marker exits before creating a default profile for GUI, CLI and MCP',async t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.profile,'workbench-server','identity.json'));
  for(const args of [[],['--cli','status'],['--mcp-stdio']]){
    await assert.rejects(run(f,{args}),error=>{assert.equal(error.code,'APP_EXIT');assert.equal(error.exitCode,1);assert.deepEqual(error.calls.mkdir,[]);assert.deepEqual(error.calls.setPath,[]);assert.equal(error.calls.dialogs.length,args.length?0:1);assert.equal(error.calls.errors.length,args.length?1:0);return true;});
  }
  assert.equal(fs.existsSync(f.appData),false);
});

test('ordinary new standalone installs without a marker retain the prior default path',async t=>{
  const f=fixture(t);fs.unlinkSync(workbenchLocationFile(f.home));const r=await run(f);assert.equal(r.result.profile,path.join(f.appData,'wucheng-ecommerce-erp-v2'));assert.equal(r.env.LINGTU_REGISTRY_PATH,path.join(f.appData,'LingtuIntegrations','registry.json'));
});
