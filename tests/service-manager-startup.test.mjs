import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fork,execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {ServiceManager as ExtensionServiceManager} from '../desktop/extensions/lingtu-desks/service-manager.mjs';
import {installBundledDesks} from '../desktop/shared/install-desks.mjs';

const managerUrl=new URL('../desktop/shared/service-manager.mjs',import.meta.url).href;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw Error('isolated startup observation timed out');await sleep(20);}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function fixture(t,scenario={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-startup-test-')),dataDir=path.join(root,'data'),registryFile=path.join(root,'registry.json'),port=await freePort(),workers=[];
 fs.mkdirSync(dataDir);fs.mkdirSync(path.join(root,'node_modules','express'),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'wucheng-sales-desk',version:'0.0.1',type:'module'}));
 fs.writeFileSync(path.join(dataDir,'sales.sqlite'),'unchanged isolated ledger sentinel');
 fs.writeFileSync(path.join(root,'scenario.json'),JSON.stringify({delayMs:300,...scenario}));
 fs.writeFileSync(registryFile,JSON.stringify({sales:{root,dataDir,port,managed:true,version:'0.0.1',nodePath:process.execPath,allowInitialize:false}}));
 fs.writeFileSync(path.join(root,'server.mjs'),`import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),dataDir=process.env.SALES_DATA_DIR,port=Number(process.env.SALES_PORT),scenario=JSON.parse(fs.readFileSync(path.join(root,'scenario.json'),'utf8'));
fs.appendFileSync(path.join(root,'spawns.jsonl'),JSON.stringify({pid:process.pid})+'\\n');
if(scenario.exitCode)setTimeout(()=>process.exit(scenario.exitCode),scenario.delayMs);else setTimeout(()=>http.createServer((q,r)=>{const current=JSON.parse(fs.readFileSync(path.join(root,'scenario.json'),'utf8'));r.setHeader('Content-Type','application/json');r.end(JSON.stringify({id:current.wrongIdentity?'foreign-service':'wucheng-sales-desk',apiVersion:1,version:'0.0.1',root,dataDir,url:'http://127.0.0.1:'+port,pid:process.pid,busy:!!current.busy}));}).listen(port,'127.0.0.1'),scenario.delayMs);
`);
 fs.writeFileSync(path.join(root,'worker.mjs'),`const {ServiceManager}=await import(process.argv[2]);const manager=new ServiceManager({registryFile:process.argv[3],startupTimeoutMs:Number(process.argv[4]),startupPollMs:20});process.on('message',async message=>{if(message!=='run')return;let result;try{result={cap:await manager.ensure('sales')};}catch(e){result={error:e.message,code:e.code};}process.send({result},()=>process.disconnect());});process.send({ready:true});`);
 const starts=()=>fs.existsSync(path.join(root,'spawns.jsonl'))?fs.readFileSync(path.join(root,'spawns.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 t.after(async()=>{
  for(const child of workers)if(child.exitCode===null)child.kill();
  const ownedPids=new Set(starts().map(row=>row.pid));try{const record=JSON.parse(fs.readFileSync(path.join(dataDir,'.integration-start.lock'),'utf8'));if(record.childPid)ownedPids.add(record.childPid);}catch{}
  for(const pid of ownedPids)if(alive(pid))try{process.kill(pid);}catch{}
  await sleep(100);
  assert.equal(fs.readFileSync(path.join(dataDir,'sales.sqlite'),'utf8'),'unchanged isolated ledger sentinel');
  const temporaryRoot=path.resolve(os.tmpdir())+path.sep;
  assert.ok(path.resolve(root).startsWith(temporaryRoot)&&path.basename(root).startsWith('lingtu-startup-test-'));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});
 });
 return {root,dataDir,registryFile,port,starts,workers,scenario(value){fs.writeFileSync(path.join(root,'scenario.json'),JSON.stringify({delayMs:100,...value}));},manager(options={}){return new ServiceManager({registryFile,startupTimeoutMs:3000,startupPollMs:20,...options});},lock(){return JSON.parse(fs.readFileSync(path.join(dataDir,'.integration-start.lock'),'utf8'));}};
}
function worker(f,timeout=3000){
 const child=fork(path.join(f.root,'worker.mjs'),[managerUrl,f.registryFile,String(timeout)],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});f.workers.push(child);
 let readyResolve,resultResolve,resultReject,finished=false,stderr='';
 const ready=new Promise(resolve=>{readyResolve=resolve;}),result=new Promise((resolve,reject)=>{resultResolve=resolve;resultReject=reject;}),exited=new Promise(resolve=>child.once('exit',resolve));
 child.stderr.on('data',data=>{stderr+=data;});
 child.on('message',message=>{if(message.ready)readyResolve();if(message.result){finished=true;resultResolve(message.result);}});
 child.once('error',resultReject);child.once('exit',(code)=>{if(!finished)resultReject(Error('isolated launcher exited '+code+': '+stderr));});
 return {child,ready,result,exited,run(){child.send('run');return result;}};
}

