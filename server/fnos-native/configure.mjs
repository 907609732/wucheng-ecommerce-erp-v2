import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {developmentConfig,validateConfig,moduleIds,databases} from '../config.mjs';
import {createSourceServices} from '../services.mjs';

export const within=(child,parent)=>{if(process.platform==='win32'){child=child.toLowerCase();parent=parent.toLowerCase();}return child===parent||child.startsWith(parent+path.sep);};
export function physicalPath(value){
 if(typeof value!=='string'||!path.isAbsolute(value))throw Error('必须使用完整绝对路径');
 const full=path.resolve(value);let current=path.parse(full).root;
 for(const segment of full.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,segment);try{if(fs.lstatSync(current).isSymbolicLink())throw Error('持久路径不能使用符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return full;
}
export function atomicJson(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
}
export async function withNativeLifecycleLock(stateDir,action,{timeoutMs=100000}={}){
 stateDir=physicalPath(stateDir);fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
 const lock=new DatabaseSync(path.join(stateDir,'native-lifecycle.sqlite')),until=Date.now()+timeoutMs;
 try{
  while(true){try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');break;}catch(error){
   if(error.code!=='ERR_SQLITE_ERROR'||!error.message.includes('locked')||Date.now()>until)throw error;
   await new Promise(r=>setTimeout(r,50));
  }}
  return await action();
 }finally{lock.close();}
}
export function configFileAt(root){
 const candidates=[path.join(root,'config.json'),path.join(root,'config','web.json')].filter(fs.existsSync);
 if(candidates.length!==1)throw Error('完整副本需要唯一 config.json 或 config/web.json');return candidates[0];
}
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function backupNative(sourceRoot,target){
 sourceRoot=physicalPath(sourceRoot);target=physicalPath(target);
 if(within(target,sourceRoot)||within(sourceRoot,target))throw Error('备份不能位于源目录内部或覆盖源目录');
 if(fs.existsSync(target))throw Error('备份目标已存在');complete(sourceRoot);assertStopped(sourceRoot);
 const before=tree(sourceRoot),stage=target+'.staging-'+randomUUID();
 try{
  fs.cpSync(sourceRoot,stage,{recursive:true,filter:src=>!fs.lstatSync(src).isSocket()});
  assertStopped(sourceRoot);if(JSON.stringify(before)!==JSON.stringify(tree(sourceRoot)))throw Error('停写备份过程中源目录变化');
  integrity(stage);await sealStoppedSource(stage);fs.renameSync(stage,target);
  return {ok:true,target,files:before.length};
 }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
}
function tree(root,prefix=''){
 const entries=[];
 for(const name of fs.readdirSync(root).sort()){
  const relative=prefix?prefix+'/'+name:name;if(relative==='migration-manifest.json')continue;
  const file=path.join(root,name),st=fs.lstatSync(file);
  if(st.isSymbolicLink())throw Error('完整副本不允许符号链接');
  if(st.isDirectory())entries.push(...tree(file,relative));
  else if(st.isFile())entries.push({path:relative,sha256:digest(file),bytes:st.size});
  else if(!st.isSocket())throw Error('完整副本含有不支持的特殊文件');
 }
 return entries;
}
function assertStopped(root){
 const names=new Set(['web-runtime.json','native-supervisor.json','.integration-runtime.json','.integration-start.lock','.web-collector.json']);
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('完整副本不允许符号链接');
  if(e.isDirectory())walk(file);else if(e.isFile()&&names.has(e.name)){
   const r=JSON.parse(fs.readFileSync(file));for(const pid of [r.pid,r.childPid??r.ownerPid].filter(v=>v!==undefined&&v!==null)){
    if(!Number.isSafeInteger(pid)||pid<1)throw Error('运行记录无效');
    try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')continue;throw Error('不能确认源进程已停止');}
    if(process.platform==='linux'){
     // Docker snapshots retain namespace PIDs (often 1). A host init/kernel
     // process with that number is not evidence that the stopped Node service
     // remains alive. Container stop provenance is the operator's prerequisite.
     let executable;try{executable=fs.readlinkSync('/proc/'+pid+'/exe');}catch(error){if(error.code==='ENOENT')continue;throw Error('不能确认源进程已停止');}
     if(!/^node(?:js)?(?:\s+\(deleted\))?$/.test(path.basename(executable)))continue;
    }
    throw Error('源副本仍有运行进程，必须先停止写入');
   }
  }
 }};walk(root);
}
function complete(root){
 configFileAt(root);
 for(const name of ['data','state','data-version'])if(!fs.statSync(path.join(root,name)).isDirectory())throw Error('源副本不完整');
 for(const id of moduleIds)if(!fs.existsSync(path.join(root,'data',id,databases[id])))throw Error(id+' 原账本不存在，已阻止创建空账本');
}
function integrity(root){for(const entry of tree(root).filter(e=>e.path.endsWith('.sqlite'))){
 const db=new DatabaseSync(path.join(root,entry.path),{readOnly:true});
 try{if(db.prepare('PRAGMA integrity_check').all().some(row=>Object.values(row)[0]!=='ok'))throw Error('账本完整性校验失败：'+entry.path);}finally{db.close();}
}}
export async function sealStoppedSource(sourceRoot){
 sourceRoot=physicalPath(sourceRoot);complete(sourceRoot);assertStopped(sourceRoot);
 const files=tree(sourceRoot),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'erp-seal-'));
 try{
  // SQLite WAL recovery/checking occurs exclusively on a disposable copy.
  fs.cpSync(sourceRoot,temporary,{recursive:true,filter:src=>!fs.lstatSync(src).isSocket()});integrity(temporary);
  assertStopped(sourceRoot);if(JSON.stringify(files)!==JSON.stringify(tree(sourceRoot)))throw Error('源副本在校验时变化');
  atomicJson(path.join(sourceRoot,'migration-manifest.json'),{schemaVersion:1,stopped:true,files});
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
 return path.join(sourceRoot,'migration-manifest.json');
}
function verifySource(root){
 complete(root);assertStopped(root);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'migration-manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1||manifest.stopped!==true||JSON.stringify(manifest.files)!==JSON.stringify(tree(root)))throw Error('迁移副本完整校验失败');
 const identityFile=path.join(root,'state','gateway','identity.json');
 if(!fs.existsSync(identityFile))throw Error('迁移副本缺少原工作台身份 identity，拒绝生成替代身份');
 const identity=JSON.parse(fs.readFileSync(identityFile,'utf8'));
 if(identity.schemaVersion!==1||![identity.serverId,identity.dataSetId].every(v=>typeof v==='string'&&/^[\w-]{8,80}$/.test(v)))throw Error('原工作台身份 identity 无效');
 return manifest;
}
function remap(value,mappings){
 if(Array.isArray(value))return value.map(v=>remap(v,mappings));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v,mappings)]));
 if(typeof value==='string')for(const [from,to] of mappings){if(value===from||value.startsWith(from+path.sep)||value.startsWith(from+'/'))return to+value.slice(from.length);}
 return value;
}
function rebaseConfig(old,root,releaseRoot){
 const maps=[...moduleIds.map(id=>[old.modules[id].dataDir,path.join(root,'data',id)]),[old.stateDir,path.join(root,'state')]];
 if(old.dataVersion?.dir)maps.push([old.dataVersion.dir,path.join(root,'data-version')]);
 if(old.native?.home)maps.push([old.native.home,path.join(root,'uvcs-home')]);
 const c=remap(old,maps.sort((a,b)=>b[0].length-a[0].length));
 c.releaseRoot=releaseRoot;c.stateDir=path.join(root,'state');c.mode='production';
 for(const id of moduleIds){c.modules[id].root=path.join(releaseRoot,'apps',id);c.modules[id].dataDir=path.join(root,'data',id);}
 delete c.windowsService;c.native={...c.native,dataRoot:root,home:path.join(root,'uvcs-home'),nodePath:process.execPath};return {config:c,maps};
}
function remapReferences(root,maps){
 // Only documented file-reference columns change; identities/passwords/locks do not.
 for(const id of moduleIds){
  const db=new DatabaseSync(path.join(root,'data',id,databases[id]));const quote=s=>'"'+s.replaceAll('"','""')+'"';
  try{db.exec('BEGIN IMMEDIATE');for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
   const columns=db.prepare('PRAGMA table_info('+quote(name)+')').all().filter(c=>/^(?:original_path|evidence_path|file_path|attachment_path|source_path)$/.test(c.name));
   for(const column of columns)for(const [from,to] of maps){
    const q=quote(column.name);db.prepare('UPDATE '+quote(name)+' SET '+q+'=? || substr('+q+', ?) WHERE '+q+'=? OR substr('+q+',1,?)=?').run(to,from.length+1,from,from.length+1,from+path.sep);
   }
  }db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
 }
}
function checkUvcs(c){
 if(!c.dataVersion?.enabled)return;
 if(!fs.existsSync(c.native.home))throw Error('原 UVCS HOME 缺失，不允许静默关闭托管');
 if(!fs.existsSync(path.join(c.dataVersion.dir,'queue.sqlite'))||!fs.existsSync(c.dataVersion.workspace)||!fs.statSync(c.dataVersion.workspace).isDirectory())throw Error('原 UVCS 队列或 workspace 缺失，不允许创建新队列');
 const result=spawnSync(c.dataVersion.cmPath,['version'],{env:{...process.env,HOME:c.native.home},encoding:'utf8',timeout:10000,windowsHide:true});
 if(result.error||result.status!==0)throw Error('原生 UVCS cm 无法运行，迁移已中止');
}
export async function configureNative(o={}){
 if(!['fresh','migrate','existing'].includes(o.mode))throw Error('必须显式指定 mode fresh、migrate 或 existing 模式');
 if(o.requireBrowsers!==undefined&&typeof o.requireBrowsers!=='boolean')throw Error('原生浏览器要求必须为布尔值');
 const releaseRoot=physicalPath(o.releaseRoot),dataRoot=physicalPath(o.dataRoot);
 if(within(dataRoot,releaseRoot)||within(releaseRoot,dataRoot))throw Error('持久数据必须位于可替换 releaseRoot 之外');
 for(const id of moduleIds)if(!fs.existsSync(path.join(releaseRoot,'apps',id,'server.mjs')))throw Error('ERP 程序不完整');
 const targetFile=path.join(dataRoot,'config','web.json');let c;
 if(o.mode==='fresh'){
  if(!o.publicOrigin)throw Error('新建必须配置真实 NAS HTTPS 地址');
  const u=new URL(o.publicOrigin);if(u.protocol!=='https:'||/\.invalid$|\.example\.ts\.net$/.test(u.hostname))throw Error('新建必须配置真实 NAS HTTPS 地址');
  c=developmentConfig({root:releaseRoot,stateDir:path.join(dataRoot,'state')});
  c.publicOrigin=o.publicOrigin;c.mode='production';c.releaseRoot=releaseRoot;c.tcpEnabled=false;
  for(const id of moduleIds)c.modules[id].dataDir=path.join(dataRoot,'data',id);
  c.fnos={enabled:true,instanceId:o.instanceId||randomUUID(),basePrefix:'/app/wuchengerp',socketPath:o.socketPath||path.join(dataRoot,'socket','app.sock'),allowedOrigins:o.allowedOrigins,allowedUids:o.allowedUids};
  c.native={dataRoot,home:path.join(dataRoot,'uvcs-home'),nodePath:process.execPath,...(o.browser?{browser:o.browser}:{})};
  const {validateFnos}=await import('../gateway/fnos.mjs');validateFnos(c.fnos);
  if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('NAS HTTPS 地址必须为源地址');
 }else if(o.mode==='existing'){
  complete(dataRoot);
  return withNativeLifecycleLock(path.join(dataRoot,'state'),async()=>{
   complete(dataRoot);
   const ownership=new DatabaseSync(path.join(dataRoot,'state','native-ownership.sqlite'));
   try{
    try{ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{throw Error('原生 supervisor 正在运行或启动，拒绝配置更新 (ownership)');}
    // Reload and merge only after both lifecycle and generation ownership are held.
    c=JSON.parse(fs.readFileSync(configFileAt(dataRoot),'utf8'));assertStopped(dataRoot);c=rebaseConfig(c,dataRoot,releaseRoot).config;
    if(o.publicOrigin&&c.tcpEnabled===false)c.publicOrigin=o.publicOrigin;
    if(o.allowedOrigins)c.fnos.allowedOrigins=o.allowedOrigins;if(o.allowedUids)c.fnos.allowedUids=o.allowedUids;
    if(o.socketPath)c.fnos.socketPath=physicalPath(o.socketPath);if(o.browser)c.native.browser=o.browser;
    if(o.requireBrowsers!==undefined)c.native.requireBrowsers=o.requireBrowsers;
    if(o.cmPath&&c.dataVersion?.enabled)c.dataVersion.cmPath=physicalPath(o.cmPath);
    c=validateConfig(c);checkUvcs(c);atomicJson(configFileAt(dataRoot),c);return configFileAt(dataRoot);
   }finally{ownership.close();}
  });
 }
 const lock=dataRoot+'.configure-lock';fs.mkdirSync(path.dirname(dataRoot),{recursive:true});fs.mkdirSync(lock);
 const stage=dataRoot+'.staging-'+randomUUID();
 try{
  if(fs.existsSync(dataRoot))throw Error('持久数据目录已存在；请显式使用 existing');fs.mkdirSync(stage,{mode:0o700});
  if(o.mode==='fresh'){
   for(const name of ['state','data','data-version','socket','uvcs-home'])fs.mkdirSync(path.join(stage,name),{mode:0o700});
   const dev=developmentConfig({root:releaseRoot,stateDir:path.join(stage,'state'),port:40000+Math.floor(Math.random()*10000)});
   for(const id of moduleIds)dev.modules[id].dataDir=path.join(stage,'data',id);
   // No gateway: never create development actors, sessions or gateway identity.
   const services=await createSourceServices(dev);try{for(const id of moduleIds)await services.ensure(id);}finally{await services.stopOwned();}
  }else{
   const source=physicalPath(o.sourceRoot);if(within(dataRoot,source)||within(source,dataRoot))throw Error('迁移目标不能覆盖源副本');verifySource(source);
   fs.cpSync(source,stage,{recursive:true,filter:src=>!fs.lstatSync(src).isSocket()});verifySource(source);
   const old=JSON.parse(fs.readFileSync(configFileAt(stage),'utf8')),rebased=rebaseConfig(old,dataRoot,releaseRoot);c=rebased.config;
   if(!c.fnos?.instanceId)throw Error('迁移缺少原飞牛 instanceId，拒绝替换身份');
   c.tcpEnabled??=true;c.fnos.socketPath=o.socketPath||path.join(dataRoot,'socket','app.sock');c.native.browser=o.browser||c.native.browser;
   if(o.cmPath&&c.dataVersion?.enabled)c.dataVersion.cmPath=physicalPath(o.cmPath);
   remapReferences(stage,rebased.maps);
   if(configFileAt(stage)===path.join(stage,'config.json'))fs.unlinkSync(path.join(stage,'config.json'));
  }
  if(o.requireBrowsers!==undefined)c.native.requireBrowsers=o.requireBrowsers;
  fs.mkdirSync(path.join(stage,'socket'),{recursive:true,mode:0o700});integrity(stage);
  validateConfig(remap(c,[[dataRoot,stage]]));if(c.dataVersion?.enabled)checkUvcs(remap(c,[[dataRoot,stage]]));
  atomicJson(path.join(stage,'config','web.json'),c);fs.renameSync(stage,dataRoot);return targetFile;
 }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});fs.rmdirSync(lock);}
}
