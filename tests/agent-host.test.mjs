import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createHostIdentity,windowsPrincipal} from '../desktop/agent-host/identity.mjs';
import {createSafeSecretStore} from '../desktop/agent-host/secret-store.mjs';
import {assertLauncherSender,agentEnvelope} from '../desktop/agent-host/trust.mjs';
import {agentBetaPaths,prepareAgentProfile,assertAgentRegistry,guardAgentServices,assertBetaServerAddress} from '../desktop/agent-host/isolation.mjs';
import {createAgentModuleTransport} from '../desktop/agent-host/module-transport.mjs';
import {startAgentBridge,createAgentBridgeClient} from '../desktop/agent-host/bridge.mjs';
import {artifactDownload,saveArtifactDownload} from '../desktop/agent-host/artifacts.mjs';
import {provisionWorkbenchKey,verifyWorkbenchActor} from '../desktop/workbench/actor.mjs';
import {prepareServe,enableServe} from '../desktop/workbench-client/tailscale-serve.mjs';
import {serverAddress} from '../desktop/workbench-client/connection.mjs';
import {assertLauncherOperationAllowed,assertLegacyAgentReadOnly} from '../desktop/agent-host/launcher-policy.mjs';

function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-host-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const owner={id:'windows:S-1-5-21-100-100-100-1001',login:'windows:S-1-5-21-100-100-100-1001',label:'Test Owner'};
const user={role:'editor',modules:['purchase'],canRunTasks:true,enabled:true};
function fixture(t){const root=temp(t),policyFile=path.join(root,'policy.json'),identity=createHostIdentity({storeDir:root,policyFile,principal:owner});return {root,policyFile,identity,meta:{actor:identity.localActor(),trustedUi:true}};}

