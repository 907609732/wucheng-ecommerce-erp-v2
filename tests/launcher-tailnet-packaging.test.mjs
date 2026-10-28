import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import resource from '../build/tailnet-resource.cjs';

function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-tailnet-packaging-'));
 t.after(()=>{const resolved=fs.realpathSync(directory),relative=path.relative(fs.realpathSync(os.tmpdir()),resolved);assert(!relative.includes(path.sep)&&relative.startsWith('lingtu-tailnet-packaging-'));fs.rmSync(resolved,{recursive:true,force:true});});
 const source=path.join(directory,'source');fs.mkdirSync(path.join(source,'LICENSES','Go'),{recursive:true});
 const exe=Buffer.alloc(128);exe.write('MZ');exe.writeUInt32LE(64,0x3c);exe.write('PE\0\0',64,'binary');exe.writeUInt16LE(0x8664,68);exe.writeUInt16LE(0x20b,88);
 fs.writeFileSync(path.join(source,'lingtu-tailnet.exe'),exe);fs.writeFileSync(path.join(source,'NOTICE'),'synthetic notice');fs.writeFileSync(path.join(source,'LICENSES','Go','LICENSE'),'synthetic license');
 const manifest={schemaVersion:1,protocolVersion:1,platform:'win32',arch:'x64',file:'lingtu-tailnet.exe',bytes:exe.length,sha256:createHash('sha256').update(exe).digest('hex'),version:'0.1.0',tailscaleVersion:'1.104.2'};
 const save=()=>fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify(manifest));save();return {directory,source,manifest,save};
}

test('Tailnet resource copy is a byte-identical public whitelist snapshot',t=>{
 const f=fixture(t),checked=resource.validateTailnetResource(f.source),destination=path.join(f.directory,'copy'),copied=resource.copyTailnetResource(f.source,destination);
 assert.equal(copied.fingerprint,checked.fingerprint);assert.equal(copied.files.length,4);assert.deepEqual(resource.filters,['lingtu-tailnet.exe','manifest.json','NOTICE','LICENSES/**/*']);
 fs.writeFileSync(path.join(destination,'NOTICE'),'changed during packaging');
 assert.throws(()=>resource.validateTailnetResource(destination,{expected:checked}),{code:'TAILNET_RESOURCE_CHANGED_DURING_PACKAGING'});
 assert.throws(()=>resource.copyTailnetResource(f.source,destination),{code:'TAILNET_RESOURCE_DESTINATION_NOT_EMPTY'});
});

test('manifest rejects wrong protocol/platform/arch and private extra fields',t=>{
 const f=fixture(t);
 for(const [field,value] of [['protocolVersion',2],['platform','linux'],['arch','arm64'],['file','../other.exe'],['stateDir','C:/private/synthetic']]){
  const previous=f.manifest[field];f.manifest[field]=value;f.save();assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_MANIFEST_INVALID'});if(previous===undefined)delete f.manifest[field];else f.manifest[field]=previous;
 }
});

test('manifest byte count and digest are checked before code can run',t=>{
 const f=fixture(t);f.manifest.bytes++;f.save();assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_DIGEST_MISMATCH'});
 f.manifest.bytes--;f.manifest.sha256='0'.repeat(64);f.save();assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_DIGEST_MISMATCH'});
});

test('a matching digest cannot make an ARM executable a Windows x64 component',t=>{
 const f=fixture(t),file=path.join(f.source,'lingtu-tailnet.exe'),bytes=fs.readFileSync(file);bytes.writeUInt16LE(0xaa64,68);fs.writeFileSync(file,bytes);f.manifest.sha256=createHash('sha256').update(bytes).digest('hex');f.save();assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_NOT_WINDOWS_X64'});
});

test('data/config files and disguised state under LICENSES fail closed',t=>{
 const f=fixture(t),config=path.join(f.source,'config.json');fs.writeFileSync(config,'{}');assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_FILE_NOT_ALLOWLISTED'});fs.unlinkSync(config);
 const state=path.join(f.source,'LICENSES','node-state.dpapi');fs.writeFileSync(state,'synthetic excluded state');assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_FILE_NOT_ALLOWLISTED'});fs.unlinkSync(state);
 fs.mkdirSync(path.join(f.source,'data'));assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_DIRECTORY_NOT_ALLOWLISTED'});
});

test('license directory junctions are rejected instead of followed',t=>{
 const f=fixture(t),outside=path.join(f.directory,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.source,'LICENSES','linked'),process.platform==='win32'?'junction':'dir');assert.throws(()=>resource.validateTailnetResource(f.source),{code:'TAILNET_RESOURCE_LINK_OR_SPECIAL_FILE'});
});

test('the frozen actual Go artifact has a valid Winx64 manifest and only public files',()=>{
 const checked=resource.validateTailnetResource(path.resolve('dist/tailnet-runtime'));
 assert.equal(checked.manifest.protocolVersion,1);assert.equal(checked.manifest.tailscaleVersion,'1.104.2');assert.equal(checked.files.length,43);
});

test('builder hook rejects a stage changed after pre-build verification',async t=>{
 const f=fixture(t),app=path.join(f.directory,'app');
 for(const name of ['fastify','@fastify/reply-from','@fastify/cookie']){const file=path.join(app,'resources/workbench-gateway/node_modules',name,'package.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{}');}
 const oldResource=process.env.LINGTU_TAILNET_RESOURCE,oldFingerprint=process.env.LINGTU_TAILNET_FINGERPRINT;process.env.LINGTU_TAILNET_RESOURCE=f.source;process.env.LINGTU_TAILNET_FINGERPRINT='0'.repeat(64);
 try{const {default:config}=await import('../build/launcher-builder.config.cjs');await assert.rejects(config.afterPack({appOutDir:app}),/stage changed after pre-build validation/);}
 finally{if(oldResource===undefined)delete process.env.LINGTU_TAILNET_RESOURCE;else process.env.LINGTU_TAILNET_RESOURCE=oldResource;if(oldFingerprint===undefined)delete process.env.LINGTU_TAILNET_FINGERPRINT;else process.env.LINGTU_TAILNET_FINGERPRINT=oldFingerprint;}
});
