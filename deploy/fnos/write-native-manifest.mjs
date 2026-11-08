import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [stage,work]=process.argv.slice(2),runtime=path.join(stage,'app/runtime');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const npm=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 if(e.isSymbolicLink())continue;
 const p=path.join(dir,e.name);
 if(e.isDirectory())walk(p);
 else if(e.name==='package.json'&&p.includes('/node_modules/')){
  const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.name&&j.version)npm.push({path:path.relative(stage,p),name:j.name,version:j.version,license:j.license||'See bundled package notices',repository:j.repository||null});
 }
}}
walk(path.join(stage,'app/erp'));
const inputs=Object.fromEntries(fs.readFileSync(path.join(import.meta.dirname,'native-inputs.env'),'utf8').split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split('=')));
const manifest={schemaVersion:1,version:'0.15.0',platform:'linux/amd64',hostLibc:'glibc 2.36 (not bundled)',commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),inputs,nodeLicense:'runtime/node/LICENSE',novncLicense:'runtime/novnc/LICENSE.txt',novncHTMLSHA256:sha(path.join(runtime,'novnc/vnc.html')),debian:JSON.parse(fs.readFileSync(path.join(work,'debian-packages.json'),'utf8')),npm,sourceCompanion:'wuchengerp-0.15.0-corresponding-source.tar.zst',xvfbBuild:{source:'Debian patched xorg-server',xkbBinDir:'/var/apps/wuchengerp/target/runtime/sysroot/usr/bin',xkbDir:'/var/apps/wuchengerp/target/runtime/sysroot/usr/share/X11/xkb'}};
manifest.sharpLibvips=JSON.parse(fs.readFileSync(path.join(work,'sharp-source-inputs.json'),'utf8'));
manifest.canvas=JSON.parse(fs.readFileSync(path.join(work,'canvas-source-inputs.json'),'utf8'));
fs.writeFileSync(path.join(stage,'app/THIRD-PARTY.json'),JSON.stringify(manifest,null,2)+'\n');
