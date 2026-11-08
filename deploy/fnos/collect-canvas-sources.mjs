// Exact shipped Linux SBOM drives MPL sources and embedded permissive notices.
// No full Skia checkout or upstream build script is executed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {canvasSourcePolicy} from './canvas-source-policy.mjs';
const [stage,work]=process.argv.slice(2),pkgDir=path.join(stage,'app/erp/apps/sales/node_modules/@napi-rs/canvas-linux-x64-gnu');
const pkg=JSON.parse(fs.readFileSync(path.join(pkgDir,'package.json'),'utf8'));
assert.equal(pkg.version,'1.0.11','Review Canvas native binary/source pins after upgrade');
const sbomBytes=fs.readFileSync(path.join(pkgDir,'sbom.cdx.json')),sbom=JSON.parse(sbomBytes),policy=canvasSourcePolicy(sbom);
const sha=b=>createHash('sha256').update(b).digest('hex');
const binary=sbom.components.find(c=>c.name==='skia.linux-x64-gnu.node');
assert.equal(sha(fs.readFileSync(path.join(pkgDir,binary.name))),binary.hashes.find(h=>h.alg==='SHA-256').content,'Canvas SBOM native-binary hash mismatch');
const dest=path.join(work,'sources/canvas'),notices=path.join(dest,'notices');fs.mkdirSync(notices,{recursive:true});
fs.writeFileSync(path.join(dest,'sbom.cdx.json'),sbomBytes);const records=[];
async function get(url){let error;for(let attempt=0;attempt<3;attempt++){try{const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('Canvas material '+r.status+' '+url);return Buffer.from(await r.arrayBuffer());}catch(e){error=e;}}throw Error('Canvas material failed '+url,{cause:error});}
function save(name,bytes,url,extra={}){const file=path.join(dest,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);records.push({file:name,url,sha256:sha(bytes),bytes:bytes.length,...extra});}
// Fetch every crate only to recover its original embedded license/notice texts.
// Only the four MPL crates are retained as complete corresponding sources.
let next=0;await Promise.all(Array.from({length:6},async()=>{while(next<policy.crates.length){
 const c=policy.crates[next++],name=c.name+'-'+c.version,url='https://static.crates.io/crates/'+c.name+'/'+name+'.crate',archive=path.join(work,'canvas-'+name+'.crate');
 const bytes=fs.existsSync(archive)?fs.readFileSync(archive):await get(url);
 assert.equal(sha(bytes),c.hashes.find(h=>h.alg==='SHA-256').content,'Canvas crate checksum '+name);
 fs.writeFileSync(archive,bytes);
 const entries=execFileSync('tar',['-tf',archive],{encoding:'utf8'}).trim().split(/\r?\n/);
 const files=entries.filter(f=>!f.endsWith('/')&&/^(?:license|copying|copyright|notice|unlicense)(?:[._-].*)?$/i.test(path.posix.basename(f)));
 const cargo=execFileSync('tar',['-xOf',archive,name+'/Cargo.toml'],{encoding:'utf8'});save('notices/rust/'+name+'/Cargo.toml',Buffer.from(cargo),url,{archiveSHA256:sha(bytes)});
 if(!files.length){
  // Some workspace crates omit the inherited root license from their package.
  // Retrieve it at the crate's own recorded VCS revision, never from HEAD.
  const vcs=JSON.parse(execFileSync('tar',['-xOf',archive,name+'/.cargo_vcs_info.json'],{encoding:'utf8'}));
  const repo=cargo.match(/^repository = "https:\/\/github.com\/([^"#]+)"/m)?.[1]?.replace(/\.git$/,'');
  assert(repo&&/^[0-9a-f]{40}$/.test(vcs.git.sha1),'Canvas crate missing pinned license origin: '+name);
  let found=0;
  for(const file of ['LICENSE','LICENSE-MIT','LICENSE-APACHE','COPYING','UNLICENSE']){const origin='https://raw.githubusercontent.com/'+repo+'/'+vcs.git.sha1+'/'+file,r=await fetch(origin,{signal:AbortSignal.timeout(30000)});if(r.status===404)continue;if(!r.ok)throw Error('Canvas crate license '+r.status+' '+origin);save('notices/rust/'+name+'/'+file,Buffer.from(await r.arrayBuffer()),origin,{revision:vcs.git.sha1});found++;}
  assert(found,'Canvas crate has no upstream license text: '+name);
 }
 for(const f of files){assert(f.startsWith(name+'/')&&!f.split('/').includes('..'));const content=execFileSync('tar',['-xOf',archive,f],{maxBuffer:16*1024*1024});save('notices/rust/'+f,content,url,{archiveSHA256:sha(bytes)});}
 if(policy.correspondingSource.includes(c))save('mpl-sources/'+name+'.crate',bytes,url,{license:'MPL-2.0',verification:'shipped native SBOM SHA256'});
}}));
const skia='95ee33d7ec7791ab9c071675710a14fe6408ae4f';
for(const file of ['LICENSE','DEPS']){const url='https://raw.githubusercontent.com/google/skia/'+skia+'/'+file;save('notices/skia/'+file,await get(url),url);}
for(const file of ['LICENSE','Cargo.lock','scripts/skia-gn-args.cjs','scripts/generate-sbom.mjs']){const url='https://raw.githubusercontent.com/Brooooooklyn/canvas/v1.0.11/'+file;save('notices/canvas/'+file,await get(url),url);}
assert.equal(policy.vendored.length,12,'Review changed enabled Skia native components');
for(const c of policy.vendored){
 const repo=c.properties.find(p=>p.name==='cdx:skia:repositoryUrl').value.replace(/\/$/,'');assert(repo.startsWith('https://')&&/^[0-9a-f]{40}$/.test(c.version));
 const root=repo+'/+/'+c.version+'/',tree=JSON.parse((await get(root+'?format=JSON')).toString().replace(/^\)\]\}'\n/,''));
 const files=tree.entries.filter(e=>e.type==='blob'&&/^(?:license|copying|copyright|notice)(?:[._-].*)?$/i.test(e.name)).map(e=>e.name);
 if(c.name==='freetype')files.push('docs/FTL.TXT');
 if(c.name==='libjpeg-turbo')files.push('README.ijg');
 assert(files.length,'Canvas Skia component license text missing: '+c.name);
 for(const f of files){const url=root+f+'?format=TEXT';save('notices/skia-vendored/'+c.name+'/'+f,Buffer.from((await get(url)).toString(),'base64'),url,{commit:c.version,licenses:c.licenses});}
}
const result={npmPackage:pkg.name,npmVersion:pkg.version,sbomSHA256:sha(sbomBytes),skiaCommit:skia,rustComponents:policy.crates.length,mplSourceComponents:policy.correspondingSource.map(c=>({name:c.name,version:c.version})),skiaVendoredComponents:policy.vendored.length,records,verification:'Native binary and Rust sources checked against shipped upstream SBOM; fixed-commit upstream HTTPS notices with calculated SHA256; no detached signature'};
fs.writeFileSync(path.join(dest,'SOURCE-INPUTS.json'),JSON.stringify(result,null,2)+'\n');
const target=path.join(stage,'app/runtime/licenses/canvas');fs.cpSync(notices,target,{recursive:true});fs.copyFileSync(path.join(dest,'sbom.cdx.json'),path.join(target,'sbom.cdx.json'));fs.copyFileSync(path.join(dest,'SOURCE-INPUTS.json'),path.join(target,'SOURCE-INPUTS.json'));
fs.writeFileSync(path.join(work,'canvas-source-inputs.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({canvasRustNotices:policy.crates.length,canvasMPLSources:policy.correspondingSource.length,canvasSkiaVendoredNotices:policy.vendored.length}));
