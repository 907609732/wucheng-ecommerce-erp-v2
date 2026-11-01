import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {atomicJson} from '../modules/module-manager.mjs';

const ids=['warehouse','purchase','sales','overview','exporter'];
const native=new Set(['warehouse','exporter']);
const volatile=name=>/^(?:\.integration-(?:runtime(?:-cloud)?\.json|start\.lock)|\.workbench-maintenance\.json|server\.pid|Singleton.*|lockfile)$/.test(name)||/-(?:wal|shm)$/.test(name);
const cloudEntries=['workspace','settings.json','secrets.bin','workbench-cloud.sqlite','.integration-key','.workbench-key'];
const exporterEntries=['orders.sqlite','images','logs','proxy-ca','workbench-exports','workbench-migration-files','.integration-key','.workbench-key'];
const fail=(code,message)=>Object.assign(Error(message),{code});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const stringify=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v);
const canonical=x=>stringify((function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;})(x));
const inside=(root,value)=>{const r=path.resolve(root),p=path.resolve(value);return p===r||p.toLowerCase().startsWith((r+path.sep).toLowerCase());};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function checkedAncestor(value){let p=path.resolve(value),existing;for(;;){if(fs.existsSync(p)){if(fs.lstatSync(p).isSymbolicLink())throw fail('UNSAFE_DATA_PATH','迁移路径及父目录不能包含链接');existing??=p;}const parent=path.dirname(p);if(parent===p)break;p=parent;}return existing;}
const alive=pid=>{if(!Number.isInteger(pid))return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const defaultUnifiedDataRoot=()=>path.join(os.homedir(),'Documents','LingtuWorkbench','Data');
function ledger(c,id){return path.join(c.dataDir,id==='warehouse'?'workspace/data/erp.sqlite':id==='exporter'?'orders.sqlite':c.db);}
function filesOf(root,entries){
 const files=[];
 function walk(relative){const file=path.join(root,relative);if(!fs.existsSync(file))return;const s=fs.lstatSync(file);if(s.isSymbolicLink())throw fail('UNSAFE_DATA_PATH','数据目录包含链接，必须先核对实际位置');if(volatile(path.basename(file)))return;if(s.isDirectory()){for(const n of fs.readdirSync(file))walk(path.join(relative,n));}else files.push({relative,bytes:s.size});}
 entries.forEach(walk);return files;
}
function isSQLite(file){const fd=fs.openSync(file,'r');try{const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,0);return b.toString()==='SQLite format 3\0';}finally{fs.closeSync(fd);}}
export function databaseFingerprint(file){
 const db=new DatabaseSync(file,{readOnly:true});try{
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw fail('DATABASE_CORRUPT','账本完整性检查失败');
  const tables={};db.exec('BEGIN');
  for(const {name}of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
   const q='"'+name.replaceAll('"','""')+'"',s=db.prepare('SELECT * FROM '+q);s.setReadBigInts(true);const rows=s.all().map(stringify).sort();tables[name]={count:rows.length,digest:hash(stringify(rows))};
  }
  return tables;
 }finally{db.close();}
}
// Revision counters may advance on an idempotent startup UPDATE. Accept only
// that exact row, with a verified original backup, an unchanged ledger UUID and
// the complete identity key set; business tables are still compared separately.
export function verifiedLedgerRevisionAdvance({beforeFile,afterFile,module,expected,expectedUsage}){
 if(module!=='purchase'||!fs.existsSync(beforeFile))return null;
 const before=new DatabaseSync(beforeFile,{readOnly:true}),after=new DatabaseSync(afterFile,{readOnly:true});
 try{
  const b=before.prepare('SELECT * FROM workbench_identity').all(),a=after.prepare('SELECT * FROM workbench_identity').all();
  if(b.length!==expected?.count||hash(stringify(b.map(stringify).sort()))!==expected.digest||a.length!==b.length||[...a,...b].some(r=>Object.keys(r).length!==2||typeof r.key!=='string'||typeof r.value!=='string'))return null;
  const old=new Map(b.map(r=>[r.key,r.value])),next=new Map(a.map(r=>[r.key,r.value])),key='revision:'+module,ledgerKey='ledger:'+module;
  if(!old.get(ledgerKey)||old.get(ledgerKey)!==next.get(ledgerKey)||!/^\d+$/.test(old.get(key)||'')||!/^\d+$/.test(next.get(key)||'')||BigInt(next.get(key))<=BigInt(old.get(key)))return null;
  if([...old].some(([k,v])=>!next.has(k)||k!==key&&next.get(k)!==v))return null;
  if(!before.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage'").get()||!after.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage'").get())return null;
  const usageRows=db=>{const s=db.prepare('SELECT * FROM usage');s.setReadBigInts(true);return s.all();};
  const usageBefore=usageRows(before),usageAfter=usageRows(after),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(expectedUsage&&(usageBefore.length!==expectedUsage.count||hash(stringify(usageBefore.map(stringify).sort()))!==expectedUsage.digest))return null;
  if([...usageBefore,...usageAfter].some(r=>Object.keys(r).length!==3||typeof r.id!=='bigint'||r.id<1n||typeof r.opens!=='bigint'||r.opens<1n||typeof r.day!=='string'))return null;
  const previousUsage=new Map(usageBefore.map(r=>[r.id,r]));let usageOpenDelta=0n;
  for(const row of usageAfter){const previous=previousUsage.get(row.id);if(previous){if(row.day!==previous.day||row.opens<previous.opens||row.opens!==previous.opens&&row.day!==today)return null;usageOpenDelta+=row.opens-previous.opens;previousUsage.delete(row.id);}else{if(row.day!==today)return null;usageOpenDelta+=row.opens;}}
  if(previousUsage.size||BigInt(usageOpenDelta)!==BigInt(next.get(key))-BigInt(old.get(key)))return null;
  return {key,before:old.get(key),after:next.get(key),ledgerIdentityPreserved:true,explainedByStartupUsage:usageOpenDelta.toString()};
 }finally{before.close();after.close();}
}
function expectedManagedProgram(relative){
 const normalized=relative.replaceAll('\\','/'),extension=/^workspace\/extensions\/lingtu-desks\/(extension\.json|extension\.mjs|service-manager\.mjs)$/.exec(normalized),shared=/^workspace\/shared\/(service-manager\.mjs|workbench-location\.mjs|user-data-path\.mjs)$/.exec(normalized);
 return extension?new URL('../extensions/lingtu-desks/'+extension[1],import.meta.url):shared?new URL('../shared/'+shared[1],import.meta.url):null;
}
function relocated(value,source,target){
 if(typeof value!=='string'||!path.isAbsolute(value)||!inside(source,value))return value;
 return path.join(target,path.relative(source,value));
}
export function rewriteOperationalPaths(file,source,target){
 const changes=[];
 if(/\.(?:sqlite|db)$/i.test(file)&&isSQLite(file)){
  const db=new DatabaseSync(file);
  const allowed={imported_files:['stored_path'],product_images:['stored_path'],inventory_data_validations:['source_file'],warehouse_monthly_sales:['source_file'],warehouse_monthly_sales_validations:['source_file'],imports:['file_path','path'],order_attachments:['file_path','thumb_path'],order_images:['file_path','thumb_path'],freight_attachments:['file_path']};
  try{db.exec('BEGIN IMMEDIATE');for(const [table,columns]of Object.entries(allowed)){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
   const actual=new Set(db.prepare('PRAGMA table_info("'+table+'")').all().map(r=>r.name));
   for(const column of columns){if(!actual.has(column))continue;for(const row of db.prepare('SELECT rowid AS _rowid,"'+column+'" AS value FROM "'+table+'"').all()){
    const value=relocated(row.value,source,target);if(value!==row.value){db.prepare('UPDATE "'+table+'" SET "'+column+'"=? WHERE rowid=?').run(value,row._rowid);changes.push({table,column});}
   }}
  }db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
 }else if(/(?:^|[\\/])(?:settings|config)\.json$/.test(file)){
  const data=read(file);function map(obj){for(const [key,value]of Object.entries(obj)){if(value&&typeof value==='object'&&!Array.isArray(value))map(value);else if(/(?:path|dir|file)$/i.test(key)){const replacement=relocated(value,source,target);if(replacement!==value){obj[key]=replacement;changes.push({setting:key});}}}}map(data);if(changes.length)atomicJson(file,data);
 }
 return changes;
}
export function initializeUnifiedData({services,dataRoot=defaultUnifiedDataRoot(),mode='standalone'}){
 if(mode==='client')return {client:true};
 const registry=fs.existsSync(services.registryFile)?read(services.registryFile):{};let changed=false;
 for(const id of ids){
  const c=services.config(id);if(fs.existsSync(ledger(c,id)))continue;
  if(Object.hasOwn(registry,id)&&c.allowInitialize!==true)throw fail('MISSING_LEDGER','已登记的原账本缺失，不能初始化空账本：'+id);
  const dataDir=path.join(dataRoot,id);if(fs.existsSync(dataDir)&&fs.readdirSync(dataDir).length&&!fs.existsSync(ledger({...c,dataDir},id)))throw fail('UNKNOWN_TARGET_DATA','目标目录包含未登记资料：'+id);
  registry[id]={...c,dataDir,allowInitialize:true};changed=true;
 }
 if(changed)atomicJson(services.registryFile,registry);
 return {dataRoot,changed};
}
export async function previewLocalDataMove({services,dataRoot=defaultUnifiedDataRoot(),backupRoot}){
 if(!backupRoot)throw Error('需要工程外的私有备份目录');
 const targetAncestor=checkedAncestor(dataRoot),backupAncestor=checkedAncestor(backupRoot);
 if(inside(dataRoot,backupRoot)||inside(backupRoot,dataRoot))throw fail('OVERLAPPING_PATHS','备份与统一数据目录不能互相包含');
 const modules=[];
 for(const id of ids){
  const config=services.config(id),source=path.resolve(config.dataDir),target=path.resolve(dataRoot,id);
  checkedAncestor(source);
  if(source===target)throw fail('ALREADY_MOVED','账本已在统一目录，请核对既有迁移记录');
  if(inside(source,dataRoot)||inside(dataRoot,source)||inside(source,backupRoot)||inside(backupRoot,source))throw fail('OVERLAPPING_PATHS','迁移源、目标和备份不能互相包含');
  if(!fs.existsSync(ledger(config,id)))throw fail('MISSING_LEDGER','找不到原账本：'+id);
  if(fs.existsSync(target))throw fail('TARGET_EXISTS','目标已存在，不能覆盖：'+id);
  const entries=id==='warehouse'?cloudEntries:id==='exporter'?exporterEntries:fs.readdirSync(source);
  const files=filesOf(source,entries),cap=await services.capabilities(id);
  if(cap?.busy)throw fail('SERVICE_BUSY','仍有采集、导入或保存任务：'+id);
  if(fs.existsSync(path.join(source,'.workbench-maintenance.json')))throw fail('MAINTENANCE_OWNED','原账本已有维护窗口：'+id);
  modules.push({id,source,target,config,files,bytes:files.reduce((n,f)=>n+f.bytes,0),wasRunning:!!cap&&(native.has(id)?!!cap.running:true)});
 }
 const bytes=modules.reduce((n,m)=>n+m.bytes,0);
 const targetStat=fs.statfsSync(targetAncestor),backupStat=fs.statfsSync(backupAncestor),sameVolume=fs.statSync(targetAncestor).dev===fs.statSync(backupAncestor).dev;
 if(targetStat.bavail*targetStat.bsize<bytes*(sameVolume?2:1)+512*1024*1024||!sameVolume&&backupStat.bavail*backupStat.bsize<bytes+512*1024*1024)throw fail('INSUFFICIENT_SPACE','数据或备份磁盘可用空间不足');
 return {schemaVersion:1,id:crypto.randomUUID(),dataRoot:path.resolve(dataRoot),backupRoot:path.resolve(backupRoot),registryFile:services.registryFile,modules,bytes,createdAt:new Date().toISOString()};
}
async function stopAll(services,plan){
 for(const m of plan.modules){const cap=await services.capabilities(m.id);if(cap?.busy)throw fail('SERVICE_BUSY','任务在迁移前发生变化：'+m.id);}
 for(const m of plan.modules){
  const marker=path.join(m.source,'.workbench-maintenance.json');fs.writeFileSync(marker,JSON.stringify({migrationId:plan.id,actor:'local-data-move',maintenance:true}),{flag:'wx',mode:0o600});
 }
 const registry=read(plan.registryFile);for(const m of plan.modules)registry[m.id]={...m.config,maintenance:true};atomicJson(plan.registryFile,registry);
 for(const m of plan.modules){
  const cap=await services.capabilities(m.id);await services.stop(m.id);
  for(let i=0;i<150;i++){
   const now=await services.capabilities(m.id);if((!now||!now.url||now.running===false)&&!alive(cap?.pid))break;
   if(i===149)throw fail('STOP_TIMEOUT','进程尚未停止，不能复制账本：'+m.id);await sleep(100);
  }
 }
}
export async function stageLocalDataMove({services,plan,onProgress=()=>{}}){
 const directory=path.join(plan.backupRoot,'data-move-'+plan.id),journalFile=path.join(directory,'journal.json');
 fs.mkdirSync(directory,{recursive:false});
 const registryBefore=fs.readFileSync(plan.registryFile);fs.writeFileSync(path.join(directory,'registry.before.json'),registryBefore,{mode:0o600});
 const journal={...plan,directory,journalFile,phase:'quiescing',snapshots:[],registryBeforeHash:hash(registryBefore)};atomicJson(journalFile,journal);
 try{
  await stopAll(services,plan);journal.phase='copying';atomicJson(journalFile,journal);
  for(const m of plan.modules){
   const saved=path.join(directory,m.id),candidate=path.join(plan.dataRoot,'.candidate-'+plan.id,m.id);fs.mkdirSync(saved,{recursive:true});fs.mkdirSync(candidate,{recursive:true});
   const snapshot={id:m.id,source:m.source,target:m.target,candidate,files:[],databases:[]};
   // Enumerate again only after all writes and browser processes have stopped.
   const entries=m.id==='warehouse'?cloudEntries:m.id==='exporter'?exporterEntries:fs.readdirSync(m.source);
   for(const f of filesOf(m.source,entries)){
    const source=path.join(m.source,f.relative),dest=path.join(saved,f.relative),copy=path.join(candidate,f.relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.mkdirSync(path.dirname(copy),{recursive:true});
    if(/\.(?:sqlite|db)$/i.test(f.relative)&&isSQLite(source)){
     const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,dest);}finally{db.close();}
     const before=databaseFingerprint(source),after=databaseFingerprint(dest);if(stringify(before)!==stringify(after))throw fail('COPY_MISMATCH','数据库备份核对失败');
     snapshot.databases.push({relative:f.relative,tables:before});
    }else{const sourceHash=hash(fs.readFileSync(source));fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL);if(hash(fs.readFileSync(source))!==sourceHash||hash(fs.readFileSync(dest))!==sourceHash)throw fail('SOURCE_CHANGED','原文件在备份时发生变化或复制损坏');}
    fs.copyFileSync(dest,copy,fs.constants.COPYFILE_EXCL);const digest=hash(fs.readFileSync(dest));if(hash(fs.readFileSync(copy))!==digest)throw fail('COPY_MISMATCH','文件复制核对失败');
    const changes=rewriteOperationalPaths(copy,m.source,m.target);if(changes.length){snapshot.pathChanges??=[];snapshot.pathChanges.push({relative:f.relative,changes});const d=snapshot.databases.find(d=>d.relative===f.relative);if(d)d.tables=databaseFingerprint(copy);}
    snapshot.files.push({relative:f.relative,bytes:fs.statSync(copy).size,sha256:hash(fs.readFileSync(copy)),sourceSha256:digest});
   }
   journal.snapshots.push(snapshot);atomicJson(journalFile,journal);onProgress({id:m.id,phase:'copied',files:snapshot.files.length});
  }
  journal.phase='switching';atomicJson(journalFile,journal);
  for(const m of plan.modules){if(fs.existsSync(m.target))throw fail('TARGET_EXISTS','切换前发现目标目录冲突');fs.renameSync(path.join(plan.dataRoot,'.candidate-'+plan.id,m.id),m.target);}
  const registry=JSON.parse(registryBefore);
  for(const m of plan.modules)registry[m.id]={...m.config,dataDir:m.target,allowInitialize:false,maintenance:true,...(native.has(m.id)?{authProfileDir:m.config.authProfileDir||m.source}:{}),legacyProfiles:[...new Set([...(m.config.legacyProfiles||[]),hash(JSON.stringify(m.source.toLowerCase()))])],dataMoveId:plan.id,dataMoveJournal:journalFile};
  atomicJson(plan.registryFile,registry);journal.registrySwitchedHash=hash(fs.readFileSync(plan.registryFile));journal.phase='awaiting-activation';atomicJson(journalFile,journal);
  return {journalFile,phase:journal.phase,modules:plan.modules.map(m=>m.id)};
 }catch(error){journal.error={code:error.code||'MOVE_FAILED',message:error.message};journal.phase='failed';atomicJson(journalFile,journal);throw Object.assign(error,{journalFile});}
}
export function verifyLocalDataMove(journalFile,{afterActivation=false}={}){
 const journal=read(journalFile),differences=[],revisionAdvances=[],managedProgramUpdates=[];
 if(!['awaiting-activation','verified','completed'].includes(journal.phase)||journal.snapshots?.length!==5||new Set(journal.snapshots.map(s=>s.id)).size!==5||ids.some(id=>!journal.snapshots.some(s=>s.id===id)))throw fail('INCOMPLETE_MOVE','迁移没有五个完整数据快照，不能报告核对通过');
 for(const s of journal.snapshots){const m=journal.modules.find(m=>m.id===s.id),primary=path.relative(m.source,ledger(m.config,m.id));if(!s.databases.some(d=>d.relative===primary)||s.target!==m.target)throw fail('INCOMPLETE_MOVE','迁移缺少原主账本或目标不符');}
 for(const snapshot of journal.snapshots){
  for(const d of snapshot.databases){const after=databaseFingerprint(path.join(snapshot.target,d.relative));for(const [table,value]of Object.entries(d.tables)){
   if(afterActivation&&['usage','launches','mobile_sessions','meta','workbench_sessions','workbench_audit'].includes(table))continue;
   if(stringify(after[table])!==stringify(value)){
    const advance=afterActivation&&table==='workbench_identity'?verifiedLedgerRevisionAdvance({beforeFile:path.join(journal.directory,snapshot.id,d.relative),afterFile:path.join(snapshot.target,d.relative),module:snapshot.id,expected:value,expectedUsage:d.tables.usage}):null;
    if(advance)revisionAdvances.push({id:snapshot.id,database:d.relative,...advance});else differences.push({id:snapshot.id,database:d.relative,table});
   }
  }}
  for(const f of snapshot.files){if(snapshot.databases.some(d=>d.relative===f.relative))continue;if(afterActivation&&(/(?:^|[\\/])(?:logs?|reports|staging|state|backups)(?:[\\/]|$)|\.(?:log|pid)$/.test(f.relative)||['settings.json'].includes(f.relative)))continue;
   const file=path.join(snapshot.target,f.relative);if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==f.sha256){
    const expected=afterActivation&&snapshot.id==='warehouse'?expectedManagedProgram(f.relative):null;
    if(expected&&fs.existsSync(file)&&!fs.lstatSync(file).isSymbolicLink()&&fs.statSync(file).isFile()&&hash(fs.readFileSync(file))===hash(fs.readFileSync(expected)))managedProgramUpdates.push({id:snapshot.id,file:f.relative,matchesBundledProgram:true});else differences.push({id:snapshot.id,file:f.relative});
   }
  }
 }
 if(differences.length)throw Object.assign(fail('VERIFICATION_FAILED','迁移核对存在差异，保持维护状态'),{differences});
 return {ok:true,modules:journal.snapshots.length,databases:journal.snapshots.reduce((n,s)=>n+s.databases.length,0),files:journal.snapshots.reduce((n,s)=>n+s.files.length,0),revisionAdvances,managedProgramUpdates};
}
export function completeLocalDataMove(journalFile){
 const journal=read(journalFile);if(journal.phase!=='verified')throw fail('INVALID_PHASE','须在维护状态完成核对后才能开放使用');
 const result=journal.verification,registry=read(journal.registryFile);
 for(const m of journal.modules){if(path.resolve(registry[m.id]?.dataDir||'')!==m.target||registry[m.id].maintenance)throw fail('NOT_ACTIVATED','新组件未完成整体健康检查：'+m.id);}
 journal.phase='completed';journal.completedAt=new Date().toISOString();journal.verification=result;atomicJson(journalFile,journal);return result;
}
export function pendingLocalDataMoves(services,{verificationOnly=false}={}){return [...new Set(ids.map(id=>services.config(id).dataMoveJournal).filter(Boolean))].filter(file=>{const phase=read(file).phase;return phase!=='completed'&&(!verificationOnly||phase!=='verified');});}
export function verifyPendingLocalDataMoves(services,{beforeCommit=()=>{}}={}){
 for(const file of pendingLocalDataMoves(services)){const journal=read(file);
  // Verification is a durable pre-release boundary. A later retry may follow
  // legitimate edits while originally running services are being restored;
  // never compare those new edits against the old migration snapshot again.
  if(journal.phase==='verified')continue;
  for(const m of journal.modules){const c=services.config(m.id);if(c.dataMoveId!==journal.id||path.resolve(c.dataDir)!==m.target||!c.maintenance)throw fail('MOVE_OWNERSHIP_CHANGED','迁移绑定或维护锁发生变化');}
  const result=verifyLocalDataMove(file,{afterActivation:true});beforeCommit();journal.phase='verified';journal.verification=result;journal.verifiedAt=new Date().toISOString();atomicJson(file,journal);
 }return {ok:true};
}
// Internal launcher hook: the fixed same-package worker keeps full ledger/file
// scans off Electron's UI thread. No renderer/CLI may select a worker entry.
export async function verifyPendingLocalDataMovesAsync(services,{timeoutMs=120000}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>600000)throw fail('INVALID_VERIFICATION_TIMEOUT','核对超时配置无效');
 if(pendingLocalDataMoves(services,{verificationOnly:true}).length===0)return {ok:true};
 const registryFile=path.resolve(services.registryFile),registryBytes=await fs.promises.readFile(registryFile),registrySha256=hash(registryBytes);
 const version=JSON.parse(await fs.promises.readFile(new URL('../launcher/package.json',import.meta.url),'utf8')).version;
 const entry=fileURLToPath(new URL('./verify-pending-entry.mjs',import.meta.url));
 let result;
 try{result=await promisify(execFile)(process.execPath,[entry,registryFile,registrySha256,version],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8',timeout:timeoutMs,maxBuffer:1024*1024});}
 catch(error){
  let receipt;try{receipt=JSON.parse(error.stdout||'');}catch{}
  if(receipt?.protocol==='lingtu-pending-verification/v1'&&receipt.ok===false)throw Object.assign(fail(receipt.code||'VERIFICATION_FAILED',receipt.error||'迁移核对失败，业务保持维护状态'),{differences:receipt.differences});
  throw fail('VERIFICATION_WORKER_FAILED',error.killed?'迁移核对超时，业务保持维护状态':'迁移核对进程未完成，业务保持维护状态');
 }
 let receipt;try{receipt=JSON.parse(result.stdout);}catch{throw fail('INVALID_VERIFICATION_RECEIPT','迁移核对回执无效，业务保持维护状态');}
 if(receipt.protocol!=='lingtu-pending-verification/v1'||receipt.ok!==true||receipt.version!==version||receipt.registrySha256!==registrySha256)throw fail('INVALID_VERIFICATION_RECEIPT','迁移核对版本或注册表回执不符');
 if(hash(await fs.promises.readFile(registryFile))!==registrySha256)throw fail('MOVE_OWNERSHIP_CHANGED','核对期间注册表发生变化，业务保持维护状态');
 return {ok:true};
}
export async function finishVerifiedLocalDataMoves(services){
 const results=[];
 for(const file of pendingLocalDataMoves(services)){
  const journal=read(file);if(journal.phase!=='verified')throw fail('INVALID_PHASE','数据尚未完成维护状态核对');
  for(const m of journal.modules){const c=services.config(m.id);if(c.dataMoveId!==journal.id||path.resolve(c.dataDir)!==m.target||c.maintenance)throw fail('NOT_ACTIVATED','迁移绑定改变或组件尚未整体放行：'+m.id);}
  const restored=[];
  for(const m of journal.modules.filter(m=>m.wasRunning)){
   let cap=await services.capabilities(m.id);
   for(let i=0;cap?.stopping&&i<150;i++){await sleep(100);cap=await services.capabilities(m.id);}
   if(cap?.stopping)throw fail('STOP_TIMEOUT','功能仍在退出，请稍后恢复工作台');
   await services.ensure(m.id);restored.push(m.id);
  }
  results.push({...completeLocalDataMove(file),restoredOriginallyRunning:restored});
 }return results;
}
export function rollbackLocalDataMove(journalFile){
 const journal=read(journalFile);if(['verified','completed'].includes(journal.phase))throw fail('POST_WRITE_ROLLBACK_FORBIDDEN','本批已允许业务写入，不能整库回退覆盖后续编辑');
 const current=read(journal.registryFile);if(journal.modules.some(m=>current[m.id]?.dataDir===m.target&&!current[m.id]?.maintenance))throw fail('POST_WRITE_ROLLBACK_FORBIDDEN','候选已开放业务写入，不能整库回退');
 if(journal.registrySwitchedHash&&hash(fs.readFileSync(journal.registryFile))!==journal.registrySwitchedHash)throw fail('REGISTRY_CHANGED','注册表已有后续变更，不能覆盖；请保留维护状态核对');
 for(const m of journal.modules)for(const name of ['.integration-runtime.json','.integration-runtime-cloud.json']){const f=path.join(m.target,name);if(fs.existsSync(f)&&alive(read(f).pid))throw fail('SERVICE_RUNNING','必须先正常停止候选服务才能恢复路径');}
 const before=fs.readFileSync(path.join(journal.directory,'registry.before.json'));if(hash(before)!==journal.registryBeforeHash)throw fail('BACKUP_CHANGED','原注册表备份已改变');
 if(!journal.registrySwitchedHash){const quiesced=JSON.parse(before);for(const m of journal.modules)quiesced[m.id]={...m.config,maintenance:true};if(canonical(current)!==canonical(quiesced)&&canonical(current)!==canonical(JSON.parse(before)))throw fail('REGISTRY_CHANGED','维护准备后注册表发生外部变更，不能覆盖');}
 for(const m of journal.modules){const marker=path.join(m.source,'.workbench-maintenance.json');if(fs.existsSync(marker)&&read(marker).migrationId===journal.id)fs.unlinkSync(marker);}
 fs.writeFileSync(journal.registryFile+'.rollback',before);fs.renameSync(journal.registryFile+'.rollback',journal.registryFile);journal.phase='rolled-back';atomicJson(journalFile,journal);return {ok:true,retainedCandidateData:true};
}
