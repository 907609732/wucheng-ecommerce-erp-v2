import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createDesktopUiSessions} from '../desktop/agent-host/desktop-ui-sessions.mjs';
import {verifyWorkbenchActor} from '../desktop/workbench/actor.mjs';
import {assertLauncherOperationAllowed} from '../desktop/agent-host/launcher-policy.mjs';

function fixture(t,{onError=()=>{}}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-desktop-ui-'));
  t.after(()=>fs.promises.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const key=randomBytes(32).toString('hex');fs.writeFileSync(path.join(directory,'.workbench-key'),key);
  let config={root:directory,dataDir:directory,port:27333,version:'fixture',managed:true,allowInitialize:false},actor={id:'windows:S-1-5-21-1-1-1-1001',login:'windows:fixture',label:'Fixture',sessionId:'fixture-session',channel:'ui',role:'admin',modules:['purchase','sales','overview'],enabled:true,canRunTasks:true};
  let interceptor;
  const session={webRequest:{onBeforeSendHeaders:handler=>{interceptor=handler;}}};
  const contents=Object.assign(new EventEmitter(),{id:42,session,isDestroyed:()=>false});
  const main={processId:4,routingId:7,url:'http://127.0.0.1:27333/'};main.top=main;contents.mainFrame=main;
  const manager=createDesktopUiSessions({services:{config:()=>config},resolveActor:()=>actor,onError});
  const binding=manager.attach({id:'sales',view:{webContents:contents},cap:{url:'http://127.0.0.1:27333'}});
  const request=change=>{let response;interceptor({webContentsId:42,url:'http://127.0.0.1:27333/api/orders?month=2026-10',method:'POST',resourceType:'xhr',frame:main,initiatorOrigin:'http://127.0.0.1:27333',requestHeaders:{Origin:'http://127.0.0.1:27333'},...change},value=>{response=value;});return response;};
  return {request,contents,main,key,binding,setActor:value=>{actor=value;},actor,setConfig:value=>{config={...config,...value};}};
}

test('real owned view proof binds Windows actor, module, exact method/path and local origin',t=>{
  const f=fixture(t),response=f.request();assert.notEqual(response.cancel,true);
  const actor=verifyWorkbenchActor(response.requestHeaders,f.key,{module:'sales',method:'POST',path:'/api/orders?month=2026-10'});
  assert.equal(actor.id,f.actor.id);assert.equal(actor.localDesktop,true);assert.equal(actor.uiOrigin,'http://127.0.0.1:27333');assert.equal(actor.channel,'ui');assert.equal(actor.sessionId,'fixture-session');
  assert.ok(actor.expiresAt-actor.issuedAt<=30000);assert.equal(JSON.stringify(f.binding).includes(f.key),false);
  assert.throws(()=>verifyWorkbenchActor(response.requestHeaders,f.key,{module:'purchase',method:'POST',path:'/api/orders?month=2026-10'}));
  assert.throws(()=>verifyWorkbenchActor(response.requestHeaders,f.key,{module:'sales',method:'DELETE',path:'/api/orders?month=2026-10'}));
});

test('unknown renderer, foreign frame and foreign initiator cannot borrow desktop UI identity',t=>{
  const f=fixture(t);
  assert.equal(f.request({webContentsId:43}).cancel,true);
  assert.equal(f.request({frame:{processId:4,routingId:8,url:'https://example.test/',top:f.main}}).cancel,true);
  assert.equal(f.request({frame:{processId:9,routingId:3,url:'http://127.0.0.1:27333/',top:{processId:9,routingId:3}}}).cancel,true);
  assert.equal(f.request({initiatorOrigin:'https://example.test/'}).cancel,true);
  assert.equal(f.request({requestHeaders:{oRiGiN:'https://example.test'}}).cancel,true);
});

test('foreign requests receive no proof and forwarded actor headers are stripped',t=>{
  const f=fixture(t),response=f.request({url:'https://example.test/a',requestHeaders:{'X-WORKBENCH-ACTOR':'forged','X-Workbench-Actor-Signature':'forged','X-Workbench-Channel':'ui',Accept:'image/png'}});
  assert.deepEqual(response.requestHeaders,{Accept:'image/png'});
  const local=f.request({requestHeaders:{'X-WORKBENCH-ACTOR':'forged','X-Workbench-Actor-Signature':'forged',Origin:'http://127.0.0.1:27333'}});
  assert.equal(verifyWorkbenchActor(local.requestHeaders,f.key,{module:'sales',method:'POST',path:'/api/orders?month=2026-10'}).id,f.actor.id);
});

test('identity revocation, maintenance and changed registry stop further signed business calls',t=>{
  const revoked=fixture(t);revoked.setActor({...revoked.actor,enabled:false});assert.equal(revoked.request().cancel,true);
  const remote=fixture(t);remote.setActor({...remote.actor,id:'tailscale:someone'});assert.equal(remote.request().cancel,true);
  const changed=fixture(t);changed.setConfig({dataDir:changed.binding.origin});assert.equal(changed.request().cancel,true);
  const maintenance=fixture(t,{onError:()=>{throw Error('diagnostic sink unavailable');}});maintenance.setConfig({maintenance:true});assert.equal(maintenance.request().cancel,true);
});

test('destroyed view cannot fall back to an unsigned legacy request in its session',t=>{
  const f=fixture(t);f.contents.emit('destroyed');assert.equal(f.request().cancel,true);
});

test('business opening is narrow and direct legacy maintenance remains disabled',()=>{
  for(const name of ['modules:open','desks:open','desks:child-open']){assert.doesNotThrow(()=>assertLauncherOperationAllowed(name,{moduleId:'purchase'}));assert.throws(()=>assertLauncherOperationAllowed(name),{code:'BETA_MAINTENANCE_DISABLED'});assert.throws(()=>assertLauncherOperationAllowed(name,{moduleId:'node-runtime'}),{code:'BETA_MAINTENANCE_DISABLED'});}
  for(const name of ['modules:install','modules:uninstall','desks:stop','desks:logs','migration:commit'])assert.throws(()=>assertLauncherOperationAllowed(name),{code:'BETA_MAINTENANCE_DISABLED'});
});
