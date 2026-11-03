// Prepared for the unified run; this file has not been executed in this phase.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';import {signWorkbenchActor} from '../lib/workbench-actor.mjs';

test('managed Beta mobile requires a signed shared login, ignores policy roles and retains session/CSRF',{timeout:30000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-managed-mobile-')),policy=path.join(dir,'broken-policy.json');fs.writeFileSync(policy,'broken and deliberately not an authorization source');
 const {app,store,mobile}=createApp({dataDir:path.join(dir,'data'),mobilePolicyFile:policy,mobileAgentManaged:true});
 const listen=async app=>{const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));return s;},desktop=await listen(app),phone=await listen(mobile.app);
 t.after(async()=>{await Promise.all([new Promise(r=>desktop.close(r)),new Promise(r=>phone.close(r))]);store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const key=fs.readFileSync(path.join(dir,'data','.workbench-key'),'utf8').trim(),bearer=fs.readFileSync(path.join(dir,'data','.integration-key'),'utf8').trim();
 async function request(server,route,{id='tailscale:member@example.test',role='viewer',channel='ui',body,cookie='',csrf='',signed=true,headerOnly=false,actorPatch={},requestId=randomUUID()}={}){
  const method=body?'POST':'GET',now=Date.now(),actor={v:1,id,login:id,role,modules:['purchase'],canRunTasks:false,channel,sessionId:'gateway-session',requestId,issuedAt:now,expiresAt:now+30000,module:'purchase',method,path:route,...actorPatch};
  const headers={Authorization:'Bearer '+bearer,'content-type':'application/json',...(signed?signWorkbenchActor(actor,key):{}),...(headerOnly?{'tailscale-user-login':'forged@example.test'}:{}),Cookie:cookie,'x-review-token':csrf,'Idempotency-Key':requestId};
  const r=await fetch('http://127.0.0.1:'+server.address().port+route,{method,headers,body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 }
 // No configured mobile origin, no policy grant and no local identity fallback.
 assert.equal((await request(phone,'/api/mobile/pair',{body:{},signed:false,headerOnly:true})).status,401);
 assert.equal((await request(phone,'/api/mobile/pair',{body:{},channel:'mcp'})).status,403);
 assert.equal((await request(phone,'/api/mobile/pair',{body:{},actorPatch:{path:'/different'}})).status,401);
 const first=await request(phone,'/api/mobile/pair',{body:{}});assert.equal(first.status,200);assert.ok(first.body.csrf);assert.match(first.cookie,/purchase_mobile=/);
 const session={cookie:first.cookie,csrf:first.body.csrf};assert.equal((await request(phone,'/api/mobile/orders',session)).status,200);
 assert.equal((await request(phone,'/api/mobile/orders',{...session,id:'tailscale:another@example.test'})).status,403);
 assert.equal((await request(phone,'/api/mobile/addresses',{...session,csrf:'wrong',body:{name:'test',phone:'1',address:'test'}})).status,403);
 const saved=await request(phone,'/api/mobile/addresses',{...session,body:{name:'已登录员工',phone:'1',address:'测试地址'}});assert.equal(saved.status,200);
 const sessionId=first.cookie.split('=')[1].split('.')[0];store.db.prepare("UPDATE mobile_sessions SET workbench_actor='' WHERE id=?").run(sessionId);assert.equal((await request(phone,'/api/mobile/session',session)).status,401);
 // Same API is mirrored on the normal module service for /apps/purchase proxying.
 const gatewayPair=await request(desktop,'/api/mobile/pair',{body:{}});assert.equal(gatewayPair.status,200);
 assert.equal((await request(desktop,'/api/mobile/session',{cookie:gatewayPair.cookie})).status,200);
 assert.equal((await request(desktop,'/api/mobile/session',{signed:false,cookie:gatewayPair.cookie})).status,401);
 const audit=store.db.prepare('SELECT actor FROM workbench_request_audit').all();assert.ok(audit.some(r=>JSON.parse(r.actor).id==='tailscale:member@example.test'));
});
