import {trustedIdentity,metadataFingerprint,assertNativeUvcsPrepared,markNativeUvcsPending,prepareNativeUvcs,nativeCm,resolveNativeCmPath} from './uvcs-registration.mjs';
import {resolveStoredFile} from '../../shared/stored-file.mjs';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {developmentConfig,validateConfig,moduleIds,databases} from '../config.mjs';
import {createSourceServices} from '../services.mjs';
import {DATA_VERSION_POLICY,embeddedBusinessFiles,quoteIdentifier as quote} from '../../shared/data-version-policy.mjs';

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
 const lock=new DatabaseSync(physicalPath(path.join(stateDir,'native-lifecycle.sqlite'))),until=Date.now()+timeoutMs;
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
 const sourceConfig=JSON.parse(fs.readFileSync(configFileAt(sourceRoot),'utf8'));
 const workspaceIdentity=sourceConfig.dataVersion?.enabled?assertNativeUvcsPrepared(sourceConfig).identity:undefined;
 const before=tree(sourceRoot),stage=target+'.staging-'+randomUUID();
 try{
  fs.cpSync(sourceRoot,stage,{recursive:true,filter:src=>!fs.lstatSync(src).isSocket()});
  assertStopped(sourceRoot);if(JSON.stringify(before)!==JSON.stringify(tree(sourceRoot)))throw Error('停写备份过程中源目录变化');
  integrity(stage);await sealStoppedSource(stage,{workspaceIdentity});fs.renameSync(stage,target);
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
function restoreStagedDatabaseModes(stage){
 // A working SQLite database needs owner-write even when its sealed input was
 // readonly. Never apply this to originals, snapshots, backups or existing DATA.
 const active=[...moduleIds.map(id=>path.join('data',id,databases[id])),
  'state/gateway/gateway.sqlite','state/gateway/gateway-ownership.sqlite',
  'state/month-admin/month-admin.sqlite','state/native-lifecycle.sqlite',
  'state/native-ownership.sqlite','data-version/queue.sqlite'];
 for(const relative of active)for(const suffix of ['','-wal','-shm','-journal']){
  const file=physicalPath(path.join(stage,relative+suffix));let before;
  try{before=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const owned=st=>st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(process.platform==='win32'||st.uid===process.getuid());
  const same=st=>owned(st)&&st.dev===before.dev&&st.ino===before.ino&&st.size===before.size&&st.mtimeMs===before.mtimeMs;
  if(!owned(before))throw Error('迁移活动 SQLite 必须为当前用户独占的普通文件：'+relative+suffix);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
   if(!same(fs.fstatSync(fd))||!same(fs.lstatSync(file)))throw Error('迁移活动 SQLite inode 已改变');
   fs.fchmodSync(fd,0o600);
   if(!same(fs.fstatSync(fd))||!same(fs.lstatSync(file)))throw Error('迁移活动 SQLite inode 已改变');
  }finally{fs.closeSync(fd);}
 }
}
function integrity(root){for(const entry of tree(root).filter(e=>e.path.endsWith('.sqlite'))){
 const db=new DatabaseSync(path.join(root,entry.path),{readOnly:true});
 try{if(db.prepare('PRAGMA integrity_check').all().some(row=>Object.values(row)[0]!=='ok'))throw Error('账本完整性校验失败：'+entry.path);}finally{db.close();}
}}
export async function sealStoppedSource(sourceRoot,{workspaceIdentity}={}){
 sourceRoot=physicalPath(sourceRoot);complete(sourceRoot);assertStopped(sourceRoot);
 const sourceConfig=JSON.parse(fs.readFileSync(configFileAt(sourceRoot),'utf8')),rebased=rebaseConfig(sourceConfig,sourceRoot,sourceConfig.releaseRoot).config;
 let uvcs;
 if(sourceConfig.dataVersion?.enabled){
  const identity=trustedIdentity(workspaceIdentity||assertNativeUvcsPrepared(sourceConfig)?.identity,sourceConfig.dataVersion.repository);
  uvcs={identity,metadataSha256:metadataFingerprint(rebased.dataVersion.workspace)};
 }
 const files=tree(sourceRoot),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'erp-seal-'));
 try{
  // SQLite WAL recovery/checking occurs exclusively on a disposable copy.
  fs.cpSync(sourceRoot,temporary,{recursive:true,filter:src=>!fs.lstatSync(src).isSocket()});integrity(temporary);
  assertStopped(sourceRoot);if(JSON.stringify(files)!==JSON.stringify(tree(sourceRoot)))throw Error('源副本在校验时变化');
  atomicJson(path.join(sourceRoot,'migration-manifest.json'),{schemaVersion:1,stopped:true,files,...(uvcs?{uvcs}:{})});
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
 // Platform VAR is independent of the migrated financial data root.
 if(old.native?.runtimeDir!==undefined)c.native.runtimeDir=old.native.runtimeDir;
 c.releaseRoot=releaseRoot;c.stateDir=path.join(root,'state');c.mode='production';
 for(const id of moduleIds){c.modules[id].root=path.join(releaseRoot,'apps',id);c.modules[id].dataDir=path.join(root,'data',id);}
 delete c.windowsService;c.native={...c.native,dataRoot:root,home:path.join(root,'uvcs-home'),nodePath:process.execPath};return {config:c,maps};
}
function validateReferences(root){
 // Reading the owning applications' reviewed file columns never changes business
 // rows, triggers, locks, outbox events or historical snapshots.
 for(const id of moduleIds){
  const dir=path.join(root,'data',id),db=new DatabaseSync(path.join(dir,databases[id]),{readOnly:true});
  const check=(value,label,expected={})=>{
   if(value===null||value===undefined||value==='')return;
   let file;try{file=resolveStoredFile(dir,value).file;}catch{throw Error(id+' '+label+' 原件引用路径无效或文件缺失');}
   if(expected.sha256&&digest(file)!==expected.sha256||expected.bytes!==undefined&&fs.statSync(file).size!==expected.bytes)throw Error(id+' '+label+' 原件引用校验失败');
  };
  try{
   const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
   const columns={...DATA_VERSION_POLICY[id].files,workbench_migration_evidence_files:['local_path']};
   for(const [table,names]of Object.entries(columns))if(tables.has(table))for(const row of db.prepare('SELECT * FROM '+quote(table)).iterate())for(const name of names)check(row[name],table+'.'+name);
   if(id==='sales'&&tables.has('platform_references'))for(const row of db.prepare('SELECT payload FROM platform_references').iterate())check(JSON.parse(row.payload).evidence_path,'platform_references.payload.evidence_path');
   if(id==='overview'&&tables.has('payments'))for(const row of db.prepare('SELECT payload FROM payments').iterate())for(const ref of embeddedBusinessFiles(id,'payments',row))check(ref.path,'payments.payload.evidence',ref);
  }finally{db.close();}
 }
}
async function checkUvcs(c){
 if(!c.dataVersion?.enabled)return;
 if(!fs.existsSync(c.native.home))throw Error('原 UVCS HOME 缺失，不允许静默关闭托管');
 if(!fs.existsSync(path.join(c.dataVersion.dir,'queue.sqlite'))||!fs.existsSync(c.dataVersion.workspace)||!fs.statSync(c.dataVersion.workspace).isDirectory())throw Error('原 UVCS 队列或 workspace 缺失，不允许创建新队列');
 c.dataVersion.cmPath=resolveNativeCmPath(c.dataVersion.cmPath,{allowSymlink:true});
 await nativeCm(c,{timeoutMs:10000}).version();
}
const trialBasePrefix='/app/wuchengerptrial';
const trialGatewayPort=29430;

