import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createCipheriv,createDecipheriv,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {TailnetRuntime,tailnetPaths,tailnetDescriptor,tailnetAtomic,tailnetAlive,tailnetStatus,existingTailnetRuntimes,tailnetFailure} from '../desktop/workbench-client/tailnet-runtime.mjs';
import {createTailnetBroker,createTailnetStdioEngine} from '../desktop/workbench-client/tailnet-broker.mjs';
import {readTailnetBrokerInit} from '../desktop/workbench-client/tailnet-broker-entry.mjs';
import {Readable,Writable,PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createPackage} from '@electron/asar';

const origin='https://fixture.test-tail.ts.net:8443';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const runtimeURL=new URL('../desktop/workbench-client/tailnet-runtime.mjs',import.meta.url).href;
const brokerURL=new URL('../desktop/workbench-client/tailnet-broker.mjs',import.meta.url).href;
const entryURL=new URL('../desktop/workbench-client/tailnet-broker-entry.mjs',import.meta.url).href;
function cryptoFor(key){return {
 encrypt(plain){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},
 decrypt(bytes){const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');}
};}
async function until(fn,message,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await pause(25);}throw Error(message);}
function request(base,route,{headers={},body={},method='POST'}={}){return new Promise((resolve,reject)=>{
 const bytes=Buffer.from(JSON.stringify(body)),q=http.request(base+route,{method,agent:false,headers:{...headers,...(method==='POST'?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{})}},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(text),headers:r.headers}));});q.on('error',reject);q.end(method==='POST'?bytes:undefined);
});}