test('startup wait defaults to 90 seconds, is bounded, and extensions use the shared lifecycle',()=>{
 assert.equal(new ServiceManager({registryFile:path.join(os.tmpdir(),'unused-startup-test-registry.json')}).startupTimeoutMs,90000);
 for(const startupTimeoutMs of [0,49,300001,Infinity])assert.throws(()=>new ServiceManager({startupTimeoutMs}),/等待配置无效/);
 assert.equal(ExtensionServiceManager,ServiceManager);
});

test('same-manager concurrent ensure waits for one delayed service and keeps busy protection',async t=>{
 const f=await fixture(t,{delayMs:500}),manager=f.manager();
 const caps=await Promise.all(Array.from({length:4},()=>manager.ensure('sales')));
 assert.equal(f.starts().length,1);assert.ok(caps.every(cap=>cap.pid===caps[0].pid));
 f.scenario({busy:true});await assert.rejects(manager.stop('sales'),/正在执行任务/);
});

test('independent launcher processes share the same cold startup child',async t=>{
 const f=await fixture(t,{delayMs:650}),a=worker(f),b=worker(f);
 await Promise.all([a.ready,b.ready]);const [first,second]=await Promise.all([a.run(),b.run()]);
 assert.ifError(first.error);assert.ifError(second.error);assert.equal(first.cap.pid,second.cap.pid);assert.equal(f.starts().length,1);
});

test('a timeout retains the live child and later managers reuse it',async t=>{
 const f=await fixture(t,{delayMs:600}),manager=f.manager({startupTimeoutMs:100});
 await assert.rejects(manager.ensure('sales'),e=>e.code==='SERVICE_START_TIMEOUT');
 const retained=f.lock();assert.ok(alive(retained.childPid));
 const [first,second]=await Promise.all([f.manager().ensure('sales'),manager.ensure('sales').catch(e=>e)]);
 assert.equal(first.pid,retained.childPid);assert.equal(f.starts().length,1);
 assert.ok(second.pid===first.pid||second.code==='SERVICE_START_TIMEOUT');
});

test('the child is reused after the launcher that timed out has exited',async t=>{
 const f=await fixture(t,{delayMs:900}),launch=worker(f,100);await launch.ready;
 const result=await launch.run();assert.equal(result.code,'SERVICE_START_TIMEOUT');await launch.exited;
 const retained=f.lock();assert.ok(alive(retained.childPid));assert.equal(alive(retained.ownerPid),false);
 const cap=await f.manager().ensure('sales');assert.equal(cap.pid,retained.childPid);assert.equal(f.starts().length,1);
});

test('a child exit reports failure and a deliberate retry can start a replacement',async t=>{
 const f=await fixture(t,{delayMs:100,exitCode:17}),manager=f.manager();
 await assert.rejects(manager.ensure('sales'),/启动进程已退出.*17/);
 assert.equal(f.starts().length,1);f.scenario({});const cap=await manager.ensure('sales');
 assert.equal(f.starts().length,2);assert.equal(cap.pid,f.starts()[1].pid);
});

test('late failure after timeout can be retried without a permanently held owner lock',async t=>{
 const f=await fixture(t,{delayMs:250,exitCode:17}),manager=f.manager({startupTimeoutMs:100});
 await assert.rejects(manager.ensure('sales'),e=>e.code==='SERVICE_START_TIMEOUT');
 await sleep(450);assert.equal(alive(f.lock().childPid),false);f.scenario({});
 const cap=await f.manager().ensure('sales');assert.equal(f.starts().length,2);assert.equal(cap.pid,f.starts()[1].pid);
});

test('capability identity mismatch still fails closed and never causes a second spawn',async t=>{
 const f=await fixture(t,{wrongIdentity:true}),manager=f.manager();
 await assert.rejects(manager.ensure('sales'),/服务身份或数据目录不符/);
 await assert.rejects(f.manager().ensure('sales'),/服务身份或数据目录不符/);assert.equal(f.starts().length,1);
});

test('an active startup with a different target version is not replaced',async t=>{
 const f=await fixture(t,{delayMs:700});await assert.rejects(f.manager({startupTimeoutMs:100}).ensure('sales'),e=>e.code==='SERVICE_START_TIMEOUT');
 const registry=JSON.parse(fs.readFileSync(f.registryFile,'utf8'));registry.sales.version='0.0.2';fs.writeFileSync(f.registryFile,JSON.stringify(registry));
 await assert.rejects(f.manager().ensure('sales'),/另一个版本或配置/);await until(()=>f.starts().length===1);assert.equal(f.starts().length,1);
});

test('legacy live launcher locks remain protected, but dead launcher locks can be reclaimed',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.dataDir,'.integration-start.lock'),String(process.pid));
 await assert.rejects(f.manager({startupTimeoutMs:100}).ensure('sales'),e=>e.code==='SERVICE_START_TIMEOUT');assert.equal(f.starts().length,0);
 fs.writeFileSync(path.join(f.dataDir,'.integration-start.lock'),'2147483647');
 const cap=await f.manager().ensure('sales');assert.equal(cap.version,'0.0.1');assert.equal(f.starts().length,1);
});

