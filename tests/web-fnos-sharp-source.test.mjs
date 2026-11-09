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
test('libffi official asset is preferred with size/hash checked and no browser URL request',async t=>{
 const f=fixture(t,async(url,file)=>{assert.equal(url,asset);fs.writeFileSync(file,bytes);});
 assert.equal(await f.run(),path.join(f.dest,'libffi.tar.gz'));assert.equal(f.calls.length,1);
 assert.deepEqual(fs.readFileSync(path.join(f.dest,'libffi.tar.gz')),bytes);
 assert.equal(f.records[0].url,asset);assert.equal(f.records[0].sourceURL,source);assert.equal(f.records[0].sha256,digest);
 assert(!fs.existsSync(path.join(f.dest,'libffi.tar.gz.partial')));
});
test('official asset failure falls back only to its pinned browser URL and records both URLs',async t=>{
 const f=fixture(t,async(url,file,args)=>{
  if(url===asset){assert(args.includes('Accept: application/octet-stream'));fs.writeFileSync(file,'incomplete');throw Error('HTTP 504');}
  assert.equal(url,source);
  assert(!fs.existsSync(file),'failed primary partial must be removed before fallback');fs.writeFileSync(file,bytes);
 });
 await f.run();assert.equal(f.calls.length,2);assert.equal(f.records[0].url,source);assert.equal(f.records[0].sourceURL,source);
 assert.deepEqual(fs.readFileSync(path.join(f.dest,'libffi.tar.gz')),bytes);
});
for(const route of ['asset','browser'])for(const corrupt of ['hash','size'])test('libffi '+route+' rejects wrong '+corrupt+' without publishing source',async t=>{
 const f=fixture(t,async(url,file)=>{
  if(route==='browser'&&url===asset)throw Error('HTTP 504');
  fs.writeFileSync(file,corrupt==='hash'?Buffer.alloc(bytes.length):bytes.subarray(1));
 });
 await assert.rejects(f.run(),corrupt==='hash'?/checksum mismatch/:/size mismatch/);
 assert.equal(f.calls.length,route==='browser'?2:1);assert.deepEqual(f.records,[]);assert.deepEqual(fs.readdirSync(f.dest),[]);
});
test('unreviewed GitHub release URL is rejected before any request',async t=>{
 const f=fixture(t,async()=>{throw Error('HTTP 504');});
 await assert.rejects(f.run(source.replace('3.8.0.tar.gz','3.8.1.tar.gz')),/Unreviewed GitHub release source/);
 assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(f.dest),[]);assert.deepEqual(f.records,[]);
});
test('both libffi transfers failing remove the sole partial and publish no record',async t=>{
 const f=fixture(t,async(url,file)=>{fs.writeFileSync(file,'incomplete');throw Error('HTTP 504');});
 await assert.rejects(f.run(),/Source download failed/);assert.equal(f.calls.length,2);
 assert.deepEqual(fs.readdirSync(f.dest),[]);assert.deepEqual(f.records,[]);
});

const additionalAssets=[
 ['https://github.com/libexif/libexif/releases/download/v0.6.26/libexif-0.6.26.tar.xz','https://api.github.com/repos/libexif/libexif/releases/assets/396064271'],
 ['https://github.com/mm2/Little-CMS/releases/download/lcms2.19.1/lcms2-2.19.1.tar.gz','https://api.github.com/repos/mm2/Little-CMS/releases/assets/413352057'],
 ['https://github.com/strukturag/libheif/releases/download/v1.23.5/libheif-1.23.5.tar.gz','https://api.github.com/repos/strukturag/libheif/releases/assets/579590172'],
 ['https://github.com/libexpat/libexpat/releases/download/R_2_8_5/expat-2.8.5.tar.xz','https://api.github.com/repos/libexpat/libexpat/releases/assets/581250599'],
 ['https://github.com/libarchive/libarchive/releases/download/v3.8.9/libarchive-3.8.9.tar.xz','https://api.github.com/repos/libarchive/libarchive/releases/assets/492571696'],
 ['https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz','https://api.github.com/repos/fribidi/fribidi/releases/assets/576224505'],
 ['https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz','https://api.github.com/repos/libvips/libvips/releases/assets/590538998'],
];
for(const [original,api] of additionalAssets)test('fixed recipe asset preferred: '+new URL(original).pathname.split('/').at(-1),async t=>{
 const f=fixture(t,async(url,file,args)=>{assert.equal(url,api);assert(args.includes('Accept: application/octet-stream'));fs.writeFileSync(file,bytes);});
 await f.run(original);assert.equal(f.calls.length,1);assert.equal(f.records[0].url,api);assert.equal(f.records[0].sourceURL,original);
});
