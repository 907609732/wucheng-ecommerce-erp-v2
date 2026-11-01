import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createRemoteWarehouseScript} from '../renderer/remote-warehouse-ui.mjs';

export {warehouseAdapter,createWarehouseAdapter} from './descriptors.mjs';
export {warehouseAdapter as default} from './descriptors.mjs';

// The API provides stockAlert as {level, text, days, label}. Display its existing
// description without recalculating thresholds or treating missing data as OK.
export function formatWarehouseInventoryAlert(row){
  for(const alert of [row?.alertLabel,row?.stockAlert,row?.alert]){
    if(typeof alert==='string'&&alert.trim())return alert;
    if(alert&&typeof alert==='object'&&!Array.isArray(alert)){
      for(const key of ['label','text'])if(typeof alert[key]==='string'&&alert[key].trim())return alert[key];
    }
  }
  return '—';
}

export {remoteWarehouseHtml as warehouseHtml,remoteWarehouseStyles as warehouseStyles} from '../renderer/remote-warehouse-ui.mjs';
export const warehouseScript = createRemoteWarehouseScript(formatWarehouseInventoryAlert);

const migrationTables={
  warehouses:['id'],skus:['sku'],inventory_snapshots:['sku','warehouse_id','snapshot_date'],
  inventory_movements:['source_type','platform','order_id','sub_order_id','sku','warehouse_id'],
  import_records:null,imported_files:['hash'],operation_logs:null,product_images:null,
  monthly_outbound:['sku','warehouse_id','month'],inventory_data_validations:null,
  warehouse_monthly_sales:['warehouse_id','sku','month'],warehouse_monthly_sales_validations:null,
  monthly_report_deliveries:['report_type','report_month'],
  warehouse_sync_runs:['id'],warehouse_daily_config:['id'],
  warehouse_attendance:['login','business_date'],warehouse_reminders:['id'],warehouse_daily_audit:['id']
};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))??'undefined').digest('hex');
const migrationError=message=>Object.assign(Error(message),{status:409,code:'MIGRATION_CONFLICT'});
const payloadRow=(row,table)=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='id'||['warehouses','warehouse_sync_runs','warehouse_daily_config','warehouse_reminders','warehouse_daily_audit'].includes(table)));

/** Internal migration adapter. The coordinator owns maintenance, two confirmations,
 * immutable staging and backups; this adapter owns schema-aware conflict/transaction checks. */