async function fixture(t){
 const created=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-tailnet-broker-')),dir=fs.realpathSync.native(created),profile=path.join(dir,'profile');fs.mkdirSync(profile);
 const key=randomBytes(32),secure=cryptoFor(key),countFile=path.join(dir,'engines.jsonl'),initDelayFile=path.join(dir,'init-delay'),engineFile=path.join(dir,'fake-engine.mjs'),entryFile=path.join(dir,'fake-broker.mjs'),sidecarPath=path.join(dir,'fixture-sidecar.exe'),workers=new Set(),runtimes=[];
 fs.writeFileSync(sidecarPath,'isolated test marker; never executed');
 fs.writeFileSync(engineFile,`
import fs from 'node:fs';import http from 'node:http';import readline from 'node:readline';import {randomBytes} from 'node:crypto';
fs.appendFileSync(${JSON.stringify(countFile)},JSON.stringify({pid:process.pid,argv:process.argv,unsafeEnv:Object.keys(process.env).filter(k=>/^TS_|^TSNET_|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$|^NODE_PATH$|^NODE_EXTRA_CA_CERTS$|^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(k))})+'\\n');
let initialized=false,nonce,origin,state='stopped',server,realm='LingtuTailnet/'+randomBytes(16).toString('hex');
const rl=readline.createInterface({input:process.stdin});
function status(){return{protocolVersion:1,state,origin,proxyURL:'http://127.0.0.1:'+server.address().port,proxyUsername:'workbench',proxyRealm:realm,prototypeOnly:true,...(state==='needs-login'?{loginURL:'https://login.tailscale.com/a/fixture_token'}:{})};}
rl.on('line',async line=>{const q=JSON.parse(line);let result,error;
 if(!initialized){if(q.op!=='init')error='INIT_REQUIRED';else{if(fs.existsSync(${JSON.stringify(initDelayFile)}))await new Promise(r=>setTimeout(r,Number(fs.readFileSync(${JSON.stringify(initDelayFile)},'utf8'))));nonce=q.nonce;origin=q.origin;server=http.createServer((_q,r)=>{r.writeHead(403);r.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));initialized=true;result=status();}}
 else if(q.nonce!==nonce)error='NONCE_MISMATCH';
 else{if(q.op==='start')state='running';if(q.op==='login')state='needs-login';if(q.op==='logout')state='logged-out';if(q.op==='stop'||q.op==='shutdown')state='stopped';result=status();}
 process.stdout.write(JSON.stringify({v:1,id:q.id,ok:!error,...(error?{error:{code:error,message:'private synthetic detail'}}:{result})})+'\\n',()=>{if(q.op==='shutdown')server.close(()=>{rl.close();process.stdin.destroy();});});
});
process.stdin.on('end',()=>{if(server)server.close();});
`);
 fs.writeFileSync(entryFile,`
import {spawn} from 'node:child_process';import {createTailnetStdioEngine} from ${JSON.stringify(brokerURL)};import {runTailnetBrokerEntry} from ${JSON.stringify(entryURL)};
runTailnetBrokerEntry({engineFactory:config=>createTailnetStdioEngine(config,{spawnImpl:(_file,_args,options)=>spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(engineFile)}],options)})}).catch(()=>{process.exitCode=1;});
`);
 const options={profile,origin,sidecarPath,execPath:process.execPath,brokerEntry:entryFile,...secure,startupTimeoutMs:15000};
 const manager=(extra={})=>{const m=new TailnetRuntime({...options,...extra});runtimes.push(m);return m;};
 const engines=()=>fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
 const workerFile=path.join(dir,'worker.mjs');fs.writeFileSync(workerFile,`
import {TailnetRuntime} from ${JSON.stringify(runtimeURL)};import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
const key=Buffer.from(process.env.TAILNET_FIXTURE_KEY,'hex'),encrypt=plain=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(plain,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);},decrypt=bytes=>{const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');};
try{const runtime=new TailnetRuntime({...JSON.parse(process.env.TAILNET_FIXTURE_OPTIONS),encrypt,decrypt});const c=await runtime.connection();process.send({ok:true,brokerId:c.brokerId,proxyURL:c.proxyURL});}catch(e){process.send({ok:false,code:e.code,message:e.message});}finally{process.disconnect();}
`);
 async function worker({runtimeOptions={},workerExecPath=process.execPath,runAsNode=false}={}){
  const {encrypt:_,decrypt:__,...serializable}={...options,...runtimeOptions};
  const child=spawn(workerExecPath,[workerFile],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,...(runAsNode?{ELECTRON_RUN_AS_NODE:'1'}:{}),TAILNET_FIXTURE_KEY:key.toString('hex'),TAILNET_FIXTURE_OPTIONS:JSON.stringify(serializable)}});workers.add(child);child.stderr.on('data',()=>{});
  const result=await new Promise((resolve,reject)=>{let received;child.once('message',m=>{received=m;});child.once('error',reject);child.once('exit',code=>{workers.delete(child);if(code!==0||!received)reject(Error('fixture worker exited '+code));else resolve(received);});});assert.equal(result.ok,true,JSON.stringify(result));return result;
 }
 t.after(async()=>{
  for(const child of workers)if(child.exitCode===null)child.kill();
  for(const runtime of runtimes){try{await runtime.shutdown();}catch{}}
  // Only PIDs created by this isolated fixture are eligible for cleanup.
  const ownDescriptors=[];for(const root of [profile,...runtimes.map(m=>m.paths.profile)]){const base=path.join(root,'tailnet-runtime');if(fs.existsSync(base))for(const name of fs.readdirSync(base)){try{ownDescriptors.push(JSON.parse(fs.readFileSync(path.join(base,name,'broker-ready.json'),'utf8')));}catch{}}}
  for(const descriptor of ownDescriptors){for(const pid of [descriptor.goPid,descriptor.pid])if(tailnetAlive(pid))try{process.kill(pid);}catch{}}
  for(const engine of engines())if(tailnetAlive(engine.pid))try{process.kill(engine.pid);}catch{}
  await until(()=>engines().every(e=>!tailnetAlive(e.pid)),'owned fake engine failed to exit');
  assert(path.basename(dir).startsWith('workbench-tailnet-broker-'));assert.equal(fs.realpathSync.native(dir),dir);fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 return {dir,profile,key,secure,options,manager,worker,engines,entryFile,sidecarPath,initDelayFile};
}

test('same manager and independent managers reuse one inert broker and child',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager(),b=f.manager();
 const states=await Promise.all([a.ensure(),a.ensure(),b.ensure(),b.ensure()]);
 assert.equal(new Set(states.map(s=>s.record.brokerId)).size,1);assert.equal(f.engines().length,1);
 assert.equal((await a.status()).state,'stopped');assert.equal((await b.start()).state,'running');assert.equal((await a.login()).state,'needs-login');assert.equal((await b.logout()).state,'logged-out');assert.equal((await a.stop()).state,'stopped');
 const connection=await b.connection(),record=states[0].record;assert.equal(connection.proxyPassword,record.proxyPassword);assert.equal(connection.brokerId,record.brokerId);assert(!('proxyPassword' in await a.status()));
 const disk=fs.readFileSync(a.paths.record).toString('utf8');for(const secret of [record.controlToken,record.proxyPassword,record.nonce]){assert(!disk.includes(secret));assert(!fs.readFileSync(a.paths.ready,'utf8').includes(secret));assert(!JSON.stringify(f.engines()).includes(secret));}
 assert.deepEqual(f.engines()[0].unsafeEnv,[]);
});

