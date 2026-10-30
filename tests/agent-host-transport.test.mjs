import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
import {createAgentModuleTransport,moduleTimeoutBudget} from '../desktop/agent-host/module-transport.mjs';
import {provisionWorkbenchKey,verifyWorkbenchActor} from '../desktop/workbench/actor.mjs';
import {selectCompatibleCodex} from '../desktop/agent-host/composition.mjs';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';

const approvalUrl=process.env.AGENT_RUNTIME_TEST_ENTRY?pathToFileURL(path.join(path.dirname(process.env.AGENT_RUNTIME_TEST_ENTRY),'approval.mjs')):new URL('../desktop/agent-runtime/approval.mjs',import.meta.url);
const {signAgentApproval,verifyAgentApproval}=await import(approvalUrl);
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-host-transport-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:80}));return root;};
async function fixture(t,{role='editor',canRunTasks=false,respond}={}){
  const root=temp(t),dataDir=path.join(root,'module');fs.mkdirSync(dataDir);const key=provisionWorkbenchKey(dataDir);fs.writeFileSync(path.join(dataDir,'.integration-key'),randomBytes(32).toString('hex'));
  let actor={id:'tailscale:employee@example.test',login:'employee@example.test',role,canRunTasks,modules:['warehouse','purchase'],enabled:true},requests=[];
  const server=http.createServer(async(req,res)=>{const signed=verifyWorkbenchActor(req.headers,key,{module:'warehouse',method:req.method,path:req.url});requests.push({method:req.method,path:req.url,actor:signed});if(respond)return respond(req,res);res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const artifactRoot=path.join(root,'tasks'),manifest={protocolVersion:1,operations:[{method:'GET',path:'/api/files/:id',kind:'download',remote:true},{method:'GET',path:'/api/query',kind:'read',remote:true}]};
  const transport=createAgentModuleTransport({services:{config:()=>({dataDir}),ensure:async()=>({url:'http://127.0.0.1:'+server.address().port,workbench:manifest})},resolveActor:async()=>actor,artifactRoot,verifyProof:verifyAgentApproval,signProof:signAgentApproval,validateApproval:async claims=>claims.taskId==='task-approved'&&claims.resultId==='result-approved'});
  return {root,artifactRoot,key,transport,requests,ctx:{actor,taskId:'task-approved'},setActor(value){actor=value;}};
}
test('viewer POST query/binding/receipt are read-only but prepares remain denied',async t=>{
  const f=await fixture(t,{role:'viewer'});for(const route of ['query','binding','receipt','receipts/operation-1'])await f.transport('warehouse','/api/integration/v1/agent/'+route,{method:'POST',ctx:f.ctx,body:{}});
  await assert.rejects(()=>f.transport('warehouse','/api/integration/v1/agent/prepare',{method:'POST',ctx:f.ctx,body:{}}),{code:'READ_ONLY'});assert.equal(f.requests.length,4);assert(f.requests.every(r=>r.actor.channel==='mcp'));
});
test('employee attendance exception uses trusted context and signed persisted approval, never body alone',async t=>{
  const f=await fixture(t),ctx={...f.ctx,capabilityId:'attendance.check-in'};
  await f.transport('warehouse','/api/integration/v1/agent/prepare',{method:'POST',ctx,body:{capabilityId:ctx.capabilityId}});
  await assert.rejects(()=>f.transport('warehouse','/api/integration/v1/agent/prepare',{method:'POST',ctx:{...ctx,capabilityId:'inventory.sync'},body:{capabilityId:'attendance.check-in'}}),{code:'TASK_PERMISSION_REQUIRED'});
  await assert.rejects(()=>f.transport('warehouse','/api/integration/v1/agent/prepare',{method:'POST',ctx,body:{capabilityId:'inventory.sync'}}),{code:'CAPABILITY_CONTEXT_REQUIRED'});
  const now=Date.now(),claims={v:1,approvalId:'approval-1',actorId:ctx.actor.id,module:'warehouse',capabilityId:ctx.capabilityId,taskId:ctx.taskId,resultId:'result-approved',resultVersion:1,dataSetId:'test-ledger',revision:1,changeDigest:'a'.repeat(64),idempotencyKey:'attendance-operation',issuedAt:now,expiresAt:now+30000},proof=await f.transport.signApproval(claims,'warehouse');
  await f.transport('warehouse','/api/integration/v1/agent/commit',{method:'POST',ctx:{...ctx,approval:proof,idempotencyKey:claims.idempotencyKey},body:{}});assert.equal(f.requests.length,2);
  await assert.rejects(()=>f.transport('warehouse','/api/integration/v1/agent/commit',{method:'POST',ctx:{...ctx,approval:{...proof,signature:'b'.repeat(64)},idempotencyKey:claims.idempotencyKey},body:{}}),{code:'AGENT_APPROVAL_INVALID'});
  const foreign=signAgentApproval({...claims,taskId:'task-unapproved'},f.key);await assert.rejects(()=>f.transport('warehouse','/api/integration/v1/agent/commit',{method:'POST',ctx:{...ctx,taskId:'task-unapproved',approval:foreign,idempotencyKey:claims.idempotencyKey},body:{}}),{code:'AGENT_APPROVAL_REQUIRED'});
  await assert.rejects(()=>f.transport.signApproval({...claims,capabilityId:'inventory.sync'},'warehouse'),{code:'MODULE_DENIED'});
});
test('long prepare has a bounded budget and cancellation makes no duplicate request',async t=>{
  let arrived;const seen=new Promise(resolve=>arrived=resolve),f=await fixture(t,{canRunTasks:true,respond:()=>arrived()}),controller=new AbortController();
  const result=f.transport('warehouse','/api/integration/v1/agent/prepare',{method:'POST',ctx:{...f.ctx,capabilityId:'inventory.sync',signal:controller.signal},body:{}});await seen;controller.abort();await assert.rejects(result);assert.equal(f.requests.length,1);
  assert.equal(moduleTimeoutBudget('/api/integration/v1/agent/prepare','POST'),1800000);assert.equal(moduleTimeoutBudget('/api/integration/v1/agent/query','POST'),120000);
});
test('allowlisted binary download streams 50MiB into one task and exposes no local path',async t=>{
  const chunk=Buffer.alloc(1024*1024,65),hash=createHash('sha256');for(let i=0;i<50;i++)hash.update(chunk);const sha256=hash.digest('hex');
  const f=await fixture(t,{role:'viewer',respond:async(_req,res)=>{res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',chunk.length*50);for(let i=0;i<50;i++)if(!res.write(chunk))await once(res,'drain');res.end();}});let registered;
  const result=await f.transport.download('warehouse','/api/files/synthetic-id',{ctx:{...f.ctx,registerArtifact:async item=>{registered=item;return {id:'artifact-1'};}},expectedSha256:sha256,filename:'synthetic.bin'});
  assert.equal(result.size,50*1024*1024);assert.equal(result.sha256,sha256);assert.equal('path'in result,false);assert.equal(fs.statSync(registered.path).size,result.size);assert.equal(path.dirname(registered.path),path.join(f.artifactRoot,f.ctx.taskId));
});
test('downloads reject arbitrary routes, outside paths, oversize and mismatched hashes',async t=>{
  const f=await fixture(t,{respond:(_req,res)=>{res.setHeader('Content-Length',4);res.end('data');}}),ctx={...f.ctx,registerArtifact:async()=>({id:'unused'})};
  for(const route of ['https://example.test/file','/api/files/id?path=C:/private','/api/query'])await assert.rejects(()=>f.transport.download('warehouse',route,{ctx}));
  await assert.rejects(()=>f.transport.download('warehouse','/api/files/id',{ctx,maxBytes:3}),{code:'ARTIFACT_TOO_LARGE'});
  await assert.rejects(()=>f.transport.download('warehouse','/api/files/id',{ctx,expectedSha256:'a'.repeat(64)}),{code:'ARTIFACT_HASH_MISMATCH'});assert.deepEqual(fs.readdirSync(path.join(f.artifactRoot,ctx.taskId)),[]);
  fs.rmSync(f.artifactRoot,{recursive:true});const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,f.artifactRoot,'junction');await assert.rejects(()=>f.transport.download('warehouse','/api/files/id',{ctx}),{code:'ARTIFACT_PATH_DENIED'});fs.unlinkSync(f.artifactRoot);
  f.setActor(null);await assert.rejects(()=>f.transport.download('warehouse','/api/files/id',{ctx}),{code:'MODULE_DENIED'});
});
test('Codex discovery validates npm before PATH candidates and refuses incompatible versions',async t=>{
  const root=temp(t),script=path.join(root,'npm','node_modules','@openai','codex','bin','codex.js');fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(script,'// fixture');const checks=[];
  const createEngine=options=>({options,check:async()=>{checks.push(options);return {available:options.argsPrefix?.[0]===script,version:options.argsPrefix?.[0]===script?'0.150.1':'0.165.0-alpha.1.2'};}});
  const engine=await selectCompatibleCodex({createEngine,nodeExecutable:process.execPath,appData:root,locate:()=>['C:/incompatible/codex.exe']});assert.equal(engine.options.argsPrefix[0],script);assert.equal(checks.length,1);
  const unavailable=await selectCompatibleCodex({createEngine,nodeExecutable:process.execPath,appData:path.join(root,'absent'),locate:()=>['C:/incompatible/codex.exe']});assert.equal((await unavailable.check()).available,false);
});
test('real managed child receives AGENT_MANAGED and leaves the isolated existing ledger intact',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-host-child-')),dataDir=path.join(root,'data');fs.mkdirSync(dataDir);fs.mkdirSync(path.join(root,'node_modules','express'),{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'wucheng-sales-desk',type:'module',version:'0.0.1'}));fs.writeFileSync(path.join(dataDir,'sales.sqlite'),'isolated-ledger-sentinel');
  const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));const registryFile=path.join(root,'registry.json');fs.writeFileSync(registryFile,JSON.stringify({sales:{root,dataDir,port,managed:true,version:'0.0.1',nodePath:process.execPath,allowInitialize:false}}));
  fs.writeFileSync(path.join(root,'server.mjs'),`import http from 'node:http';import fs from 'node:fs';fs.writeFileSync('owned-pid',String(process.pid));http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({id:'wucheng-sales-desk',apiVersion:1,version:'0.0.1',root:process.cwd(),dataDir:process.env.SALES_DATA_DIR,url:'http://127.0.0.1:'+process.env.SALES_PORT,pid:process.pid,agentManaged:process.env.LINGTU_AGENT_MANAGED}));}).listen(Number(process.env.SALES_PORT),'127.0.0.1');`);
  t.after(async()=>{const file=path.join(root,'owned-pid');if(fs.existsSync(file)){const pid=Number(fs.readFileSync(file,'utf8'));try{process.kill(pid);}catch{}const deadline=Date.now()+3000;while(Date.now()<deadline){try{process.kill(pid,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,25));}}await new Promise(resolve=>setImmediate(resolve));await fs.promises.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:80});});
  const cap=await new ServiceManager({registryFile,agentManaged:true,startupTimeoutMs:5000,startupPollMs:20}).ensure('sales');assert.equal(cap.agentManaged,'1');assert.equal(fs.readFileSync(path.join(dataDir,'sales.sqlite'),'utf8'),'isolated-ledger-sentinel');
});