export function createWorkbenchMigration({databasePath,dataDir=path.dirname(databasePath),resolveFile,canCommit=()=>false}={}){
  if(!databasePath||!fs.existsSync(databasePath))throw migrationError('原云仓账本不存在，不能创建空账本进行迁移');
  const database=new DatabaseSync(databasePath);database.exec('PRAGMA foreign_keys=ON');
  database.exec('CREATE TABLE IF NOT EXISTS workbench_identity(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  if(!database.prepare('SELECT value FROM workbench_identity WHERE key=?').get('ledger-instance'))database.prepare('INSERT OR IGNORE INTO workbench_identity(key,value) VALUES(?,?)').run('ledger-instance',randomUUID());
  const sourceInstance=String(database.prepare('SELECT value FROM workbench_identity WHERE key=?').get('ledger-instance').value);
  if(!/^[a-f0-9-]{36}$/.test(sourceInstance)){database.close();throw migrationError('账本身份无效，请保留现有数据并检查备份');}
  database.exec(`CREATE TABLE IF NOT EXISTS workbench_migration_sources(source_instance TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,version TEXT NOT NULL,target_key TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_instance,kind,source_id));
    CREATE TABLE IF NOT EXISTS workbench_migration_evidence(id TEXT PRIMARY KEY,source_instance TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,payload TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workbench_migration_results(id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  if(!database.prepare('PRAGMA table_info(workbench_migration_sources)').all().some(column=>column.name==='target_hash'))database.exec("ALTER TABLE workbench_migration_sources ADD COLUMN target_hash TEXT NOT NULL DEFAULT ''");
  const exists=table=>!!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const read=table=>exists(table)?database.prepare('SELECT * FROM '+table).all().map(row=>({...row})):[];
  const sourceKey=(table,row)=>migrationTables[table]?JSON.stringify(migrationTables[table].map(key=>row[key])):hash(payloadRow(row,table));
  const revisions=()=>hash({dataSetId:sourceInstance,records:Object.keys(migrationTables).map(table=>[table,read(table)])});
  function exportSnapshot(){
    const records=[];
    for(const table of Object.keys(migrationTables))for(const row of read(table)){
      const payload=payloadRow(row,table),files=[];
      for(const role of ['stored_path','source_file'])if(typeof payload[role]==='string'&&payload[role]){
        const sourcePath=path.resolve(payload[role]),allowed=sourcePath.startsWith(path.resolve(dataDir)+path.sep)&&/\.(?:xlsx?|csv|pdf|png|jpe?g|webp|gif|txt)$/i.test(sourcePath);
        if(allowed&&fs.existsSync(sourcePath)&&fs.statSync(sourcePath).isFile()){const bytes=fs.readFileSync(sourcePath);files.push({id:hash([table,sourceKey(table,row),role]),role,filename:path.basename(sourcePath),sourcePath,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
        // Paths are only source-side evidence, never a destination path provided by a client.
        payload[role]=path.basename(payload[role]);
      }
      records.push({kind:table,sourceId:sourceKey(table,row),version:hash(payload),payload,files});
    }
    return {module:'warehouse',schemaVersion:1,sourceInstance,revision:revisions(),records};
  }
  function preview(bundle){
    if(bundle?.module!=='warehouse'||bundle.schemaVersion!==1||typeof bundle.sourceInstance!=='string'||!Array.isArray(bundle.records))throw migrationError('云仓迁移格式不兼容');
    const seen=new Set(),rows=bundle.records.map(record=>{
      const issues=[],table=record.kind,key=record.kind+':'+record.sourceId;
      if(!Object.hasOwn(migrationTables,table)||!exists(table))issues.push('来源表不在云仓业务范围内或当前版本不存在');
      if(!record.sourceId||seen.has(key))issues.push('来源记录标识重复或缺失');seen.add(key);
      if(!record.payload||record.version!==hash(record.payload))issues.push('不可变来源摘要不符');
      const columns=issues.length?[]:database.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
      if(record.payload&&Object.keys(record.payload).some(key=>!columns.includes(key)))issues.push('来源包含当前账本不支持的字段');
      if(record.payload&&['imported_files','product_images'].includes(table)&&record.payload.stored_path&&!(record.files||[]).some(file=>file.role==='stored_path'))issues.push('原件或附件缺失，必须补齐或跳过此记录');
      let existing;
      const mapping=database.prepare('SELECT * FROM workbench_migration_sources WHERE source_instance=? AND kind=? AND source_id=?').get(bundle.sourceInstance,table,record.sourceId);
      if(!issues.length){
        const keys=migrationTables[table];
        if(keys)existing=database.prepare('SELECT * FROM '+table+' WHERE '+keys.map(k=>k+'=?').join(' AND ')).get(...keys.map(k=>record.payload[k]));
        else existing=read(table).find(row=>hash(payloadRow(row,table))===record.version);
      }
      const existingPayload=existing?payloadRow({...existing},table):null;
      if(existingPayload)for(const role of ['stored_path','source_file'])if(existingPayload[role])existingPayload[role]=path.basename(existingPayload[role]);
      const evidence=table==='monthly_report_deliveries'&&mapping?database.prepare('SELECT payload FROM workbench_migration_evidence WHERE id=?').get(mapping.target_key):null;
      if(mapping&&!existing&&!evidence)issues.push('来源关联的目标记录已不存在，请人工处理');
      const currentTargetHash=evidence?hash(JSON.parse(evidence.payload)):existing?hash(payloadRow({...existing},table)):null;
      const duplicate=mapping?.version===record.version&&mapping.target_hash===currentTargetHash||existingPayload&&hash(existingPayload)===record.version;
      const differences=existingPayload?Object.keys(record.payload).filter(key=>hash(record.payload[key])!==hash(existingPayload[key])).map(field=>({field,existing:existingPayload[field],incoming:record.payload[field],default:'existing',emptyIncoming:record.payload[field]==null||record.payload[field]===''})):[];
      return {module:'warehouse',sourceInstance:bundle.sourceInstance,sourceId:record.sourceId,kind:table,action:issues.length?'blocked':duplicate?'duplicate':existing?'conflict':'new',issues,differences,existingId:existing?sourceKey(table,existing):null,existingVersion:existingPayload?hash(existingPayload):null,incoming:record.payload,proposed:record.payload};
    });return {schemaVersion:1,module:'warehouse',sourceInstance:bundle.sourceInstance,revision:revisions(),rows,counts:Object.fromEntries(['new','duplicate','conflict','blocked'].map(action=>[action,rows.filter(row=>row.action===action).length]))};
  }
  async function commit(input,actor){
    if(actor?.role!=='admin'||!await canCommit(actor,input))throw Object.assign(Error('迁移提交需要维护窗口与两次页面确认凭据'),{status:403,code:'MIGRATION_CONFIRMATION_REQUIRED'});
    const plan=preview(input.bundle);if(plan.revision!==input.revision)throw migrationError('主服务器云仓账本已变化，请重新核对');
    if(!Array.isArray(input.selections)||input.selections.length!==plan.rows.length||new Set(input.selections.map(s=>s.kind+':'+s.sourceId)).size!==plan.rows.length)throw migrationError('每条迁移记录必须有唯一核对选择');
    const records=[...input.bundle.records].sort((a,b)=>Object.keys(migrationTables).indexOf(a.kind)-Object.keys(migrationTables).indexOf(b.kind)),idMap=[];
    const preparedFiles=new Map(),newFiles=[],verified=[],migrationId=randomUUID();
    for(const record of records){const choice=input.selections?.find(s=>s.kind===record.kind&&s.sourceId===record.sourceId);if(choice?.action==='skip')continue;for(const file of record.files||[]){
      if(!resolveFile||!['stored_path','source_file'].includes(file.role)||!/^[a-f0-9]{64}$/.test(file.sha256))throw migrationError('业务原件未通过受控文件迁移');
      const bytes=await resolveFile(file.id,file);if(!Buffer.isBuffer(bytes)||bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw migrationError('迁移原件摘要不符');
      const extension=path.extname(file.filename||path.basename(file.sourcePath||'')).toLowerCase();if(!/^\.(?:xlsx?|csv|pdf|png|jpe?g|webp|gif|txt)$/.test(extension))throw migrationError('原件类型无效');
      const folder=path.join(dataDir,'workbench-migration-files');fs.mkdirSync(folder,{recursive:true});const destination=path.join(folder,file.sha256+extension);if(!fs.existsSync(destination)){fs.writeFileSync(destination,bytes,{flag:'wx'});newFiles.push(destination);}const written=fs.readFileSync(destination);if(written.length!==file.bytes||createHash('sha256').update(written).digest('hex')!==file.sha256)throw migrationError('入库后原件摘要校验失败');preparedFiles.set(record.kind+':'+record.sourceId+':'+file.role,destination);
    }}
    if(preview(input.bundle).revision!==input.revision)throw migrationError('准备期间云仓账本已变化，请重新核对');
    if(!await canCommit(actor,input))throw Object.assign(Error('迁移维护窗口或本批确认凭据已变化'),{status:409,code:'MIGRATION_CONFIRMATION_REQUIRED'});
    database.exec('BEGIN IMMEDIATE');
    try{
      for(const record of records){
        const row=plan.rows.find(r=>r.kind===record.kind&&r.sourceId===record.sourceId),selection=input.selections?.find(s=>s.kind===record.kind&&s.sourceId===record.sourceId);
        if(!selection)throw migrationError('迁移记录未逐项确认');
        if(selection.action==='skip'||row.action==='duplicate'){idMap.push({sourceId:row.sourceId,kind:row.kind,id:row.existingId,action:'skip'});continue;}
        if(row.action==='blocked'||!['add','update'].includes(selection.action))throw migrationError('存在未解决的云仓迁移差异');
        const table=record.kind,keys=migrationTables[table],payload=structuredClone(record.payload);
        if(row.action==='conflict'&&selection.action!=='update')throw migrationError('相同业务标识已存在，请逐项选择更新字段或跳过');
        if(selection.action==='update'&&!row.existingId)throw migrationError('需要更新的云仓记录不存在');
        if(selection.action==='update'){
          if(!keys)throw migrationError('历史审计和验证记录只能追加或跳过');
          const current=database.prepare('SELECT * FROM '+table+' WHERE '+keys.map(key=>key+'=?').join(' AND ')).get(...keys.map(key=>payload[key]));
          for(const difference of row.differences){const key=difference.field,choice=selection.fields?.[key];if(choice==='existing')payload[key]=current[key];else if(choice!=='incoming')throw migrationError('云仓冲突字段未逐项确认');else if(difference.emptyIncoming&&current[key]!=null&&current[key]!=='')throw migrationError('不能用空白覆盖现有云仓字段');}
        }
        if(table==='monthly_report_deliveries'){
          // Old send status is provenance, never permission to resend/skip a live job.
          const id=randomUUID();database.prepare('INSERT INTO workbench_migration_evidence VALUES(?,?,?,?,?,?,?)').run(id,input.bundle.sourceInstance,table,record.sourceId,JSON.stringify(payload),actor.id,new Date().toISOString());database.prepare('INSERT INTO workbench_migration_sources(source_instance,kind,source_id,version,target_key,actor_id,created_at,target_hash) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_instance,kind,source_id) DO UPDATE SET version=excluded.version,target_key=excluded.target_key,target_hash=excluded.target_hash').run(input.bundle.sourceInstance,table,record.sourceId,record.version,id,actor.id,new Date().toISOString(),hash(payload));idMap.push({sourceId:record.sourceId,kind:table,id,action:'evidence'});verified.push({kind:table,sourceId:record.sourceId,targetId:id,recordHash:hash(payload),evidence:true,verified:true});continue;
        }
        for(const file of record.files||[])payload[file.role]=preparedFiles.get(record.kind+':'+record.sourceId+':'+file.role);
        const fields=Object.keys(payload),values=fields.map(key=>payload[key]);
        let target;
        if(selection.action==='update'){
          const changed=fields.filter(key=>!keys.includes(key));database.prepare('UPDATE '+table+' SET '+changed.map(key=>key+'=?').join(',')+' WHERE '+keys.map(key=>key+'=?').join(' AND ')).run(...changed.map(key=>payload[key]),...keys.map(key=>payload[key]));target=payload;
        }else{
          const inserted=database.prepare('INSERT INTO '+table+' ('+fields.join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')').run(...values);target=keys?payload:{...payload,id:Number(inserted.lastInsertRowid)};
        }
        const written=keys?database.prepare('SELECT * FROM '+table+' WHERE '+keys.map(key=>key+'=?').join(' AND ')).get(...keys.map(key=>payload[key])):database.prepare('SELECT * FROM '+table+' WHERE id=?').get(target.id);
        if(!written||fields.some(key=>hash(written[key])!==hash(payload[key])))throw migrationError('写入后云仓逐字段校验失败');
        const targetKey=sourceKey(table,target);database.prepare('INSERT INTO workbench_migration_sources(source_instance,kind,source_id,version,target_key,actor_id,created_at,target_hash) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_instance,kind,source_id) DO UPDATE SET version=excluded.version,target_key=excluded.target_key,actor_id=excluded.actor_id,created_at=excluded.created_at,target_hash=excluded.target_hash').run(input.bundle.sourceInstance,table,record.sourceId,record.version,targetKey,actor.id,new Date().toISOString(),hash(payloadRow({...written},table)));
        database.prepare('INSERT INTO workbench_migration_evidence VALUES(?,?,?,?,?,?,?)').run(randomUUID(),input.bundle.sourceInstance,table,record.sourceId,JSON.stringify({beforeVersion:row.existingVersion,incomingVersion:record.version,selection,provenanceOnly:true}),actor.id,new Date().toISOString());idMap.push({sourceId:record.sourceId,kind:table,id:targetKey,action:selection.action});
        verified.push({kind:table,sourceId:record.sourceId,targetId:targetKey,recordHash:hash(payloadRow({...written},table)),verified:true});
      }
      const result={migrationId,module:'warehouse',idMap:Object.fromEntries(idMap.map(entry=>[entry.kind+':'+entry.sourceId,entry.id])),verified,verification:{ok:true,records:verified.length,skipped:idMap.length-verified.length},newFiles,revision:revisions()};database.prepare('INSERT INTO workbench_migration_results VALUES(?,?)').run(migrationId,JSON.stringify(result));database.exec('COMMIT');return result;
    }catch(error){database.exec('ROLLBACK');for(const file of newFiles)try{fs.unlinkSync(file);}catch{}throw error;}
  }
  function verify(id){const row=database.prepare('SELECT payload FROM workbench_migration_results WHERE id=?').get(id);if(!row)throw migrationError('迁移结果不存在');const result=JSON.parse(row.payload),differences=[];for(const record of result.verified){const table=record.kind;if(record.evidence){const evidence=database.prepare('SELECT payload FROM workbench_migration_evidence WHERE id=?').get(record.targetId);if(!evidence||hash(JSON.parse(evidence.payload))!==record.recordHash)differences.push({kind:table,targetId:record.targetId,reason:'来源证据已变化'});continue;}const keys=migrationTables[table],values=keys?JSON.parse(record.targetId):null;const actual=keys?database.prepare('SELECT * FROM '+table+' WHERE '+keys.map(key=>key+'=?').join(' AND ')).get(...values):read(table).find(row=>sourceKey(table,row)===record.targetId);if(!actual||hash(payloadRow({...actual},table))!==record.recordHash)differences.push({kind:table,targetId:record.targetId,reason:'迁移后记录已变化'});}return {migrationId:id,ok:differences.length===0,records:result.verified.length,differences};}
  const getDataSetIdentity=()=>({dataSetId:sourceInstance,revision:revisions(),dataAvailable:true});
  return {exportSnapshot,preview,commit,verify,getDataSetIdentity,database,close:()=>database.close()};
}