test('independent parent processes race once and reuse broker after both parents exit',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager();const [first,second]=await Promise.all([f.worker(),f.worker()]);
 assert.equal(first.brokerId,second.brokerId);assert.equal(f.engines().length,1);
 const connection=await a.connection();assert.equal(connection.brokerId,first.brokerId);assert.equal(f.engines().length,1);assert.equal((await a.status()).state,'stopped');
});

test('bundled Electron executes an ASAR broker entry without a system Node broker or archive cwd',{timeout:35000},async t=>{
 const f=await fixture(t),source=path.join(f.dir,'asar-source'),archive=path.join(f.dir,'fixture.asar');fs.mkdirSync(source);fs.copyFileSync(f.entryFile,path.join(source,'broker.mjs'));await createPackage(source,archive);
 const runtimeOptions={execPath:path.resolve('node_modules/electron/dist/electron.exe'),brokerEntry:path.join(archive,'broker.mjs')},runtime=f.manager(runtimeOptions);
 await f.worker({runtimeOptions,workerExecPath:runtimeOptions.execPath,runAsNode:true});
 assert.equal((await runtime.status()).state,'stopped');assert.equal(f.engines().length,1);const {descriptor}=await runtime.ensure();assert(tailnetAlive(descriptor.pid));
 // The injected engine stays synthetic; only the broker uses bundled Electron.
 assert.equal(f.engines()[0].argv[0],process.execPath);
});

test('origin and physical profile are independent scopes; encrypted records cannot be copied',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager(),b=f.manager({origin:'https://other.test-tail.ts.net:8443'}),otherProfile=path.join(f.dir,'other-profile');fs.mkdirSync(otherProfile);const c=f.manager({profile:otherProfile});
 const [x,y]=await Promise.all([a.ensure(),b.ensure()]);assert.notEqual(x.record.brokerId,y.record.brokerId);assert.equal(f.engines().length,2);
 fs.mkdirSync(c.paths.directory,{recursive:true});fs.copyFileSync(a.paths.record,c.paths.record);
 await assert.rejects(c.ensure(),{code:'TAILNET_RUNTIME_UNCERTAIN'});assert.equal(f.engines().length,2);
});

test('wrong decrypt and missing ready state fail closed without creating another child',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager();await a.ensure();const wrong=f.manager(cryptoFor(randomBytes(32)));
 await assert.rejects(wrong.ensure(),{code:'TAILNET_RUNTIME_UNCERTAIN'});assert.equal(f.engines().length,1);
 const ready=fs.readFileSync(a.paths.ready);fs.unlinkSync(a.paths.ready);await assert.rejects(a.ensure(),{code:'TAILNET_RUNTIME_UNCERTAIN'});assert.equal(f.engines().length,1);fs.writeFileSync(a.paths.ready,ready);
});

