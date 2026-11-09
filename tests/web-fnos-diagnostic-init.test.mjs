import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {ServiceManager} from '../server/service-manager.mjs';
import {createSourceServices} from '../server/services.mjs';
import {developmentConfig} from '../server/config.mjs';
import {diagnosticInitializationCleanup} from '../deploy/fnos/smoke-checks.mjs';

async function availablePorts(){
 for(let port=51050;port<59000;port+=5){const sockets=[];try{
  for(let i=0;i<5;i++){const s=net.createServer();sockets.push(s);await new Promise((resolve,reject)=>s.once('error',reject).listen(port+i,'127.0.0.1',resolve));}return port;
 }catch{}finally{await Promise.all(sockets.map(s=>new Promise(r=>s.close(r))));}}
 throw Error('No isolated diagnostic test ports');
}

test('diagnostic cancellation and initializer finally await one real pending-start teardown',{timeout:45000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diag-init-'));let entered,release;
 const starting=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 class DelayedManager extends ServiceManager{async start(id){entered();await gate;return super.start(id);}}
 const config=developmentConfig({stateDir:dir,port:await availablePorts()});
 const services=await createSourceServices(config,{Manager:DelayedManager});
 const originalStop=services.stop.bind(services);let stopRequests=0;
 services.stop=async id=>{stopRequests++;return originalStop(id);};
 const cleanup=diagnosticInitializationCleanup(services);
 const initialization=services.ensure('purchase').finally(cleanup);initialization.catch(()=>{});
 await starting;
 let cleanupFinished=false;const cancellation=cleanup().then(()=>{cleanupFinished=true;});cancellation.catch(()=>{});
 try{
  await new Promise(r=>setTimeout(r,100));assert.equal(cleanupFinished,false,'Cancellation must wait for its in-flight start');
  release();
  const results=await Promise.allSettled([initialization,cancellation]);
  assert.equal(results[1].status,'fulfilled',results[1].reason?.stack);
  assert.equal(results[0].status,'rejected');assert.match(results[0].reason.message,/维护/);
  assert.equal(stopRequests,1,'Signal cleanup and initialization finally must share the authenticated stop');
  assert.equal(await services.capabilities('purchase'),null,'Real owned purchase child must have exited');
  assert.equal(cleanupFinished,true);
  const next=await createSourceServices(config);
  try{
   assert.ok((await next.ensure('purchase')).pid,'A subsequent initializer must really start a new child');
   await diagnosticInitializationCleanup(next)();
   assert.equal(await next.capabilities('purchase'),null,'A new initializer must perform its own real teardown');
  }finally{await next.stopOwned();}
 }finally{
  release();await Promise.allSettled([initialization,cancellation]);
  await services.stopOwned();fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('diagnostic initializer cleanup preserves the original stop failure',async()=>{
 let calls=0;const failed=diagnosticInitializationCleanup({stopOwned:async()=>{calls++;throw Error('owned stop failed');}});
 await assert.rejects(failed(),/owned stop failed/);await assert.rejects(failed(),/owned stop failed/);assert.equal(calls,1);
});
