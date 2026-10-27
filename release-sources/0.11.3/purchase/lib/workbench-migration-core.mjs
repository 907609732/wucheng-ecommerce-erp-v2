import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const canonicalJSON=v=>JSON.stringify(canonical(v));
export const digest=v=>createHash('sha256').update(canonicalJSON(v)).digest('hex');
export const migrationError=(message,code='MIGRATION_INVALID')=>Object.assign(Error(message),{status:409,code});
export const pick=(v,fields)=>Object.fromEntries(fields.filter(k=>v[k]!==undefined).map(k=>[k,v[k]]));
export function describeFile(root,relative,metadata={}){const full=path.resolve(root,relative);if(!full.startsWith(path.resolve(root)+path.sep))throw migrationError('原件路径越界');const buffer=fs.readFileSync(full);return {...metadata,id:metadata.id||relative,sourcePath:relative,sha256:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length};}
export async function resolveFiles(files,resolver){if(!Array.isArray(files)||files.length>1000)throw migrationError('附件清单无效');if(files.length&&!resolver)throw migrationError('迁移包含原件，请由受控暂存区提供附件');return Promise.all(files.map(async f=>{if(!f.id||!/^\w{64}$/.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0)throw migrationError('附件清单无效');const result=await resolver(f.id,f),buffer=Buffer.isBuffer(result)?result:result?.buffer;if(!Buffer.isBuffer(buffer)||buffer.length!==f.bytes||createHash('sha256').update(buffer).digest('hex')!==f.sha256)throw migrationError('附件摘要或大小校验失败：'+f.id);return {...f,buffer};}));}
export function businessEvidenceType(store,tables,options={}){
 const db=store.db;db.exec("CREATE TABLE IF NOT EXISTS workbench_migration_evidence(id TEXT PRIMARY KEY,table_name TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,source_instance TEXT NOT NULL,source_id TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS workbench_evidence_no_update BEFORE UPDATE ON workbench_migration_evidence BEGIN SELECT RAISE(ABORT,'MIGRATION_EVIDENCE_IMMUTABLE');END;CREATE TRIGGER IF NOT EXISTS workbench_evidence_no_delete BEFORE DELETE ON workbench_migration_evidence BEGIN SELECT RAISE(ABORT,'MIGRATION_EVIDENCE_IMMUTABLE');END;");
 db.exec('CREATE INDEX IF NOT EXISTS workbench_evidence_origin ON workbench_migration_evidence(source_instance,source_id,table_name)');
 const clean=value=>{if(Array.isArray(value))return value.map(clean);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key,val])=>!/(?:token|cookie|secret|password|authorization|credential|pairing|session|nonce)/i.test(key)).map(([key,val])=>[key,clean(val)]));if(typeof value==='string'&&/^[\s]*[\[{]/.test(value)){try{return JSON.stringify(clean(JSON.parse(value)));}catch{}}return value;};
 const cleanRecord=(table,value)=>{const record=clean(value);if(table==='integration_transfers'&&record&&typeof record==='object')delete record.receipt;return record;};
 const decode=r=>r?{id:r.id,table:r.table_name,record:cleanRecord(r.table_name,JSON.parse(r.payload)),origin:{sourceInstance:r.source_instance,sourceId:r.source_id},retainedId:r.id}:null;
 const read=id=>decode(db.prepare('SELECT * FROM workbench_migration_evidence WHERE id=?').get(id));
 const nativeOrigin=id=>({sourceInstance:db.prepare("SELECT value FROM workbench_identity WHERE key LIKE 'ledger:%' ORDER BY key LIMIT 1").get()?.value,sourceId:id});
 const fields=['table','record','origin'];
 return {fields,id:r=>r.id,list:()=>[...tables.flatMap(table=>{if(!/^[a-z_]+$/.test(table)||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return [];return db.prepare('SELECT rowid AS _migration_rowid,* FROM '+table+' ORDER BY rowid').all().map(row=>{const rawId=table+':'+String(row.id??row._migration_rowid),record=cleanRecord(table,Object.fromEntries(Object.entries(row).filter(([key])=>key!=='_migration_rowid'))),origin=nativeOrigin(rawId);return {id:rawId+'@'+digest(record).slice(0,24),table,record,origin};});}),...db.prepare('SELECT * FROM workbench_migration_evidence ORDER BY id').all().map(row=>({...decode(row),id:'retained:'+row.id}))],read,export:r=>pick(r,fields),find:r=>db.prepare('SELECT * FROM workbench_migration_evidence WHERE source_instance=? AND source_id=? AND table_name=?').all(r.origin.sourceInstance,r.origin.sourceId,r.table).map(decode).find(row=>digest(pick(row,fields))===digest(r)),normalize:(r,c)=>{if(typeof r?.table!=='string'||!/^[a-z_]+$/.test(r.table)||!r.record||typeof r.record!=='object')throw migrationError('只读业务档案类型无效');const origin=r.origin||{sourceInstance:c.bundle.sourceInstance,sourceId:c.record.sourceId};if(typeof origin.sourceInstance!=='string'||!origin.sourceInstance||typeof origin.sourceId!=='string'||!origin.sourceId)throw migrationError('历史证据缺少来源身份');return {table:r.table,record:cleanRecord(r.table,r.record),origin};},
 files:r=>{if(r.retainedId&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_migration_evidence_files'").get())return db.prepare('SELECT * FROM workbench_migration_evidence_files WHERE evidence_id=? ORDER BY source_file_id').all(r.retainedId).map(file=>describeFile(store.dir,file.local_path,{id:file.source_file_id,filename:r.record.filename||path.basename(file.local_path),role:'evidence'}));return ['file_path','thumb_path','original_path','path'].filter(k=>typeof r.record[k]==='string'&&r.record[k]&&!path.isAbsolute(r.record[k])).filter(k=>fs.existsSync(path.resolve(store.dir,r.record[k]))).map(k=>describeFile(store.dir,r.record[k],{id:'evidence:'+r.origin.sourceInstance+':'+r.origin.sourceId+':'+digest(r.record).slice(0,24)+':'+k,filename:path.basename(r.record[k]),role:'evidence'}));},
 prepare:files=>resolveFiles(files,options.resolveFile),cleanup:assets=>{for(const asset of assets||[])if(asset.createdPath)fs.rmSync(path.join(store.dir,asset.createdPath),{force:true});},
 write:(r,b,c)=>{if(b)throw migrationError('历史业务档案是只读证据，不能覆盖');const id=c.targetId,fileMap={};for(const asset of c.assets||[]){const relative='originals/workbench-evidence-'+randomUUID()+path.extname(asset.filename||'').slice(0,10);fs.writeFileSync(path.join(store.dir,relative),asset.buffer,{flag:'wx'});asset.createdPath=relative;fileMap[asset.id]=relative;}db.prepare('INSERT INTO workbench_migration_evidence VALUES(?,?,?,?,?,?,?)').run(id,r.table,JSON.stringify(r.record),digest(r),r.origin.sourceInstance,r.origin.sourceId,new Date().toISOString());if(Object.keys(fileMap).length){db.exec('CREATE TABLE IF NOT EXISTS workbench_migration_evidence_files(evidence_id TEXT NOT NULL,source_file_id TEXT NOT NULL,local_path TEXT NOT NULL,PRIMARY KEY(evidence_id,source_file_id))');for(const [sourceId,localPath]of Object.entries(fileMap))db.prepare('INSERT INTO workbench_migration_evidence_files VALUES(?,?,?)').run(id,sourceId,localPath);}return read(id);}
 };
}
const empty=v=>v==null||v===''||Array.isArray(v)&&v.length===0;
export const plannedMigrationId=value=>{const hex=digest(value).slice(0,32).split('');hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);const s=hex.join('');return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');};
export function migrationInstance(store,module,override){store.db.exec('CREATE TABLE IF NOT EXISTS workbench_identity(key TEXT PRIMARY KEY,value TEXT NOT NULL)');const key='ledger:'+module;store.db.prepare('INSERT OR IGNORE INTO workbench_identity(key,value) VALUES(?,?)').run(key,randomUUID());const identity=store.db.prepare('SELECT value FROM workbench_identity WHERE key=?').get(key).value;return override||identity;}

// Internal coordinator API. There is deliberately no public HTTP commit route. The caller
// supplies the maintenance/two-confirmation authorization and controlled file resolver.
export function createMigration({module,store,types,sourceInstance,transaction,canCommit=()=>false,context=()=>({}),audit=()=>{}}){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS workbench_migration_links(source_instance TEXT NOT NULL,module TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_instance,module,kind,source_id));
 CREATE TABLE IF NOT EXISTS workbench_migration_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,source_instance TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const instance=migrationInstance(store,module,sourceInstance);
 const listRecords=()=>Object.entries(types).flatMap(([kind,t])=>t.list().map(r=>({module,kind,sourceId:String(t.id(r)),version:t.version?.(r)||digest(r),payload:t.export?t.export(r):pick(r,t.fields),files:t.files?.(r)||[]})));
 const targetRevision=()=>digest({dataSetId:instance,records:listRecords(),context:context()});
 const exportSnapshot=()=>{const records=listRecords();return {schemaVersion:1,module,sourceInstance:instance,revision:targetRevision(),records};};
 function inspect(bundle){
  if(bundle?.schemaVersion!==1||bundle.module!==module||typeof bundle.sourceInstance!=='string'||!bundle.sourceInstance||!Array.isArray(bundle.records))throw migrationError('迁移包格式或模块不匹配');
  if(bundle.records.length>100000)throw migrationError('迁移记录超过单批上限');
  const seen=new Set();
  return bundle.records.map(r=>{
   if(typeof r.sourceId!=='string'||!r.sourceId||r.module&&r.module!==module)throw migrationError('来源记录标识无效');
   const composite=[bundle.sourceInstance,module,r.kind,r.sourceId].join(':');if(seen.has(composite))throw migrationError('迁移包包含重复来源记录');seen.add(composite);
   const t=types[r.kind],issues=[];let incoming,existing,proposed,differences=[];
   if(!t)return {...r,composite,action:'blocked',issues:['不支持的业务记录类型']};
   try{
    incoming=t.normalize(r.payload,{bundle,record:r});
    const link=db.prepare('SELECT target_id FROM workbench_migration_links WHERE source_instance=? AND module=? AND kind=? AND source_id=?').get(bundle.sourceInstance,module,r.kind,r.sourceId);
    existing=link?t.read(link.target_id):t.find(incoming);
    if(link&&!existing)throw migrationError('来源关联的目标记录已不存在，需人工处理');
    proposed=existing?{...pick(existing,t.fields)}:{...incoming};
    if(existing)differences=t.fields.filter(k=>digest(existing[k]??null)!==digest(incoming[k]??null)).map(field=>({field,existing:existing[field],incoming:incoming[field],default:'existing',emptyIncoming:empty(incoming[field])}));
    if(!existing||differences.length)t.check?.(incoming,existing,{bundle,record:r});
   }catch(e){issues.push(e.message);}
   const plannedTargetId=existing?String(t.id(existing)):incoming&&t.reserveId?.(incoming,{bundle,record:r})||plannedMigrationId({targetInstance:instance,sourceInstance:bundle.sourceInstance,module,kind:r.kind,sourceId:r.sourceId});
   if(!existing&&t.read(plannedTargetId))issues.push('预留目标标识与其他业务记录冲突');
   return {module,kind:r.kind,sourceId:r.sourceId,composite,sourceInstance:bundle.sourceInstance,existingId:existing?String(t.id(existing)):null,plannedTargetId,existingVersion:existing?(t.version?.(existing)||digest(existing)):null,action:issues.length?'blocked':!existing?'new':differences.length?'conflict':'duplicate',issues,differences,incoming,sourcePayload:r.payload,proposed,files:r.files||[]};
  });
 }
 function monetarySummary(rows,selections=[]){
  const selected=new Map(selections.map(s=>[s.kind+':'+s.sourceId,s])),groups={source:new Map(),existing:new Map(),proposed:new Map()};
  const add=(which,row,value,attachments)=>{if(!value)return;const t=types[row.kind];let metrics;try{metrics=t?.metrics?.(value)||[{basis:row.kind,month:'不适用',currency:'不适用',amountCents:null,monetary:false}];}catch{metrics=[{basis:row.kind,month:'未知',currency:'未知',amountCents:null}];}for(const metric of metrics){const key=[row.kind,metric.basis,metric.month,metric.currency].join('|'),g=groups[which].get(key)||{kind:row.kind,basis:metric.basis,month:metric.month,currency:metric.currency,records:0,amountCents:0,unknownAmounts:0,attachments:0};g.records++;g.attachments+=attachments||0;if(metric.monetary!==false){if(Number.isSafeInteger(metric.amountCents)){g.amountCents+=metric.amountCents;if(!Number.isSafeInteger(g.amountCents))throw migrationError('迁移金额合计超出安全范围');}else g.unknownAmounts++;}groups[which].set(key,g);}};
  for(const row of rows){const t=types[row.kind],before=row.existingId?t?.read(row.existingId):null,choice=selected.get(row.kind+':'+row.sourceId);let proposed=before;
   if(row.action!=='blocked'&&choice?.action!=='skip'){if(!before)proposed=row.incoming;else {proposed={...before};for(const [field,decision]of Object.entries(choice?.fields||{}))if(decision==='incoming'&&t.fields.includes(field)&&!empty(row.incoming?.[field]))proposed[field]=row.incoming[field];}}
   add('source',row,row.incoming||row.sourcePayload,row.files?.length);add('existing',row,before,before?t?.files?.(before)?.length:0);add('proposed',row,proposed,proposed?before?(t?.files?.(before)?.length||0)+(choice?.action==='update'?row.files?.length||0:0):row.files?.length:0);
  }
  const array=m=>[...m.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),difference=[];for(const key of new Set([...groups.existing.keys(),...groups.proposed.keys()])){const a=groups.existing.get(key),b=groups.proposed.get(key),base=b||a;difference.push({...base,records:(b?.records||0)-(a?.records||0),amountCents:(b?.amountCents||0)-(a?.amountCents||0),unknownAmounts:(b?.unknownAmounts||0)-(a?.unknownAmounts||0),attachments:(b?.attachments||0)-(a?.attachments||0)});}return {source:array(groups.source),existing:array(groups.existing),proposed:array(groups.proposed),difference,notice:'各账本、统计口径和币种分开核对；未知金额单列，不按零处理。'};
 }
 const preview=(bundle,{selections=[]}={})=>{const rows=inspect(bundle),revision=digest({bundle,targetRevision:targetRevision()});return {schemaVersion:1,module,sourceInstance:bundle.sourceInstance,revision,rows,plannedIdMap:Object.fromEntries(rows.filter(r=>r.plannedTargetId&&r.action!=='blocked').map(r=>[r.kind+':'+r.sourceId,r.plannedTargetId])),summary:monetarySummary(rows,selections),counts:Object.fromEntries(['new','duplicate','conflict','blocked'].map(k=>[k,rows.filter(r=>r.action===k).length]))};};
 async function commit(plan,actor){
  if(!actor||!await canCommit(actor,plan))throw migrationError('迁移只允许管理员在维护窗口完成两次界面确认后提交','MIGRATION_CONFIRMATION_REQUIRED');
  const {bundle,selections}=plan;if(!Array.isArray(selections))throw migrationError('缺少逐条核对选择');
  const p=preview(bundle);if(p.revision!==plan.revision)throw migrationError('来源或目标数据已变化，请重新核对','MIGRATION_CHANGED');
  const selected=new Map();for(const s of selections){const key=s.kind+':'+s.sourceId;if(selected.has(key)||!p.rows.some(r=>r.kind===s.kind&&r.sourceId===s.sourceId))throw migrationError('选择包含重复或未知记录');selected.set(key,s);}
  if(selected.size!==p.rows.length)throw migrationError('每条记录都需要明确选择导入、更新或跳过');
  const prepared=[];for(const row of p.rows){
   const choice=selected.get(row.kind+':'+row.sourceId),t=types[row.kind];
   if(choice.action==='skip'){prepared.push({row,choice});continue;}
   if(row.action==='blocked'||!['add','update'].includes(choice.action)||choice.action==='add'&&row.existingId||choice.action==='update'&&!row.existingId)throw migrationError('记录状态与核对操作不一致：'+row.sourceId);
   let proposed={...row.incoming};
   if(row.existingId){
    proposed={...row.proposed};
    if(choice.fields&&Object.keys(choice.fields).some(k=>!t.fields.includes(k)))throw migrationError('包含不可修改字段');
    for(const field of t.fields){const selection=choice.fields?.[field]||'existing';if(!['existing','incoming'].includes(selection))throw migrationError('字段选择无效');if(selection==='incoming'){if(empty(row.incoming[field])&&!empty(proposed[field]))throw migrationError('不能用空白覆盖已有字段：'+field);proposed[field]=row.incoming[field];}}
   }
   const before=row.existingId?t.read(row.existingId):null;
   proposed=t.normalize(proposed,{bundle,record:row,existing:before,phase:'commit'});t.check?.(proposed,before,{bundle,record:row,phase:'commit'});
   const assets=await t.prepare?.(row.files,{bundle,record:row,choice});prepared.push({row,choice,t,proposed,before,assets});
  }
  // Preparation may perform IO; invalidate the review again immediately before BEGIN.
  if(preview(bundle).revision!==plan.revision)throw migrationError('准备期间账本已变化，请重新核对','MIGRATION_CHANGED');
  if(!await canCommit(actor,plan))throw migrationError('准备期间迁移维护所有者或确认凭据已变化','MIGRATION_CONFIRMATION_REQUIRED');
  const idMap={},verified=[],migrationId=randomUUID();
  try{return transaction(()=>{
   for(const item of prepared){const {row,choice,t,proposed,before,assets}=item,key=row.kind+':'+row.sourceId;if(choice.action==='skip'){if(row.existingId)idMap[key]=row.existingId;continue;}
    const saved=t.write(proposed,before,{bundle,record:row,assets,idMap,actor,migrationId,targetId:row.plannedTargetId});
    if(String(t.id(saved))!==row.plannedTargetId)throw migrationError('写入标识与已核对预留标识不一致','MIGRATION_ID_MISMATCH');
    const actual=t.read(t.id(saved));if(!actual||(t.verify?!t.verify(actual,proposed,{idMap,bundle,record:row}):digest(t.comparable?t.comparable(actual):pick(actual,t.fields))!==digest(t.comparable?t.comparable(proposed):pick(proposed,t.fields))))throw migrationError('写入后逐条校验失败，整批已撤销：'+row.sourceId,'MIGRATION_MISMATCH');
    const targetId=String(t.id(actual));idMap[key]=targetId;verified.push({kind:row.kind,sourceId:row.sourceId,targetId,verified:true,recordHash:digest(t.comparable?t.comparable(actual):pick(actual,t.fields))});
    db.prepare('INSERT INTO workbench_migration_links VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_instance,module,kind,source_id) DO UPDATE SET target_id=excluded.target_id,payload_hash=excluded.payload_hash').run(bundle.sourceInstance,module,row.kind,row.sourceId,targetId,digest(row.incoming),new Date().toISOString());
   }
   const skipped=prepared.filter(x=>x.choice.action==='skip').length;
   const result={migrationId,module,sourceInstance:bundle.sourceInstance,idMap,verified,verification:{ok:true,records:verified.length,skipped},newFiles:prepared.flatMap(x=>(x.assets||[]).flatMap(a=>a.createdPaths||[a.createdPath]).filter(Boolean)),revision:plan.revision,skipped};
   db.prepare('INSERT INTO workbench_migration_audit VALUES(?,?,?,?,?)').run(migrationId,JSON.stringify(actor),bundle.sourceInstance,JSON.stringify({revision:plan.revision,selections,result}),new Date().toISOString());audit(result,actor);return result;
  });}catch(e){for(const item of prepared)item.t?.cleanup?.(item.assets);throw e;}
 }
 const verify=migrationId=>{const row=db.prepare('SELECT payload FROM workbench_migration_audit WHERE id=?').get(migrationId);if(!row)throw migrationError('迁移结果不存在');const result=JSON.parse(row.payload).result,differences=[];for(const record of result.verified){const t=types[record.kind],actual=t.read(record.targetId);if(!actual||digest(t.comparable?t.comparable(actual):pick(actual,t.fields))!==record.recordHash)differences.push({kind:record.kind,targetId:record.targetId,reason:'迁移后记录已变化'});}return {migrationId,ok:differences.length===0,records:result.verified.length,differences};};
 return {listRecords,exportSnapshot,preview,commit,verify};
}
