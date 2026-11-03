import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {DATA_VERSION_POLICY,PRIMARY_BUSINESS_TABLES,isBusinessMutation,isRecoverableBusinessRow,businessRowCondition,sanitizeBusinessRow,quoteIdentifier as qi} from './data-version-policy.mjs';

export const dataVersionDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function safeDataVersionPath(root,relative){
 if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes(':')||relative.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(relative))throw Error('Invalid attachment path');
 const base=path.resolve(root),target=path.resolve(base,relative);noSymlinkAncestors(base);if(!target.startsWith(base+path.sep))throw Error('Invalid attachment path');
 let current=base;for(const part of relative.split('/')){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Attachment path contains symlink');}return target;
}
function noSymlinkAncestors(target){let current=path.resolve(target);while(true){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Data version path contains symlink');const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function durableWrite(file,bytes){const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function sqlStatements(sql){
 const result=[];let start=0,quote='',comment='',trigger=false,block=0,word='',beforeWord='',head=[];
 const token=()=>{if(!word)return;const upper=word.toUpperCase();head.push(upper);if(head[0]==='CREATE'&&head.includes('TRIGGER'))trigger=true;if(trigger&&beforeWord!=='.'){if(upper==='BEGIN'||upper==='CASE'&&block>0)block++;if(upper==='END'&&block>0)block--;}word='';};
 for(let i=0;i<sql.length;i++){const c=sql[i],n=sql[i+1];if(comment){if(comment==='line'&&c==='\n')comment='';else if(comment==='block'&&c==='*'&&n==='/'){comment='';i++;}continue;}if(quote){if(c===quote){if(n===quote)i++;else quote='';}else if(quote===']'&&c===']')quote='';continue;}if(c==='-'&&n==='-'){token();comment='line';i++;continue;}if(c==='/'&&n==='*'){token();comment='block';i++;continue;}if(c==="'"||c==='"'||c==='`'||c==='['){token();quote=c==='['?']':c;continue;}if(/[A-Za-z_]/.test(c)){if(!word)beforeWord=sql[i-1]||'';word+=c;continue;}token();if(c===';'&&(!trigger||block===0)){const part=sql.slice(start,i).trim();if(part)result.push(part);start=i+1;head=[];trigger=false;block=0;}}
 token();const last=sql.slice(start).trim();if(last)result.push(last);return result;
}
const prefix=sql=>sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,'').trim();
const isMutation=sql=>/^(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(prefix(sql));


function savepointIdentifier(sql){
 const raw=prefix(sql).replace(/^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+TRANSACTION)?\s+TO(?:\s+SAVEPOINT)?)\s+/i,'').trim();
 let name='';if(['"',"'",String.fromCharCode(96),'['].includes(raw[0])){const end=raw[0]==='['?']':raw[0];let closed=false;for(let i=1;i<raw.length;i++){if(raw[i]===end){if(raw[i+1]===end&&end!==']'){name+=end;i++;}else{closed=true;break;}}else name+=raw[i];}if(!closed)throw Error('DATA_VERSION_UNSUPPORTED_SQL: invalid savepoint');}else name=raw.match(/^[\p{L}\p{N}_$]+/u)?.[0]||'';
 if(!name)throw Error('DATA_VERSION_UNSUPPORTED_SQL: invalid savepoint');return name.replace(/[A-Z]/g,c=>c.toLowerCase());
}