test('stale loopback process cannot receive Bearer without a valid fresh proof',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager(),{record,descriptor}=await a.ensure();let authHeaders=0,proofs=0;
 const impostor=http.createServer((q,r)=>{if(q.headers.authorization)authHeaders++;proofs++;r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({v:1,brokerId:record.brokerId,profileKey:a.paths.profileKey,origin,pid:descriptor.pid,mac:'0'.repeat(64)}));});await new Promise(r=>impostor.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>impostor.close(r)));
 const original=fs.readFileSync(a.paths.ready);tailnetAtomic(a.paths.ready,JSON.stringify(tailnetDescriptor(record,{...descriptor,url:'http://127.0.0.1:'+impostor.address().port})));
 try{await assert.rejects(a.start(),{code:'TAILNET_RUNTIME_UNCERTAIN'});assert.equal(proofs,1);assert.equal(authHeaders,0);assert.equal(f.engines().length,1);}finally{fs.writeFileSync(a.paths.ready,original);}
});

test('a trickling proof response is bounded by an absolute deadline and receives no credentials',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager(),{record,descriptor}=await a.ensure();a.requestTimeoutMs=200;let authHeaders=0;
 const impostor=http.createServer((q,r)=>{if(q.headers.authorization)authHeaders++;r.writeHead(200,{'Content-Type':'application/json'});r.write('{');const interval=setInterval(()=>r.write(' '),30);r.once('close',()=>clearInterval(interval));});await new Promise(r=>impostor.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{impostor.closeAllConnections();impostor.close(r);}));
 const original=fs.readFileSync(a.paths.ready);tailnetAtomic(a.paths.ready,JSON.stringify(tailnetDescriptor(record,{...descriptor,url:'http://127.0.0.1:'+impostor.address().port})));
 try{const started=Date.now();await assert.rejects(a.start(),{code:'TAILNET_RUNTIME_UNCERTAIN'});assert(Date.now()-started<1500);assert.equal(authHeaders,0);assert.equal(f.engines().length,1);}finally{fs.writeFileSync(a.paths.ready,original);a.requestTimeoutMs=45000;}
});

test('broker RPC rejects browser origins, wrong host, missing auth and arbitrary operations',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager(),{record,descriptor}=await a.ensure(),headers={Authorization:'Bearer '+record.controlToken};
 assert.equal((await request(descriptor.url,'/rpc/status')).status,401);
 assert.equal((await request(descriptor.url,'/rpc/status',{headers:{Authorization:'Bearer '+ 'é'.repeat(64)}})).status,401);
 assert.equal((await request(descriptor.url,'/rpc/status',{headers:{...headers,Origin:'null'}})).status,403);
 assert.equal((await request(descriptor.url,'/rpc/status',{headers:{...headers,Host:'attacker.invalid'}})).status,403);
 assert.equal((await request(descriptor.url,'/rpc/execute',{headers})).status,400);
 assert.equal((await request(descriptor.url,'/rpc/start',{headers,body:{target:'unlisted'}})).status,400);
 assert.equal((await request(descriptor.url,'/rpc/status?extra=true',{headers})).status,400);
 assert.equal((await request(descriptor.url,'/proof?challenge=short',{method:'GET'})).status,400);
 const ok=await request(descriptor.url,'/rpc/status',{headers});assert.equal(ok.status,200);assert.equal(ok.headers['access-control-allow-origin'],undefined);assert.equal(ok.headers['cache-control'],'no-store');assert(!JSON.stringify(ok.body).includes(record.proxyPassword));assert.equal(ok.body.result.state,'stopped');
});

