import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {createCompanyIdentity} from '../desktop/agent-host/company-identity.mjs';
import {createAgentHost} from '../desktop/agent-host/index.mjs';
import {agentBetaPaths,prepareAgentProfile} from '../desktop/agent-host/isolation.mjs';
import {provisionWorkbenchKey,verifyWorkbenchActor} from '../desktop/workbench/actor.mjs';

test('Beta company identity binds the existing gateway dataset and fails closed after metadata loss',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-company-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile=path.join(root,'profile'),storeDir=path.join(profile,'agent-runtime');fs.mkdirSync(path.join(profile,'workbench-server'),{recursive:true});
  const original={schemaVersion:1,serverId:randomUUID(),dataSetId:randomUUID()},gatewayFile=path.join(profile,'workbench-server','identity.json');fs.writeFileSync(gatewayFile,JSON.stringify(original));
  const identity=createCompanyIdentity({profile,storeDir}),first=identity();assert.equal(first.dataSetId,original.dataSetId);assert.notEqual(first.companyId,original.serverId);
  assert.deepEqual(createCompanyIdentity({profile,storeDir})(),first);
  fs.writeFileSync(gatewayFile,JSON.stringify({...original,dataSetId:randomUUID()}));assert.throws(identity,{code:'COMPANY_IDENTITY_CHANGED'});
  fs.writeFileSync(gatewayFile,JSON.stringify(original));fs.mkdirSync(storeDir,{recursive:true});fs.writeFileSync(path.join(storeDir,'agent-tasks.sqlite'),'metadata-exists');fs.unlinkSync(path.join(profile,'company-identity.json'));
  assert.throws(()=>createCompanyIdentity({profile,storeDir}),{code:'COMPANY_IDENTITY_MISSING'});
});

test('system backup uses actual host company identity and adapter HTTP binding, not stale capability revision',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-backup-composition-')),previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=root;
  let server,host;
  t.after(async()=>{try{await host?.close();}finally{try{if(server?.listening){server.closeIdleConnections();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}finally{if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;fs.rmSync(root,{recursive:true,force:true});}}});
  const paths=agentBetaPaths({localAppData:root});prepareAgentProfile(paths);const registry=JSON.parse(fs.readFileSync(paths.registryFile,'utf8')),dataDir=registry.purchase.dataDir;fs.mkdirSync(path.join(dataDir,'attachments'),{recursive:true});
  const db=new DatabaseSync(path.join(dataDir,'purchases.sqlite'));db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY, amount_cents INTEGER); INSERT INTO orders VALUES(1,12345)');db.close();fs.writeFileSync(path.join(dataDir,'attachments','sample.txt'),'synthetic source');
  const moduleKey=provisionWorkbenchKey(dataDir);fs.writeFileSync(path.join(dataDir,'.integration-key'),randomBytes(32).toString('hex'));
  const moduleDataSetId=randomUUID(),revision=createHash('sha256').update(fs.readFileSync(path.join(dataDir,'purchases.sqlite'))).digest('hex');let bindings=0;
  server=http.createServer((req,res)=>{verifyWorkbenchActor(req.headers,moduleKey,{module:'purchase',method:req.method,path:req.url});assert.equal(req.url,'/api/integration/v1/agent/binding');bindings++;res.setHeader('content-type','application/json');res.end(JSON.stringify({dataSetId:moduleDataSetId,revision}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const load=file=>import(pathToFileURL(file).href);
  const [{createAgentRuntime},{createAgentBackups},{createPurchaseAgentAdapter}]=await Promise.all([
    load(process.env.AGENT_RUNTIME_TEST_ENTRY||path.resolve('desktop/agent-runtime/index.mjs')),
    load(process.env.AGENT_BACKUPS_TEST_ENTRY||path.resolve('desktop/agent-host/backups.mjs')),
    load(process.env.AGENT_PURCHASE_ADAPTER_TEST_ENTRY||path.resolve('apps/purchase/lib/agent-adapter.mjs'))
  ]);
  const services={config:id=>registry[id],ensure:async()=>({url:'http://127.0.0.1:'+server.address().port,dataSetId:'stale-cached-dataset',revision:'stale-cached-revision'})};
  host=await createAgentHost({paths,services,principal:{id:'windows:S-1-5-21-1-1-1-1001',login:'synthetic-owner'},safeStorage:{isEncryptionAvailable:()=>false},startBridge:false,loadDependencies:async({transport})=>({runtimeFactory:options=>createAgentRuntime({...options,autoStart:false}),adapters:[createPurchaseAgentAdapter({transport})],engines:{},createBackups:createAgentBackups})});
  const meta={actor:host.identity.localActor(),trustedUi:true};
  await assert.rejects(()=>host.request('backups.prepare',{modules:['purchase']},meta),{code:'INTERNAL_OPERATION'});
  const {task}=await host.request('tasks.create',{goal:'备份测试采购账本',scope:{modules:['system','purchase']}},meta);host.runtime.store.update('task',task.id,{status:'running'});
  const result=await host.runtime.invokeTool(task.id,'erp_prepare',{module:'system',capabilityId:'backups.create',input:{modules:['purchase']}});
  assert.equal(result.requiresReview,false);assert(bindings>=2);
  const evidence=result.result.evidence.find(item=>item.kind==='backup');assert.equal(evidence.status,'verified');assert(evidence.artifactId);
  const artifact=await host.request('artifacts.open',{id:evidence.artifactId,taskId:task.id},meta),report=JSON.parse(Buffer.from(artifact.download.bytes,'base64'));
  const company=JSON.parse(fs.readFileSync(path.join(paths.profile,'company-identity.json'),'utf8'));assert.equal(report.companyId,company.companyId);assert.equal(report.dataSetId,company.dataSetId);assert.deepEqual(report.moduleBindings.purchase,{dataSetId:moduleDataSetId,revision});
  assert.equal(report.files.find(file=>file.kind==='sqlite').tables.orders.count,1);assert.equal(report.crossDatabaseAtomic,false);assert.equal(report.files.filter(file=>file.kind==='attachment').length,1);
});
