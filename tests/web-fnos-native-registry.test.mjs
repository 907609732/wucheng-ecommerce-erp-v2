import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {createSourceServices} from '../server/services.mjs';
import {developmentConfig,databases} from '../server/config.mjs';
import {createWebRuntime} from '../server/runtime.mjs';
import {control} from '../server/control.mjs';

const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function freePorts(count){
 const sockets=[];
 try{for(let n=0;n<count;n++){const socket=net.createServer();sockets.push(socket);await new Promise((resolve,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',resolve));}return sockets.map(socket=>socket.address().port);}
 finally{await Promise.all(sockets.map(socket=>new Promise(resolve=>socket.close(resolve))));}
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-registry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state=path.join(dir,'state'),config=developmentConfig({stateDir:state});config.mode='production';config.publicOrigin='https://nas.example.test';
 for(const [id,module]of Object.entries(config.modules)){fs.mkdirSync(module.dataDir,{recursive:true});fs.writeFileSync(path.join(module.dataDir,databases[id]),'retained ledger '+id);}
 const file=path.join(state,'web-registry.json');fs.writeFileSync(file,'{"retained":"stale derived registry"}');
 return {dir,state,config,file};
}

test('derived registry publication is atomic and cleans its private temporary on failure',async t=>{
 const {state,config,file}=fixture(t),before=hash(file),failure=Object.assign(Error('synthetic registry publication refusal'),{code:'EACCES'}),rename=fs.renameSync;
 let staged=false;
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(to!==file)return rename(from,to);
  staged=true;assert.equal(hash(file),before);assert.equal(path.dirname(from),state);assert.equal(JSON.parse(fs.readFileSync(from)).sales.allowInitialize,false);
  if(process.platform!=='win32')assert.equal(fs.statSync(from).mode&0o077,0);
  throw failure;
 });
 await assert.rejects(createSourceServices(config),error=>error===failure);
 assert.equal(staged,true);assert.equal(hash(file),before);assert.deepEqual(fs.readdirSync(state).sort(),['data','web-registry.json']);
});

test('POSIX non-root restarts replace a copied 0400 registry without changing retained books',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
 const {state,config,file}=fixture(t);fs.chmodSync(file,0o400);
 const books=Object.entries(config.modules).map(([id,module])=>{const book=path.join(module.dataDir,databases[id]);fs.chmodSync(book,0o400);return {book,hash:hash(book),mode:fs.statSync(book).mode};});
 const stale=hash(file);let generated;
 for(let start=0;start<2;start++){
  const services=await createSourceServices(config);
  try{
   const registry=JSON.parse(fs.readFileSync(file));assert.equal(fs.statSync(file).mode&0o777,0o600);assert.notEqual(hash(file),stale);
   if(generated)assert.equal(hash(file),generated,'restart must publish the same derived configuration');else generated=hash(file);
   for(const [id,module]of Object.entries(config.modules)){assert.equal(registry[id].allowInitialize,false);assert.equal(registry[id].nodePath,process.execPath);assert.equal(services.config(id).root,module.root);assert.equal(services.config(id).dataDir,module.dataDir);assert.equal(services.config(id).version,registry[id].version);}
  }finally{await services.stopOwned();}
  for(const book of books){assert.equal(hash(book.book),book.hash);assert.equal(fs.statSync(book.book).mode,book.mode);}
  assert.equal(fs.readdirSync(state).some(name=>name.endsWith('.tmp')),false);
 }
});

test('native VAR keeps copied registry and service logs immutable across real module restarts',async t=>{
 const {dir,state,config,file}=fixture(t),runtimeDir=path.join(dir,'var','runtime');
 config.mode='development';config.publicOrigin='http://127.0.0.1:'+config.port;config.native={runtimeDir};
 const sales=config.modules.sales;for(const [id,module]of Object.entries(config.modules))fs.unlinkSync(path.join(module.dataDir,databases[id]));
 const legacyLog=path.join(sales.dataDir,'integration-service.log');fs.writeFileSync(legacyLog,'retained old service log');
 for(const retained of [file,legacyLog])fs.chmodSync(retained,0o400);
 const before=[file,legacyLog].map(retained=>({file:retained,hash:hash(retained),mode:fs.statSync(retained).mode}));
 [sales.port]=await freePorts(1);
 const pids=[];
 for(let start=0;start<2;start++){
  const services=await createSourceServices(config);
  try{
   const registry=path.join(runtimeDir,'web-registry.json');assert.ok(fs.existsSync(registry),'derived registry must use native.runtimeDir');
   let cap;try{cap=await services.ensure('sales');}catch(error){throw new Error(error.message+'\n'+fs.readFileSync(path.join(runtimeDir,'logs','sales-integration-service.log'),'utf8').slice(-4000),{cause:error});}pids.push(cap.pid);assert.equal(cap.dataDir,sales.dataDir);assert.equal(cap.root,sales.root);
   assert.ok(fs.existsSync(path.join(runtimeDir,'logs','sales-integration-service.log')));
   assert.ok(fs.existsSync(path.join(state,'web-ownership.json')),'ownership must retain its original data namespace');
   assert.ok(fs.existsSync(path.join(sales.dataDir,'.integration-start.lock')),'start lock must remain with its ledger');
   if(process.platform!=='win32'){assert.equal(fs.statSync(path.join(runtimeDir,'logs')).mode&0o777,0o700);assert.equal(fs.statSync(registry).mode&0o777,0o600);assert.equal(fs.statSync(path.join(runtimeDir,'logs','sales-integration-service.log')).mode&0o777,0o600);}
   for(const retained of before){assert.equal(hash(retained.file),retained.hash);assert.equal(fs.statSync(retained.file).mode,retained.mode);}
  }finally{await services.stopOwned();}
  assert.equal(await services.capabilities('sales'),null);
 }
 assert.notEqual(pids[0],pids[1]);
});

test('native VAR hosts generic logs while control records retain their DATA namespace',async t=>{
 const {dir,state,config}=fixture(t);
 config.releaseRoot=path.resolve(import.meta.dirname,'..');config.native={dataRoot:dir,home:path.join(dir,'home')};
 // Native data roots are siblings of state; VAR is outside the persistent data root.
 const outer=fs.mkdtempSync(path.join(os.tmpdir(),'native-var-'));t.after(()=>fs.rmSync(outer,{recursive:true,force:true}));
 config.native.runtimeDir=path.join(outer,'runtime');
 for(const [id,module]of Object.entries(config.modules)){const next=path.join(dir,'data',id);fs.mkdirSync(next,{recursive:true});fs.renameSync(path.join(module.dataDir,databases[id]),path.join(next,databases[id]));module.dataDir=next;}
 [config.port,config.modules.purchase.port,config.modules.purchase.mobilePort,config.modules.sales.port,config.modules.overview.port]=await freePorts(5);
 const oldLog=path.join(state,'logs','web.log');fs.mkdirSync(path.dirname(oldLog));fs.writeFileSync(oldLog,'retained web log');fs.chmodSync(oldLog,0o400);const oldHash=hash(oldLog),oldMode=fs.statSync(oldLog).mode;
 for(let start=0;start<2;start++){
  for(const name of ['web-control.json','web-runtime.json']){const file=path.join(state,name);fs.writeFileSync(file,'{}');if(process.platform!=='win32')fs.chmodSync(file,0o400);}
  const runtime=await createWebRuntime(config,{watch:false});
  try{
   await runtime.start();
   assert.equal(runtime.logger.file,path.join(config.native.runtimeDir,'logs','web.log'));
   assert.ok(fs.statSync(runtime.logger.file).size>0);
   for(const name of ['web-control.json','web-runtime.json']){const file=path.join(state,name);assert.ok(JSON.parse(fs.readFileSync(file)));assert.equal(fs.existsSync(path.join(config.native.runtimeDir,name)),false);if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);}
   assert.equal((await control(state,'quiesce')).ok,true);
   assert.equal(hash(oldLog),oldHash);assert.equal(fs.statSync(oldLog).mode,oldMode);
  }finally{await runtime.stop();}
  for(const name of ['web-control.json','web-runtime.json'])assert.equal(fs.existsSync(path.join(state,name)),false);
 }
});