test('initialization timeout preserves an uncertain owner and later reuses that same child',{timeout:35000},async t=>{
 const f=await fixture(t);fs.writeFileSync(f.initDelayFile,'1000');const a=f.manager({startupTimeoutMs:200});
 await assert.rejects(a.ensure(),{code:'TAILNET_RUNTIME_UNCERTAIN'});assert(fs.existsSync(a.paths.record));
 const before=fs.readFileSync(a.paths.record);await assert.rejects(a.ensure(),{code:'TAILNET_RUNTIME_UNCERTAIN'});assert(fs.readFileSync(a.paths.record).equals(before));
 await until(()=>fs.existsSync(a.paths.ready),'original broker never became ready');assert.equal((await a.status()).state,'stopped');assert.equal(f.engines().length,1);assert(fs.readFileSync(a.paths.record).equals(before));
});

function fakeProtocol({delayStart=0,malformedLogin=false,initExit=false}={}){
 const messages=[],child=new EventEmitter();child.pid=424242;child.stdout=new PassThrough();child.stderr=new PassThrough();let state='stopped',queue=Promise.resolve(),ended=false,spawnOptions;
 const result=q=>({protocolVersion:1,state,origin:q.origin||origin,proxyURL:'http://127.0.0.1:12345',proxyUsername:'workbench',proxyRealm:'LingtuTailnet/'+'a'.repeat(32),prototypeOnly:true});
 child.stdin=new Writable({write(bytes,_encoding,done){const q=JSON.parse(bytes.toString());messages.push(q);done();queue=queue.then(async()=>{
  if(q.op==='init'&&initExit){child.emit('exit',1);return;}
  if(q.op==='start'){await pause(delayStart);state='running';}
  const status=result(q);if(q.op==='login'&&malformedLogin)status.loginURL='https://attacker.invalid/a/secret';
  child.stdout.write(JSON.stringify({v:1,id:q.id,ok:true,result:status})+'\n');if(q.op==='shutdown'){ended=true;setImmediate(()=>child.emit('exit',0));}
 });},final(done){if(!ended){ended=true;setImmediate(()=>child.emit('exit',0));}done();}});
 return {messages,spawnImpl:(file,args,options)=>{spawnOptions={file,args,...options};return child;},options:()=>spawnOptions};
}

test('stdio timeout never replays a mutation; late result is observed by explicit status',async()=>{
 const fake=fakeProtocol({delayStart:90}),config={sidecarPath:'fixture-never-executed.exe',origin,stateDir:'C:/isolated-node-state',hostname:'lingtu-fixture',nonce:'1'.repeat(64),proxyPassword:'2'.repeat(64)};
 const engine=await createTailnetStdioEngine(config,{spawnImpl:fake.spawnImpl,timeoutMs:30});
 assert.deepEqual(Object.keys(fake.messages[0]).sort(),['v','id','op','nonce','proxyPassword','origin','stateDir','hostname'].sort());assert.deepEqual(fake.options().args,[]);assert(!JSON.stringify(fake.options()).includes(config.nonce));assert(!JSON.stringify(fake.options()).includes(config.proxyPassword));
 await assert.rejects(engine.request('start'),{code:'TAILNET_ENGINE_OUTCOME_UNKNOWN'});await pause(120);assert.equal((await engine.request('status')).state,'running');assert.equal(fake.messages.filter(q=>q.op==='start').length,1);await engine.shutdown();
});

test('stdio rejects unsafe login URLs and unexpected child exit without exposing raw messages',async()=>{
 const config={sidecarPath:'fixture-never-executed.exe',origin,stateDir:'C:/isolated-node-state',hostname:'lingtu-fixture',nonce:'1'.repeat(64),proxyPassword:'2'.repeat(64)},fake=fakeProtocol({malformedLogin:true});
 const engine=await createTailnetStdioEngine(config,{spawnImpl:fake.spawnImpl});await assert.rejects(engine.request('login'),{code:'TAILNET_LOGIN_URL_INVALID'});await assert.rejects(engine.request('start'),{code:'TAILNET_ENGINE_PROTOCOL_INVALID'});
 await assert.rejects(createTailnetStdioEngine(config,{spawnImpl:fakeProtocol({initExit:true}).spawnImpl}),{code:'TAILNET_ENGINE_EXITED'});
});

