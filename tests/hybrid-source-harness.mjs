import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {privateProfileEnvironment} from '../desktop/agent-runtime/engine-common.mjs';

// This manual QA launcher is deliberately separate from the production/Beta
// launcher. It never creates a packaging proof or changes a user's registry.
if(!process.argv.includes('--launch')){
  console.log('Prepared only. After the implementation freeze: node tests/hybrid-source-harness.mjs --launch');
}else{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const electron=path.join(root,'node_modules','electron','dist','electron.exe');
  if(process.platform!=='win32'||!fs.existsSync(electron))throw Error('This fixture needs the already installed Windows Electron runtime. It does not install dependencies.');
  const ids=['purchase','sales','overview'],fixtureRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'wucheng-hybrid-source-harness-')));
  const nonce=randomUUID(),output=path.join(root,'.codex-artifacts','hybrid-source-harness',nonce),registryFile=path.join(fixtureRoot,'fixture-registry.json');
  fs.mkdirSync(output,{recursive:true});
  const allocated=new Set(),configs={};
  const freePort=async()=>{
    for(let attempt=0;attempt<10;attempt++){
      const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
      if(!allocated.has(port)&&!(port>=17800&&port<=17999)&&!(port>=27300&&port<=27499)){allocated.add(port);return port;}
    }
    throw Error('Could not allocate an independent fixture port');
  };
  const manifest={schemaVersion:1,purpose:'hybrid-source-manual-acceptance',nonce,root,fixtureRoot,registryFile,output,scope:'Real source Electron and three HTTP services, synthetic temporary books, no company model credentials; not a packaged Beta'};
  let manager,child,exitCode=1;
  try{
    for(const name of Object.keys(process.env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)|^(?:CODEX_HOME|HERMES_HOME|LINGTU_REGISTRY_PATH|LINGTU_WORKBENCH_POLICY_FILE)$/i.test(name))delete process.env[name];
    Object.assign(process.env,privateProfileEnvironment(path.join(fixtureRoot,'private-home')));
    for(const id of ids){
      const folder=path.join(root,'apps',id),pkg=JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8'));
      configs[id]={root:folder,dataDir:path.join(fixtureRoot,'data',id),port:await freePort(),managed:true,allowInitialize:false,nodePath:process.execPath,version:pkg.version,...(id==='purchase'?{mobilePort:await freePort()}:{} )};
      if(!fs.existsSync(path.join(folder,'node_modules','express')))throw Error(id+' source dependencies are missing; no fallback to an installed/formal app is allowed');
    }
    // These variables affect this short-lived fixture process and its children.
    process.env.OVERVIEW_PURCHASE_DB=path.join(configs.purchase.dataDir,'purchases.sqlite');
    process.env.OVERVIEW_SALES_DB=path.join(configs.sales.dataDir,'sales.sqlite');
    for(const id of ids){
      const storeFile=path.join(configs[id].root,'lib',id==='sales'?'db.mjs':'store.mjs');
      const {openStore}=await import(pathToFileURL(storeFile).href),store=openStore(configs[id].dataDir);store.close();
    }
    fs.writeFileSync(registryFile,JSON.stringify(configs,null,2),{flag:'wx'});
    fs.writeFileSync(path.join(fixtureRoot,'fixture-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
    manager=new ServiceManager({registryFile,agentManaged:true});
    const actual=[];
    for(const id of ids){const cap=await manager.ensure(id);actual.push({module:id,url:cap.url,dataDir:configs[id].dataDir,version:cap.version});}
    let sourceCommit=null;try{sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();}catch{}
    fs.writeFileSync(path.join(output,'launch.json'),JSON.stringify({...manifest,sourceCommit,services:actual,executedChecks:[],acceptancePassed:false},null,2));
    const env={...process.env};
    for(const name of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)|^(?:CODEX_HOME|HERMES_HOME|ELECTRON_RUN_AS_NODE|LINGTU_REGISTRY_PATH|LINGTU_WORKBENCH_POLICY_FILE)$/i.test(name))delete env[name];
    env.HYBRID_SOURCE_FIXTURE_ROOT=fixtureRoot;
    const log=fs.openSync(path.join(output,'electron.log'),'a');
    try{child=spawn(electron,[path.join(root,'tests','fixtures','hybrid-source-electron')],{cwd:root,env,windowsHide:true,stdio:['ignore',log,log],shell:false});}finally{fs.closeSync(log);}
    const stop=()=>{if(child?.exitCode===null)child.kill();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    console.log(JSON.stringify({scope:manifest.scope,fixtureRoot,output,windowTitle:'五成 ERP · 三合一隔离验收',pid:child.pid,acceptancePassed:false}));
    exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
  }finally{
    const cleanup=[];
    for(const id of ids)if(manager&&configs[id])try{cleanup.push({module:id,result:await manager.stop(id)});}catch(error){cleanup.push({module:id,error:error.message});}
    fs.writeFileSync(path.join(output,'session-closed.json'),JSON.stringify({scope:manifest.scope,exitCode,cleanup,acceptancePassed:false,note:'Closure is not a pass. Root must record the actual native/manual results. Temporary evidence is retained.'},null,2));
    process.exitCode=exitCode;
  }
}
