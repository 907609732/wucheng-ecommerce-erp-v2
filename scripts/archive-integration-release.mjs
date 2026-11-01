import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Local source delivery only. Runtime ledgers, credentials and dependencies are never included.
const root=process.cwd(),base=path.join(os.homedir(),'Documents','ChatGPT');
const output=path.join(root,'dist','local-extensions-2026-10-20');
const purchase=path.join(base,'采购'),sales=path.join(base,'销售台');
const overview=path.join(purchase,'采购台和销售额台聚合'),exporter=path.join(base,'复刻买家历史订单导出软件');
const archiver=createRequire(path.join(purchase,'package.json'))('archiver');
fs.mkdirSync(output,{recursive:true});
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const specs=[
  {id:'purchase',root:purchase,entries:['lib','public','scripts','tests','licenses','extension','package.json','package-lock.json','server.mjs','README.md','CHANGELOG.md','SECURITY.md','config.example.json','启动采购台.cmd','启动灵兔采购台.cmd','重启采购台.cmd','重启灵兔采购台.cmd']},
  {id:'sales',root:sales,entries:['lib','public','scripts','test','package.json','package-lock.json','server.mjs','README.md','启动销售台.bat']},
  {id:'overview',root:overview,entries:['lib','public','scripts','tests','package.json','package-lock.json','server.mjs','README.md','启动灵兔经营收支总览.cmd']},
  {id:'exporter',root:exporter,entries:['src','tests','build','package.json','package-lock.json','electron.vite.config.ts','tsconfig.json','vitest.config.ts','README.md']},
  {id:'host-extension',root,entries:['desktop/extensions/lingtu-desks']}
];
const forbidden=/(^|\/)(?:node_modules|data|private|\.git|\.plastic|\.env[^/]*|__pycache__|config\.json|\.integration[^/]*)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|pem|key|pfx)$/i;
const sources=[];
for(const spec of specs){
  const version=JSON.parse(fs.readFileSync(path.join(spec.root,'package.json'),'utf8')).version;
  const files=[];
  const walk=relative=>{
    if(forbidden.test(relative))return;
    const file=path.join(spec.root,relative);
    if(!fs.existsSync(file))throw Error('Missing source entry: '+file);
    const s=fs.lstatSync(file);if(s.isSymbolicLink())throw Error('Source symlinks require review: '+relative);
    if(s.isDirectory())for(const name of fs.readdirSync(file))walk(relative+'/'+name);
    else files.push({path:relative,bytes:s.size,sha256:sha(file)});
  };
  spec.entries.forEach(walk);files.sort((a,b)=>a.path.localeCompare(b.path));
  const filename=`${spec.id}-${version}-source.tgz`,archive=path.join(output,filename),list=path.join(output,`${spec.id}-files.txt`);
  fs.writeFileSync(list,files.map(f=>f.path).join('\n')+'\n');
  await new Promise((resolve,reject)=>{
    const outputStream=fs.createWriteStream(archive),tar=archiver('tar',{gzip:true,gzipOptions:{level:9}});
    outputStream.once('close',resolve);outputStream.once('error',reject);tar.once('error',reject);tar.once('warning',reject);
    tar.pipe(outputStream);for(const file of files)tar.file(path.join(spec.root,file.path),{name:file.path});
    tar.finalize().catch(reject);
  });
  for(const f of files)if(sha(path.join(spec.root,f.path))!==f.sha256)throw Error('Source changed during packaging: '+f.path);
  fs.writeFileSync(path.join(output,`${spec.id}-source-manifest.json`),JSON.stringify({id:spec.id,version,root:spec.root,files},null,2));
  sources.push({id:spec.id,version,root:spec.root,archive:filename,files:files.length,bytes:fs.statSync(archive).size,sha256:sha(archive)});
}
const artifacts=[
  path.join(root,'dist','CloudWarehouseInventorySync-Setup-0.7.0-x64.exe'),
  path.join(root,'dist','CloudWarehouseInventorySync-Portable-0.7.0-x64.exe'),
  path.join(exporter,'release','LingtuOrderExport-0.2.0-Setup.exe')
].map(file=>({path:file,bytes:fs.statSync(file).size,sha256:sha(file)}));
for(const name of ['本机扩展接口-v1.md','本机扩展验收报告-2026-10-20.md'])fs.copyFileSync(path.join(root,'docs',name),path.join(output,name));
fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),scope:'this Windows computer; source-only archives; private ledgers and configuration excluded',artifacts,sources},null,2));
console.log(JSON.stringify({output,artifacts:artifacts.map(a=>({name:path.basename(a.path),bytes:a.bytes,sha256:a.sha256})),sources:sources.map(({id,version,files,bytes,sha256})=>({id,version,files,bytes,sha256}))}));
