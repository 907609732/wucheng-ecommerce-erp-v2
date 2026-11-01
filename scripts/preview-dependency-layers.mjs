// Deployment-only dependency compaction. Inputs are a previously verified snapshot
// and its SHA inventory; business sources and native component ASARs stay intact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{ZipFile}=require('yazl');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const dev=p=>/(^|\/)(@types|tests?|__tests__|examples?|benchmarks?)(\/|$)/i.test(p)||/\.(d\.ts|map)$/i.test(p)||/(^|\/)(README|LICENSE|LICENCE|CHANGELOG|HISTORY|NOTICE)[^/]*$/i.test(p);
const pkg=p=>{const a=p.split('/');return a[0].startsWith('@')?a.slice(0,2).join('/'):a[0];};
export async function compactPreview({source,destination,inventory,tracedFiles,warnings=[]}){
 if(fs.existsSync(destination))throw Error('Destination must be new');
 fs.mkdirSync(destination,{recursive:true});
 const prefix='resources/agent-runtime/',groups=new Map(),used=new Set(),notices=new Map(),layers={},moduleLayers={purchase:[],sales:[],overview:[]};
 for(const f of tracedFiles)if(f.startsWith('node_modules/'))used.add(pkg(f.slice(13)));
 // Retain every package involved in an unresolved/optional dependency warning.
 for(const w of warnings){const s=typeof w==='string'?w:JSON.stringify(w);for(const m of s.replaceAll('\\\\','/').replaceAll('\\','/').matchAll(/\/node_modules\/((?:@[^/\s]+\/)?[^/\s:'"]+)/g))used.add(m[1]);}
 // Dynamic host assets are served directly rather than imported by Node.
 for(const name of ['echarts','tabulator-tables','yauzl','yazl','playwright','playwright-core'])used.add(name);
 let removedExporter=0,removedRoot=0,removedDev=0,rawApp=0;
 for(const item of inventory){
  const rel=item.path,src=path.join(source,...rel.split('/')),runtime=rel.startsWith(prefix)?rel.slice(prefix.length):'';
  if(/(^|\/)(LICENSE|LICENCE|NOTICE)[^/]*$/i.test(rel)){const b=fs.readFileSync(src);notices.set(hash(b),{rel,text:b.toString('utf8')});}
  const app=runtime.match(/^apps\/(purchase|sales|overview|exporter)\/node_modules\/(.+)$/);
  if(app){
   if(app[1]==='exporter'){removedExporter+=item.bytes;continue;}
   const name=pkg(app[2]);if(name==='typescript'||dev(app[2])){removedDev+=item.bytes;continue;}
   const key=app[1]+'/'+name;if(!groups.has(key))groups.set(key,{id:app[1],name,files:[]});
   groups.get(key).files.push({...item,entry:'node_modules/'+app[2]});rawApp+=item.bytes;continue;
  }
  if(runtime.startsWith('node_modules/')){const p=runtime.slice(13);if(!used.has(pkg(p))||pkg(p)==='typescript'||dev(p)&&!tracedFiles.includes(runtime)){removedRoot+=item.bytes;continue;}}
  const out=path.join(destination,...rel.split('/'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(src,out,fs.constants.COPYFILE_EXCL);
 }
 const layerDir=path.join(destination,prefix,'dependency-layers');fs.mkdirSync(layerDir,{recursive:true});
 let repeatedRaw=0,layerBytes=0;
 for(const g of groups.values()){
  g.files.sort((a,b)=>a.entry.localeCompare(b.entry));
  const key=hash(JSON.stringify(g.files.map(f=>[f.entry,f.bytes,f.sha256])));
  if(!layers[key]){
   const archive='dependency-layers/'+key+'.zip',file=path.join(destination,prefix,archive),zip=new ZipFile();
   const done=new Promise((resolve,reject)=>{const out=fs.createWriteStream(file,{flags:'wx'});out.on('close',resolve);out.on('error',reject);zip.outputStream.on('error',reject);zip.outputStream.pipe(out);});
   for(const f of g.files)zip.addFile(path.join(source,...f.path.split('/')),f.entry,{mtime:new Date('2020-01-01'),compressionLevel:6});zip.end();await done;
   const data=fs.readFileSync(file);layerBytes+=data.length;
   layers[key]={archive,sha256:hash(data),files:Object.fromEntries(g.files.map(f=>[f.entry,{sha256:f.sha256,bytes:f.bytes}]))};
  }else repeatedRaw+=g.files.reduce((n,f)=>n+f.bytes,0);
  moduleLayers[g.id].push(key);
 }
 const notice=Array.from(notices.values(),n=>'===== '+n.rel+' =====\n'+n.text).join('\n\n');fs.writeFileSync(path.join(destination,prefix,'THIRD_PARTY_NOTICES.txt'),notice);
 return {format:1,layers,modules:moduleLayers,metrics:{removedExporter,removedRoot,removedDev,rawApp,repeatedRaw,layerBytes,layerCount:Object.keys(layers).length}};
}
