import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import {createWorkbenchGateway} from '../desktop/workbench/gateway.mjs';
import {provisionWorkbenchKey,verifyWorkbenchActor} from '../desktop/workbench/actor.mjs';

const origin='https://erp.test-tail.ts.net:8443',login='owner@example.test';
async function fixture(t,{role='editor',channel='ui',canRunTasks=true,maxUploadBytes}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-gateway-test-')),dataDir=path.join(dir,'module');fs.mkdirSync(dataDir);
  const key=provisionWorkbenchKey(dataDir),integrationKey='a'.repeat(64);fs.writeFileSync(path.join(dataDir,'.integration-key'),integrationKey);
  let writes=0,lastActor=null,lastHeaders=null;
  const operations=[['GET','/','ui'],['GET','/app.js','ui'],['GET','/api/orders','read'],['POST','/api/orders','write'],['POST','/api/confirm','confirmation'],['POST','/api/review-session','confirmation'],['GET','/api/files/:id','download'],['POST','/api/upload','upload'],['POST','/api/secret','write']].map(([method,path,kind])=>({module:'purchase',method,path,kind,remote:path!=='/api/secret',uiOnly:kind==='confirmation'}));
  const manifest={protocolVersion:1,operations};
  const backend=Fastify();
  backend.addHook('preHandler',async req=>{assert.equal(req.headers.authorization,'Bearer '+integrationKey);lastActor=verifyWorkbenchActor(req.headers,key,{module:'purchase',method:req.method,path:req.raw.url});lastHeaders=req.headers;});
  backend.get('/',async()=>'<html><script src="/apps/purchase/app.js"></script></html>');
  backend.get('/app.js',async(req,reply)=>reply.type('text/javascript').send('window.moduleLoaded=true;'));
  backend.get('/api/orders',async()=>({orders:[{id:'100000000000000001'}]}));
  backend.post('/api/orders',async req=>({ok:true,writes:++writes,value:req.body}));
  backend.post('/api/confirm',async()=>({ok:true,confirmed:true}));
  backend.post('/api/review-session',async(req,reply)=>reply.header('set-cookie','integration_review=abc; HttpOnly; Path=/api/integration; SameSite=Strict').send({ok:true,token:'nonce'}));
  backend.get('/api/files/:id',async(req,reply)=>reply.header('content-disposition','attachment; filename="orders.csv"').type('text/csv').send('id,amount\n100000000000000001,123\n'));
  backend.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(req,body,done)=>done(null,body));
  backend.post('/api/upload',async req=>({ok:true,bytes:req.body.length}));
  await backend.listen({host:'127.0.0.1',port:0});
  const url='http://127.0.0.1:'+backend.server.address().port;
  const cap={url,version:'1.0.0',workbench:{...manifest,dataSetId:'a0000000-0000-4000-8000-000000000001',revision:'revision-1'}};const services={config:id=>({root:dir,dataDir,version:'1.0.0'}),capabilities:async()=>cap,ensure:async()=>cap};
  const accessPolicy={schemaVersion:1,users:{[login]:{role,modules:['purchase'],canRunTasks,enabled:true}}};
  const gateway=await createWorkbenchGateway({services,storeDir:path.join(dir,'gateway'),publicOrigin:origin,accessPolicy,port:0,...(maxUploadBytes?{maxUploadBytes}:{})});
  t.after(async()=>{await gateway.stop();await backend.close();fs.rmSync(dir,{recursive:true,force:true});});
  const initial={'host':new URL(origin).host,'tailscale-user-login':login,'x-workbench-channel':channel};
  const session=await gateway.app.inject({url:'/api/workbench/v1/session',headers:initial});assert.equal(session.statusCode,200,session.body);
  const data=session.json(),cookie=[session.headers['set-cookie']].flat()[0].split(';')[0];
  const headers={...initial,cookie,origin,'x-workbench-csrf':data.csrfToken};
  const inject=(url,options={})=>gateway.app.inject({url,...options,headers:{...headers,...options.headers}});
  return {gateway,backend,inject,headers,data,accessPolicy,cap,dir,stats:()=>({writes,lastActor,lastHeaders})};
}
test('gateway establishes per-person session, immutable identity and safe module metadata',async t=>{
  const f=await fixture(t);assert.equal(f.data.actor.id,'tailscale:'+login);assert.equal(f.data.protocolVersion,1);assert.equal(f.data.modules[0].id,'purchase');assert(!JSON.stringify(f.data).includes(f.dir));
  const r=await f.inject('/api/workbench/v1/modules');assert.equal(r.statusCode,200);assert.equal(r.json().dataSetId,f.data.dataSetId);
  assert.equal(r.json().modules[0].dataSetId,'a0000000-0000-4000-8000-000000000001');assert.equal(r.json().modules[0].revision,'revision-1');
  const cap=await f.inject('/api/workbench/v1/capabilities');assert.equal(cap.json().operationManifest[0].operations.length,9);
  const unauth=await f.gateway.app.inject({url:'/api/workbench/v1/session',headers:{host:new URL(origin).host}});assert.equal(unauth.statusCode,401);
  const unknown=await f.gateway.app.inject({method:'HEAD',url:'/api/workbench/v1/session',headers:{host:new URL(origin).host,'tailscale-user-login':'unlisted@example.test'}});assert.equal(unknown.statusCode,403);
  const health=(await f.gateway.app.inject({url:'/api/workbench/v1/health'})).json();assert.equal(health.serverId,f.data.serverId);assert.equal(health.dataSetId,f.data.dataSetId);
});
test('discovery marks an old service incompatible before a module page is opened',async t=>{const f=await fixture(t);f.cap.workbench.protocolVersion=0;const rows=(await f.inject('/api/workbench/v1/modules')).json().modules;assert.equal(rows[0].status,'incompatible');assert.equal((await f.inject('/apps/purchase/')).statusCode,503);});
test('authorized module connection starts and identifies its ledger without exposing host metadata',async t=>{const f=await fixture(t);const response=await f.inject('/api/workbench/v1/modules/purchase/connection');assert.equal(response.statusCode,200,response.body);assert.equal(response.json().dataSetId,'a0000000-0000-4000-8000-000000000001');assert.equal(response.json().protocolVersion,1);assert(!response.body.includes(f.dir));assert.equal((await f.inject('/api/workbench/v1/modules/sales/connection')).statusCode,403);f.cap.workbench.protocolVersion=0;assert.equal((await f.inject('/api/workbench/v1/modules/purchase/connection')).statusCode,503);});
test('session module identity rejects replacement and missing ledgers before reads or writes',async t=>{const f=await fixture(t);assert.equal((await f.inject('/api/workbench/v1/modules/purchase/connection')).statusCode,200);f.cap.workbench.dataSetId='b0000000-0000-4000-8000-000000000002';for(const route of ['/api/workbench/v1/modules/purchase/connection','/apps/purchase/api/orders']){const r=await f.inject(route);assert.equal(r.statusCode,409,r.body);assert.equal(r.json().code,'DATASET_CHANGED');}const write=await f.inject('/apps/purchase/api/orders',{method:'POST',payload:{amount:1},headers:{'idempotency-key':'changed-dataset-0001'}});assert.equal(write.statusCode,409);assert.equal(f.stats().writes,0);f.cap.workbench.dataSetId=null;const missing=await f.inject('/apps/purchase/api/orders');assert.equal(missing.statusCode,503);assert.equal(missing.json().code,'MODULE_DATA_NOT_READY');});
test('prefix proxy preserves business URL and signed actor, strips spoofable credentials',async t=>{
  const f=await fixture(t);const r=await f.inject('/apps/purchase/api/orders?month=2026-10',{headers:{authorization:'Bearer attacker','cf-access-authenticated-user-email':'attacker'}});assert.equal(r.statusCode,200,r.body);
  assert.equal(f.stats().lastActor.path,'/api/orders?month=2026-10');assert.equal(f.stats().lastActor.channel,'ui');assert.equal(f.stats().lastHeaders.origin,undefined);assert.equal(f.stats().lastHeaders['cf-access-authenticated-user-email'],undefined);
  const ui=await f.inject('/apps/purchase/');assert.equal(ui.statusCode,200,ui.body);const js=await f.inject('/apps/purchase/app.js');assert.match(js.body,/moduleLoaded/);
});
test('mutations enforce CSRF, origin, identity, channel, module and local-only boundaries',async t=>{
  const f=await fixture(t);const options={method:'POST',payload:{amount:123},headers:{'idempotency-key':'test-write-0001'}};
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/orders',{...options,headers:{...options.headers,'x-workbench-csrf':'wrong'}})).statusCode,403);
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/orders',{...options,headers:{...options.headers,origin:'https://evil.test'}})).statusCode,403);
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/orders',{...options,headers:{...options.headers,'tailscale-user-login':'other@example.test'}})).statusCode,403);
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/orders',{...options,headers:{...options.headers,'x-workbench-channel':'mcp'}})).statusCode,403);
  assert.equal((await f.inject('/api/workbench/v1/modules/sales/api/orders')).statusCode,403);
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/secret',options)).statusCode,403);
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/not-listed')).statusCode,404);
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/orders',{headers:{'x-workbench-actor':'spoof'}})).statusCode,400);
  assert.equal((await f.inject('/api/workbench/v1/modules/purchase/api/orders?path=C%3A%5Cledger.sqlite')).statusCode,400);assert.equal(f.stats().writes,0);
});
test('viewer cannot write and policy changes revoke sessions immediately',async t=>{
  const f=await fixture(t,{role:'viewer'});const r=await f.inject('/apps/purchase/api/orders',{method:'POST',payload:{},headers:{'idempotency-key':'viewer-test-0001'}});assert.equal(r.statusCode,403);f.accessPolicy.users[login].enabled=false;assert.equal((await f.inject('/apps/purchase/api/orders')).statusCode,403);
});
test('MCP cannot bypass browser confirmation; namespaced review cookie stays scoped',async t=>{
  const f=await fixture(t,{channel:'mcp'});const denied=await f.inject('/api/workbench/v1/modules/purchase/api/confirm',{method:'POST',payload:{},headers:{'idempotency-key':'mcp-confirm-0001'}});assert.equal(denied.statusCode,403);assert.equal(denied.json().code,'UI_CONFIRMATION_REQUIRED');
  const ui=await fixture(t);const review=await ui.inject('/apps/purchase/api/review-session',{method:'POST',payload:{},headers:{'idempotency-key':'ui-review-000001'}});assert.equal(review.statusCode,200,review.body);const cookie=[review.headers['set-cookie']].flat()[0];assert.match(cookie,/^wb_purchase_integration_review=abc;/);assert.match(cookie,/Path=\/apps\/purchase\//);
});
test('writes are audited and duplicate retry returns the exact result without another write',async t=>{
  const f=await fixture(t);const options={method:'POST',payload:{order:'100000000000000001',amount:123},headers:{'idempotency-key':'same-operation-0001'}};
  const first=await f.inject('/api/workbench/v1/modules/purchase/api/orders',options),retry=await f.inject('/api/workbench/v1/modules/purchase/api/orders',options);assert.equal(first.statusCode,200,first.body);assert.equal(retry.body,first.body);assert.equal(f.stats().writes,1);
  const conflict=await f.inject('/api/workbench/v1/modules/purchase/api/orders',{...options,payload:{amount:456}});assert.equal(conflict.statusCode,409);assert.equal(f.stats().writes,1);
  const audit=f.gateway.operationStore.db.prepare('SELECT outcome FROM audit ORDER BY id').all();assert.deepEqual(audit.map(r=>r.outcome),['started','completed']);
  const lookup=await f.inject('/api/workbench/v1/operations/same-operation-0001?module=purchase');assert.equal(lookup.statusCode,200);assert.equal(lookup.json().state,'completed');assert.equal(lookup.json().result.writes,1);
});
test('downloads stream with safe file metadata, binary uploads are bounded and proxied',async t=>{
  const f=await fixture(t);const file=await f.inject('/api/workbench/v1/modules/purchase/api/files/known-id');assert.equal(file.statusCode,200,file.body);assert.match(file.body,/100000000000000001/);assert.equal(file.headers['content-disposition'],'attachment; filename="orders.csv"');
  const upload=await f.inject('/api/workbench/v1/modules/purchase/api/upload',{method:'POST',payload:Buffer.alloc(32768,1),headers:{'content-type':'application/octet-stream','idempotency-key':'upload-test-0001'}});assert.equal(upload.statusCode,200,upload.body);assert.equal(upload.json().bytes,32768);
});
test('delegation is signed after a slow upload rather than expiring while its body is spooled',async t=>{
 const f=await fixture(t);await f.gateway.start();const port=f.gateway.app.server.address().port,originalNow=Date.now,start=originalNow();
 let request;
 try{
  const response=new Promise((resolve,reject)=>{
   request=http.request({hostname:'127.0.0.1',port,path:'/apps/purchase/api/upload',method:'POST',headers:{...f.headers,'content-type':'application/octet-stream','idempotency-key':'slow-upload-signature-001'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});request.on('error',reject);request.write(Buffer.from('first-'));
  });
  const spool=path.join(f.dir,'gateway','requests');let waiting=false;
  for(let i=0;i<200;i++){if(fs.readdirSync(spool).some(n=>n.endsWith('.request'))){waiting=true;break;}await new Promise(r=>setTimeout(r,5));}
  assert.equal(waiting,true);Date.now=()=>start+60000;request.end(Buffer.from('last'));
  const result=await response;assert.equal(result.status,200,result.body);assert.equal(JSON.parse(result.body).bytes,10);assert.equal(f.stats().lastActor.issuedAt,start+60000);
 }finally{Date.now=originalNow;request?.destroy();}
});
test('oversized streamed upload is rejected and temporary contents are removed',async t=>{
  const f=await fixture(t,{maxUploadBytes:1024});const result=await f.inject('/api/workbench/v1/modules/purchase/api/upload',{method:'POST',payload:Buffer.alloc(4096),headers:{'content-type':'application/octet-stream','idempotency-key':'too-large-000001'}});assert.equal(result.statusCode,413,result.body);assert.equal(fs.readdirSync(path.join(f.dir,'gateway','requests')).length,0);
});
test('chunked upload limit returns a clear 413 without destroying the response connection',async t=>{
  const f=await fixture(t,{maxUploadBytes:1024}),url=await f.gateway.start();
  const response=await new Promise((resolve,reject)=>{const q=http.request(url+'/api/workbench/v1/modules/purchase/api/upload',{method:'POST',headers:{...f.headers,'content-type':'application/octet-stream','idempotency-key':'chunked-cap-00001','transfer-encoding':'chunked'}},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks).toString()}));});q.once('error',reject);q.setTimeout(5000,()=>q.destroy(Error('upload response timeout')));q.write(Buffer.alloc(512));q.end(Buffer.alloc(2048));});
  assert.equal(response.status,413,response.body);assert.equal(fs.readdirSync(path.join(f.dir,'gateway','requests')).length,0);
});
