import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const [runtime,work]=process.argv.slice(2),sources=path.join(work,'sources');
function run(command,args,options={}){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:16*1024*1024,...options});if(r.status!==0)throw Error(command+' '+args.join(' ')+'\n'+r.stderr);return (r.stdout||'').trim();}
const packages=[];const done=new Set();
for(const owner of fs.readFileSync(path.join(work,'owners.txt'),'utf8').trim().split('\n')){
 const fields=run('dpkg-query',['-W','-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}',owner]).split('\t');
 const [binary,version,source,sourceVersion]=fields;
 const doc=path.join('/usr/share/doc',binary.replace(/:amd64$/,''),'copyright');
 if(!fs.existsSync(doc))throw Error('Missing Debian copyright '+binary);
 const target=path.join(runtime,'licenses','debian',binary.replace(':','_'));fs.mkdirSync(target,{recursive:true});fs.copyFileSync(doc,path.join(target,'copyright'));
 packages.push({binary,version,source,sourceVersion,copyright:path.relative(runtime,path.join(target,'copyright'))});
 const id=source+'='+sourceVersion;if(done.has(id))continue;done.add(id);
 run('apt-get',['source','--download-only',id],{cwd:sources,stdio:['ignore','inherit','inherit']});
}
fs.cpSync('/usr/share/common-licenses',path.join(runtime,'licenses','common-licenses'),{recursive:true,dereference:true});
for(const required of ['chromium','chromium-common','xvfb','x11vnc','xauth','x11-xkb-utils','xkb-data','fonts-noto-cjk','libnss3','libx11-6','libstdc++6','libfontconfig1'])if(!packages.some(p=>p.binary.replace(/:amd64$/,'')===required))throw Error('Source closure lacks required Debian owner '+required);
fs.writeFileSync(path.join(work,'debian-packages.json'),JSON.stringify(packages,null,2)+'\n');
fs.copyFileSync(path.join(work,'debian-packages.json'),path.join(sources,'debian-packages.json'));
// apt-get source --download-only validates the signed Sources index checksums.
// Preserve .dsc, orig tar and Debian patches together; never ship links alone.
console.log(JSON.stringify({debianBinaries:packages.length,correspondingSourcePackages:done.size}));
