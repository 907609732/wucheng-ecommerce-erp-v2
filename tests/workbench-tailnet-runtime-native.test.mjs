import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {TailnetRuntime,tailnetAlive} from '../desktop/workbench-client/tailnet-runtime.mjs';

// Only this explicit candidate component is eligible. No start/login operation
// exists in the worker or either test: actual tsnet enrollment is out of scope.
const binary=path.resolve(process.env.TAILNET_RUNTIME_BINARY||'dist/tailnet-runtime/lingtu-tailnet.exe');
const manifestFile=path.join(path.dirname(binary),'manifest.json');
const available=process.platform==='win32'&&fs.existsSync(binary)&&fs.existsSync(manifestFile);
const runtimeURL=new URL('../desktop/workbench-client/tailnet-runtime.mjs',import.meta.url).href;
const origin='https://inert-broker.synthetic-tail.ts.net:8443';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,message,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(25);}throw Error(message);}
function encryption(key){return {
 encrypt(plain){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(plain,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);},
 decrypt(bytes){const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');}
};}
function probe(proxyURL,authority,credentials){return new Promise((resolve,reject)=>{
 const url=new URL(proxyURL),socket=net.connect(Number(url.port),'127.0.0.1',()=>socket.write('CONNECT '+authority+' HTTP/1.1\r\nHost: '+authority+'\r\n'+(credentials?'Proxy-Authorization: Basic '+Buffer.from('workbench:'+credentials).toString('base64')+'\r\n':'')+'\r\n'));let reply='';
 socket.setTimeout(3000,()=>{socket.destroy();reject(Error('inert CONNECT probe timed out'));});socket.once('error',reject);socket.on('data',bytes=>{reply+=bytes.toString('utf8');if(reply.includes('\r\n')){const status=Number(reply.split(' ')[1]);socket.destroy();resolve(status);}});
});}

async function fixture(t){
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')),bytes=fs.readFileSync(binary),sha256=createHash('sha256').update(bytes).digest('hex');
 assert.equal(manifest.schemaVersion,1);assert.equal(manifest.protocolVersion,1);assert.equal(manifest.file,path.basename(binary));assert.equal(manifest.bytes,bytes.length);assert.equal(manifest.sha256,sha256);
 const made=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-tailnet-native-inert-')),dir=fs.realpathSync.native(made),profile=path.join(dir,'profile');fs.mkdirSync(profile);
 const key=randomBytes(32),secure=encryption(key),options={profile,origin,sidecarPath:binary,execPath:path.resolve('node_modules/electron/dist/electron.exe'),startupTimeoutMs:20000,...secure},runtimes=[],descriptors=[],workers=new Set();
 const manager=()=>{const m=new TailnetRuntime(options);runtimes.push(m);return m;};
 const worker=path.join(dir,'worker.mjs');fs.writeFileSync(worker,`
import {TailnetRuntime} from ${JSON.stringify(runtimeURL)};import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
const key=Buffer.from(process.env.INERT_BROKER_FIXTURE_KEY,'hex'),encrypt=plain=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(plain,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);},decrypt=bytes=>{const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');};
try{const r=new TailnetRuntime({...JSON.parse(process.env.INERT_BROKER_FIXTURE_OPTIONS),encrypt,decrypt});const status=await r.status(),c=await r.ensure();process.send({ok:true,state:status.state,descriptor:c.descriptor});}catch(e){process.send({ok:false,code:e.code});}finally{process.disconnect();}
`);
 async function child(){
  const {encrypt:_,decrypt:__,...plain}=options;
  const p=spawn(process.execPath,[worker],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,INERT_BROKER_FIXTURE_KEY:key.toString('hex'),INERT_BROKER_FIXTURE_OPTIONS:JSON.stringify(plain)}});workers.add(p);p.stderr.on('data',()=>{});
  const result=await new Promise((resolve,reject)=>{let value;p.once('message',v=>value=v);p.once('error',reject);p.once('exit',code=>{workers.delete(p);if(code!==0||!value)reject(Error('inert broker fixture parent failed'));else resolve(value);});});assert.equal(result.ok,true,JSON.stringify(result));descriptors.push(result.descriptor);return result;
 }
 t.after(async()=>{
  for(const p of workers)if(p.exitCode===null)p.kill();
  for(const r of runtimes){try{await r.shutdown();}catch{}}
  // Last-resort cleanup is confined to PIDs returned by this fixture's verified
  // encrypted record, never discovered from a port or an external profile.
  for(const d of descriptors)for(const pid of [d.pid,d.goPid])if(tailnetAlive(pid))try{process.kill(pid);}catch{}
  await until(()=>descriptors.every(d=>!tailnetAlive(d.pid)&&!tailnetAlive(d.goPid)),'owned inert fixture process failed to exit');
  assert(path.basename(dir).startsWith('workbench-tailnet-native-inert-'));assert.equal(fs.realpathSync.native(dir),dir);fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 return {profile,manager,child,descriptors,sha256,bytes:bytes.length};
}

test('actual Go inert runtime is shared across parents and remains stopped behind authenticated CONNECT',{skip:!available,timeout:60000},async t=>{
 const f=await fixture(t),m=f.manager(),[first,second]=await Promise.all([f.child(),f.child()]);
 assert.equal(first.state,'stopped');assert.equal(first.descriptor.brokerId,second.descriptor.brokerId);assert.equal(first.descriptor.pid,second.descriptor.pid);assert.equal(first.descriptor.goPid,second.descriptor.goPid);
 const own=await m.ensure();assert.equal(own.record.brokerId,first.descriptor.brokerId);assert(tailnetAlive(own.descriptor.pid));assert(tailnetAlive(own.descriptor.goPid));
 assert.equal((await m.stop()).state,'stopped');await assert.rejects(m.logout(),error=>error.code==='LOGOUT_REQUIRES_START'&&/尚未注销/.test(error.message));assert.equal((await m.status()).state,'stopped');
 const connection=await m.connection(),authority=new URL(origin).host;
 assert.equal(await probe(connection.proxyURL,authority),407);assert.equal(await probe(connection.proxyURL,'unlisted.synthetic-tail.ts.net:8443',connection.proxyPassword),403);assert.equal(await probe(connection.proxyURL,authority,connection.proxyPassword),503);
 assert.deepEqual(fs.readdirSync(m.paths.stateDir),['sidecar.lock'],'init/status/stop/rejected logout/CONNECT must never create node keys or log files');
 for(const secret of [own.record.controlToken,own.record.proxyPassword,own.record.nonce]){assert(!fs.readFileSync(m.paths.record).includes(Buffer.from(secret)));assert(!fs.readFileSync(m.paths.ready,'utf8').includes(secret));}
 assert.equal((await m.shutdown()).state,'stopped');await until(()=>!tailnetAlive(own.descriptor.pid)&&!tailnetAlive(own.descriptor.goPid),'authenticated shutdown not confirmed');
 assert.deepEqual(fs.readdirSync(m.paths.stateDir),['sidecar.lock']);
 t.diagnostic(JSON.stringify({scope:'actual Electron_RUN_AS_NODE broker and Go binary, isolated encrypted fixture profile, no real Tailnet',sha256:f.sha256,bytes:f.bytes,parents:2,brokers:1,goChildren:1,enrollmentStarted:false,stateFiles:['sidecar.lock'],recordEncryption:'fixture AES-GCM callbacks, not Electron safeStorage acceptance'}));
});

test('actual Go observes owned broker EOF and releases the inert state for safe replacement',{skip:!available,timeout:60000},async t=>{
 const f=await fixture(t),m=f.manager(),first=await m.ensure();f.descriptors.push(first.descriptor);
 assert.equal((await m.status()).state,'stopped');process.kill(first.descriptor.pid);await until(()=>!tailnetAlive(first.descriptor.pid)&&!tailnetAlive(first.descriptor.goPid),'Go did not release on owned broker pipe EOF');
 const replacement=await m.ensure();f.descriptors.push(replacement.descriptor);assert.notEqual(replacement.record.brokerId,first.record.brokerId);assert.equal((await m.status()).state,'stopped');assert.deepEqual(fs.readdirSync(m.paths.stateDir),['sidecar.lock']);
 await m.shutdown();await until(()=>!tailnetAlive(replacement.descriptor.pid)&&!tailnetAlive(replacement.descriptor.goPid),'replacement did not exit');
});

test('actual Electron safeStorage persists a private inert broker across independent app and CLI processes',{skip:!available,timeout:60000},async t=>{
 const f=await fixture(t),runtime=f.manager(),entry=path.join(f.profile,'secure-owner.mjs');
 fs.writeFileSync(entry,`
import {app,safeStorage} from 'electron';import fs from 'node:fs';import path from 'node:path';import {TailnetRuntime} from ${JSON.stringify(runtimeURL)};
const config=JSON.parse(process.env.INERT_SECURE_OWNER_OPTIONS);app.setPath('userData',path.join(config.profile,'launcher'));
app.whenReady().then(async()=>{
 if(!safeStorage.isEncryptionAvailable())throw Error('SECURE_STORAGE_UNAVAILABLE');
 const r=new TailnetRuntime({profile:config.profile,origin:config.origin,sidecarPath:config.binary,encrypt:plain=>safeStorage.encryptStringAsync?safeStorage.encryptStringAsync(plain):safeStorage.encryptString(plain),decrypt:bytes=>safeStorage.decryptStringAsync?safeStorage.decryptStringAsync(bytes):safeStorage.decryptString(bytes)});
 const status=await r.status(),owned=await r.ensure();let shutdown;
 if(config.shutdown)shutdown=await r.shutdown();
 fs.writeFileSync(config.reply,JSON.stringify({ok:true,status:status.state,descriptor:owned.descriptor,secureStorage:true,shutdownState:shutdown?.state}));app.exit(0);
}).catch(error=>{fs.writeFileSync(config.reply,JSON.stringify({ok:false,code:error.code||'SECURE_OWNER_FAILED'}));app.exit(1);});
`);
 const parents=[];
 async function secureOwner(shutdown=false){
  const reply=path.join(f.profile,'secure-reply-'+randomBytes(8).toString('hex')+'.json'),env={...process.env,INERT_SECURE_OWNER_OPTIONS:JSON.stringify({profile:f.profile,origin,binary,reply,shutdown})};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.resolve('node_modules/electron/dist/electron.exe'),[entry],{windowsHide:true,stdio:'ignore',env});parents.push(child);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert(fs.existsSync(reply),'secure fixture parent did not report');const result=JSON.parse(fs.readFileSync(reply,'utf8'));if(result.descriptor)f.descriptors.push(result.descriptor);assert.equal(exit,0,JSON.stringify(result));assert.equal(result.ok,true);return result;
 }
 t.after(()=>{for(const child of parents)if(child.exitCode===null)child.kill();});
 const first=await secureOwner(),second=await secureOwner();assert.equal(first.status,'stopped');assert.equal(second.status,'stopped');assert.equal(first.descriptor.brokerId,second.descriptor.brokerId);assert.equal(first.descriptor.goPid,second.descriptor.goPid);
 assert.deepEqual(fs.readdirSync(runtime.paths.stateDir),['sidecar.lock']);
 const encrypted=fs.readFileSync(runtime.paths.record);assert(encrypted.length>0);assert(!encrypted.includes(Buffer.from('controlToken')));assert(!encrypted.includes(Buffer.from(origin)));
 const final=await secureOwner(true);assert.equal(final.descriptor.brokerId,first.descriptor.brokerId);assert.equal(final.shutdownState,'stopped');await until(()=>!tailnetAlive(first.descriptor.pid)&&!tailnetAlive(first.descriptor.goPid),'safeStorage-owned broker did not shut down');
 t.diagnostic('Actual Electron safeStorage callbacks encrypted/decrypted the same runtime record across three independent windowless app processes; actual Go remained inert throughout.');
});