test('real Windows identity uses the process SID, not a renderer-selected role',{skip:process.platform!=='win32'},()=>{
  assert.match(windowsPrincipal().id,/^windows:S-1-5-/);
  assert.throws(()=>windowsPrincipal({run:()=> 'not-an-identity'}),{code:'WINDOWS_IDENTITY_UNAVAILABLE'});
});
test('permissions re-read enabled membership and reject stale updates and self-selected admin',t=>{
  const f=fixture(t),before=f.identity.permissionsGet({},f.meta),policy={schemaVersion:1,users:{'member@example.test':structuredClone(user)}};
  const saved=f.identity.permissionsSave({policy,revision:before.revision},f.meta);
  assert.equal(f.identity.resolveActor('tailscale:member@example.test').role,'editor');
  assert.throws(()=>f.identity.permissionsSave({policy,revision:before.revision},f.meta),{code:'REVISION_CONFLICT'});
  assert.throws(()=>f.identity.permissionsGet({}, {actor:{id:'tailscale:member@example.test',role:'admin'},trustedUi:true}),{code:'ADMIN_REQUIRED'});
  policy.users['member@example.test'].enabled=false;f.identity.permissionsSave({policy,revision:saved.revision},f.meta);
  assert.equal(f.identity.resolveActor('tailscale:member@example.test'),null);
  const other=createHostIdentity({storeDir:f.root,policyFile:f.policyFile,principal:{...owner,id:'windows:S-1-5-21-200-200-200-1001'}});
  assert.throws(()=>other.localActor(),{code:'HOST_OWNER_DENIED'});
});
test('secret store encrypts bytes and supports Electron async decrypt result',async t=>{
  const root=temp(t),key=randomBytes(32),safeStorage={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]);},decryptStringAsync:async bytes=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString(),shouldReEncrypt:false};}};
  const store=createSafeSecretStore({storeDir:root,safeStorage}),value='synthetic-test-company-credential';
  await store.set('company-api-key',value);assert.equal(store.has('company-api-key'),true);assert.equal(await store.get('company-api-key'),value);
  assert.equal(fs.readFileSync(path.join(root,'company-secrets.json'),'utf8').includes(value),false);
  await store.delete('company-api-key');assert.equal(await store.get('company-api-key'),null);
  const unavailable=createSafeSecretStore({storeDir:root,safeStorage:{...safeStorage,getSelectedStorageBackend:()=> 'basic_text'}});
  await assert.rejects(()=>unavailable.set('company-api-key',value),{code:'SAFE_STORAGE_UNAVAILABLE'});
});
test('IPC requires exact packaged top frame and rejects identity injection',t=>{
  const page=path.join(temp(t),'agent-index.html'),frame={url:pathToFileURL(page).href},contents={mainFrame:frame},win={isDestroyed:()=>false,webContents:contents};
  assertLauncherSender({sender:contents,senderFrame:frame},win,[page]);
  assert.throws(()=>assertLauncherSender({sender:contents,senderFrame:{url:frame.url}},win,[page]),{code:'UI_SOURCE_DENIED'});
  frame.url='https://example.test/agent-index.html';assert.throws(()=>assertLauncherSender({sender:contents,senderFrame:frame},win,[page]),{code:'UI_SOURCE_DENIED'});
  assert.throws(()=>agentEnvelope({operation:'reviews.approve',payload:{actor:{role:'admin'}}}),{code:'IDENTITY_INPUT_DENIED'});
  assert.throws(()=>agentEnvelope({operation:'status',payload:{},trustedUi:true}),{code:'AGENT_REQUEST_INVALID'});
});
test('beta registry cannot fall back to production, follow junctions, or start without copied ledgers',t=>{
  const root=temp(t),paths=agentBetaPaths({localAppData:root});prepareAgentProfile(paths);const registry=assertAgentRegistry(paths);let starts=0;
  const services={registryFile:paths.registryFile,config:id=>({...registry[id],db:'purchases.sqlite'}),ensure:async()=>{starts++;},start:async()=>{starts++;}};
  guardAgentServices(services,paths);assert.throws(()=>services.ensure('purchase'),{code:'TEST_LEDGER_NOT_READY'});assert.equal(starts,0);
  registry.purchase.dataDir=path.join(root,'formal-ledger');fs.writeFileSync(paths.registryFile,JSON.stringify(registry));assert.throws(()=>services.config('purchase'),{code:'BETA_REGISTRY_UNSAFE'});
  assert.throws(()=>agentBetaPaths({localAppData:root,root:path.join(root,'formal')}),{code:'BETA_LOCATION_INVALID'});
});
test('real HTTP module transport signs current identity, forces MCP channel and denies unreviewed commit',async t=>{
  const f=fixture(t),current=f.identity.permissionsGet({},f.meta);f.identity.permissionsSave({policy:{schemaVersion:1,users:{'member@example.test':structuredClone(user)}},revision:current.revision},f.meta);
  const dataDir=path.join(f.root,'module');fs.mkdirSync(dataDir);const key=provisionWorkbenchKey(dataDir);fs.writeFileSync(path.join(dataDir,'.integration-key'),randomBytes(32).toString('hex'));
  let requests=0;const server=http.createServer(async(req,res)=>{requests++;const actor=verifyWorkbenchActor(req.headers,key,{module:'purchase',method:req.method,path:req.url});assert.equal(actor.role,'editor');assert.equal(actor.channel,'mcp');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,actorId:actor.id,bound:true}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeIdleConnections();server.close(resolve);}));
  const transport=createAgentModuleTransport({services:{config:()=>({dataDir}),ensure:async()=>({url:'http://127.0.0.1:'+server.address().port,dataSetId:'test-ledger',revision:1})},resolveActor:f.identity.resolveActor});
  const ctx={actor:{id:'tailscale:member@example.test',role:'admin',sessionId:'test-session'}};
  const result=await transport('purchase','/api/integration/v1/agent/prepare',{method:'POST',body:{item:1},ctx});assert.equal(result.bound,true);assert.equal(requests,1);
  await assert.rejects(()=>transport('purchase','/api/integration/v1/agent/commit',{method:'POST',body:{},ctx}),{code:'AGENT_APPROVAL_REQUIRED'});assert.equal(requests,1);
  const now=f.identity.permissionsGet({},f.meta);now.policy.users['member@example.test'].enabled=false;f.identity.permissionsSave(now,f.meta);
  await assert.rejects(()=>transport('purchase','/api/integration/v1/agent/query',{method:'POST',ctx}),{code:'MODULE_DENIED'});
  await assert.rejects(()=>transport.signApproval({actorId:owner.id},'purchase'),{code:'AGENT_APPROVAL_REQUIRED'});
});
test('private HTTP bridge authenticates gateway and never accepts renderer identity fields',async t=>{
  const root=temp(t),seen=[];const bridge=await startAgentBridge({storeDir:root,request:async(operation,payload,meta)=>{seen.push(meta);return {operation};}});t.after(()=>bridge.close());
  const denied=await fetch(bridge.url+'/request',{method:'POST',body:'{}'});assert.equal(denied.status,403);
  const client=createAgentBridgeClient({storeDir:root}),actor={id:'tailscale:member@example.test',channel:'mcp',sessionId:'example'};
  await client.request('status',{}, {actor,trustedUi:true});assert.equal(seen[0].trustedUi,false);
  await assert.rejects(()=>client.request('status',{role:'admin'}, {actor}),{code:'IDENTITY_INPUT_DENIED'});
});
test('artifact downloads only read task-owned paths and save bytes without executing files',async t=>{
  const root=temp(t),dir=path.join(root,'tasks','task-1');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'result.csv');fs.writeFileSync(file,'synthetic,1\n');
  const result=artifactDownload(root,{taskId:'task-1',path:file,name:'result.csv'});
  assert.throws(()=>artifactDownload(root,{taskId:'task-2',path:file}),{code:'FILE_SCOPE_DENIED'});
  const destination=path.join(root,'saved.csv');await saveArtifactDownload(result,{dialog:{showSaveDialog:async()=>({canceled:false,filePath:destination})},downloads:root});assert.equal(fs.readFileSync(destination,'utf8'),'synthetic,1\n');
});
test('Beta Tailscale proposal preserves every original HTTPS entry and does not reset',t=>{
  const root=temp(t),host='erp.test.ts.net',before={Web:{[host+':443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:4000'}}},[host+':8443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:17330'}}}},TCP:{443:{HTTPS:true},8443:{HTTPS:true}}};let current=structuredClone(before);const calls=[];
  const run=args=>{calls.push(args);if(args[1]==='status')return JSON.stringify(current);assert.deepEqual(args,['serve','--bg','--https=9443','http://127.0.0.1:27330']);current.Web[host+':9443']={Handlers:{'/':{Proxy:'http://127.0.0.1:27330'}}};current.TCP['9443']={HTTPS:true};return '';};
  const options={origin:'https://'+host+':9443',backupRoot:root,httpsPort:9443,targetPort:27330,run};const plan=prepareServe(options);assert.equal(plan.alreadyEnabled,false);assert.equal(calls.length,1);enableServe(options);
  for(const port of [443,8443])assert.deepEqual(current.Web[host+':'+port],before.Web[host+':'+port]);assert.equal(calls.flat().includes('reset'),false);
  assert.equal(serverAddress(options.origin),options.origin);assert.equal(serverAddress('https://'+host+':8443'),'https://'+host+':8443');
  for(const url of ['https://example.com:9443','https://'+host+':1234','http://'+host+':9443'])assert.throws(()=>serverAddress(url));
  assert.equal(assertBetaServerAddress(options.origin),options.origin);assert.throws(()=>assertBetaServerAddress('https://'+host+':8443'),{code:'BETA_SERVER_INVALID'});
});
test('Beta startup and maintenance cannot activate stable packages or bypass result review',()=>{
  for(const op of ['modules:refresh','modules:install','modules:uninstall','modules:offline','modules:offline-install','modules:offline-plan','migration:commit','launcher:update-install','personnel:select','permissions:save','desks:stop','unknown:write'])assert.throws(()=>assertLauncherOperationAllowed(op),{code:'BETA_MAINTENANCE_DISABLED'});
  for(const op of ['agent:request','modules:list','diagnostics:read','permissions:get'])assert.doesNotThrow(()=>assertLauncherOperationAllowed(op));
  for(const request of [{command:'import'},{command:'extension-call',action:'start'},{command:'extension-call',action:'prepare',confirmSideEffect:true}])assert.throws(()=>assertLegacyAgentReadOnly(request),{code:'LEGACY_AGENT_WRITE_DISABLED'});
  assert.doesNotThrow(()=>assertLegacyAgentReadOnly({command:'extension-call',action:'query'}));
  const main=fs.readFileSync(new URL('../desktop/launcher/main.mjs',import.meta.url),'utf8');
  assert(!main.includes('modules-stable'));assert(!main.includes('ensureBundledSuite('));assert(!main.includes('initializeUnifiedData('));assert(!main.includes('createUpdater('));assert(!main.includes('modules.setCatalog('));
});
