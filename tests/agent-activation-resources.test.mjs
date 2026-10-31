import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {createActivationResourceOperation,verifyActivationResources} from '../desktop/agent-host/activation-resources.mjs';
import {createAgentActivation} from '../desktop/agent-host/activation.mjs';
import {agentBetaPaths,prepareAgentProfile} from '../desktop/agent-host/isolation.mjs';
import {AGENT_RESOURCE_FORMAT_V1,AGENT_RESOURCE_FORMAT_V2} from '../desktop/agent-host/resource-layout.mjs';
const base=path.resolve('.codex-artifacts/activation-resource-tests'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){fs.mkdirSync(base,{recursive:true});const work=fs.mkdtempSync(path.join(base,'case-')),resources=path.join(work,'resources');fs.mkdirSync(resources);t.after(()=>{const actual=fs.realpathSync(work),relative=path.relative(base,actual);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(actual,{recursive:true,force:true});});const put=(rel,bytes='public resource')=>{const file=path.join(resources,...rel.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;};return {work,resources,put};}
test('normal files keep canonical/lstat/SHA checks, one buffer and bounded ancestor checks with real yields',async t=>{
 const {resources,put}=fixture(t),payloadHashes={};for(let i=0;i<256;i++){const rel='apps/purchase/deep/shared/'+i+'.txt',bytes='public-'+i;put(rel,bytes);payloadHashes[rel]=sha(bytes);}put('vendor/large.bin',Buffer.alloc(2*1024*1024+17,7));put('vendor/short.txt','x');put('vendor/empty.txt','');for(const rel of ['vendor/large.bin','vendor/short.txt','vendor/empty.txt'])payloadHashes[rel]=sha(fs.readFileSync(path.join(resources,rel)));
 const progress=[],started=performance.now(),metrics=await verifyActivationResources(resources,{payloadHashes},{batchSize:16,onProgress:v=>progress.push(v)});
 assert.equal(metrics.canonicalFileChecks,Object.keys(payloadHashes).length);assert.equal(metrics.fileLstatChecks,metrics.canonicalFileChecks);assert.equal(metrics.hashes,metrics.canonicalFileChecks);assert.equal(metrics.bufferAllocations,1);assert.ok(metrics.ancestorChecks<40);assert.ok(metrics.yields>=16);assert.equal(progress.at(-1).processed,Object.keys(payloadHashes).length);assert.equal(progress.at(-1).total,Object.keys(payloadHashes).length);
 t.diagnostic(JSON.stringify({files:metrics.hashes,elapsedMs:performance.now()-started,...metrics}));
});
test('parent junctions and leaf symlinks reject even when target bytes have the expected digest',async t=>{
 const {work,resources,put}=fixture(t),outside=path.join(work,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'same.txt'),'public resource');fs.mkdirSync(path.join(resources,'apps'));fs.symlinkSync(outside,path.join(resources,'apps','linked'),'junction');
 await assert.rejects(verifyActivationResources(resources,{payloadHashes:{'apps/linked/same.txt':sha('public resource')}}),/链接|重定向/);
 put('apps/normal/same.txt');fs.symlinkSync(path.join(resources,'apps/normal/same.txt'),path.join(resources,'apps/normal/alias.txt'),'file');await assert.rejects(verifyActivationResources(resources,{payloadHashes:{'apps/normal/alias.txt':sha('public resource')}}),/链接|重定向/);
});
test('replacing an already cached parent with an inner junction is still rejected per file',t=>{
 const {resources,put}=fixture(t),file=put('apps/purchase/original/same.txt'),alias=put('apps/purchase/alias/same.txt'),operation=createActivationResourceOperation(resources);
 operation.sourceFile(file);const parent=path.dirname(file);fs.renameSync(parent,parent+'-saved');fs.symlinkSync(path.dirname(alias),parent,'junction');assert.throws(()=>operation.sourceFile(file),/链接|重定向/);
});
test('content tampering with unchanged size/mtime is rejected and each invocation resets its ancestor cache',async t=>{
 const {resources,put}=fixture(t),file=put('apps/purchase/file.txt','aaaa'),payloadHashes={'apps/purchase/file.txt':sha('aaaa')},first=await verifyActivationResources(resources,{payloadHashes}),before=fs.statSync(file);fs.writeFileSync(file,'bbbb');fs.utimesSync(file,before.atime,before.mtime);await assert.rejects(verifyActivationResources(resources,{payloadHashes}),/摘要不符/);fs.writeFileSync(file,'aaaa');const again=await verifyActivationResources(resources,{payloadHashes});assert.ok(first.ancestorChecks>0&&again.ancestorChecks===first.ancestorChecks);
});

