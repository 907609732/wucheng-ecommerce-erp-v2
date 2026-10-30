import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';
import {validatePolicy} from '../workbench/policy.mjs';
import {createBackupRecovery} from './backup-recovery.mjs';

const modules = ['warehouse','purchase','sales','overview','exporter'];
const primary = {warehouse:'workspace/data/erp.sqlite',purchase:'purchases.sqlite',sales:'sales.sqlite',overview:'overview.sqlite',exporter:'orders.sqlite'};
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function fileHash(file) { const h=crypto.createHash('sha256'), fd=fs.openSync(file,'r'), b=Buffer.alloc(1024*1024); try { let n; while ((n=fs.readSync(fd,b,0,b.length,null))>0) h.update(b.subarray(0,n)); return h.digest('hex'); } finally { fs.closeSync(fd); } }
function noLinks(file) { let p=path.parse(file).root; for(const part of file.slice(p.length).split(path.sep).filter(Boolean)){p=path.join(p,part);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('备份路径包含链接');} }
function within(root,file) { const r=path.relative(root,file); return !!r && r!=='..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r); }
function inventory(root) { const entries=[]; function visit(dir){ for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name), rel=path.relative(root,f).replaceAll('\\','/'); if(e.isSymbolicLink())throw Error('数据目录包含链接'); if(/(^|\/)(?:Partitions|Network|Cookies|Cache|logs?|backups?|node_modules|profiles?|auth|login|session)(\/|$)|(^|\/)(?:secrets\.bin|\.env[^/]*|\.workbench-key|.*token.*|.*credentials.*)(\/|$)/i.test(rel))continue; if(e.isDirectory()){visit(f);continue;} if(!e.isFile())throw Error('数据目录包含不支持的文件'); if(/-(?:wal|shm|journal)$/i.test(rel))continue; const db=/\.(?:sqlite3?|db)$/i.test(rel), attachment=/(^|\/)(?:originals|attachments|images|taobao-source)(\/|$)/i.test(rel); if(db||attachment)entries.push({rel,kind:db?'sqlite':'attachment',sha256:db?undefined:fileHash(f)}); }} visit(root); return entries.sort((a,b)=>a.rel.localeCompare(b.rel)); }
function fingerprint(file){const db=new DatabaseSync(file,{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('备份数据库完整性检查失败');const tables={};for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){const s=db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"');s.setReadBigInts(true);const rows=s.all().map(v=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x)).sort();tables[name]={count:rows.length,sha256:hash(JSON.stringify(rows))};}return tables;}finally{db.close();}}
function stripSession(value){if(Array.isArray(value))return value.map(stripSession);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).filter(([key])=>! /^(?:engineSession|sessionId|threadId|turnId|bridgeToken|apiKey|accessToken|refreshToken|password|secret)$/i.test(key)).map(([key,v])=>[key,stripSession(v)]));}
function sanitizeTasks(file){const db=new DatabaseSync(file);try{db.exec('PRAGMA secure_delete=ON');for(const table of ['entities','events','effects']){const cols=db.prepare('PRAGMA table_info('+table+')').all();if(!cols.some(x=>x.name==='json'))throw Error('任务数据库格式不兼容');const rows=db.prepare('SELECT rowid,json FROM '+table).all(),update=db.prepare('UPDATE '+table+' SET json=? WHERE rowid=?');for(const row of rows)update.run(JSON.stringify(stripSession(JSON.parse(row.json))),row.rowid);}db.exec('VACUUM');}finally{db.close();}}
function copyTaskAttachments(snapshot,storeDir,shared,files){const db=new DatabaseSync(snapshot,{readOnly:true});try{for(const row of db.prepare("SELECT json FROM entities WHERE kind='attachment'").all()){const item=JSON.parse(row.json);if(typeof item.id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(item.id)||typeof item.name!=='string'||item.name!==path.basename(item.name)||!item.name||!/^[a-f0-9]{64}$/i.test(item.sha256||''))throw Error('任务附件记录无效');const base=path.join(storeDir,'attachments',item.id),source=path.join(base,item.name),dest=path.join(shared,'attachments',item.id,item.name);noLinks(source);if(!within(base,source)||fileHash(source)!==item.sha256)throw Error('任务附件缺失或摘要变化');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL);if(fileHash(dest)!==item.sha256||fileHash(source)!==item.sha256)throw Error('任务附件备份期间发生变化');files.push({module:'shared',relative:'attachments/'+item.id+'/'+item.name,kind:'task-attachment',sha256:item.sha256});}}finally{db.close();}}
function copyTaskArtifacts(snapshot,storeDir,shared,files){
  const db=new DatabaseSync(snapshot,{readOnly:true});
  try{for(const row of db.prepare("SELECT json FROM entities WHERE kind='artifact'").all()){
    const item=JSON.parse(row.json);
    if(!/^[a-zA-Z0-9_-]+$/.test(item.taskId||'')||typeof item.path!=='string'||!/^[a-f0-9]{64}$/i.test(item.sha256||''))throw Error('任务产物记录无效');
    const base=path.join(storeDir,'tasks',item.taskId),source=path.resolve(item.path),relative=path.relative(base,source);
    noLinks(source);if(!within(base,source)||fileHash(source)!==item.sha256)throw Error('任务产物缺失或摘要变化');
    const rel=path.join('tasks',item.taskId,relative).replaceAll('\\','/'),dest=path.join(shared,...rel.split('/'));
    if(!within(shared,dest))throw Error('任务产物备份路径无效');
    fs.mkdirSync(path.dirname(dest),{recursive:true});if(!fs.existsSync(dest))fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL);
    if(fileHash(dest)!==item.sha256||fileHash(source)!==item.sha256)throw Error('任务产物备份期间发生变化');
    if(!files.some(file=>file.module==='shared'&&file.relative===rel))files.push({module:'shared',relative:rel,kind:'task-artifact',sha256:item.sha256});
  }}finally{db.close();}
}

