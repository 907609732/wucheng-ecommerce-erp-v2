import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {ZipFile} from 'yazl';
import {createOnDemandComponents} from '../desktop/business-host/on-demand.mjs';
import {agentBetaPaths,prepareAgentProfile} from '../desktop/business-host/isolation.mjs';
import {downloadPackage,digest} from '../desktop/modules/package-format.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
async function archive(file,entries){const z=new ZipFile();for(const [rel,bytes]of Object.entries(entries))z.addBuffer(Buffer.from(bytes),rel);z.end();await pipeline(z.outputStream,fs.createWriteStream(file));}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-demand-')),old=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=dir;
 t.after(()=>{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const paths=agentBetaPaths({localAppData:dir,preview:true});prepareAgentProfile(paths);
 const resources=path.join(dir,'shell');fs.mkdirSync(path.join(resources,'desktop/business-host'),{recursive:true});
 const executable=path.join(dir,'host.exe');fs.writeFileSync(executable,'test host');Object.assign(paths,{sharedElectronExecutable:executable,sharedElectronVersion:'44.7.0'});
 const moduleEntries={'apps/purchase/server.mjs':'export {};','apps/purchase/lib/agent-adapter.mjs':'export {};'};
 const archiveFile=path.join(dir,'purchase.zip'),nodeFile=path.join(dir,'node.zip');await archive(archiveFile,moduleEntries);await archive(nodeFile,{'node.exe':'test node'});
 const host='export {};';fs.mkdirSync(path.join(resources,'desktop/launcher'),{recursive:true});fs.writeFileSync(path.join(resources,'desktop/launcher/main.mjs'),host);
 const hashes=Object.fromEntries(Object.entries(moduleEntries).map(([rel,b])=>[rel,sha(b)]));hashes['desktop/launcher/main.mjs']=sha(host);hashes['vendor/node.zip']=await digest(nodeFile);
 hashes['apps/warehouse/runtime/resources/app.asar']=sha('warehouse');hashes['apps/exporter/runtime/resources/app.asar']=sha('exporter');
 const vendor={id:'node-runtime',version:'24.18.0',archive:'node.zip',sha256:await digest(nodeFile),bytes:fs.statSync(nodeFile).size,hostRange:'=0.11.8'};
 const manifest={format:'agent-beta-resources/v2',businessOnly:true,purchaseMobilePort:27380,sharedElectron:{version:'44.7.0',components:['warehouse','exporter']},modules:{purchase:{version:'1.0.0'},warehouse:{runtime:{kind:'shared-electron',app:'runtime/resources/app.asar',sha256:sha('warehouse')}},exporter:{runtime:{kind:'shared-electron',app:'runtime/resources/app.asar',sha256:sha('exporter')}}},payloadHashes:hashes,vendor:{components:[vendor]}};
 const manifestBytes=JSON.stringify(manifest),manifestSha256=sha(manifestBytes);fs.writeFileSync(path.join(resources,'agent-beta-resources.json'),manifestBytes);fs.writeFileSync(path.join(resources,'desktop/business-host/packaged-manifest.json'),JSON.stringify({sha256:manifestSha256}));
 const base={platform:'win32',arch:'x64',hostRange:'=0.11.8',dependencies:[]};
 const specs=[{...base,...vendor,kind:'runtime',entry:'node.exe',unpackedBytes:9},{...base,id:'purchase',kind:'service',version:'1.0.0',archive:'purchase.zip',bytes:fs.statSync(archiveFile).size,unpackedBytes:Object.values(moduleEntries).reduce((n,b)=>n+Buffer.byteLength(b),0),sha256:await digest(archiveFile),entry:'apps/purchase/server.mjs',dependencies:[{id:'node-runtime',range:'=24.18.0'}]}].map(spec=>({...spec,url:'https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/test/'+spec.archive}));
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),keys={test:publicKey.export({format:'pem',type:'spki'})};
 const payload=Buffer.from(JSON.stringify({schemaVersion:1,preview:true,version:'0.11.8',releaseManifestSha256:manifestSha256,packages:specs}));
 const envelope={format:'lingtu-catalog/v1',keyId:'test',payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')},catalogBytes=JSON.stringify(envelope);
 fs.writeFileSync(path.join(resources,'component-catalog.json'),catalogBytes);fs.writeFileSync(path.join(resources,'on-demand.json'),JSON.stringify({format:'lingtu-on-demand/v1',version:'0.11.8',manifestSha256,catalogSha256:sha(catalogBytes)}));
 const calls=[],fetchImpl=async(url,options)=>{calls.push({url,range:options.headers?.Range});const file=url.endsWith('node.zip')?nodeFile:archiveFile;return new Response(fs.readFileSync(file),{status:200});};
 return {dir,paths,resources,manifestSha256,keys,fetchImpl,calls,archiveFile,nodeFile,specs};
}

test('opening one module downloads only its dependencies, preserves other registry rows and reuses verified preparation',async t=>{
 const f=await fixture(t),ledger=path.join(f.paths.data,'purchase/purchases.sqlite');fs.mkdirSync(path.dirname(ledger),{recursive:true});fs.writeFileSync(ledger,'existing synthetic ledger');
 const before=JSON.parse(fs.readFileSync(f.paths.registryFile));
 const manager=await createOnDemandComponents({paths:f.paths,resourcesDir:f.resources,hostVersion:'0.11.8',publicKeys:f.keys,fetchImpl:f.fetchImpl,isBusy:()=>false});
 const a=manager.ensure('purchase'),b=manager.ensure('purchase');assert.equal(a,b);const result=await a;
 assert.equal(result.ready,true);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>!c.url.includes('browser')));
 const current=JSON.parse(fs.readFileSync(f.paths.registryFile));assert.deepEqual(current.sales,before.sales);assert.ok(fs.existsSync(path.join(current.purchase.root,'server.mjs')));assert.equal(fs.readFileSync(ledger,'utf8'),'existing synthetic ledger');
 await manager.ensure('purchase');assert.equal(f.calls.length,2);
 // A new process must validate the selected module again, without downloading.
 const next=await createOnDemandComponents({paths:f.paths,resourcesDir:f.resources,hostVersion:'0.11.8',publicKeys:f.keys,fetchImpl:f.fetchImpl,isBusy:()=>false});
 assert.equal((await next.ensure('purchase')).reused,true);assert.equal(f.calls.length,2);
});
test('activation failure restores the old registry and is retryable',async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.paths.registryFile,'utf8');let attempts=0;
 const manager=await createOnDemandComponents({paths:f.paths,resourcesDir:f.resources,hostVersion:'0.11.8',publicKeys:f.keys,fetchImpl:f.fetchImpl,activate:()=>async()=>{attempts++;fs.writeFileSync(f.paths.registryFile,'{}');throw Error('synthetic activation failure');}});
 await assert.rejects(manager.ensure('purchase'),/synthetic activation/);assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.registryFile)),JSON.parse(before));assert.equal(manager.ready.size,0);
 await assert.rejects(manager.ensure('purchase'),/synthetic activation/);assert.equal(attempts,2);assert.equal(f.calls.length,2);
});
test('wrong signature and incompatible host fail before any network or activation',async t=>{
 const f=await fixture(t);await assert.rejects(createOnDemandComponents({paths:f.paths,resourcesDir:f.resources,hostVersion:'0.11.8',publicKeys:{},fetchImpl:f.fetchImpl}),{code:'UNTRUSTED_PACKAGE'});
 await assert.rejects(createOnDemandComponents({paths:f.paths,resourcesDir:f.resources,hostVersion:'0.11.9',publicKeys:f.keys,fetchImpl:f.fetchImpl}),{code:'INVALID_MANIFEST'});assert.equal(f.calls.length,0);
});
test('corrupt bytes never change registry or become ready',async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.paths.registryFile);
 const manager=await createOnDemandComponents({paths:f.paths,resourcesDir:f.resources,hostVersion:'0.11.8',publicKeys:f.keys,fetchImpl:async()=>new Response(Buffer.alloc(f.specs[0].bytes,1))});
 await assert.rejects(manager.ensure('purchase'),{code:'HASH_MISMATCH'});assert.deepEqual(fs.readFileSync(f.paths.registryFile),before);assert.equal(manager.ready.size,0);
});
test('Range resumes partial bytes; a server ignoring Range restarts safely; invalid ranges fail',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-range-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'part');
 const spec={url:'https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/test/a.zip',bytes:6};
 fs.writeFileSync(file,'abc');await downloadPackage(spec,file,{fetchImpl:async(_url,options)=>{assert.equal(options.headers.Range,'bytes=3-');return new Response('def',{status:206,headers:{'content-range':'bytes 3-5/6'}});}});assert.equal(fs.readFileSync(file,'utf8'),'abcdef');
 fs.writeFileSync(file,'abc');await downloadPackage(spec,file,{fetchImpl:async()=>new Response('abcdef',{status:200})});assert.equal(fs.readFileSync(file,'utf8'),'abcdef');
 fs.writeFileSync(file,'abc');await assert.rejects(downloadPackage(spec,file,{fetchImpl:async()=>new Response('def',{status:206,headers:{'content-range':'bytes 0-2/6'}})}),{code:'INVALID_RANGE'});assert.equal(fs.readFileSync(file,'utf8'),'abc');
});
