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
const empty=v=>v==null||v===''||Array.isArray(v)&&v.length===0;

// Internal coordinator API. There is deliberately no HTTP commit route. The caller
// supplies the maintenance/two-confirmation authorization and controlled file resolver.
export function createMigration({module,store,types,sourceInstance,transaction,canCommit=()=>false,context=()=>({}),audit=()=>{}}){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS workbench_migration_links(source_instance TEXT NOT NULL,module TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_instance,module,kind,source_id));
 CREATE TABLE IF NOT EXISTS workbench_migration_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,source_instance TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const instance=sourceInstance||digest({module,dir:store.dir});
 const listRecords=()=>Object.entries(types).flatMap(([kind,t])=>t.list().map(r=>({module,kind,sourceId:String(t.id(r)),version:t.version?.(r)||digest(r),payload:t.export?t.export(r):pick(r,t.fields),files:t.files?.(r)||[]})));
 const targetRevision=()=>digest({records:listRecords(),context:context()});
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
    t.check?.(incoming,existing,{bundle,record:r});
   }catch(e){issues.push(e.message);}
   return {module,kind:r.kind,sourceId:r.sourceId,composite,sourceInstance:bundle.sourceInstance,existingId:existing?String(t.id(existing)):null,existingVersion:existing?(t.version?.(existing)||digest(existing)):null,action:issues.length?'blocked':!existing?'new':differences.length?'conflict':'duplicate',issues,differences,incoming,proposed,files:r.files||[]};
  });
 }
 function monetarySummary(rows,selections=[]){
  const selected=new Map(selections.map(s=>[s.kind+':'+s.sourceId,s])),groups={source:new Map(),existing:new Map(),proposed:new Map()};
  const add=(which,row,value,attachments)=>{if(!value)return;const t=types[row.kind];let metrics;try{metrics=t?.metrics?.(value)||[{basis:row.kind,month:'不适用',currency:'不适用',amountCents:null,monetary:false}];}catch{metrics=[{basis:row.kind,month:'未知',currency:'未知',amountCents:null}];}for(const metric of metrics){const key=[row.kind,metric.basis,metric.month,metric.currency].join('|'),g=groups[which].get(key)||{kind:row.kind,basis:metric.basis,month:metric.month,currency:metric.currency,records:0,amountCents:0,unknownAmounts:0,attachments:0};g.records++;g.attachments+=attachments||0;if(metric.monetary!==false){if(Number.isSafeInteger(metric.amountCents)){g.amountCents+=metric.amountCents;if(!Number.isSafeInteger(g.amountCents))throw migrationError('迁移金额合计超出安全范围');}else g.unknownAmounts++;}groups[which].set(key,g);}};
  for(const row of rows){const t=types[row.kind],before=row.existingId?t?.read(row.existingId):null,choice=selected.get(row.kind+':'+row.sourceId);let proposed=before;
   if(row.action!=='blocked'&&choice?.action!=='skip'){if(!before)proposed=row.incoming;else {proposed={...before};for(const [field,decision]of Object.entries(choice?.fields||{}))if(decision==='incoming'&&t.fields.includes(field)&&!empty(row.incoming?.[field]))proposed[field]=row.incoming[field];}}
   add('source',row,row.incoming,row.files?.length);add('existing',row,before,before?t?.files?.(before)?.length:0);add('proposed',row,proposed,proposed?before?(t?.files?.(before)?.length||0)+(choice?.action==='update'?row.files?.length||0:0):row.files?.length:0);
  }
  const array=m=>[...m.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),difference=[];for(const key of new Set([...groups.existing.keys(),...groups.proposed.keys()])){const a=groups.existing.get(key),b=groups.proposed.get(key),base=b||a;difference.push({...base,records:(b?.records||0)-(a?.records||0),amountCents:(b?.amountCents||0)-(a?.amountCents||0),unknownAmounts:(b?.unknownAmounts||0)-(a?.unknownAmounts||0),attachments:(b?.attachments||0)-(a?.attachments||0)});}return {source:array(groups.source),existing:array(groups.existing),proposed:array(groups.proposed),difference,notice:'各账本、统计口径和币种分开核对；未知金额单列，不按零处理。'};
 }
 const preview=(bundle,{selections=[]}={})=>{const rows=inspect(bundle),revision=digest({bundle,targetRevision:targetRevision()});return {schemaVersion:1,module,sourceInstance:bundle.sourceInstance,revision,rows,summary:monetarySummary(rows,selections),counts:Object.fromEntries(['new','duplicate','conflict','blocked'].map(k=>[k,rows.filter(r=>r.action===k).length]))};};
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
   proposed=t.normalize(proposed,{bundle,record:row,existing:before});t.check?.(proposed,before,{bundle,record:row});
   const assets=await t.prepare?.(row.files,{bundle,record:row,choice});prepared.push({row,choice,t,proposed,before,assets});
  }
  // Preparation may perform IO; invalidate the review again immediately before BEGIN.
  if(preview(bundle).revision!==plan.revision)throw migrationError('准备期间账本已变化，请重新核对','MIGRATION_CHANGED');
  const idMap={},verified=[],migrationId=randomUUID();
  try{return transaction(()=>{
   for(const item of prepared){const {row,choice,t,proposed,before,assets}=item,key=row.kind+':'+row.sourceId;if(choice.action==='skip'){if(row.existingId)idMap[key]=row.existingId;continue;}
    const saved=t.write(proposed,before,{bundle,record:row,assets,idMap,actor,migrationId});
    const actual=t.read(t.id(saved));if(!actual||(t.verify?!t.verify(actual,proposed,{idMap,bundle,record:row}):digest(t.comparable?t.comparable(actual):pick(actual,t.fields))!==digest(t.comparable?t.comparable(proposed):pick(proposed,t.fields))))throw migrationError('写入后逐条校验失败，整批已撤销：'+row.sourceId,'MIGRATION_MISMATCH');
    const targetId=String(t.id(actual));idMap[key]=targetId;verified.push({kind:row.kind,sourceId:row.sourceId,targetId,verified:true,recordHash:digest(t.comparable?t.comparable(actual):pick(actual,t.fields))});
    db.prepare('INSERT INTO workbench_migration_links VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_instance,module,kind,source_id) DO UPDATE SET target_id=excluded.target_id,payload_hash=excluded.payload_hash').run(bundle.sourceInstance,module,row.kind,row.sourceId,targetId,digest(row.incoming),new Date().toISOString());
   }
   const skipped=prepared.filter(x=>x.choice.action==='skip').length;
   const result={migrationId,module,sourceInstance:bundle.sourceInstance,idMap,verified,verification:{ok:true,records:verified.length,skipped},newFiles:prepared.flatMap(x=>(x.assets||[]).map(a=>a.createdPath).filter(Boolean)),revision:plan.revision,skipped};
   db.prepare('INSERT INTO workbench_migration_audit VALUES(?,?,?,?,?)').run(migrationId,JSON.stringify(actor),bundle.sourceInstance,JSON.stringify({revision:plan.revision,selections,result}),new Date().toISOString());audit(result,actor);return result;
  });}catch(e){for(const item of prepared)item.t?.cleanup?.(item.assets);throw e;}
 }
 const verify=migrationId=>{const row=db.prepare('SELECT payload FROM workbench_migration_audit WHERE id=?').get(migrationId);if(!row)throw migrationError('迁移结果不存在');const result=JSON.parse(row.payload).result,differences=[];for(const record of result.verified){const t=types[record.kind],actual=t.read(record.targetId);if(!actual||digest(t.comparable?t.comparable(actual):pick(actual,t.fields))!==record.recordHash)differences.push({kind:record.kind,targetId:record.targetId,reason:'迁移后记录已变化'});}return {migrationId,ok:differences.length===0,records:result.verified.length,differences};};
 return {listRecords,exportSnapshot,preview,commit,verify};
}
