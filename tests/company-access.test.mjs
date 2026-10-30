import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostIdentity} from '../desktop/agent-host/identity.mjs';
import {createWorkbenchGateway} from '../desktop/workbench/gateway.mjs';
import {WORKBENCH_MODULES} from '../desktop/workbench/actor.mjs';
import {configureWorkbench} from '../desktop/workbench/server.mjs';

test('only real gateway login creates a shared company identity; obsolete policy is inert',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'company-shared-access-')),profile=path.join(root,'profile'),storeDir=path.join(profile,'workbench-server'),origin='https://erp.example.ts.net:9443',principal={id:'windows:S-1-5-21-test',login:'local-owner',label:'Local Owner'};
  fs.mkdirSync(storeDir,{recursive:true});const policyFile=path.join(storeDir,'access-policy.json');fs.writeFileSync(policyFile,'obsolete policy is deliberately not valid JSON');
  const identity=createHostIdentity({storeDir:path.join(profile,'agent-host'),principal});
  const gateway=await createWorkbenchGateway({storeDir,publicOrigin:origin,port:0,accessPolicy(){throw Error('Removed authorization policy must never be evaluated');},services:{config(){throw Error('No synthetic module started');},async capabilities(){return null;}},registerRoutes(app,{requireAdmin}){app.post('/shared-settings',{preHandler:requireAdmin},async request=>({id:request.workbenchActor.id}));}});
  t.after(async()=>{await gateway.stop();fs.rmSync(root,{recursive:true,force:true});});
  const login='employee@example.test',id='tailscale:'+login,initial={host:new URL(origin).host,'tailscale-user-login':login,'x-workbench-channel':'ui'};
  assert.equal(identity.resolveActor(id),null);
  const unauthenticated=await gateway.app.inject({url:'/api/workbench/v1/session',headers:{host:initial.host}});assert.equal(unauthenticated.statusCode,401);
  const invented=await gateway.app.inject({url:'/api/workbench/v1/session',headers:{...initial,'tailscale-user-login':'invented@example.test','x-workbench-actor':'forged'}});assert.equal(invented.statusCode,400);assert.equal(identity.resolveActor('tailscale:invented@example.test'),null);
  const session=await gateway.app.inject({url:'/api/workbench/v1/session',headers:initial});assert.equal(session.statusCode,200,session.body);
  const data=session.json(),actor=identity.resolveActor(id);assert(actor);assert.equal(actor.id,id);assert.deepEqual(actor.modules,[...WORKBENCH_MODULES]);assert.equal(actor.canRunTasks,true);assert.equal(actor.accessMode,'company-shared');
  assert.deepEqual(data.actor.modules,[...WORKBENCH_MODULES]);assert.equal(fs.readFileSync(policyFile,'utf8'),'obsolete policy is deliberately not valid JSON');
  const cookie=[session.headers['set-cookie']].flat()[0].split(';')[0],headers={...initial,cookie,origin,'x-workbench-csrf':data.csrfToken};
  const allowed=await gateway.app.inject({method:'POST',url:'/shared-settings',payload:{},headers});assert.equal(allowed.statusCode,200);assert.equal(allowed.json().id,id);
  assert.equal((await gateway.app.inject({method:'POST',url:'/shared-settings',payload:{},headers:{...headers,'x-workbench-csrf':'wrong'}})).statusCode,403);
  assert.equal((await gateway.app.inject({method:'POST',url:'/shared-settings',payload:{},headers:{...headers,'tailscale-user-login':'other@example.test'}})).statusCode,401);
  assert.equal(identity.resolveActor('tailscale:other@example.test'),null);
  assert.throws(()=>identity.permissionsSave({policy:{schemaVersion:1,users:{}}},{actor,trustedUi:true}),{code:'FEATURE_REMOVED'});
});

test('old --policy configuration is explicitly removed and preserves its source file',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'company-removed-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const policyFile=path.join(root,'old-policy.json');fs.writeFileSync(policyFile,'historical');
  assert.throws(()=>configureWorkbench({storeDir:path.join(root,'server'),publicOrigin:'https://erp.example.ts.net:9443',policyFile}),{code:'FEATURE_REMOVED'});
  assert.equal(fs.readFileSync(policyFile,'utf8'),'historical');
});