/** Preserve the native DatabaseSync object and wrap the existing ownership guards. */
export function installDataVersioning({db,module,dataDir,versionDir,initializing=false}){
 if(!DATA_VERSION_POLICY[module]||!path.isAbsolute(versionDir||'')||!path.isAbsolute(dataDir||''))throw Error('Invalid data version configuration');
 const policy=DATA_VERSION_POLICY[module],context=new AsyncLocalStorage(),nativeExec=db.exec.bind(db),nativePrepare=db.prepare.bind(db);
 let internal=false,tracked=false,savepoints=[];
 const rawRun=(sql,...values)=>nativePrepare(sql).run(...values);
 nativeExec('CREATE TABLE IF NOT EXISTS data_version_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS data_version_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS data_version_changes(table_name TEXT NOT NULL,operation TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(table_name,operation));');
 if(nativePrepare('SELECT count(*) AS n FROM data_version_changes').get().n)throw Error('DATA_VERSION_PROTECTION_GAP');
 db.function('data_version_write_allowed',()=>{if(!tracked&&!internal)throw Error('DATA_VERSION_UNCONTROLLED_WRITE');return 1;});
 const businessTables=()=>nativePrepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name").all().filter(t=>policy.tables.includes(t.name));
 function refresh(bootstrap=false){
  if(!bootstrap)initializing=false;
  for(const table of businessTables()){
   const columns=nativePrepare(`PRAGMA table_info(${qi(table.name)})`).all().map(c=>c.name),allowed=policy.settings.map(k=>"'"+k.replaceAll("'","''")+"'").join(',')||"''";
   for(const operation of ['INSERT','UPDATE','DELETE']){
    const alias=operation==='DELETE'?'OLD':'NEW',conditions=[];
    const rowCondition=businessRowCondition(module,table.name,alias);if(rowCondition)conditions.push(operation==='UPDATE'?'('+rowCondition+' OR '+businessRowCondition(module,table.name,'OLD')+')':rowCondition);
    if(table.name==='settings')conditions.push(`${alias}.key IN (${allowed})`);
    if(operation==='UPDATE')conditions.push('('+columns.map(c=>`OLD.${qi(c)} IS NOT NEW.${qi(c)}`).join(' OR ')+')');
    const when=conditions.length?' WHEN '+conditions.join(' AND '):'';
    nativeExec(`DROP TRIGGER IF EXISTS ${qi('data_version_'+table.name+'_'+operation.toLowerCase())};CREATE TRIGGER ${qi('data_version_'+table.name+'_'+operation.toLowerCase())} AFTER ${operation} ON ${qi(table.name)}${when} BEGIN SELECT data_version_write_allowed();INSERT INTO data_version_changes(table_name,operation,n) VALUES('${table.name}','${operation.toLowerCase()}',1) ON CONFLICT(table_name,operation) DO UPDATE SET n=n+1;END;`);
   }
  }
 }
 function capture(actionOverride){
  const changes=nativePrepare('SELECT table_name,operation,n FROM data_version_changes ORDER BY table_name,operation').all();
  if(!actionOverride&&!changes.some(change=>isBusinessMutation(module,change.table_name))){rawRun('DELETE FROM data_version_changes');return null;}
  const current=context.getStore()||{},counts={insert:0,update:0,delete:0};for(const c of changes)if(PRIMARY_BUSINESS_TABLES[module].includes(c.table_name))counts[c.operation]+=c.n;
  const id=randomUUID(),eventDir=path.join(versionDir,'events',module,id);noSymlinkAncestors(eventDir);fs.mkdirSync(eventDir,{recursive:true});
  const tables={},files=new Map(),names=new Set(businessTables().map(t=>t.name));
  const privateTables=nativePrepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name).filter(name=>!names.has(name)&&!name.startsWith('sqlite_'));
  for(const name of names)for(const foreignKey of nativePrepare(`PRAGMA foreign_key_list(${qi(name)})`).all())if(!names.has(foreignKey.table))throw Error('DATA_VERSION_PRIVATE_SCHEMA_REFERENCE: '+name);
  for(const table of businessTables()){
   const rowCondition=businessRowCondition(module,table.name,qi(table.name));
   const rows=nativePrepare(`SELECT * FROM ${qi(table.name)}${rowCondition?' WHERE '+rowCondition:''}`).all().filter(row=>(table.name!=='settings'||policy.settings.includes(row.key))&&isRecoverableBusinessRow(module,table.name,row)).map(row=>sanitizeBusinessRow(module,table.name,row));
   for(const row of rows)for(const column of policy.files[table.name]||[]){
    if(!row[column])continue;let relative=String(row[column]);if(path.isAbsolute(relative)){relative=path.relative(dataDir,relative).split(path.sep).join('/');}else relative=relative.replaceAll('\\','/');
    if(!policy.folders.includes(relative.split('/')[0]))throw Error('Attachment path is outside business whitelist');
    const source=safeDataVersionPath(dataDir,relative);if(!fs.statSync(source).isFile())throw Error('Attachment path is not a file');row[column]=relative;files.set(relative,source);
   }
   tables[table.name]=rows;
  }
  const schema=nativePrepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,name").all().filter(s=>{
   if(s.name.startsWith('data_version_')||s.name.startsWith('workbench_')||s.name.startsWith('agent_'))return false;
   if(s.type==='view')return module==='sales'&&['active_ledger','active_operations'].includes(s.name);
   if(!names.has(s.tbl_name))return false;
   if(s.type==='table'||s.type==='index')return true;
   return !privateTables.some(name=>new RegExp('\\b'+name.replace(/[^A-Za-z0-9_]/g,c=>'\\'+c)+'\\b','i').test(s.sql));
  });
  for(const name of names)if(!schema.some(item=>item.type==='table'&&item.name===name))throw Error('DATA_VERSION_SCHEMA_MISSING: '+name);
  const attachments=[];for(const [relative,source]of [...files].sort(([a],[b])=>a.localeCompare(b))){const bytes=fs.readFileSync(source),relativeCopy='attachments/'+relative,destination=safeDataVersionPath(eventDir,relativeCopy);fs.mkdirSync(path.dirname(destination),{recursive:true});const digest=dataVersionDigest(bytes),blob=path.join(versionDir,'blobs',digest);noSymlinkAncestors(blob);fs.mkdirSync(path.dirname(blob),{recursive:true});if(fs.existsSync(blob)){if(dataVersionDigest(fs.readFileSync(blob))!==digest)throw Error('Attachment blob digest mismatch');}else durableWrite(blob,bytes);try{fs.linkSync(blob,destination);}catch(e){if(!['EPERM','ENOSYS','ENOTSUP','EXDEV'].includes(e.code))throw e;durableWrite(destination,bytes);}attachments.push({path:relativeCopy,sha256:dataVersionDigest(bytes),bytes:bytes.length});}
  const sequences=nativePrepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()?nativePrepare('SELECT name,seq FROM sqlite_sequence').all().filter(row=>names.has(row.name)):[];
  const snapshot={schemaVersion:1,module,sequences,userVersion:nativePrepare('PRAGMA user_version').get().user_version,schema,tables};
  const bytes=Buffer.from(JSON.stringify(snapshot,(_k,v)=>v instanceof Uint8Array?{$blob:Buffer.from(v).toString('base64')}:typeof v==='bigint'?{$integer:v.toString()}:v));durableWrite(path.join(eventDir,'snapshot.json'),bytes);
  const actor={id:String(current.actor?.id||'system'),label:String(current.actor?.label||'本机业务操作')},requestedAction=String(current.action||''),action=actionOverride||(/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+\//i.test(requestedAction)?'业务保存':requestedAction||(initializing?'系统迁移':'业务保存'));
  const label={purchase:'采购',sales:'销售',overview:'经营总览'}[module],containedRecords=PRIMARY_BUSINESS_TABLES[module].reduce((total,table)=>total+(tables[table]?.length||0),0),summary=actionOverride?`${label}｜${action}｜包含业务记录${containedRecords}条、附件${attachments.length}份｜操作人：${actor.label}`:`${label}｜${action}｜新增${counts.insert}条、修改${counts.update}条、删除${counts.delete}条｜操作人：${actor.label}`;
  const event={schemaVersion:1,id,module,createdAt:new Date().toISOString(),actor,action,summary,counts,snapshot:{path:'snapshot.json',sha256:dataVersionDigest(bytes)},attachments};
  durableWrite(path.join(eventDir,'event.json'),Buffer.from(JSON.stringify(event)));
  rawRun('INSERT INTO data_version_events(id,payload) VALUES(?,?)',id,JSON.stringify(event));rawRun('DELETE FROM data_version_changes');return event;
 }
 function finish(sql){try{internal=true;capture();nativeExec(sql);tracked=false;savepoints=[];}catch(e){if(db.isTransaction)nativeExec('ROLLBACK');tracked=false;savepoints=[];throw e;}finally{internal=false;}}
 function implicit(fn){if(db.isTransaction||internal)return fn();nativeExec('BEGIN IMMEDIATE');tracked=true;try{const result=fn();finish('COMMIT');return result;}catch(e){if(db.isTransaction)nativeExec('ROLLBACK');tracked=false;throw e;}}
 function execute(sql){
  const p=prefix(sql);
  if(/^(?:COMMIT|END)\b/i.test(p))return finish(sql);
  if(/^BEGIN\b/i.test(p)){const result=nativeExec(sql);tracked=true;savepoints=[];return result;}
  if(/^SAVEPOINT\b/i.test(p)){const name=savepointIdentifier(sql),was=db.isTransaction,result=nativeExec(sql);if(!was)tracked=true;savepoints.push({name,outer:!was});return result;}
  if(/^RELEASE\b/i.test(p)){const name=savepointIdentifier(sql),index=savepoints.findLastIndex(item=>item.name===name);if(index===0&&savepoints[0].outer)return finish(sql);const result=nativeExec(sql);if(index>=0)savepoints.splice(index);return result;}
  if(/^ROLLBACK(?:\s+TRANSACTION)?\s+TO\b/i.test(p)){const name=savepointIdentifier(sql),index=savepoints.findLastIndex(item=>item.name===name),result=nativeExec(sql);if(index>=0)savepoints.splice(index+1);return result;}
  const result=nativeExec(sql);if(/^ROLLBACK\b/i.test(p)&&!db.isTransaction){tracked=false;savepoints=[];}return result;
 }
 db.exec=sql=>{if(internal)return nativeExec(sql);const statements=sqlStatements(String(sql));const work=()=>{let result;for(const statement of statements)result=execute(statement);return result;};return !db.isTransaction&&statements.some(isMutation)&&!statements.some(s=>/^(?:BEGIN|SAVEPOINT)\b/i.test(prefix(s)))?implicit(work):work();};
 db.prepare=(...args)=>{if(/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(prefix(String(args[0]))))throw Error('DATA_VERSION_UNSUPPORTED_SQL: use db.exec for transaction control');const statement=nativePrepare(...args),mutation=isMutation(String(args[0]));for(const method of ['run','get','all','iterate']){const native=statement[method]?.bind(statement);if(!native)continue;statement[method]=(...values)=>{if(!mutation||internal)return native(...values);return implicit(()=>method==='iterate'?statement.all(...values)[Symbol.iterator]():native(...values));};}return statement;};
 refresh(true);
 return {run:(value,fn)=>context.run({...context.getStore(),...value},fn),refresh,baseline(){if(db.isTransaction)throw Error('Baseline requires an idle database');nativeExec('BEGIN IMMEDIATE');tracked=true;try{internal=true;const event=capture(dataVersionBaselineRequired(db)?'重新建立基线（停用期间未逐次保护）':'建立基线');rawRun("DELETE FROM data_version_state WHERE key='unprotected_interval'");nativeExec('COMMIT');return event;}catch(e){if(db.isTransaction)nativeExec('ROLLBACK');throw e;}finally{internal=false;tracked=false;}}};
}
/** Explicit maintenance opt-out. Retains history and marks the interval as unprotected. */
export function disableDataVersioning(db){
 if(db.isTransaction)throw Error('Data version disable requires an idle database');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='data_version_events'").get())return {disabled:false};
 const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all().filter(row=>/^data_version_[a-z_]+_(?:insert|update|delete)$/.test(row.name)&&/\bdata_version_write_allowed\s*\(/i.test(row.sql));
 db.exec('BEGIN IMMEDIATE');try{for(const trigger of triggers)db.exec('DROP TRIGGER '+qi(trigger.name));db.exec('CREATE TABLE IF NOT EXISTS data_version_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare("INSERT OR IGNORE INTO data_version_state(key,value) VALUES('unprotected_interval',?)").run(new Date().toISOString());if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='data_version_changes'").get())db.exec('DELETE FROM data_version_changes');db.exec('COMMIT');return {disabled:true,triggers:triggers.length};}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}
export function dataVersionBaselineRequired(db){return !!db.prepare("SELECT value FROM data_version_state WHERE key='unprotected_interval'").get();}
