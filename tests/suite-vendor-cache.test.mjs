import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {selectSuiteVendorRuntimes} from '../scripts/lib/suite-vendor-cache.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'suite-vendor-cache-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'dist'));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),publicKeys={fixture:publicKey.export({type:'spki',format:'pem'})};
  const options={root,hostVersion:'0.11.0',publicKeys};
  function write(directory,{suite=true,hostRange='>=0.11.0 <1'}={}){
    fs.mkdirSync(directory,{recursive:true});
    const packages=['node-runtime','browser-runtime'].map(id=>{
      const data=Buffer.from('synthetic-'+id),archive=id+'.zip';fs.writeFileSync(path.join(directory,archive),data);
      return {id,version:'1.0.0',hostRange,platform:'win32',arch:'x64',kind:'runtime',archive,entry:id==='node-runtime'?'node.exe':'chrome.exe',bytes:data.length,unpackedBytes:data.length,sha256:sha(data),dependencies:[],url:'https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/fixture/'+archive};
    });
    const payload=Buffer.from(JSON.stringify({schemaVersion:1,packages,...(suite?{suite:{format:'lingtu-suite/v1',productId:'com.wucheng.ecommerce.erp.v2',version:'0.11.0'}}:{})}));
    const catalog=Buffer.from(JSON.stringify({format:'lingtu-catalog/v1',keyId:'fixture',payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')}));
    fs.writeFileSync(path.join(directory,'catalog.json'),catalog);return {packages,catalog};
  }
  function current(settings){const directory=path.join(root,'dist','suite-payload-fixture'),value=write(directory,settings);fs.writeFileSync(path.join(root,'dist','suite-payload-current.json'),JSON.stringify({directory,version:'0.11.0',catalogSha256:sha(value.catalog)}));return {directory,...value};}
  return {root,options,write,current};
}

test('current signed payload is preferred and remains sufficient without old dist/modules',async t=>{
  const f=fixture(t),current=f.current();
  let selected=await selectSuiteVendorRuntimes(f.options);assert.equal(selected.source,'current-suite');assert.equal(selected.directory,current.directory);assert.equal(selected.vendors.length,2);
  fs.mkdirSync(path.join(f.root,'dist','modules'));fs.writeFileSync(path.join(f.root,'dist','modules','catalog.json'),'untrusted legacy cache');
  selected=await selectSuiteVendorRuntimes(f.options);assert.equal(selected.source,'current-suite');
});

test('only an absent current pointer permits the signed legacy bootstrap cache',async t=>{
  const f=fixture(t),legacy=path.join(f.root,'dist','modules');f.write(legacy,{suite:false});
  const selected=await selectSuiteVendorRuntimes(f.options);assert.equal(selected.source,'legacy-modules');assert.equal(selected.directory,legacy);
  fs.writeFileSync(path.join(f.root,'dist','suite-payload-current.json'),'{broken');
  await assert.rejects(selectSuiteVendorRuntimes(f.options));
});

test('present current corruption never falls back to a valid old cache',async t=>{
  const f=fixture(t),current=f.current();f.write(path.join(f.root,'dist','modules'),{suite:false});
  fs.writeFileSync(path.join(current.directory,'browser-runtime.zip'),'damaged');
  await assert.rejects(selectSuiteVendorRuntimes(f.options),/size or digest/);
});

test('catalog signature, pointer digest and runtime compatibility are checked',async t=>{
  const f=fixture(t),current=f.current({hostRange:'>=0.12.0 <1'});
  await assert.rejects(selectSuiteVendorRuntimes(f.options),e=>e.code==='INCOMPATIBLE_PACKAGE');
  const pointer=path.join(f.root,'dist','suite-payload-current.json'),metadata=JSON.parse(fs.readFileSync(pointer));
  metadata.catalogSha256='0'.repeat(64);fs.writeFileSync(pointer,JSON.stringify(metadata));
  await assert.rejects(selectSuiteVendorRuntimes(f.options),/catalog digest/);
  const envelope=JSON.parse(current.catalog);envelope.signature=Buffer.alloc(64).toString('base64');const bytes=Buffer.from(JSON.stringify(envelope));fs.writeFileSync(path.join(current.directory,'catalog.json'),bytes);metadata.catalogSha256=sha(bytes);fs.writeFileSync(pointer,JSON.stringify(metadata));
  await assert.rejects(selectSuiteVendorRuntimes(f.options),e=>e.code==='INVALID_SIGNATURE');
});

test('current directory cannot escape the managed payload level or use redirected parents',async t=>{
  const f=fixture(t),outside=path.join(f.root,'outside'),value=f.write(outside);
  const pointer=path.join(f.root,'dist','suite-payload-current.json');
  fs.writeFileSync(pointer,JSON.stringify({directory:outside,version:'0.11.0',catalogSha256:sha(value.catalog)}));
  await assert.rejects(selectSuiteVendorRuntimes(f.options),/escapes/);
  const alias=path.join(f.root,'dist','suite-payload-alias');fs.symlinkSync(outside,alias,'junction');
  fs.writeFileSync(pointer,JSON.stringify({directory:alias,version:'0.11.0',catalogSha256:sha(value.catalog)}));
  await assert.rejects(selectSuiteVendorRuntimes(f.options),/链接|重定向/);
});

test('runtime ZIP and catalog links cannot substitute another filesystem file',async t=>{
  const f=fixture(t),current=f.current(),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
  const archive=path.join(current.directory,'node-runtime.zip'),saved=path.join(outside,'runtime.zip');fs.renameSync(archive,saved);
  fs.symlinkSync(outside,path.join(current.directory,'redirect'),'junction');
  // Re-signing is not involved: the advertised name remains a safe basename.
  fs.linkSync(saved,archive);await selectSuiteVendorRuntimes(f.options);fs.unlinkSync(archive);
  try{fs.symlinkSync(saved,archive,'file');}catch(error){if(error.code==='EPERM'){t.diagnostic('File symlink privilege unavailable; parent-junction rejection was already covered');return;}throw error;}
  await assert.rejects(selectSuiteVendorRuntimes(f.options),/链接|重定向/);
});
