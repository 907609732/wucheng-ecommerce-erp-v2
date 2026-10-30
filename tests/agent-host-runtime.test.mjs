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
  let host,gateway;
  t.after(async()=>{try{await gateway?.stop();}finally{try{await host?.close();}finally{fs.rmSync(root,{recursive:true,force:true});}}});
  const services={config:()=>({version:'test'}),capabilities:async()=>null};
  host=await createAgentHost({paths:{profile,environment:{mode:'test',label:'测试账本'}},services,runtimeFactory:createAgentRuntime,principal:{id:'windows:S-1-5-21-1-1-1-1001',login:'local-test',label:'Fixture Owner'},safeStorage:{isEncryptionAvailable:()=>false}});
  const ownerMeta={actor:host.identity.localActor(),trustedUi:true};
  await assert.rejects(()=>host.request('permissions.inspect',{},ownerMeta),{code:'FEATURE_REMOVED'});
  assert.equal(host.identity.resolveActor('tailscale:member@example.test'),null,'a guessed identity is not a real login');
  const origin='https://fixture.test.ts.net:9443';gateway=await createWorkbenchGateway({storeDir:path.join(profile,'workbench-server'),services,publicOrigin:origin,port:0,agentRuntime:host.runtime});
  await gateway.start();const url='http://127.0.0.1:'+gateway.app.server.address().port;
  async function connect(channel){const response=await wireFetch(url+'/api/workbench/v1/session',{headers:{host:new URL(origin).host,'tailscale-user-login':'member@example.test','x-workbench-channel':channel,origin}});assert.equal(response.status,200);return {session:await response.json(),cookie:response.headers.getSetCookie()[0].split(';')[0],channel};}
  async function request(session,operation,payload={},extra={}){return wireFetch(url+'/api/workbench/v1/agent/request',{method:'POST',headers:{host:new URL(origin).host,'tailscale-user-login':'member@example.test',origin,'x-workbench-channel':session.channel,'x-workbench-csrf':session.session.csrfToken,cookie:session.cookie,'content-type':'application/json',...extra},body:JSON.stringify({operation,payload})});}
  const ui=await connect('ui'),mcp=await connect('mcp');
  const status=await request(ui,'status');assert.equal(status.status,200);const state=await status.json();assert.equal(state.actor.role,'admin');assert.equal(state.actor.id,'tailscale:member@example.test');assert.equal(state.actor.modules.length,5);assert.equal(state.actor.canRunTasks,true);assert.equal(state.environment.mode,'test');
  const noCsrf=await request(ui,'status',{}, {'x-workbench-csrf':'invalid'});assert.equal(noCsrf.status,403);
  const upload=await request(ui,'attachments.upload',{name:'fixture.csv',type:'text/csv',bytes:Buffer.from('item,1').toString('base64')});assert.equal(upload.status,200);const attachment=await upload.json();assert(attachment.id);assert(!('path' in attachment));
  const mcpUpload=await request(mcp,'attachments.upload',{name:'fixture.csv',bytes:Buffer.from('item,1').toString('base64')});assert.equal(mcpUpload.status,403);assert.equal((await mcpUpload.json()).code,'UPLOAD_DENIED');
  const forged=await request(ui,'status',{actor:{role:'admin'}});assert.equal(forged.status,403);
  const settings=await request(ui,'permissions.get');assert.equal(settings.status,410);assert.equal((await settings.json()).code,'FEATURE_REMOVED');
  fs.writeFileSync(path.join(profile,'workbench-server','access-policy.json'),JSON.stringify({schemaVersion:1,users:{'member@example.test':{enabled:false,role:'viewer',modules:[],canRunTasks:false}}}));
  const shared=await request(ui,'status');assert.equal(shared.status,200,'old authorization flags must not revoke a real login');
  const differentLogin=await request(ui,'status',{}, {'tailscale-user-login':'model-invented@example.test'});assert.equal(differentLogin.status,401);
  assert.equal(host.identity.resolveActor('tailscale:model-invented@example.test'),null);
});
