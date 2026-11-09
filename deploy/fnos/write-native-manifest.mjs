import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {verifyRelease} from '../../server/release.mjs';

const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function acceptedNativeRelease(erpRoot){
 const release=verifyRelease(erpRoot);
 const version=JSON.parse(fs.readFileSync(path.join(erpRoot,'package.json'),'utf8')).version;
 if(typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version))throw Error('Accepted ERP release has invalid version');
 return {version,sourceCompanion:`wuchengerp-${version}-corresponding-source.tar.zst`,release};
}

export function writeNativeManifest(stage,work){
 stage=path.resolve(stage);work=path.resolve(work);
 const runtime=path.join(stage,'app/runtime');
 const {version,sourceCompanion}=acceptedNativeRelease(path.join(stage,'app/erp'));
 const npm=[];
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(e.isSymbolicLink())continue;
  const p=path.join(dir,e.name);
  if(e.isDirectory())walk(p);
  else if(e.name==='package.json'&&p.includes(`${path.sep}node_modules${path.sep}`)){
   const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.name&&j.version)npm.push({path:path.relative(stage,p),name:j.name,version:j.version,license:j.license||'See bundled package notices',repository:j.repository||null});
  }
 }}
 walk(path.join(stage,'app/erp'));
 const inputs=Object.fromEntries(fs.readFileSync(path.join(import.meta.dirname,'native-inputs.env'),'utf8').split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split('=')));
 const manifest={schemaVersion:1,version,platform:'linux/amd64',hostLibc:'glibc 2.36 (not bundled)',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8'}).trim(),inputs,nodeLicense:'runtime/node/LICENSE',novncLicense:'runtime/novnc/LICENSE.txt',novncHTMLSHA256:sha(path.join(runtime,'novnc/vnc.html')),debian:JSON.parse(fs.readFileSync(path.join(work,'debian-packages.json'),'utf8')),npm,sourceCompanion,xvfbBuild:{source:'Debian patched xorg-server',xkbBinDir:'/var/apps/wuchengerp/target/runtime/sysroot/usr/bin',xkbDir:'/var/apps/wuchengerp/target/runtime/sysroot/usr/share/X11/xkb'}};
 manifest.sharpLibvips=JSON.parse(fs.readFileSync(path.join(work,'sharp-source-inputs.json'),'utf8'));
 manifest.canvas=JSON.parse(fs.readFileSync(path.join(work,'canvas-source-inputs.json'),'utf8'));
 fs.writeFileSync(path.join(stage,'app/THIRD-PARTY.json'),JSON.stringify(manifest,null,2)+'\n');
 return manifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const [stage,work]=process.argv.slice(2);if(!stage||!work)throw Error('Usage: node write-native-manifest.mjs <stage> <work>');console.log(JSON.stringify(writeNativeManifest(stage,work)));}
 catch(error){console.error(error.stack);process.exitCode=1;}
}
