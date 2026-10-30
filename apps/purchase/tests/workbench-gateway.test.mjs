import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {signWorkbenchActor} from '../lib/workbench-actor.mjs';
import {createHmac} from 'node:crypto';
import {digest} from '../lib/workbench-migration-core.mjs';
test('delegated gateway identity remains signed, scoped and bound to UI confirmation session',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-workbench-')),{app,store,integration}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');integration.attach(server);await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port,key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim(),bearer=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
 const request=(route,method='GET',body,{role='editor',channel='ui',session='one',extra={}}={})=>{const now=Date.now(),actor={v:1,id:'tailscale:test',login:'test',role,modules:['purchase'],canRunTasks:true,sessionId:session,channel,requestId:crypto.randomUUID(),issuedAt:now,expiresAt:now+30000,module:'purchase',method,path:route};return fetch(base+route,{method,headers:{...signWorkbenchActor(actor,key),Authorization:'Bearer '+bearer,'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});};
 assert.equal((await fetch(base+'/api/bootstrap',{headers:{'x-workbench-actor':'forged'}})).status,401);
 const capabilities=await(await fetch(base+'/api/integration/v1/capabilities',{headers:{Authorization:'Bearer '+bearer}})).json();assert.match(capabilities.dataSetId,/^[a-f0-9-]{36}$/);assert.match(capabilities.revision,/^\d+$/);assert.equal((await request('/api/integration/v1/capabilities')).status,403);
 const bootstrap=await(await request('/api/bootstrap')).json();assert.equal(bootstrap.token,undefined);assert.ok((await(await fetch(base+'/api/bootstrap')).json()).token);
 const html=await(await request('/')).text();assert.match(html,/\/apps\/purchase\/workbench-base.js/);assert.match(html,/\/apps\/purchase\/app.js/);
 const manifest=await(await request('/api/integration/v1/workbench/operations')).json();assert.ok(manifest.operations.some(x=>x.path==='/api/admin/password'&&!x.remote));assert.ok(manifest.operations.some(x=>x.path==='/api/orders'&&x.remote&&x.method==='POST'));
 assert.equal((await request('/api/backup','POST',{})).status,403);
 const data={platform:'手工',account:'test',orderNo:'123456789012345678901',date:'2026-10-01',supplier:'test',status:'已完成',amountCents:100,refundCents:0,items:[{title:'test',qty:1,unitPriceCents:100}]};
 assert.equal((await request('/api/orders','POST',{...data,orderNo:'viewer-member-order'},{role:'viewer'})).status,200);
 const saved=await request('/api/orders','POST',data);assert.equal(saved.status,200,await saved.clone().text());
 assert.equal(integration.state.dataSetId,capabilities.dataSetId);assert.ok(Number(integration.state.revision)>Number(capabilities.revision));
 assert.equal((await(await request('/api/integration/v1/workbench/migration/export','GET',null,{role:'admin'})).json()).sourceInstance,capabilities.dataSetId);
 assert.equal((await request('/api/integration/v1/review-session','GET',null,{channel:'mcp'})).status,403);
 const s=await request('/api/integration/v1/review-session'),nonce=(await s.json()).nonce,cookie=s.headers.get('set-cookie').split(';')[0];
 const created=await(await request('/api/integration/v1/edits','POST',{type:'order',target:store.list()[0].id,patch:{note:'reviewed'},reason:'人工核对'})).json();
 const route='/api/integration/v1/edits/'+created.id+'/commit';assert.equal((await request(route,'POST',{revision:created.revision},{channel:'mcp'})).status,403);
 assert.equal((await request(route,'POST',{revision:created.revision},{session:'other',extra:{Cookie:cookie,'x-review-token':nonce}})).status,403);
 assert.equal((await request(route,'POST',{revision:created.revision},{extra:{Cookie:cookie,'x-review-token':nonce}})).status,200);
 assert.equal(store.get(store.list()[0].id).note,'reviewed');assert.ok(store.db.prepare('SELECT * FROM workbench_request_audit').all().some(x=>JSON.parse(x.actor).id==='tailscale:test'));
 const maintenance=await request('/api/integration/v1/workbench/migration/maintenance','POST',{enabled:true,migrationId:'test-migration'},{role:'admin'});assert.equal(maintenance.status,200,await maintenance.clone().text());assert.ok(fs.existsSync(path.join(dir,'.workbench-maintenance.json')));
 assert.equal((await request('/api/orders','POST',{...data,orderNo:'new'})).status,503);
 const backup=await(await request('/api/integration/v1/workbench/migration/backup','POST',{}, {role:'admin'})).json();assert.ok(fs.existsSync(backup.path));assert.match(backup.sha256,/^[a-f0-9]{64}$/);
 assert.equal((await request('/api/integration/v1/workbench/migration/maintenance','POST',{enabled:false,migrationId:'another-batch'},{role:'admin'})).status,409);
 const bundle={schemaVersion:1,module:'purchase',sourceInstance:'empty-source',records:[]},preview=await(await request('/api/integration/v1/workbench/migration/preview','POST',{bundle},{role:'admin'})).json();
 const permit=plan=>{const expiresAt=Date.now()+30000,hash=digest(plan);return {digest:hash,expiresAt,signature:createHmac('sha256',key).update('workbench-migration/v1:'+hash+':'+expiresAt+':one').digest('hex')};};
 const wrong={migrationId:'another-batch',bundle,revision:preview.revision,selections:[]};assert.equal((await request('/api/integration/v1/workbench/migration/commit','POST',{plan:wrong,permit:permit(wrong)},{role:'admin'})).status,409);
 const plan={...wrong,migrationId:'test-migration'},committed=await request('/api/integration/v1/workbench/migration/commit','POST',{plan,permit:permit(plan)},{role:'admin'});assert.equal(committed.status,200,await committed.clone().text());const result=await committed.json();assert.equal(result.verification.ok,true);assert.equal((await(await request('/api/integration/v1/workbench/migration/verify/'+result.migrationId,'GET',null,{role:'admin'})).json()).ok,true);
 assert.equal((await request('/api/integration/v1/workbench/migration/maintenance','POST',{enabled:false,migrationId:'test-migration'},{role:'admin'})).status,200);
});


// Hybrid acceptance cases: authored only; run with the coordinated freeze.
test('managed local business pages use verified Windows UI identity, reviewed month locks and durable manual receipts',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-hybrid-http-')),{app,store}=createApp({dataDir:dir,agentManaged:true}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port,key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim(),actorId='windows:S-1-5-21-1234';
 async function call(route,{body,method=body?'POST':'GET',operationKey=crypto.randomUUID(),patch={},signed=true,requestOrigin=origin}={}){
  const now=Date.now(),actor={v:1,id:actorId,login:'真实本机用户',label:'真实操作人',role:'admin',modules:['purchase'],canRunTasks:true,sessionId:'hybrid-ui-session',channel:'ui',requestId:crypto.randomUUID(),issuedAt:now,expiresAt:now+30000,module:'purchase',method,path:route,localDesktop:true,uiOrigin:origin,...patch};
  const r=await fetch(origin+route,{method,headers:{'content-type':'application/json',Origin:requestOrigin,'Idempotency-Key':operationKey,...(signed?signWorkbenchActor(actor,key):{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};
 }
 assert.equal((await call('/api/bootstrap',{signed:false})).status,401);
 const page=await call('/');assert.equal(page.status,200);assert.doesNotMatch(page.body,/src="\/apps\/purchase\/workbench-base\.js"/);
 const bootstrap=await call('/api/bootstrap');assert.equal(bootstrap.status,200);assert.equal(bootstrap.body.confirmationMode,'signed-review');assert.equal(bootstrap.body.token,undefined);assert.equal(bootstrap.body.adminConfigured,false);
 assert.equal((await call('/api/bootstrap',{patch:{id:'tailscale:spoof'}})).status,403);
 assert.equal((await call('/api/bootstrap',{patch:{uiOrigin:'http://127.0.0.1:1'}})).status,403);
 assert.equal((await call('/api/bootstrap',{requestOrigin:'http://untrusted.invalid'})).status,403);
 assert.equal((await call('/api/backup',{body:{}})).status,403);
 assert.equal((await call('/api/integration/v1/workbench/migration/export')).status,403);
 const order={platform:'微信',account:'测试账号',orderNo:'HYBRID-001',date:'2020-01-02',supplier:'测试商家',amountCents:12345,items:[{title:'商品',qty:1}],uploadedBy:'伪造录入人'},saved=await call('/api/orders',{body:order,operationKey:'hybrid-once'});assert.equal(saved.status,200);assert.equal(saved.body.uploadedBy,'真实操作人');
 assert.deepEqual((await call('/api/orders',{body:order,operationKey:'hybrid-once'})).body,saved.body);assert.equal(store.list().length,1);
 assert.equal((await call('/api/orders',{body:{...order,amountCents:1},operationKey:'hybrid-once'})).status,409);
 assert.equal((await call('/api/manual-receipts/hybrid-once')).body.state,'completed');
 const audit=store.auditLog.detail(store.history(saved.body.id)[0].id);assert.equal(audit.actor.id,actorId);assert.equal(audit.actor.login,'真实本机用户');
 const preview=(await call('/api/month-confirmations/preview?month=2020-01&platform='+encodeURIComponent('微信'))).body,scope={month:'2020-01',platform:'微信',revision:preview.revision};
 assert.equal((await call('/api/month-confirmations',{body:scope})).status,400);
 assert.equal((await call('/api/month-confirmations',{body:{...scope,ack:true},patch:{channel:'mcp',localDesktop:false}})).status,403);
 const confirmed=await call('/api/month-confirmations',{body:{...scope,ack:true}});assert.equal(confirmed.status,200);assert.equal(store.monthLocks.configured(),false);
 assert.throws(()=>store.insert({...order,orderNo:'locked'}),e=>e.code==='MONTH_LOCKED');
 const cancel={month:'2020-01',platform:'微信',version:confirmed.body.version,ack:true};
 assert.equal((await call('/api/month-confirmations/cancel',{body:cancel})).status,400);
 assert.equal((await call('/api/month-confirmations/cancel',{body:{...cancel,version:'stale',reason:'补录依据'}})).status,409);
 assert.equal((await call('/api/month-confirmations/cancel',{body:{...cancel,reason:'补录依据'}})).status,200);
 const history=store.monthLocks.history('2020-01','微信');assert.equal(history.at(-1).details.actorId,actorId);assert.equal(history.at(-1).details.authorization,'workbench-ui-review');assert.equal(store.monthLocks.confirmations().length,0);
});
