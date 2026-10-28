import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {generateKeyPairSync,sign} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {ModuleManager} from '../desktop/modules/module-manager.mjs';
import {MODULE_IDS,digest} from '../desktop/modules/package-format.mjs';
import {ensureBundledSuite,inspectBundledSuite} from '../desktop/modules/bundled-suite.mjs';

const business=['warehouse','purchase','sales','overview','exporter'];
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-suite-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bundleDirectory=path.join(root,'bundle'),profile=path.join(root,'profile');fs.mkdirSync(bundleDirectory);fs.mkdirSync(profile);
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),live=new Set(),released=new Set(),calls={activate:[],health:[],complete:[],activationEffects:[],stop:[]};
 let failId='',failCompleteId='',lostAck=false;
 const services={config:id=>({dataDir:path.join(root,'data',id)}),capabilities:async id=>live.has(id)?{running:true,maintenance:fs.existsSync(path.join(root,'data',id,'.workbench-maintenance.json'))||!released.has(id)}:null,ensure:async id=>{live.add(id);return {running:true};},stop:async id=>{live.delete(id);calls.stop.push(id);}};
 const lifecycle={checkIdle:async()=>{},backup:async()=>({synthetic:true}),activate:async c=>{calls.activate.push(c.id);live.add(c.id);released.delete(c.id);},health:async c=>{calls.health.push(c.id);if(c.kind!=='runtime')assert(fs.existsSync(path.join(services.config(c.id).dataDir,'.workbench-maintenance.json')));if(c.id===failId){failId='';throw Error('synthetic interruption');}},complete:async c=>{
   if(c.kind==='runtime')return;
   // Match the actual native cloud/exporter rule: activate refuses any remaining
   // maintenance file. The previous permissive fixture concealed that defect.
   if(fs.existsSync(path.join(services.config(c.id).dataDir,'.workbench-maintenance.json')))throw Error('迁移维护窗口尚未结束');
   assert(business.every(id=>calls.health.includes(id)));calls.complete.push(c.id);
   if(released.has(c.id))return;
   if(c.id===failCompleteId&&!lostAck){failCompleteId='';throw Error('synthetic release interruption');}
   released.add(c.id);calls.activationEffects.push(c.id);
   if(c.id===failCompleteId&&lostAck){failCompleteId='';throw Error('synthetic lost activation acknowledgement');}
 },recover:async j=>{live.delete(j.id);},deactivate:async()=>{}};
 const modules=new ModuleManager({root:path.join(profile,'modules'),hostVersion:'0.11.0',publicKeys:{test:publicKey.export({type:'spki',format:'pem'})},platform:'win32',arch:'x64',lifecycle});
 const packages=[];
 for(const id of MODULE_IDS){const archive=id+'.zip',file=path.join(bundleDirectory,archive),zip=new yazl.ZipFile();zip.addBuffer(Buffer.from('synthetic entry'),'entry.mjs');zip.end();await pipeline(zip.outputStream,fs.createWriteStream(file));packages.push({id,version:'0.11.0',hostRange:'>=0.11.0 <1',platform:'win32',arch:'x64',kind:id.endsWith('-runtime')?'runtime':'service',entry:'entry.mjs',archive,bytes:fs.statSync(file).size,unpackedBytes:15,sha256:await digest(file),dependencies:[],url:'https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/test/'+archive});}
 const payload=Buffer.from(JSON.stringify({schemaVersion:1,publishedAt:new Date().toISOString(),suite:{format:'lingtu-suite/v1',productId:'com.wucheng.ecommerce.erp.v2',version:'0.11.0',components:packages.map(({id,version,sha256})=>({id,version,sha256}))},packages}));
 const envelope={format:'lingtu-catalog/v1',keyId:'test',payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')};fs.writeFileSync(path.join(bundleDirectory,'catalog.json'),JSON.stringify(envelope));
 return {root,bundleDirectory,profile,modules,services,calls,live,released,options:{bundleDirectory,profile,modules,services,mode:'standalone'},fail:id=>{failId=id;},failComplete:(id,{after=false}={})=>{failCompleteId=id;lostAck=after;}};
}
test('one signed suite installs all seven components offline; no monthly service remains running',async t=>{
 const f=await fixture(t),result=await ensureBundledSuite(f.options);assert.equal(result.ready,true);assert.equal(result.activated,true);assert.deepEqual(Object.keys(f.modules.state().packages).sort(),[...MODULE_IDS].sort());assert.equal(f.calls.complete.length,5);assert.equal(f.live.size,2); // only synthetic runtime health entries remain
 assert(business.every(id=>!fs.existsSync(path.join(f.services.config(id).dataDir,'.workbench-maintenance.json'))));
 const before=f.calls.activate.length;assert.equal((await ensureBundledSuite(f.options)).activated,false);assert.equal(f.calls.activate.length,before);
});
test('client and headless first-run never activate local services or create data directories',async t=>{
 const f=await fixture(t);assert.equal((await ensureBundledSuite({...f.options,mode:'client'})).remote,true);assert.equal((await ensureBundledSuite({...f.options,headless:true})).setupRequired,true);assert.equal(f.calls.activate.length,0);assert.equal(fs.existsSync(path.join(f.root,'data')),false);assert.equal(fs.existsSync(path.join(f.profile,'suite-activation.json')),false);
});
test('all archive hashes are verified before any activation or data fence',async t=>{
 const f=await fixture(t);fs.appendFileSync(path.join(f.bundleDirectory,'exporter.zip'),'corrupt');await assert.rejects(ensureBundledSuite(f.options),{code:'INCOMPLETE_SUITE'});assert.equal(f.calls.activate.length,0);assert.equal(fs.existsSync(path.join(f.root,'data')),false);
});
test('interrupted component health leaves suite fenced and resumes the same release',async t=>{
 const f=await fixture(t);f.fail('sales');await assert.rejects(ensureBundledSuite(f.options),{code:'SUITE_RECOVERY_REQUIRED'});assert.equal(f.calls.complete.length,0);assert(business.every(id=>fs.existsSync(path.join(f.services.config(id).dataDir,'.workbench-maintenance.json'))));assert.equal((await ensureBundledSuite({...f.options,headless:true})).setupRequired,true);
 const result=await ensureBundledSuite(f.options);assert.equal(result.ready,true);assert.equal(f.calls.activate.filter(id=>id==='purchase').length,1);assert.equal(fs.existsSync(path.join(f.profile,'suite-activation.json')),false);
});
test('foreign maintenance and invalid signatures cannot be bypassed by suite activation',async t=>{
 const f=await fixture(t);const dir=f.services.config('purchase').dataDir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'.workbench-maintenance.json'),JSON.stringify({migrationId:'another'}));await assert.rejects(ensureBundledSuite(f.options),{code:'SERVICE_MAINTENANCE'});assert.equal(f.calls.activate.length,0);
 const file=path.join(f.bundleDirectory,'catalog.json'),envelope=JSON.parse(fs.readFileSync(file));envelope.signature=Buffer.alloc(64).toString('base64');fs.writeFileSync(file,JSON.stringify(envelope));assert.throws(()=>inspectBundledSuite(f.options),{code:'INVALID_SIGNATURE'});
});
test('previously running services and an enabled warehouse schedule are retained',async t=>{
 const f=await fixture(t);f.live.add('sales');const dir=f.services.config('warehouse').dataDir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({scheduleEnabled:true}));
 await ensureBundledSuite(f.options);assert(f.live.has('warehouse'));assert(f.live.has('sales'));assert(!f.calls.stop.includes('warehouse'));assert(!f.calls.stop.includes('sales'));assert(f.calls.stop.includes('purchase'));
});
test('a valid current receipt cannot conceal a different archive for the same component version',async t=>{
 const f=await fixture(t);await ensureBundledSuite(f.options);const state=f.modules.state();state.packages.purchase.sha256='0'.repeat(64);fs.writeFileSync(f.modules.stateFile,JSON.stringify(state));await assert.rejects(ensureBundledSuite(f.options),{code:'COMPONENT_VERSION_REUSED'});
});
test('beforeRelease data verification runs behind every fence and a failure prevents all completions',async t=>{
 const f=await fixture(t);let checks=0;
 const beforeRelease=async()=>{checks++;assert.equal(f.calls.complete.length,0);for(const id of business){const marker=JSON.parse(fs.readFileSync(path.join(f.services.config(id).dataDir,'.workbench-maintenance.json')));assert.equal(marker.migrationId,undefined);assert(marker.suiteId);}if(checks===1)throw Error('synthetic data difference');};
 await assert.rejects(ensureBundledSuite({...f.options,beforeRelease}),{code:'SUITE_RECOVERY_REQUIRED'});assert.equal(f.calls.complete.length,0);assert(business.every(id=>fs.existsSync(path.join(f.services.config(id).dataDir,'.workbench-maintenance.json'))));
 assert.equal((await ensureBundledSuite({...f.options,beforeRelease})).ready,true);assert.equal(checks,2);
});
test('a pending data move can force fenced verification despite a matching product receipt',async t=>{
 const f=await fixture(t);await ensureBundledSuite(f.options);const count=f.calls.activate.length;f.calls.complete.length=0;let verified=false;
 await ensureBundledSuite({...f.options,forceVerification:true,beforeRelease:async()=>{verified=true;assert.equal(f.calls.complete.length,0);assert(business.every(id=>fs.existsSync(path.join(f.services.config(id).dataDir,'.workbench-maintenance.json'))));}});
 assert(verified);assert.equal(f.calls.activate.length,count);assert.equal(f.calls.complete.length,5);
});
test('a persisted release resumes forward without reinstalling or comparing later legitimate edits',async t=>{
 const f=await fixture(t);f.failComplete('sales');let verified=0;
 const beforeRelease=async()=>{verified++;};await assert.rejects(ensureBundledSuite({...f.options,beforeRelease}),{code:'SUITE_RECOVERY_REQUIRED'});
 const journal=JSON.parse(fs.readFileSync(path.join(f.profile,'suite-activation.json')));assert.equal(journal.phase,'releasing');assert(journal.completed.includes('warehouse'));assert(journal.completed.includes('purchase'));assert(!journal.completed.includes('sales'));
 const later=path.join(f.services.config('purchase').dataDir,'later-edit.txt');fs.writeFileSync(later,'legitimate edit after release');const activations=f.calls.activate.length,health=f.calls.health.length;
 await ensureBundledSuite({...f.options,beforeRelease:async()=>{throw Error('Must not revalidate an old snapshot after release');}});
 assert.equal(verified,1);assert.equal(f.calls.activate.length,activations);assert.equal(f.calls.health.length,health);assert.equal(fs.readFileSync(later,'utf8'),'legitimate edit after release');assert.equal(f.calls.activationEffects.filter(id=>id==='purchase').length,1);assert.equal(f.calls.stop.length,0,'Recovery does not stop modules that may now be in use');
});
test('lost acknowledgement after native activation is idempotent, and foreign release fences are never erased',async t=>{
 const f=await fixture(t);f.failComplete('warehouse',{after:true});await assert.rejects(ensureBundledSuite(f.options),{code:'SUITE_RECOVERY_REQUIRED'});assert(f.released.has('warehouse'));
 const file=path.join(f.services.config('exporter').dataDir,'.workbench-maintenance.json');fs.writeFileSync(file,JSON.stringify({migrationId:'later-independent-maintenance'}));await assert.rejects(ensureBundledSuite(f.options),{code:'SUITE_RECOVERY_REQUIRED'});assert.equal(JSON.parse(fs.readFileSync(file)).migrationId,'later-independent-maintenance');
 fs.unlinkSync(file);await ensureBundledSuite({...f.options,beforeRelease:async()=>{throw Error('Never replay verification');}});assert.equal(f.calls.activationEffects.filter(id=>id==='warehouse').length,1);assert.equal(fs.existsSync(path.join(f.profile,'suite-activation.json')),false);
});