test('shutdown is existing-only, confirms child exit and retains node state for later reuse',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager();assert.deepEqual(await a.shutdown(),{ok:true,alreadyStopped:true});assert.equal(f.engines().length,0);
 const first=await a.ensure();fs.mkdirSync(a.paths.stateDir,{recursive:true});const state=path.join(a.paths.stateDir,'synthetic.dpapi');fs.writeFileSync(state,'fixture bytes');
 assert.equal((await a.shutdown()).state,'stopped');await until(()=>!tailnetAlive(first.descriptor.pid)&&!tailnetAlive(first.descriptor.goPid),'owned broker did not stop');
 assert.deepEqual(await a.shutdown(),{ok:true,alreadyStopped:true});assert.equal(f.engines().length,1);
 const second=await a.ensure();assert.notEqual(second.record.brokerId,first.record.brokerId);assert.equal(f.engines().length,2);assert.equal(fs.readFileSync(state,'utf8'),'fixture bytes');
});

test('unexpected owned engine exit never spawns a second child and authenticated shutdown recovers',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager(),first=await a.ensure();assert.equal(f.engines()[0].pid,first.descriptor.goPid);
 process.kill(first.descriptor.goPid);await until(()=>!tailnetAlive(first.descriptor.goPid),'owned fake engine did not exit');
 await assert.rejects(a.status(),{code:'TAILNET_ENGINE_EXITED'});assert.equal(f.engines().length,1);
 await a.shutdown();await until(()=>!tailnetAlive(first.descriptor.pid),'owned broker did not exit');await a.ensure();assert.equal(f.engines().length,2);
});

test('status allowlist rejects unsafe login URLs and broker init rejects extra control fields',async t=>{
 assert.equal(tailnetFailure('TAILNET_BUSY').message,'私网仍有正在进行的连接，请等待任务结束后重试');
 const f=await fixture(t),valid={protocolVersion:1,state:'stopped',origin,proxyURL:'http://127.0.0.1:12345',proxyUsername:'workbench',proxyRealm:'LingtuTailnet/'+'1'.repeat(32),prototypeOnly:true};
 for(const loginURL of ['http://login.tailscale.com/a/token','https://attacker.invalid/a/token','https://login.tailscale.com.attacker.invalid/a/token','https://login.tailscale.com/a/token?next=evil','https://login.tailscale.com:444/a/token'])assert.throws(()=>tailnetStatus({...valid,loginURL},origin),{code:'TAILNET_LOGIN_URL_INVALID'});
 assert.throws(()=>tailnetStatus({...valid,proxyURL:'http://localhost:12345'},origin),{code:'TAILNET_ENDPOINT_INVALID'});
 const init={v:1,profile:f.profile,origin,brokerId:randomUUID(),controlToken:randomBytes(32).toString('hex'),proxyPassword:randomBytes(32).toString('hex'),nonce:randomBytes(32).toString('hex'),sidecarPath:f.sidecarPath,target:'other'};
 await assert.rejects(createTailnetBroker(init,{engineFactory:()=>{throw Error('must not reach engine');}}),{code:'TAILNET_BROKER_INIT_INVALID'});
 assert.deepEqual(await readTailnetBrokerInit(Readable.from([Buffer.from('{"v":1}\n')])),{v:1});await assert.rejects(readTailnetBrokerInit(Readable.from([Buffer.from('{}\n{}')])));await assert.rejects(readTailnetBrokerInit(Readable.from([Buffer.alloc(17000)])));
});

