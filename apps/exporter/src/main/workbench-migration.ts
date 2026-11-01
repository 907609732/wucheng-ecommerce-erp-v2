import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '../core/store';
import type {Task} from '../shared/types';

const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(canonical(v))??'undefined').digest('hex');
const error=(message:string)=>Object.assign(Error(message),{status:409,code:'MIGRATION_CONFLICT'});
function publicTask(task:Task){
  const {accountCookie:_cookie,cursor:_cursor,exportedPath:_path,detailExport:_detail,...safe}=task;
  return safe;
}
export function createWorkbenchMigration(store:Store,{resolveFile,canCommit=()=>false,dataDir=''}:{sourceInstance?:string;resolveFile?:(id:string,file:any)=>Promise<Buffer>|Buffer;canCommit?:(actor:any,plan:any)=>boolean;dataDir?:string}={}){
  store.db.exec('CREATE TABLE IF NOT EXISTS workbench_identity(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  if(!store.db.prepare('SELECT value FROM workbench_identity WHERE key=?').get('ledger-instance'))store.db.prepare('INSERT OR IGNORE INTO workbench_identity(key,value) VALUES(?,?)').run('ledger-instance',randomUUID());
  const sourceInstance=String((store.db.prepare('SELECT value FROM workbench_identity WHERE key=?').get('ledger-instance') as any).value);
  if(!/^[a-f0-9-]{36}$/.test(sourceInstance))throw error('账本身份无效，请保留现有数据并检查备份');
  store.db.exec('CREATE TABLE IF NOT EXISTS workbench_migration_sources(source_instance TEXT NOT NULL,source_id TEXT NOT NULL,version TEXT NOT NULL,target_id TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_instance,source_id));');
  if(!(store.db.prepare('PRAGMA table_info(workbench_migration_sources)').all() as any[]).some(column=>column.name==='target_hash'))store.db.exec("ALTER TABLE workbench_migration_sources ADD COLUMN target_hash TEXT NOT NULL DEFAULT ''");
  store.db.exec('CREATE TABLE IF NOT EXISTS workbench_migration_results(id TEXT PRIMARY KEY,payload TEXT NOT NULL);');
  const revision=()=>hash({dataSetId:sourceInstance,records:store.tasks().map(t=>[t.id,hash(t),hash(store.orders(t.id))])});
  const payload=(task:Task)=>({task:publicTask(task),orders:store.orders(task.id)});
  function exportSnapshot(){
    return {module:'exporter',schemaVersion:1,sourceInstance,revision:revision(),records:store.tasks().map(task=>{
      const data=payload(task),files:any[]=[];
      if(task.exportedPath&&fs.existsSync(task.exportedPath)&&fs.statSync(task.exportedPath).isFile()){const bytes=fs.readFileSync(task.exportedPath);files.push({id:task.id,role:'export',filename:path.basename(task.exportedPath),sourcePath:task.exportedPath,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
      return {kind:'task-history',sourceId:task.id,version:hash(data),payload:data,files};
    })};
  }
  function preview(bundle:any){
    if(bundle?.module!=='exporter'||bundle.schemaVersion!==1||!Array.isArray(bundle.records)||typeof bundle.sourceInstance!=='string')throw error('订单历史迁移格式不兼容');
    const seen=new Set<string>();
    const rows=bundle.records.map((record:any)=>{
      const issues:string[]=[];if(!record.sourceId||seen.has(record.sourceId))issues.push('来源记录标识重复或缺失');seen.add(record.sourceId);
      if(record.kind!=='task-history'||!record.payload?.task||!Array.isArray(record.payload?.orders)||record.version!==hash(record.payload))issues.push('来源快照摘要或结构不符');
      const task=record.payload?.task;
      if(task&&(['accountCookie','cursor','exportedPath','detailExport'].some(key=>Object.hasOwn(task,key))))issues.push('来源包含不允许迁移的登录或任务执行状态');
      if(task&&!['taobao','alibaba','pdd','jd','xianyu','dewu','kuaishou','eleme','meituan'].includes(task.platform))issues.push('平台无效');
      if(task&&record.payload.orders.some((o:any)=>o.platform!==task.platform||typeof o.id!=='string'||!o.id))issues.push('订单平台或字符串订单号无效');
      const mapped=store.db.prepare('SELECT * FROM workbench_migration_sources WHERE source_instance=? AND source_id=?').get(bundle.sourceInstance,record.sourceId) as any;
      let existing:Task|undefined;if(mapped)try{existing=store.get(mapped.target_id);}catch{}
      if(!existing&&task)existing=store.tasks().find(t=>t.platform===task.platform&&t.account===task.account&&t.accountKey===task.accountKey&&t.from===task.from&&t.to===task.to);
      if(mapped&&!existing)issues.push('来源关联的目标历史已不存在，请人工处理');
      const same=existing&&(mapped?.version===record.version&&mapped.target_hash===hash(payload(existing))||hash(payload(existing))===record.version);
      const differences=existing&&!same?Object.keys(record.payload).filter(k=>hash((payload(existing) as any)[k])!==hash(record.payload[k])).map(field=>({field,existing:(payload(existing!) as any)[field],incoming:record.payload[field],default:'existing',emptyIncoming:record.payload[field]==null||record.payload[field]===''})):[];
      return {module:'exporter',sourceInstance:bundle.sourceInstance,sourceId:record.sourceId,kind:record.kind,action:issues.length?'blocked':same?'duplicate':existing?'conflict':'new',issues,differences,existingId:existing?.id,existingVersion:existing?hash(payload(existing)):null,incoming:record.payload,proposed:record.payload};
    });return {schemaVersion:1,module:'exporter',sourceInstance:bundle.sourceInstance,revision:revision(),rows,counts:Object.fromEntries(['new','duplicate','conflict','blocked'].map(action=>[action,rows.filter((row:any)=>row.action===action).length]))};
  }
  async function commit(input:any,actor:any){
    if(actor?.role!=='admin'||!canCommit(actor,input))throw Object.assign(Error('迁移提交需要维护窗口与两次页面确认凭据'),{status:403,code:'MIGRATION_CONFIRMATION_REQUIRED'});
    const before=preview(input.bundle);if(input.revision!==before.revision)throw error('订单历史已变化，请重新核对');
    if(!Array.isArray(input.selections)||input.selections.length!==before.rows.length||new Set(input.selections.map((s:any)=>s.kind+':'+s.sourceId)).size!==before.rows.length)throw error('每条迁移记录必须有唯一核对选择');
    const preparedFiles=new Map<string,string>(),newFiles:string[]=[];
    for(const record of input.bundle.records){const selected=input.selections?.find((s:any)=>s.sourceId===record.sourceId&&s.kind===record.kind);if(selected?.action==='skip')continue;for(const file of record.files||[]){
      const extension=path.extname(file.filename||path.basename(file.sourcePath||'')).toLowerCase();if(!resolveFile||!dataDir||!/^[a-f0-9]{64}$/.test(file.sha256)||!/^\.(?:xlsx?|csv)$/.test(extension))throw error('导出原件未完成受控文件迁移');
      const bytes=await resolveFile(file.id,file);if(!Buffer.isBuffer(bytes)||bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw error('迁移原件摘要不符');
      const folder=path.join(dataDir,'workbench-migration-files');fs.mkdirSync(folder,{recursive:true});const destination=path.join(folder,file.sha256+extension);if(!fs.existsSync(destination)){fs.writeFileSync(destination,bytes,{flag:'wx'});newFiles.push(destination);}const written=fs.readFileSync(destination);if(written.length!==file.bytes||createHash('sha256').update(written).digest('hex')!==file.sha256)throw error('入库后原件摘要校验失败');preparedFiles.set(record.sourceId,destination);
    }}
    if(preview(input.bundle).revision!==input.revision)throw error('准备期间订单历史已变化，请重新核对');
    if(!canCommit(actor,input))throw Object.assign(Error('迁移维护窗口或本批确认凭据已变化'),{status:409,code:'MIGRATION_CONFIRMATION_REQUIRED'});
    const idMap:any[]=[];const verified:any[]=[];const migrationId=randomUUID();store.db.exec('BEGIN IMMEDIATE');
    try{
      for(const row of before.rows){
        const record=input.bundle.records.find((r:any)=>r.sourceId===row.sourceId&&r.kind===row.kind),selection=input.selections?.find((s:any)=>s.sourceId===row.sourceId&&s.kind===row.kind);
        if(!selection)throw error('迁移记录未逐项选择');
        if(selection.action==='skip'||row.action==='duplicate'){idMap.push({sourceId:row.sourceId,id:row.existingId||null,action:'skip'});continue;}
        if(row.action==='blocked')throw error('存在禁止迁移的记录');
        if(!['add','update'].includes(selection.action))throw error('迁移选择无效');
        const incoming=structuredClone(record.payload);let targetId:string=randomUUID();
        if(selection.action==='update'){
          if(!row.existingId)throw error('要更新的历史记录不存在');
          const existing=store.get(row.existingId);if(!existing.historicalOnly)throw error('当前主机采集任务不能被历史证据覆盖，请另存为历史任务或跳过');
          targetId=existing.id;
          for(const field of ['task','orders']){const choice=selection.fields?.[field];if(choice==='existing')incoming[field]=(payload(existing) as any)[field];else if(choice!=='incoming'&&row.differences.some((difference:any)=>difference.field===field))throw error('历史冲突字段未逐项确认');}
        }
        const exported=(record.files||[]).find((f:any)=>f.role==='export');
        const original=incoming.task;
        const task:Task={...original,id:targetId,status:original.status==='completed'?'completed':'paused',cursor:'',exportedPath:exported?preparedFiles.get(record.sourceId)||'':'',historicalOnly:true,sourceProvenance:{instance:input.bundle.sourceInstance,id:record.sourceId,version:record.version,originalStatus:original.status},message:'从旧客户端保存的历史证据；不包含登录资料，不能恢复原采集进程'};
        store.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,payload=excluded.payload').run(targetId,task.platform,JSON.stringify(task));
        store.db.prepare('DELETE FROM task_orders WHERE task_id=?').run(targetId);
        const add=store.db.prepare('INSERT INTO task_orders VALUES(?,?,?)');for(const order of incoming.orders)add.run(targetId,order.id,JSON.stringify(order));
        if(hash(store.orders(targetId))!==hash(incoming.orders))throw error('迁移后订单逐项校验失败');
        if(store.orders(targetId).length!==Number(task.count))throw error('迁移后任务数量与订单明细不一致');
        store.db.prepare('INSERT INTO workbench_migration_sources(source_instance,source_id,version,target_id,actor_id,created_at,target_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_instance,source_id) DO UPDATE SET version=excluded.version,target_id=excluded.target_id,actor_id=excluded.actor_id,created_at=excluded.created_at,target_hash=excluded.target_hash').run(input.bundle.sourceInstance,record.sourceId,record.version,targetId,actor.id,new Date().toISOString(),hash(payload(task)));
        idMap.push({sourceId:record.sourceId,id:targetId,action:selection.action});
        verified.push({kind:record.kind,sourceId:record.sourceId,targetId,recordHash:hash(payload(task)),verified:true});
      }
      const result={migrationId,module:'exporter',idMap:Object.fromEntries(idMap.map(entry=>['task-history:'+entry.sourceId,entry.id])),verified,verification:{ok:true,records:verified.length,skipped:idMap.length-verified.length},newFiles,revision:revision()};store.db.prepare('INSERT INTO workbench_migration_results VALUES(?,?)').run(migrationId,JSON.stringify(result));store.db.exec('COMMIT');return result;
    }catch(e){store.db.exec('ROLLBACK');for(const file of newFiles)try{fs.unlinkSync(file);}catch{}throw e;}
  }
  function verify(id:string){const row=store.db.prepare('SELECT payload FROM workbench_migration_results WHERE id=?').get(id) as any;if(!row)throw error('迁移结果不存在');const result=JSON.parse(row.payload),differences:any[]=[];for(const record of result.verified){let actual;try{actual=store.get(record.targetId);}catch{}if(!actual||hash(payload(actual))!==record.recordHash)differences.push({kind:record.kind,targetId:record.targetId,reason:'迁移后记录已变化'});}return {migrationId:id,ok:differences.length===0,records:result.verified.length,differences};}
  const getDataSetIdentity=()=>({dataSetId:sourceInstance,revision:revision(),dataAvailable:true});
  return {exportSnapshot,preview,commit,verify,getDataSetIdentity};
}