// Both identity providers are trusted host callbacks. No path is accepted from a caller.
export function createAgentBackups({paths,services,storeDir,resolveActor,getCompanyIdentity,binding}={}) {
  async function readBinding(ids,ctx){
    if(typeof getCompanyIdentity!=='function'||typeof binding!=='function')throw Error('备份公司与账本绑定服务未接入');
    const company=await getCompanyIdentity(ctx);
    if(!company||typeof company.companyId!=='string'||!company.companyId||typeof company.dataSetId!=='string'||!company.dataSetId)throw Error('公司或数据集绑定不可核验');
    const bound={};for(const id of ids){const value=await binding(id,ctx);if(!value||typeof value.dataSetId!=='string'||!value.dataSetId||value.revision===undefined)throw Error('模块账本身份或版本不可核验: '+id);bound[id]={dataSetId:value.dataSetId,revision:value.revision};}
    return {companyId:company.companyId,dataSetId:company.dataSetId,modules:bound};
  }
  return {...createBackupRecovery({paths,storeDir,resolveActor,getCompanyIdentity}),'backups.prepare':async(input,ctx)=>{
    if(!input||Object.keys(input).some(k=>k!=='modules')||!Array.isArray(input.modules)||!input.modules.length||new Set(input.modules).size!==input.modules.length||input.modules.some(id=>!modules.includes(id)))throw Error('备份参数无效');
    if(!ctx?.actor?.id||!ctx.taskId||!/^[a-zA-Z0-9_-]+$/.test(ctx.taskId)||typeof ctx.registerArtifact!=='function')throw Error('缺少任务身份或产物登记能力');
    if(typeof resolveActor!=='function')throw Error('备份身份服务未接入');
    const actor=await resolveActor(ctx.actor.id); if(!actor||actor.enabled===false||actor.role!=='admin'||actor.canRunTasks!==true||modules.some(id=>!actor.modules?.includes(id)))throw Error('公共任务与权限备份需要拥有全部模块权限的管理员');
    const root=path.resolve(paths?.root||''), expected=path.resolve(process.env.LOCALAPPDATA||'', 'WuchengAgentBeta');
    const registryFile=paths?.registryFile;
    if(!process.env.LOCALAPPDATA||root!==expected||registryFile!==path.join(root,'registry.json')||paths.data!==path.join(root,'data')||!within(root,path.resolve(storeDir||'')))throw Error('仅允许使用隔离 Beta 目录');
    noLinks(root);noLinks(registryFile);noLinks(storeDir);
    const registryBytes=fs.readFileSync(registryFile), registry=JSON.parse(registryBytes), sources={};
    const bound=await readBinding(input.modules,ctx);
    const policyFile=path.join(paths.profile,'workbench-server','access-policy.json'),taskFile=path.join(storeDir,'agent-tasks.sqlite');if(paths.profile!==path.join(root,'profile')||storeDir!==path.join(paths.profile,'agent-runtime'))throw Error('公共资料目录不属于测试版');noLinks(policyFile);noLinks(taskFile);if(!fs.existsSync(taskFile))throw Error('任务数据库不存在，无法创建完整备份');let policyBytes;try{policyBytes=fs.readFileSync(policyFile);validatePolicy(JSON.parse(policyBytes));}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const id of input.modules){const c=registry[id],dir=path.join(paths.data,id);if(!c||c.managed!==true||c.allowInitialize!==false||c.dataDir!==dir||services.config(id)?.dataDir!==dir||!bound.modules[id]?.dataSetId)throw Error('模块账本绑定或路径无效: '+id);noLinks(dir);const files=inventory(dir);if(!files.some(x=>x.kind==='sqlite'&&x.rel===primary[id]))throw Error('模块主账本不存在: '+id);sources[id]={dir,files};}
    const id=crypto.randomUUID(),base=path.join(root,'backups'),dest=path.join(base,'backup-'+id);noLinks(base);fs.mkdirSync(base,{recursive:true});noLinks(dest);fs.mkdirSync(dest,{recursive:false});const files=[],issues=[];
    for(const module of input.modules)for(const item of sources[module].files){if(ctx.signal?.aborted)throw Error('备份任务已取消');const source=path.join(sources[module].dir,...item.rel.split('/')),target=path.join(dest,module,...item.rel.split('/'));if(!within(path.join(dest,module),target))throw Error('备份文件路径无效');noLinks(source);noLinks(target);fs.mkdirSync(path.dirname(target),{recursive:true});if(item.kind==='sqlite'){const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,target);}finally{db.close();}files.push({module,relative:item.rel,kind:item.kind,sha256:fileHash(target),tables:fingerprint(target)});}else{fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);const sha256=fileHash(target);if(sha256!==item.sha256)issues.push({module,relative:item.rel,reason:'附件在备份期间发生变化',blocking:true});files.push({module,relative:item.rel,kind:item.kind,sha256});}}
    const shared=path.join(dest,'shared');fs.mkdirSync(shared);const taskCopy=path.join(shared,'agent-tasks.sqlite'),taskDb=new DatabaseSync(taskFile,{readOnly:true});let taskVersion;try{taskVersion=taskDb.prepare('PRAGMA data_version').get().data_version;await backup(taskDb,taskCopy);if(taskDb.prepare('PRAGMA data_version').get().data_version!==taskVersion)throw Error('任务数据库备份期间发生变化');}finally{taskDb.close();}sanitizeTasks(taskCopy);copyTaskAttachments(taskCopy,storeDir,shared,files);copyTaskArtifacts(taskCopy,storeDir,shared,files);files.push({module:'shared',relative:'agent-tasks.sqlite',kind:'task-snapshot',sha256:fileHash(taskCopy),tables:fingerprint(taskCopy)});if(policyBytes){const copy=path.join(shared,'access-policy.json');fs.writeFileSync(copy,policyBytes,{flag:'wx',mode:0o600});validatePolicy(JSON.parse(fs.readFileSync(copy)));files.push({module:'shared',relative:'access-policy.json',kind:'access-policy',sha256:fileHash(copy)});}
    for(const module of input.modules){const before=sources[module].files,after=inventory(sources[module].dir);if(JSON.stringify(before)!==JSON.stringify(after))issues.push({module,reason:'数据目录在备份期间发生变化',blocking:true});}
    const again=await readBinding(input.modules,ctx),fresh=await resolveActor(actor.id);if(JSON.stringify(bound)!==JSON.stringify(again)||hash(fs.readFileSync(registryFile))!==hash(registryBytes)||!fresh||fresh.enabled===false||fresh.role!=='admin'||fresh.canRunTasks!==true||modules.some(id=>!fresh.modules?.includes(id)))throw Error('备份期间身份、权限或账本绑定已变化；副本保留待检查');
    let policyAfter;try{policyAfter=fs.readFileSync(policyFile);}catch(error){if(error.code!=='ENOENT')throw error;}if((policyBytes?hash(policyBytes):null)!==(policyAfter?hash(policyAfter):null))throw Error('权限配置在备份期间发生变化');
    const report={format:'agent-beta-backup/v1',id,createdAt:new Date().toISOString(),companyId:bound.companyId,dataSetId:bound.dataSetId,moduleBindings:bound.modules,registrySha256:hash(registryBytes),files,issues,policy:policyBytes?'copied':'absent',taskSnapshotDataVersion:taskVersion,crossDatabaseAtomic:false,attachmentScope:['originals','attachments','images','taobao-source'],notIncluded:['登录与会话凭据','未列明的临时引擎工作目录'],note:'SQLite 在线快照分别一致；跨账本及附件不是同一时点。任务快照移除已知会话与密钥字段；公共权限文件缺失时记录缺失。'};
    const reportText=JSON.stringify(report,null,2);fs.writeFileSync(path.join(dest,'backup.json'),reportText,{flag:'wx',mode:0o600});
    const taskDir=path.join(storeDir,'tasks',ctx.taskId);noLinks(taskDir);fs.mkdirSync(taskDir,{recursive:true});const artifact=path.join(taskDir,'backup-'+id+'.json');fs.writeFileSync(artifact,reportText,{flag:'wx',mode:0o600});const registered=ctx.registerArtifact({path:artifact,name:'备份校验清单.json',mimeType:'application/json'});
    return {summary:issues.length?'备份已生成，但存在需要核对的差异':'备份已生成并完成副本校验',blocks:[{type:'text',text:report.note}],evidence:[{id,kind:'backup',status:issues.length?'needs_review':'verified',fileCount:files.length,artifactId:registered?.id,registrySha256:report.registrySha256}],issues,requiresReview:false};
  }};
}
