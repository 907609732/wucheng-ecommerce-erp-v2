// Preserve upstream's exact libvips build recipe and source inputs; do not execute
// the downloaded build script. npm's bundled libvips is outside dpkg ownership.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const curl=promisify(execFile);
const sha=b=>createHash('sha256').update(b).digest('hex');
export const libffiSource=Object.freeze({url:'https://github.com/libffi/libffi/releases/download/v3.8.0/libffi-3.8.0.tar.gz',assetURL:'https://api.github.com/repos/libffi/libffi/releases/assets/506805115',sha256:'7da3e2d9a171eb0a038f592ecad3ff2bb2550f3496d87b3b29ad0cf4430c0db4',bytes:1581626});
export async function downloadSharpSource({dest,records,runCurl=curl},url,name,expected,expectedBytes){
 const file=path.join(dest,name),partial=file+'.partial',cached=fs.existsSync(file);let bytes,usedURL=url;
 try{
 if(cached)bytes=fs.readFileSync(file);
 else{
  // Actual CI hit TLS ECONNRESET mid-source transfer. Standard curl supplies
  // bounded retries, including connection resets, without weakening TLS/SHA.
  const transfer=target=>runCurl('curl',['--silent','--show-error','--fail','--location','--proto','=https','--proto-redir','=https','--tlsv1.2','--retry','3','--retry-all-errors','--retry-delay','1','--connect-timeout','15','--max-time','120',...(target===libffiSource.assetURL?['--header','Accept: application/octet-stream','--header','X-GitHub-Api-Version: 2022-11-28']:[]),'--output',partial,target],{maxBuffer:1024*1024});
  try{
   try{await transfer(url);}catch(error){
    if(url!==libffiSource.url)throw error;
    // Same official release asset, independently pinned to the accepted bytes.
    // Never mix a failed transfer's partial bytes into the fallback response.
    fs.rmSync(partial,{force:true});usedURL=libffiSource.assetURL;await transfer(usedURL);
   }
   bytes=fs.readFileSync(partial);
  }
  catch(error){throw Error('Source download failed '+url,{cause:error});}
 }
 if(expectedBytes!==undefined&&bytes.length!==expectedBytes)throw Error('Source size mismatch '+name);
 const digest=sha(bytes);if(expected&&digest!==expected)throw Error('Source checksum mismatch '+name);
 if(!cached)fs.renameSync(partial,file);
 records.push({file:name,url:cached&&url===libffiSource.url?null:usedURL,...(url===libffiSource.url?{sourceURL:url,...(cached?{fromCache:true}:{})}:{}),sha256:digest,bytes:bytes.length,verification:expected?'pinned SHA256':'HTTPS upstream source; calculated SHA256 (not detached signature)'});return file;
 }finally{fs.rmSync(partial,{force:true});}
}
export async function collectSharpSources(stage,work){
const dest=path.join(work,'sources/sharp-libvips');fs.mkdirSync(dest,{recursive:true});
const pkg=JSON.parse(fs.readFileSync(path.join(stage,'app/erp/apps/purchase/node_modules/@img/sharp-libvips-linux-x64/package.json'),'utf8'));
if(pkg.version!=='1.3.4')throw Error('Review libvips corresponding-source inputs for changed npm binary');
const records=[];
const download=(url,name,expected)=>downloadSharpSource({dest,records},url,name,url===libffiSource.url?libffiSource.sha256:expected,url===libffiSource.url?libffiSource.bytes:undefined);
const recipe=await download('https://codeload.github.com/lovell/sharp-libvips/tar.gz/refs/tags/v1.3.4','sharp-libvips-v1.3.4.tar.gz','a8e96acb479c9bc1a5b7950f8f25aa6c8e1ef3a19755b45cf2f00d506aeaccc0');
const readRecipe=p=>execFileSync('tar',['-xOf',recipe,'sharp-libvips-1.3.4/'+p],{encoding:'utf8'});
const versions=Object.fromEntries(readRecipe('versions.properties').trim().split('\n').map(l=>l.split('=')));
const script=readRecipe('build/posix.sh');fs.writeFileSync(path.join(dest,'posix.sh'),script);fs.writeFileSync(path.join(dest,'versions.properties'),readRecipe('versions.properties'));
const urls=[...script.matchAll(/^\s*\$CURL\s+(https:.+?)\s+\|/gm)].map(m=>{
 let u=m[1].replace(/\$\(without_patch \$([A-Z0-9_]+)\)/g,(_,v)=>versions[v].split('.').slice(0,2).join('.'))
 .replace(/\$\(without_prerelease \$([A-Z0-9_]+)\)/g,(_,v)=>versions[v].split('-')[0])
 .replace(/\$\{([A-Z0-9_]+)\/\/\.\/([^}]+)\}/g,(_,v,s)=>versions[v].replaceAll('.',s))
 .replace(/\$\{([A-Z0-9_]+)\}/g,(_,v)=>versions[v]);
 if(u.includes('$')||!u.startsWith('https://'))throw Error('Unreviewed upstream source URL '+u);return u;
});
if(urls.length<30)throw Error('Incomplete upstream libvips source recipe');
let rsvg;
for(const [i,url] of urls.entries()){
 const name=String(i+1).padStart(2,'0')+'-'+new URL(url).pathname.split('/').at(-1);
 // freedesktop's GitLab rejects automated downloads (HTTP 406). This is the
 // project's official GitHub mirror, same exact tag, not an unrelated tarball.
 const mirror=url.includes('gitlab.freedesktop.org/fontconfig/fontconfig/')?'https://codeload.github.com/fontconfig/fontconfig/tar.gz/refs/tags/2.18.3':url.includes('gitlab.com/libtiff/libtiff/')?'https://download.osgeo.org/libtiff/tiff-4.7.2.tar.gz':url;
 const file=await download(mirror,name);if(mirror!==url)records.at(-1).upstreamRecipeURL=url;
 if(/\.tar\.(?:gz|xz)$/.test(name))execFileSync('tar',['-tf',file],{stdio:'ignore'});
 if(url.includes('/librsvg-'))rsvg=file;
}
if(!rsvg)throw Error('librsvg source missing');
const lockPath=execFileSync('tar',['-tf',rsvg],{encoding:'utf8'}).split(/\r?\n/).find(n=>/^[^/]+\/Cargo.lock$/.test(n));
if(!lockPath)throw Error('librsvg Cargo.lock missing');
const lock=execFileSync('tar',['-xOf',rsvg,lockPath],{encoding:'utf8'});fs.writeFileSync(path.join(dest,'librsvg-Cargo.lock'),lock);
const crates=lock.split('[[package]]').slice(1).map(block=>Object.fromEntries([...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"/gm)].map(m=>[m[1],m[2]]))).filter(p=>p.source);
for(const p of crates)if(p.source!=='registry+https://github.com/rust-lang/crates.io-index'||!p.checksum)throw Error('Unreviewed Rust source '+JSON.stringify(p));
let next=0;await Promise.all(Array.from({length:6},async()=>{while(next<crates.length){const p=crates[next++];await download('https://static.crates.io/crates/'+p.name+'/'+p.name+'-'+p.version+'.crate',p.name+'-'+p.version+'.crate',p.checksum);}}));
fs.writeFileSync(path.join(dest,'SOURCE-INPUTS.json'),JSON.stringify({npmPackage:pkg.name,npmVersion:pkg.version,versions,archivesAndPatches:urls.length,rustCrates:crates.length,records},null,2)+'\n');
fs.copyFileSync(path.join(dest,'SOURCE-INPUTS.json'),path.join(work,'sharp-source-inputs.json'));
console.log(JSON.stringify({libvipsSourceInputs:records.length}));

}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await collectSharpSources(...process.argv.slice(2));
