import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {downloadSharpSource} from '../deploy/fnos/collect-sharp-sources.mjs';

const source='https://github.com/libffi/libffi/releases/download/v3.8.0/libffi-3.8.0.tar.gz';
const asset='https://api.github.com/repos/libffi/libffi/releases/assets/506805115';
const bytes=Buffer.from('synthetic source archive'),digest=createHash('sha256').update(bytes).digest('hex');
function fixture(t,respond){
 const dest=fs.mkdtempSync(path.join(os.tmpdir(),'sharp-source-')),records=[],calls=[];
 t.after(()=>fs.rmSync(dest,{recursive:true,force:true}));
 const context={dest,records,runCurl:async(command,args)=>{
  assert.equal(command,'curl');calls.push(args);const file=args[args.indexOf('--output')+1];
  assert.equal(file,path.join(dest,'libffi.tar.gz.partial'));
  assert(!args.some(a=>/authorization|token/i.test(a)));
  await respond(args.at(-1),file,args);
 }};
 return {dest,records,calls,run:(url=source)=>downloadSharpSource(context,url,'libffi.tar.gz',digest,bytes.length)};
}
test('libffi primary source succeeds with size/hash checked and no API request',async t=>{
 const f=fixture(t,async(url,file)=>{assert.equal(url,source);fs.writeFileSync(file,bytes);});
 assert.equal(await f.run(),path.join(f.dest,'libffi.tar.gz'));assert.equal(f.calls.length,1);
 assert.deepEqual(fs.readFileSync(path.join(f.dest,'libffi.tar.gz')),bytes);
 assert.equal(f.records[0].url,source);assert.equal(f.records[0].sourceURL,source);assert.equal(f.records[0].sha256,digest);
 assert(!fs.existsSync(path.join(f.dest,'libffi.tar.gz.partial')));
});
test('only exact libffi URL failure falls back to official asset and records both URLs',async t=>{
 const f=fixture(t,async(url,file,args)=>{
  if(url===source){fs.writeFileSync(file,'incomplete');throw Error('HTTP 504');}
  assert.equal(url,asset);assert(args.includes('Accept: application/octet-stream'));
  assert(!fs.existsSync(file),'failed primary partial must be removed before fallback');fs.writeFileSync(file,bytes);
 });
 await f.run();assert.equal(f.calls.length,2);assert.equal(f.records[0].url,asset);assert.equal(f.records[0].sourceURL,source);
 assert.deepEqual(fs.readFileSync(path.join(f.dest,'libffi.tar.gz')),bytes);
});
for(const route of ['primary','asset'])for(const corrupt of ['hash','size'])test('libffi '+route+' rejects wrong '+corrupt+' without publishing source',async t=>{
 const f=fixture(t,async(url,file)=>{
  if(route==='asset'&&url===source)throw Error('HTTP 504');
  fs.writeFileSync(file,corrupt==='hash'?Buffer.alloc(bytes.length):bytes.subarray(1));
 });
 await assert.rejects(f.run(),corrupt==='hash'?/checksum mismatch/:/size mismatch/);
 assert.equal(f.calls.length,route==='asset'?2:1);assert.deepEqual(f.records,[]);assert.deepEqual(fs.readdirSync(f.dest),[]);
});
test('other source errors never use the libffi API fallback',async t=>{
 const f=fixture(t,async()=>{throw Error('HTTP 504');});
 await assert.rejects(f.run(source.replace('3.8.0.tar.gz','3.8.1.tar.gz')),/Source download failed/);
 assert.equal(f.calls.length,1);assert.deepEqual(fs.readdirSync(f.dest),[]);assert.deepEqual(f.records,[]);
});
test('both libffi transfers failing remove the sole partial and publish no record',async t=>{
 const f=fixture(t,async(url,file)=>{fs.writeFileSync(file,'incomplete');throw Error('HTTP 504');});
 await assert.rejects(f.run(),/Source download failed/);assert.equal(f.calls.length,2);
 assert.deepEqual(fs.readdirSync(f.dest),[]);assert.deepEqual(f.records,[]);
});
