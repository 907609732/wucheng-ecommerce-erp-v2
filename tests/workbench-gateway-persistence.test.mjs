import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createGatewayStore} from '../desktop/workbench/store.mjs';
import {normalizeManifest,matchOperation,safeRequestPath} from '../desktop/workbench/manifest.mjs';
import {provisionWorkbenchKey,signWorkbenchActor,verifyWorkbenchActor} from '../desktop/workbench/actor.mjs';

test('persistent identity, sessions and completed writes survive restart; incomplete write is blocked as unknown',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-store-test-'));let store;
 try{
  store=createGatewayStore(dir);const {serverId,dataSetId}=store,actor={id:'tailscale:person@example.test',sessionId:'session-1'};
  store.saveSession('token',{sessionId:'session-1',login:'person@example.test',channel:'ui',csrfToken:'csrf',expiresAt:Date.now()+100000});
  store.bindModule('session-1','purchase','a0000000-0000-4000-8000-000000000001');
  store.begin('completed','hash',actor,'request-1');store.finish('completed',{status:201,headers:{'content-type':'application/json'},body:Buffer.from('{"ok":true}')});store.begin('interrupted','hash2',actor,'request-2');store.close();
  store=createGatewayStore(dir);assert.equal(store.serverId,serverId);assert.equal(store.dataSetId,dataSetId);assert.equal(store.session('token').session_id,'session-1');assert.equal(store.get('completed').state,'completed');assert.equal(store.get('completed').body.toString(),'{"ok":true}');assert.equal(store.get('interrupted').state,'unknown');assert.equal(store.get('interrupted').request_id,'request-2');assert.throws(()=>store.bindModule('session-1','purchase','b0000000-0000-4000-8000-000000000002'),e=>e.code==='DATASET_CHANGED');
 }finally{store?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('a second gateway cannot touch pending writes or uploads owned by a running gateway',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-exclusive-test-'));let first,second;
 try{first=createGatewayStore(dir);first.begin('running','same',{id:'user',sessionId:'session'},'request');assert.throws(()=>createGatewayStore(dir),e=>e.code==='GATEWAY_STORE_BUSY');assert.equal(first.get('running').state,'pending');first.close();first=null;second=createGatewayStore(dir);assert.equal(second.get('running').state,'unknown');}
 finally{first?.close();second?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('a crashed gateway releases its process lock while retaining uncertain writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-crash-test-'));let recovered;
 try{const code=`import {createGatewayStore} from ${JSON.stringify(new URL('../desktop/workbench/store.mjs',import.meta.url).href)};const s=createGatewayStore(${JSON.stringify(dir)});s.begin('crash-operation','fingerprint',{id:'user',sessionId:'session'},'request-before-crash');process.exit(73);`;const result=spawnSync(process.execPath,['--input-type=module','-e',code],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(result.status,73,result.stderr);recovered=createGatewayStore(dir);assert.equal(recovered.get('crash-operation').state,'unknown');assert.equal(recovered.get('crash-operation').request_id,'request-before-crash');}
 finally{recovered?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('manifest aliases map to one upstream path, literal blocked routes win and unsafe paths never match',()=>{
 const m=normalizeManifest('exporter',{basePath:'/api/integration/v1/workbench',operations:[{method:'GET',path:'/tasks/:id',kind:'read',remote:true},{method:'GET',path:'/tasks/settings',kind:'read',remote:false}]});
 assert.equal(matchOperation(m,'GET','/tasks/123?platform=jd').upstreamPath,'/api/integration/v1/workbench/tasks/123?platform=jd');assert.equal(matchOperation(m,'GET','/api/integration/v1/workbench/tasks/123').operation.remote,true);assert.equal(matchOperation(m,'GET','/tasks/settings').operation.remote,false);
 for(const bad of ['/api/../secrets','/api/%2e%2e/secrets','/api/%252e%252e/secrets','/api/a%2fb','/api/.env','/api/\\secrets','/api//file'])assert.equal(safeRequestPath(bad),false,bad);
 assert.throws(()=>normalizeManifest('purchase',{operations:[{method:'GET',path:'/api/x',kind:'raw',remote:true}]}));
});
test('actor HMAC binds module, exact query, method, permissions, expiry and session',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-actor-test-'));
 try{const key=provisionWorkbenchKey(dir),now=Date.now(),actor={v:1,id:'tailscale:user',login:'user',role:'editor',modules:['purchase'],canRunTasks:false,sessionId:'session',channel:'ui',requestId:'req',issuedAt:now,expiresAt:now+30000,module:'purchase',method:'POST',path:'/api/order?revision=2'},headers=signWorkbenchActor(actor,key);
  assert.equal(verifyWorkbenchActor(headers,key,{module:'purchase',method:'POST',path:actor.path,now}).sessionId,'session');assert.throws(()=>verifyWorkbenchActor(headers,key,{module:'purchase',method:'POST',path:'/api/order?revision=3',now}));assert.throws(()=>verifyWorkbenchActor(headers,key,{module:'sales',method:'POST',path:actor.path,now}));assert.throws(()=>verifyWorkbenchActor(headers,key,{module:'purchase',method:'GET',path:actor.path,now}));assert.throws(()=>verifyWorkbenchActor(headers,key,{module:'purchase',method:'POST',path:actor.path,now:now+30001}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