test('a native standalone first launch can create its program-owned data directory',async t=>{
 const f=await fixture(t),nativeDir=path.join(f.root,'native-data'),registry=JSON.parse(fs.readFileSync(f.registryFile,'utf8'));
 registry.exporter={root:f.root,dataDir:nativeDir,exe:process.execPath,managed:false};fs.writeFileSync(f.registryFile,JSON.stringify(registry));
 assert.equal(fs.existsSync(nativeDir),false);const result=await f.manager().ensure('exporter');
 assert.equal(result.opened,true);const record=JSON.parse(fs.readFileSync(path.join(nativeDir,'.integration-start.lock'),'utf8'));
 t.after(()=>{if(alive(record.childPid))try{process.kill(record.childPid);}catch{}});
 assert.ok(record.childPid);assert.equal(fs.existsSync(path.join(nativeDir,'purchases.sqlite')),false);
});

test('a missing original business ledger still blocks startup without creating an empty replacement',async t=>{
 const f=await fixture(t),file=path.join(f.dataDir,'sales.sqlite');fs.unlinkSync(file);
 try{await assert.rejects(f.manager().ensure('sales'),/原账本不存在/);assert.equal(fs.existsSync(file),false);assert.equal(f.starts().length,0);}
 finally{fs.writeFileSync(file,'unchanged isolated ledger sentinel');}
});

test('default registry and policy follow one physical marker while explicit overrides bypass it',async t=>{
 const f=await fixture(t),home=path.join(f.root,'isolated-home'),virtualAppData=path.join(f.root,'virtual-appdata'),physicalProfile=path.join(f.root,'physical-profile'),marker=path.join(home,'Documents','LingtuWorkbench','workbench-location.json');
 fs.mkdirSync(path.dirname(marker),{recursive:true});fs.mkdirSync(physicalProfile);
 const run=(options={},overrides={})=>{
  const env={...process.env,APPDATA:virtualAppData,LINGTU_TEST_HOME:home,LINGTU_TEST_MANAGER_URL:managerUrl,LINGTU_TEST_OPTIONS:JSON.stringify(options)};
  delete env.LINGTU_REGISTRY_PATH;delete env.LINGTU_WORKBENCH_POLICY_FILE;Object.assign(env,overrides);
  const code=`import os from 'node:os';os.homedir=()=>process.env.LINGTU_TEST_HOME;const {ServiceManager}=await import(process.env.LINGTU_TEST_MANAGER_URL);try{const m=new ServiceManager(JSON.parse(process.env.LINGTU_TEST_OPTIONS));console.log(JSON.stringify({registryFile:m.registryFile,policyFile:m.policyFile}));}catch(e){console.log(JSON.stringify({error:e.message,code:e.code}));}`;
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env,windowsHide:true,encoding:'utf8'}));
 };
 const legacy=run();assert.equal(legacy.registryFile,path.join(virtualAppData,'LingtuIntegrations','registry.json'));assert.equal(legacy.policyFile,path.join(virtualAppData,'wucheng-ecommerce-erp-v2','workbench-server','access-policy.json'));
 fs.writeFileSync(marker,JSON.stringify({schemaVersion:1,profile:physicalProfile,registryFile:f.registryFile}));
 const physical=run();assert.equal(physical.registryFile,f.registryFile);assert.equal(physical.policyFile,path.join(physicalProfile,'workbench-server','access-policy.json'));
 fs.writeFileSync(marker,'{broken');assert.equal(run().code,'WORKBENCH_LOCATION_INVALID');
 const explicit=run({registryFile:f.registryFile,policyFile:path.join(f.root,'explicit-policy.json')},{LINGTU_REGISTRY_PATH:path.join(f.root,'ignored-env-registry.json')});
 assert.equal(explicit.registryFile,f.registryFile);assert.equal(explicit.policyFile,path.join(f.root,'explicit-policy.json'));
 const environment=run({},{LINGTU_REGISTRY_PATH:f.registryFile,LINGTU_WORKBENCH_POLICY_FILE:path.join(f.root,'env-policy.json')});assert.equal(environment.registryFile,f.registryFile);assert.equal(environment.policyFile,path.join(f.root,'env-policy.json'));
 assert.equal(f.starts().length,0);
});

test('the installed bundled extension imports its complete location-helper dependency chain',async t=>{
 const f=await fixture(t),workspace=path.join(f.root,'extension-workspace'),settingsPath=path.join(f.root,'extension-settings.json');
 installBundledDesks({source:fileURLToPath(new URL('../desktop/extensions/lingtu-desks',import.meta.url)),workspace,settingsPath});
 const entry=pathToFileURL(path.join(workspace,'extensions','lingtu-desks','extension.mjs')).href;
 const code=`const {actions}=await import(process.env.LINGTU_TEST_EXTENSION_URL);console.log(JSON.stringify(Object.keys(actions).sort()));`;
 const result=execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,LINGTU_REGISTRY_PATH:f.registryFile,LINGTU_TEST_EXTENSION_URL:entry},windowsHide:true,encoding:'utf8'});
 assert.deepEqual(JSON.parse(result),['prepare','query','start','status','stop']);assert.equal(f.starts().length,0);
});
