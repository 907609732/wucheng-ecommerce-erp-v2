import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {configureNative} from '../server/fnos-native/configure.mjs';
import {loadConfig,databases} from '../server/config.mjs';

const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen({port,host:'127.0.0.1',exclusive:true},()=>{server.removeListener('error',reject);resolve();});});
const close=server=>new Promise(resolve=>server.close(resolve));
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-init-ports-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {mode:'fresh',releaseRoot:path.resolve(import.meta.dirname,'..'),dataRoot:path.join(root,'data'),publicOrigin:'https://nas.example.com',allowedOrigins:['https://nas.example.com'],allowedUids:['1000']};
}
function observeReservations(t,edit=(_server,_index,proceed)=>proceed()){
 const create=net.createServer,reservations=[];
 t.mock.method(net,'createServer',function(...args){
  const server=Reflect.apply(create,this,args),original=server.listen;
  t.mock.method(server,'listen',function(...values){
   const proceed=()=>Reflect.apply(original,this,values);
   if(values[0]?.port!==0)return proceed();
   assert.equal(values[0].host,'127.0.0.1');assert.equal(values[0].exclusive,true);
   reservations.push(server);return edit(server,reservations.length,proceed);
  });return server;
 });
 return reservations;
}

test('fresh initializes real ledgers with OS-bound temporary ports while the legacy random port stays foreign',async t=>{
 const options=fixture(t),foreign=http.createServer((request,response)=>{response.statusCode=request.url==='/fixture-marker'?200:404;response.end('owned by fixture');});
 t.after(()=>close(foreign));
 // Arrange a genuinely occupied port inside the OLD random range. Only this
 // test setup scans candidates; production must ask the OS for port zero.
 let port;for(let candidate=40001;candidate<=50000;candidate++)try{await listen(foreign,candidate);port=candidate;break;}catch(error){if(!['EADDRINUSE','EACCES'].includes(error.code))throw error;}
 assert.ok(port,'test could not arrange its foreign listener');
 t.mock.method(Math,'random',()=>((port-1)-40000+0.25)/10000);
 const reservations=observeReservations(t),file=await configureNative(options),config=loadConfig(file);
 assert.equal(reservations.length,4);assert(reservations.every(server=>!server.listening));
 const registry=JSON.parse(fs.readFileSync(path.join(config.stateDir,'web-registry.json'))),ports=Object.values(registry).flatMap(module=>[module.port,...(module.mobilePort?[module.mobilePort]:[])]);
 assert.equal(new Set(ports).size,4);assert(!ports.includes(port));
 assert.equal(config.port,28430);assert.deepEqual(Object.values(config.modules).map(module=>module.port),[28431,28432,28433]);assert.equal(config.modules.purchase.mobilePort,28434);
 for(const [id,module] of Object.entries(config.modules)){const db=new DatabaseSync(path.join(module.dataDir,databases[id]),{readOnly:true});try{assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');assert(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n>3);}finally{db.close();}}
 assert.equal(await(await fetch('http://127.0.0.1:'+port+'/fixture-marker')).text(),'owned by fixture');assert.equal(foreign.listening,true);
});

test('fresh propagates an OS reservation refusal once and closes earlier reservations',async t=>{
 const options=fixture(t),failure=Object.assign(Error('synthetic OS bind refusal'),{code:'EACCES'});
 const reservations=observeReservations(t,(server,index,proceed)=>{if(index===2){queueMicrotask(()=>server.emit('error',failure));return server;}return proceed();});
 await assert.rejects(configureNative(options),error=>error===failure);
 assert.equal(reservations.length,2,'a refusal must not trigger a random retry');assert(reservations.every(server=>!server.listening));assert.equal(fs.existsSync(options.dataRoot),false);
});

test('fresh refuses a foreign listener that acquires a released reservation and closes all remaining reservations',async t=>{
 const options=fixture(t),foreign=http.createServer((_request,response)=>{response.statusCode=404;response.end('owned by fixture');});t.after(()=>close(foreign));
 let claimedPort,claimError;const reservations=observeReservations(t,(server,index,proceed)=>{
  if(index!==1)return proceed();const original=server.close;let claimed=false;
  t.mock.method(server,'close',function(callback){
   if(claimed)return Reflect.apply(original,this,[callback]);claimed=true;claimedPort=this.address().port;
   return Reflect.apply(original,this,[()=>{listen(foreign,claimedPort).then(()=>callback(),error=>{claimError=error;callback(error);});}]);
  });
  return proceed();
 });
 await assert.rejects(configureNative(options),/端口.*(?:占用|已有)/);
 assert.equal(claimError,undefined);assert.equal(foreign.listening,true);assert.equal(reservations.length,4);assert(reservations.every(server=>!server.listening));assert.equal(fs.existsSync(options.dataRoot),false);
 assert.equal(await(await fetch('http://127.0.0.1:'+claimedPort+'/')).text(),'owned by fixture');
});