test('updater enumeration finds restarted and old-origin owners and shuts them down without spawning',{timeout:35000},async t=>{
 const f=await fixture(t);assert.deepEqual(await existingTailnetRuntimes(f.options),[]);assert(!fs.existsSync(path.join(f.profile,'tailnet-runtime')));
 const a=f.manager(),b=f.manager({origin:'https://old-origin.test-tail.ts.net:8443'}),states=await Promise.all([a.ensure(),b.ensure()]);
 // No in-memory runtime map is consulted; a fresh caller sees both origins.
 const restored=await existingTailnetRuntimes(f.options);assert.equal(restored.length,2);assert.deepEqual(new Set(restored.map(r=>r.paths.origin)),new Set([a.paths.origin,b.paths.origin]));assert.equal(f.engines().length,2);
 await Promise.all(restored.map(r=>r.shutdown()));await until(()=>states.every(s=>!tailnetAlive(s.descriptor.pid)&&!tailnetAlive(s.descriptor.goPid)),'enumerated old owners did not exit');
 for(const r of await existingTailnetRuntimes(f.options))assert.deepEqual(await r.shutdown(),{ok:true,alreadyStopped:true});assert.equal(f.engines().length,2);
});

test('updater enumeration rejects corrupt, misbound and incomplete records without spawning',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager();await a.ensure();const original=fs.readFileSync(a.paths.record),ready=fs.readFileSync(a.paths.ready),base=path.dirname(a.paths.directory);
 try{fs.writeFileSync(a.paths.record,'not ciphertext');await assert.rejects(existingTailnetRuntimes(f.options),{code:'TAILNET_RUNTIME_UNCERTAIN'});}finally{fs.writeFileSync(a.paths.record,original);}
 try{fs.writeFileSync(a.paths.ready,JSON.stringify({...JSON.parse(ready),signature:'0'.repeat(64)}));await assert.rejects(existingTailnetRuntimes(f.options),{code:'TAILNET_RUNTIME_UNCERTAIN'});}finally{fs.writeFileSync(a.paths.ready,ready);}
 const falseHash=path.join(base,'0'.repeat(64));fs.mkdirSync(falseHash);fs.copyFileSync(a.paths.record,path.join(falseHash,'runtime.dpapi'));fs.copyFileSync(a.paths.ready,path.join(falseHash,'broker-ready.json'));
 try{await assert.rejects(existingTailnetRuntimes(f.options),{code:'TAILNET_RUNTIME_UNCERTAIN'});}finally{fs.rmSync(falseHash,{recursive:true});}
 const incomplete=path.join(base,'1'.repeat(64));fs.mkdirSync(incomplete);assert.equal((await existingTailnetRuntimes(f.options)).length,1,'fully empty slot is inert');fs.mkdirSync(path.join(incomplete,'node-state'));fs.writeFileSync(path.join(incomplete,'node-state','sidecar.lock'),'');
 try{await assert.rejects(existingTailnetRuntimes(f.options),{code:'TAILNET_RUNTIME_UNCERTAIN'});}finally{fs.rmSync(incomplete,{recursive:true});}
 assert.equal(f.engines().length,1);
});

test('updater enumeration rejects directory and state junctions rather than following another profile',{timeout:35000},async t=>{
 const f=await fixture(t),a=f.manager();await a.ensure();const target=path.join(f.dir,'foreign-empty-state');fs.mkdirSync(target);
 const link=path.join(path.dirname(a.paths.directory),'2'.repeat(64));fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
 try{await assert.rejects(existingTailnetRuntimes(f.options),{code:'TAILNET_RUNTIME_UNCERTAIN'});}finally{fs.unlinkSync(link);}
 fs.symlinkSync(target,a.paths.stateDir,process.platform==='win32'?'junction':'dir');
 try{await assert.rejects(existingTailnetRuntimes(f.options),{code:'TAILNET_RUNTIME_UNCERTAIN'});}finally{fs.unlinkSync(a.paths.stateDir);}
 assert.equal(f.engines().length,1);assert.deepEqual(fs.readdirSync(target),[]);
});