export async function configureNative(o={}){
 if(!['fresh','migrate','existing'].includes(o.mode))throw Error('必须显式指定 mode fresh、migrate 或 existing 模式');
 if(o.basePrefix!==undefined&&!['/app/wuchengerp','/app/wuchengerptrial'].includes(o.basePrefix))throw Error('原生应用前缀仅允许受控主包或试装前缀');
 if(o.entry!==undefined&&!['fnos','tailscale'].includes(o.entry))throw Error('入口必须为 fnos 或 tailscale');
 if(o.requireBrowsers!==undefined&&typeof o.requireBrowsers!=='boolean')throw Error('原生浏览器要求必须为布尔值');
 const releaseRoot=physicalPath(o.releaseRoot),dataRoot=physicalPath(o.dataRoot);
 if(within(dataRoot,releaseRoot)||within(releaseRoot,dataRoot))throw Error('持久数据必须位于可替换 releaseRoot 之外');
 for(const id of moduleIds)if(!fs.existsSync(path.join(releaseRoot,'apps',id,'server.mjs')))throw Error('ERP 程序不完整');
 const targetFile=path.join(dataRoot,'config','web.json');let c;
 if(o.mode==='fresh'){
  const tailscale=o.entry==='tailscale';
  if(!o.publicOrigin)throw Error('新建必须配置真实 HTTPS 地址');
  const u=new URL(o.publicOrigin);if(u.protocol!=='https:'||/\.invalid$|\.example\.ts\.net$/.test(u.hostname))throw Error('新建必须配置真实 HTTPS 地址');
  c=developmentConfig({root:releaseRoot,stateDir:path.join(dataRoot,'state'),port:o.basePrefix===trialBasePrefix?trialGatewayPort:undefined});
  c.publicOrigin=u.origin;c.mode='production';c.releaseRoot=releaseRoot;c.tcpEnabled=tailscale;
  for(const id of moduleIds)c.modules[id].dataDir=path.join(dataRoot,'data',id);
  const allowedOrigins=Array.isArray(o.allowedOrigins)?[...new Set([...o.allowedOrigins,u.origin])]:o.allowedOrigins;
  c.fnos=tailscale?{enabled:false}:{enabled:true,instanceId:o.instanceId||randomUUID(),basePrefix:o.basePrefix||'/app/wuchengerp',socketPath:o.socketPath||path.join(dataRoot,'socket','app.sock'),allowedOrigins,allowedUids:o.allowedUids,accessPolicy:o.accessPolicy,hostAliases:{localhost:u.origin}};
  c.native={dataRoot,home:path.join(dataRoot,'uvcs-home'),nodePath:process.execPath,...(o.browser?{browser:o.browser}:{}),...(o.requireBrowsers!==undefined?{requireBrowsers:o.requireBrowsers}:{}),...(o.runtimeDir!==undefined?{runtimeDir:physicalPath(o.runtimeDir)}:{})};
  const {validateFnos}=await import('../gateway/fnos.mjs');validateFnos(c.fnos);
  if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('HTTPS 地址必须为源地址');
 }else if(o.mode==='existing'){
  complete(dataRoot);
  return withNativeLifecycleLock(path.join(dataRoot,'state'),async()=>{
   complete(dataRoot);
   const ownership=new DatabaseSync(path.join(dataRoot,'state','native-ownership.sqlite'));
   try{
    try{ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{throw Error('原生 supervisor 正在运行或启动，拒绝配置更新 (ownership)');}
    // Reload and merge only after both lifecycle and generation ownership are held.
    c=JSON.parse(fs.readFileSync(configFileAt(dataRoot),'utf8'));assertStopped(dataRoot);c=rebaseConfig(c,dataRoot,releaseRoot).config;
    if(o.basePrefix!==undefined&&c.fnos?.enabled&&o.basePrefix!==c.fnos.basePrefix)throw Error('existing 模式不能通过前缀变更既有身份');
    if(o.entry!==undefined&&((o.entry==='tailscale')===Boolean(c.fnos?.enabled)))throw Error('existing 模式不能切换现有身份入口');
    // Early trial builds inherited the formal module ports. Move only that
    // exact default layout, while holding both existing lifecycle locks.
    if(c.fnos?.basePrefix===trialBasePrefix&&c.port===28430&&
       moduleIds.every((id,index)=>c.modules[id].port===28431+index)&&c.modules.purchase.mobilePort===28434){
     const trial=developmentConfig({root:releaseRoot,stateDir:c.stateDir,port:trialGatewayPort});
     c.port=trial.port;
     for(const id of moduleIds)c.modules[id].port=trial.modules[id].port;
     c.modules.purchase.mobilePort=trial.modules.purchase.mobilePort;
    }
    if(o.allowedOrigins)c.fnos.allowedOrigins=o.allowedOrigins;if(o.allowedUids)c.fnos.allowedUids=o.allowedUids;
    if(o.accessPolicy!==undefined&&c.fnos?.enabled)c.fnos.accessPolicy=o.accessPolicy;
    if(o.publicOrigin&&c.tcpEnabled===false){
     const u=new URL(o.publicOrigin);
     if(u.protocol!=='https:'||/\.invalid$|\.example\.ts\.net$/.test(u.hostname))throw Error('必须配置真实 NAS HTTPS 地址');
     if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('NAS HTTPS 地址必须为源地址');
     // Only the fresh-install primary binding is managed here. Preserve other
     // explicit aliases, including a localhost alias for a different entry.
     if(c.fnos.hostAliases?.localhost===new URL(c.publicOrigin).origin)c.fnos.hostAliases.localhost=u.origin;
     c.publicOrigin=u.origin;
     if(Array.isArray(c.fnos.allowedOrigins))c.fnos.allowedOrigins=[...new Set([...c.fnos.allowedOrigins,u.origin])];
    }
    if(o.socketPath)c.fnos.socketPath=physicalPath(o.socketPath);if(o.browser)c.native.browser=o.browser;
    if(o.requireBrowsers!==undefined)c.native.requireBrowsers=o.requireBrowsers;
    if(o.runtimeDir!==undefined)c.native.runtimeDir=physicalPath(o.runtimeDir);
    if(o.cmPath&&c.dataVersion?.enabled)c.dataVersion.cmPath=resolveNativeCmPath(o.cmPath,{allowSymlink:true});
    c=validateConfig(c);await checkUvcs(c);await prepareNativeUvcs(c);atomicJson(configFileAt(dataRoot),c);return configFileAt(dataRoot);
   }finally{ownership.close();}
  });
 }
 const lock=physicalPath(dataRoot+'.configure-state');fs.mkdirSync(lock,{recursive:true,mode:0o700});
 const lockStat=fs.statSync(lock);
 if(!lockStat.isDirectory()||process.platform!=='win32'&&(lockStat.uid!==process.getuid()||(lockStat.mode&0o077)))throw Error('初始化锁目录必须由当前用户私有持有');
 return withNativeLifecycleLock(lock,async()=>{
 const stage=dataRoot+'.staging-'+randomUUID();
 try{
  if(fs.existsSync(dataRoot))throw Error('持久数据目录已存在；请显式使用 existing');fs.mkdirSync(stage,{mode:0o700});
  if(o.mode==='fresh'){
   for(const name of ['state','data','data-version','socket','uvcs-home'])fs.mkdirSync(path.join(stage,name),{mode:0o700});
   const dev=developmentConfig({root:releaseRoot,stateDir:path.join(stage,'state')}),reservations=new Map();
   const release=sockets=>Promise.all(sockets.map(socket=>new Promise(resolve=>socket.close(resolve))));
   try{
    for(const id of moduleIds){
     const module=dev.modules[id],sockets=[];reservations.set(id,sockets);module.dataDir=path.join(stage,'data',id);
     // Match both business HTTP and purchase mobile's actual loopback bind.
     // Hold distinct OS-assigned ports until the owning module is about to start.
     for(const key of id==='purchase'?['port','mobilePort']:['port']){
      const socket=net.createServer(connection=>connection.destroy());sockets.push(socket);
      await new Promise((resolve,reject)=>socket.once('error',reject).listen({port:0,host:'127.0.0.1',exclusive:true},resolve));
      module[key]=socket.address().port;
     }
    }
    // No gateway or changes to the final config. The existing foreign-port
    // guards still fail closed if another process wins the release/start gap.
    const services=await createSourceServices(dev);
    try{for(const id of moduleIds){await release(reservations.get(id));await services.ensure(id);}}finally{await services.stopOwned();}
   }finally{await release([...reservations.values()].flat());}
  }else{
   const source=physicalPath(o.sourceRoot);if(within(dataRoot,source)||within(source,dataRoot))throw Error('迁移目标不能覆盖源副本');const manifest=verifySource(source);
   fs.cpSync(source,stage,{recursive:true,filter:src=>!fs.lstatSync(src).isSocket()});verifySource(source);
   restoreStagedDatabaseModes(stage);
   const old=JSON.parse(fs.readFileSync(configFileAt(stage),'utf8')),rebased=rebaseConfig(old,dataRoot,releaseRoot);c=rebased.config;
   if(o.basePrefix!==undefined&&c.fnos?.enabled&&o.basePrefix!==c.fnos.basePrefix)throw Error('migrate 模式不能通过前缀变更既有身份');
   if(c.dataVersion?.enabled){c.native.uvcsIdentity=trustedIdentity(manifest.uvcs?.identity,c.dataVersion.repository);c.native.uvcsSourceMetadataHash=manifest.uvcs?.metadataSha256;if(metadataFingerprint(path.join(stage,path.relative(dataRoot,c.dataVersion.workspace)))!==c.native.uvcsSourceMetadataHash)throw Error('UVCS_METADATA_CHANGED');markNativeUvcsPending(c,path.join(stage,'state'));}
   if(o.entry!==undefined&&((o.entry==='tailscale')===Boolean(c.fnos?.enabled)))throw Error('迁移源与目标身份入口不同，拒绝切换');
   if(c.fnos?.enabled&&!c.fnos.instanceId)throw Error('迁移缺少原飞牛 instanceId，拒绝替换身份');
   if(o.accessPolicy!==undefined&&c.fnos?.enabled)c.fnos.accessPolicy=o.accessPolicy;
   c.tcpEnabled??=true;c.fnos.socketPath=o.socketPath||path.join(dataRoot,'socket','app.sock');c.native.browser=o.browser||c.native.browser;
   if(o.cmPath&&c.dataVersion?.enabled)c.dataVersion.cmPath=resolveNativeCmPath(o.cmPath,{allowSymlink:true});
   validateReferences(stage);
   if(configFileAt(stage)===path.join(stage,'config.json'))fs.unlinkSync(path.join(stage,'config.json'));
  }
  if(o.requireBrowsers!==undefined)c.native.requireBrowsers=o.requireBrowsers;
  if(o.runtimeDir!==undefined)c.native.runtimeDir=physicalPath(o.runtimeDir);
  fs.mkdirSync(path.join(stage,'socket'),{recursive:true,mode:0o700});integrity(stage);
  validateConfig(remap(c,[[dataRoot,stage]]));if(c.dataVersion?.enabled){c.dataVersion.cmPath=resolveNativeCmPath(c.dataVersion.cmPath,{allowSymlink:true});await checkUvcs(remap(c,[[dataRoot,stage]]));}
  atomicJson(path.join(stage,'config','web.json'),c);fs.renameSync(stage,dataRoot);
  // Registration must see the published physical path, never its staging name.
  // Failure intentionally retains the complete ledger and pending marker.
  await prepareNativeUvcs(c);return targetFile;
 }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
 });
}