test('v2 verifies host code, core and root production dependencies while v1 preserves its external filter',async t=>{
 const {resources,put}=fixture(t),payloadHashes={};for(const rel of ['desktop/launcher/main.mjs','core/worker.mjs','node_modules/runtime/index.js','apps/purchase/lib/store.mjs','vendor/runtime.zip']){put(rel,'public-'+rel);payloadHashes[rel]=sha('public-'+rel);}
 const before=await verifyActivationResources(resources,{format:AGENT_RESOURCE_FORMAT_V2,payloadHashes});assert.equal(before.hashes,5);
 for(const rel of ['desktop/launcher/main.mjs','core/worker.mjs','node_modules/runtime/index.js']){put(rel,'changed');await assert.rejects(verifyActivationResources(resources,{format:AGENT_RESOURCE_FORMAT_V2,payloadHashes}),/摘要不符/);put(rel,'public-'+rel);}
 put('desktop/launcher/main.mjs','changed');assert.equal((await verifyActivationResources(resources,{format:AGENT_RESOURCE_FORMAT_V1,payloadHashes})).hashes,2);
 await assert.rejects(verifyActivationResources(resources,{format:AGENT_RESOURCE_FORMAT_V2,payloadHashes:{'desktop/../../outside.mjs':sha('public')}}),/资源路径无效/);
});

test('v2 root dependencies retain canonical link checks and cancellation yields',async t=>{
 const {work,resources,put}=fixture(t),outside=path.join(work,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'index.js'),'public');fs.mkdirSync(path.join(resources,'node_modules'));fs.symlinkSync(outside,path.join(resources,'node_modules','linked'),'junction');
 await assert.rejects(verifyActivationResources(resources,{format:AGENT_RESOURCE_FORMAT_V2,payloadHashes:{'node_modules/linked/index.js':sha('public')}}),/链接|重定向/);
 const payloadHashes={};for(let i=0;i<130;i++){const rel='desktop/runtime/file-'+i+'.mjs';put(rel,'public');payloadHashes[rel]=sha('public');}const controller=new AbortController();
 await assert.rejects(verifyActivationResources(resources,{format:AGENT_RESOURCE_FORMAT_V2,payloadHashes},{signal:controller.signal,onProgress:v=>{if(v.processed>=128)controller.abort();}}),{code:'BETA_ACTIVATION_CANCELLED'});
});
for(const format of [AGENT_RESOURCE_FORMAT_V1,AGENT_RESOURCE_FORMAT_V2])test('cancellation yields to the event loop, releases the service fence and preserves the existing registry: '+format,async t=>{
 const {work,resources,put}=fixture(t),local=path.join(work,'local'),old=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=local;t.after(()=>{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;});
 const paths=agentBetaPaths({localAppData:local,root:path.join(local,'WuchengAgentBeta-preview'),preview:true});prepareAgentProfile(paths);const registryBefore=fs.readFileSync(paths.registryFile),payloadHashes={};for(let i=0;i<130;i++){const rel='apps/warehouse/file-'+i+'.txt';put(rel,'public');payloadHashes[rel]=sha('public');}
 const manifest={format,purchaseMobilePort:27380,payloadHashes};fs.writeFileSync(path.join(resources,'agent-beta-resources.json'),JSON.stringify(manifest));const controller=new AbortController();
 await assert.rejects(createAgentActivation({paths,resourcesDir:resources,expectedManifestSha256:sha(fs.readFileSync(path.join(resources,'agent-beta-resources.json'))),isBusy:async()=>false,signal:controller.signal,onProgress:v=>{if(v.phase==='verify'&&v.processed>=128)controller.abort();}})(),{code:'BETA_ACTIVATION_CANCELLED'});
 assert.equal(fs.existsSync(path.join(paths.root,'beta-data-maintenance.lock')),false);assert.equal(fs.existsSync(paths.programs),false);assert.deepEqual(fs.readFileSync(paths.registryFile),registryBefore);
});
