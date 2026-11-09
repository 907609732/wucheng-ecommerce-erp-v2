import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const api=await import('../server/fnos-native/uvcs-registration.mjs').catch(()=>({}));
import {uvcsFixture,expected} from './fnos-native-uvcs-fixture.mjs';
const bytes=root=>{const walk=(dir,rel='')=>fs.readdirSync(dir).sort().flatMap(name=>{const p=path.join(dir,name),r=rel+'/'+name;return fs.statSync(p).isDirectory()?walk(p,r):[[r,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]];});return walk(root);};
test('registration preserves original identity and all workspace bytes, is repeatable after legitimate metadata writes',async t=>{
 assert.equal(typeof api.prepareNativeUvcs,'function','native registration preparation required');
 const f=uvcsFixture(t),before=bytes(f.workspace);f.c.native.uvcsSourceMetadataHash=api.metadataFingerprint(f.workspace);
 assert.throws(()=>api.assertNativeUvcsPrepared(f.c));await api.prepareNativeUvcs(f.c);assert.deepEqual(bytes(f.workspace),before);api.assertNativeUvcsPrepared(f.c);
 const commands=fs.readFileSync(path.join(f.root,'commands.log'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(commands.map(c=>c[0]),['workspace','showselector','workspace']);
 await api.prepareNativeUvcs(f.c);fs.appendFileSync(path.join(f.workspace,'.plastic','plastic.wktree'),'legitimate next submission');
 api.assertNativeUvcsPrepared(f.c);await api.prepareNativeUvcs(f.c);
 assert.equal(fs.readFileSync(path.join(f.root,'commands.log'),'utf8').split('showselector').length-1,1);
});
for(const mode of ['wrong-id','error','metadata-change','timeout'])test('failed registration remains pending and preserves published ledger: '+mode,async t=>{
 assert.equal(typeof api.prepareNativeUvcs,'function');const f=uvcsFixture(t);f.c.native.uvcsSourceMetadataHash=api.metadataFingerprint(f.workspace);fs.writeFileSync(path.join(f.home,'mode'),mode);
 await assert.rejects(api.prepareNativeUvcs(f.c,{timeoutMs:500}));assert.throws(()=>api.assertNativeUvcsPrepared(f.c));assert.ok(fs.existsSync(f.configFile));assert.equal(JSON.parse(fs.readFileSync(path.join(f.c.stateDir,'native-uvcs-registration.json'))).status,'pending');
 if(mode!=='metadata-change'){fs.unlinkSync(path.join(f.home,'mode'));await api.prepareNativeUvcs(f.c);api.assertNativeUvcsPrepared(f.c);}
});
test('registration refuses missing trusted identity, wrong metadata and unpublished staging paths',async t=>{
 assert.equal(typeof api.prepareNativeUvcs,'function');const f=uvcsFixture(t);f.c.native.uvcsSourceMetadataHash='0'.repeat(64);await assert.rejects(api.prepareNativeUvcs(f.c));assert.equal(fs.existsSync(path.join(f.root,'commands.log')),false);
 delete f.c.native.uvcsIdentity;await assert.rejects(api.prepareNativeUvcs(f.c));
});

test('verified registration can retry after a later client failure without freezing initial metadata',async t=>{
 const f=uvcsFixture(t);f.c.native.uvcsSourceMetadataHash=api.metadataFingerprint(f.workspace);await api.prepareNativeUvcs(f.c);
 fs.appendFileSync(path.join(f.workspace,'.plastic','plastic.wktree'),'new legitimate submission');fs.writeFileSync(path.join(f.home,'mode'),'error');
 await assert.rejects(api.prepareNativeUvcs(f.c));fs.unlinkSync(path.join(f.home,'mode'));await api.prepareNativeUvcs(f.c);api.assertNativeUvcsPrepared(f.c);
});
test('registration never operates on an unpublished stage or with an unconfirmed command lease',async t=>{
 const f=uvcsFixture(t);f.c.native.uvcsSourceMetadataHash=api.metadataFingerprint(f.workspace);
 const published={...f.c,native:{...f.c.native,dataRoot:path.join(f.root,'final')}};fs.writeFileSync(f.configFile,JSON.stringify(published));
 await assert.rejects(api.prepareNativeUvcs(f.c),/FINAL_PATH/);assert.equal(fs.existsSync(path.join(f.root,'commands.log')),false);
 fs.writeFileSync(f.configFile,JSON.stringify(f.c));fs.mkdirSync(path.join(f.workspace,'.lingtu-data-version-staging'));fs.writeFileSync(path.join(f.workspace,'.lingtu-data-version-staging','command-lease.json'),'{}');
 await assert.rejects(api.prepareNativeUvcs(f.c),/LEASE/);assert.equal(fs.existsSync(path.join(f.root,'commands.log')),false);
});

for(const mode of ['unregistered','wrong-id','timeout','updated-metadata'])test('direct supervisor checks actual local registration before runtime: '+mode,{skip:process.platform==='linux'&&process.getuid()===0},async t=>{
 const f=uvcsFixture(t);f.c.native.uvcsSourceMetadataHash=api.metadataFingerprint(f.workspace);fs.writeFileSync(f.configFile,JSON.stringify(f.c));await api.prepareNativeUvcs(f.c);
 if(mode==='unregistered')fs.unlinkSync(path.join(f.home,'registered'));else if(mode==='updated-metadata')fs.appendFileSync(path.join(f.workspace,'.plastic','plastic.wktree'),'legitimate new commit');else fs.writeFileSync(path.join(f.home,'mode'),mode);
 const before=fs.readFileSync(path.join(f.root,'commands.log'),'utf8'),{runSupervisor}=await import('../server/fnos-native/supervisor.mjs');let runtimeCalls=0;
 await assert.rejects(runSupervisor(f.configFile,{createRuntime:()=>{runtimeCalls++;throw Error('EXPECTED_RUNTIME_ENTRY');}}),mode==='updated-metadata'?/EXPECTED_RUNTIME_ENTRY/:mode==='timeout'?/UVCS_TIMEOUT/:/UVCS_REGISTRATION/);
 assert.equal(runtimeCalls,mode==='updated-metadata'?1:0);
 const after=fs.readFileSync(path.join(f.root,'commands.log'),'utf8').slice(before.length);assert.equal(after.includes('showselector'),false);assert.equal(after.includes('fileinfo'),false);
 if(mode==='unregistered'||mode==='wrong-id'){if(mode==='wrong-id')fs.unlinkSync(path.join(f.home,'mode'));await api.prepareNativeUvcs(f.c);api.assertNativeUvcsPrepared(f.c);}
});

test('native CLI resolves a trusted system alias and rejects an untrusted executable',t=>{
 assert.equal(typeof api.resolveNativeCmPath,'function','system CLI physical path validation required');
 assert.equal(api.resolveNativeCmPath(process.platform==='win32'?process.execPath:'/bin/true',{allowSymlink:true}),fs.realpathSync(process.platform==='win32'?process.execPath:'/bin/true'));
 if(process.platform!=='win32'){const f=uvcsFixture(t),file=path.join(f.root,'untrusted-cm');fs.writeFileSync(file,'#!/bin/sh\nexit 0\n',{mode:0o777});assert.throws(()=>api.resolveNativeCmPath(file,{allowSymlink:true}),/EXECUTABLE/);}
});

test('trusted source identity remains opaque but rejects unresolved official placeholders',()=>{
 assert.equal(api.trustedIdentity({...expected,id:'{opaque-original-identity}'},expected.repository).id,'{opaque-original-identity}');
 assert.throws(()=>api.trustedIdentity({...expected,id:'{wkid}'},expected.repository));
});
