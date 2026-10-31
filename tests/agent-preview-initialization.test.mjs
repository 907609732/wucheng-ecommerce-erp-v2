import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {agentBetaPaths,assertPreviewPaths,assertPreviewLocalMode,prepareAgentProfile,assertAgentRegistry,guardAgentServices} from '../desktop/agent-host/isolation.mjs';
import {initializePreviewLedgers} from '../desktop/agent-host/preview-ledgers.mjs';
import {verifyActivationResources} from '../desktop/agent-host/activation.mjs';
import {AGENT_RESOURCE_FORMAT_V1,AGENT_RESOURCE_FORMAT_V2} from '../desktop/agent-host/resource-layout.mjs';
const repo=path.resolve(import.meta.dirname,'..'),require=createRequire(path.join(repo,'apps/exporter/package.json'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){const local=fs.mkdtempSync(path.join(os.tmpdir(),'erp-preview-init-')),previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=local;t.after(()=>{if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;fs.rmSync(local,{recursive:true,force:true});});return {local,paths:agentBetaPaths({localAppData:local,preview:true,root:undefined})};}

test('preview identity, root and ports are fixed independently from Beta',t=>{
 const {local,paths}=fixture(t);assert.equal(paths.root,path.join(local,'WuchengAgentBeta-preview'));assert.equal(paths.appId,'com.wucheng.ecommerce.erp.v2.agentpreview');assert.equal(paths.gatewayPort,27430);
 for(const root of [path.join(local,'WuchengAgentBeta'),path.join(local,'formal'),path.join(local,'WuchengAgentBeta-another')])assert.throws(()=>agentBetaPaths({localAppData:local,root,preview:true}),{code:'PREVIEW_LOCATION_INVALID'});
 assert.throws(()=>assertPreviewPaths({...paths,data:path.join(local,'formal')}),{code:'PREVIEW_LOCATION_INVALID'});
 prepareAgentProfile(paths);const registry=assertAgentRegistry(paths);assert.equal(registry.purchase.mobilePort,27480);assert.equal(registry.sales.port,27433);assert.ok(Object.values(registry).every(x=>x.allowInitialize===false));
 const beta=agentBetaPaths({localAppData:local,preview:false,root:undefined});assert.notEqual(beta.appId,paths.appId);assert.equal(beta.gatewayPort,27330);
 assert.doesNotThrow(()=>assertPreviewLocalMode(paths,{mode:'standalone'}));for(const mode of ['server','client',undefined])assert.throws(()=>assertPreviewLocalMode(paths,{mode}),{code:'PREVIEW_LOCAL_ONLY'});assert.doesNotThrow(()=>assertPreviewLocalMode(beta,{mode:'server'}));
});

for(const format of [AGENT_RESOURCE_FORMAT_V1,AGENT_RESOURCE_FORMAT_V2])test('real domain stores create only new empty preview ledgers and preserve them on reuse: '+format,async t=>{
 const {local,paths}=fixture(t),resources=path.join(local,'resources');prepareAgentProfile(paths);
 const registry=assertAgentRegistry(paths),node=path.join(paths.programs,'node-runtime','node.exe');fs.mkdirSync(path.dirname(node),{recursive:true});fs.copyFileSync(process.execPath,node);for(const value of Object.values(registry))value.nodePath=node;fs.writeFileSync(paths.registryFile,JSON.stringify(registry));
 const write=(rel,content)=>{const file=path.join(resources,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);};
 write('package.json','{"type":"module"}');
 const prefix=format===AGENT_RESOURCE_FORMAT_V2?'':'workbench-gateway/';
 for(const id of ['purchase','sales','overview']){const rel='apps/'+id+'/lib/'+(id==='sales'?'db.mjs':'store.mjs');write(prefix+rel,'export {openStore} from '+JSON.stringify(pathToFileURL(path.join(repo,rel)).href)+';');}
 write(prefix+'core/erp/db.js','export {getDb,closeDb} from '+JSON.stringify(pathToFileURL(path.join(repo,'core/erp/db.js')).href)+';');
 await require('esbuild').build({entryPoints:[path.join(repo,'apps/exporter/src/main/preview-ledger.ts')],outfile:path.join(resources,'apps/exporter/out/main/preview-ledger.js'),bundle:true,platform:'node',format:'esm'});
 assert.deepEqual(initializePreviewLedgers({paths,resourcesDir:resources,manifest:{format}}).created,['warehouse','purchase','sales','overview','exporter']);
 const files={warehouse:['workspace/data/erp.sqlite','inventory_snapshots'],purchase:['purchases.sqlite','orders'],sales:['sales.sqlite','ledger'],overview:['overview.sqlite','bills'],exporter:['orders.sqlite','tasks']},before={};
 for(const [id,[name,table]] of Object.entries(files)){const file=path.join(paths.data,id,...name.split('/')),db=new DatabaseSync(file,{readOnly:true});assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM '+table).get().n),0);db.close();before[id]=hash(file);}
 assert.deepEqual(initializePreviewLedgers({paths,resourcesDir:resources,manifest:{format}}).created,[]);
 for(const [id,[name]] of Object.entries(files))assert.equal(hash(path.join(paths.data,id,...name.split('/'))),before[id]);
 assert.equal(fs.existsSync(path.join(local,'WuchengAgentBeta')),false);
});

test('initialization rejects Beta and unsafe paths before creating data; managed guards remain strict',t=>{
 const {local,paths}=fixture(t),beta=agentBetaPaths({localAppData:local,root:undefined,preview:false});
 assert.throws(()=>initializePreviewLedgers({paths:beta,resourcesDir:local}),{code:'PREVIEW_LOCATION_INVALID'});assert.equal(fs.existsSync(beta.root),false);
 prepareAgentProfile(paths);const registry=assertAgentRegistry(paths);registry.purchase.db='purchases.sqlite';let started=0;
 const services=guardAgentServices({registryFile:paths.registryFile,config:id=>registry[id],ensure:()=>{started++;},start:()=>{started++;}},paths);
 assert.throws(()=>services.ensure('purchase'),{code:'TEST_LEDGER_NOT_READY'});assert.equal(started,0);
 registry.sales.allowInitialize=true;fs.writeFileSync(paths.registryFile,JSON.stringify(registry));assert.throws(()=>assertAgentRegistry(paths),{code:'BETA_REGISTRY_UNSAFE'});
});

test('activation verifies external gateway bytes before first or reused initialization',async t=>{
 const {local}=fixture(t),resources=path.join(local,'resources'),rel='workbench-gateway/apps/purchase/lib/store.mjs',file=path.join(resources,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'export const store=1;');const manifest={payloadHashes:{[rel]:hash(file)}};
 await assert.doesNotReject(verifyActivationResources(resources,manifest));fs.writeFileSync(file,'export const store=2;');await assert.rejects(verifyActivationResources(resources,manifest),/资源摘要不符/);
 await assert.rejects(verifyActivationResources(resources,{payloadHashes:{'workbench-gateway/../../outside.mjs':'0'.repeat(64)}}),/资源路径无效/);
});
