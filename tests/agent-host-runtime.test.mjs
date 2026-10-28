import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createAgentHost} from '../desktop/agent-host/index.mjs';
import {createWorkbenchGateway} from '../desktop/workbench/gateway.mjs';
const runtimePath=process.env.AGENT_RUNTIME_TEST_ENTRY||path.resolve('desktop/agent-runtime/index.mjs');
const {createAgentRuntime}=await import(pathToFileURL(runtimePath).href);
function wireFetch(url,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const request=http.request(url,{method,headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:{getSetCookie:()=>response.headers['set-cookie']||[]},json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});request.on('error',reject);request.end(body);});}

test('real HTTP gateway reaches durable runtime with current Tailscale member and CSRF UI context',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-host-runtime-')),profile=path.join(root,'profile');
  const services={config:()=>({version:'test'}),capabilities:async()=>null};
  const host=await createAgentHost({paths:{profile,environment:{mode:'test',label:'测试账本'}},services,runtimeFactory:createAgentRuntime,principal:{id:'windows:S-1-5-21-1-1-1-1001',login:'local-test',label:'Fixture Owner'},safeStorage:{isEncryptionAvailable:()=>false}});
  const ownerMeta={actor:host.identity.localActor(),trustedUi:true},initial=host.identity.permissionsGet({},ownerMeta),policy={schemaVersion:1,users:{'member@example.test':{enabled:true,role:'editor',modules:['purchase'],canRunTasks:true}}};
  assert.throws(()=>host.request('permissions.inspect',{},ownerMeta),{code:'INTERNAL_OPERATION'});
  host.identity.permissionsSave({policy,revision:initial.revision},ownerMeta);
  const origin='https://fixture.test.ts.net:9443',gateway=await createWorkbenchGateway({storeDir:path.join(profile,'workbench-server'),services,publicOrigin:origin,port:0,agentRuntime:host.runtime});
  await gateway.start();const url='http://127.0.0.1:'+gateway.app.server.address().port;
  t.after(async()=>{await gateway.stop();await host.close();fs.rmSync(root,{recursive:true,force:true});});
  async function connect(channel){const response=await wireFetch(url+'/api/workbench/v1/session',{headers:{host:new URL(origin).host,'tailscale-user-login':'member@example.test','x-workbench-channel':channel,origin}});assert.equal(response.status,200);return {session:await response.json(),cookie:response.headers.getSetCookie()[0].split(';')[0],channel};}
  async function request(session,operation,payload={},extra={}){return wireFetch(url+'/api/workbench/v1/agent/request',{method:'POST',headers:{host:new URL(origin).host,'tailscale-user-login':'member@example.test',origin,'x-workbench-channel':session.channel,'x-workbench-csrf':session.session.csrfToken,cookie:session.cookie,'content-type':'application/json',...extra},body:JSON.stringify({operation,payload})});}
  const ui=await connect('ui'),mcp=await connect('mcp');
  const status=await request(ui,'status');assert.equal(status.status,200);const state=await status.json();assert.equal(state.actor.role,'editor');assert.equal(state.actor.id,'tailscale:member@example.test');assert.equal(state.environment.mode,'test');
  const noCsrf=await request(ui,'status',{}, {'x-workbench-csrf':'invalid'});assert.equal(noCsrf.status,403);
  const upload=await request(ui,'attachments.upload',{name:'fixture.csv',type:'text/csv',bytes:Buffer.from('item,1').toString('base64')});assert.equal(upload.status,200);const attachment=await upload.json();assert(attachment.id);assert(!('path' in attachment));
  const mcpUpload=await request(mcp,'attachments.upload',{name:'fixture.csv',bytes:Buffer.from('item,1').toString('base64')});assert.equal(mcpUpload.status,403);assert.equal((await mcpUpload.json()).code,'UPLOAD_DENIED');
  const forged=await request(ui,'status',{actor:{role:'admin'}});assert.equal(forged.status,403);
  const settings=await request(ui,'permissions.get');assert.equal(settings.status,403);
  const current=host.identity.permissionsGet({},ownerMeta);current.policy.users['member@example.test'].enabled=false;host.identity.permissionsSave(current,ownerMeta);
  const revoked=await request(ui,'status');assert.equal(revoked.status,403);assert.equal((await revoked.json()).code,'MEMBER_DENIED');
});
