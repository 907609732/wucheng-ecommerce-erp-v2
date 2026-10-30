import {randomUUID} from 'node:crypto';

const active=new Set(['collecting','collected','validating','cancelling']);
const retryable=new Set(['failed','cancelled','waiting-host-action']);
const fail=(code,message,statusCode=409)=>Object.assign(Error(message),{code,statusCode,workbenchPublic:true});
export function warehouseValidationSummary(v){if(!v)return null;const keys=['ok','valid','status','sourceDate','expectedSourceDate','month','periodStart','periodEnd','rowCount','skuCount','totalQuantity','totalSalesQuantity','sourceFileHash'];return {...Object.fromEntries(keys.filter(k=>v[k]!==undefined).map(k=>[k,v[k]])),errors:(v.errors||[]).slice(0,20),warnings:(v.warnings||[]).slice(0,20)};}
export function createWarehouseCollectionJournal({database,now=()=>new Date(),digest}){
  database.exec(`CREATE TABLE IF NOT EXISTS warehouse_agent_collection_jobs(
    id TEXT PRIMARY KEY,operation_key TEXT NOT NULL UNIQUE,actor_id TEXT NOT NULL,
    task_id TEXT NOT NULL,kind TEXT NOT NULL,month TEXT NOT NULL,payload TEXT NOT NULL);`);
  const write=job=>database.prepare('UPDATE warehouse_agent_collection_jobs SET payload=? WHERE id=?').run(JSON.stringify(job),job.id);
  function get(id,actor,{writeAccess=false}={}){
    const row=database.prepare('SELECT payload FROM warehouse_agent_collection_jobs WHERE id=?').get(id);
    if(!row)throw fail('WAREHOUSE_JOB_MISSING','采集编号不存在',404);
    const job=JSON.parse(row.payload);
    if(job.actorId!==actor.id&&(writeAccess||actor.role!=='admin'))throw fail('WAREHOUSE_JOB_FORBIDDEN','不能操作其他人员的采集任务',403);
    return job;
  }
  function update(id,patch){const row=database.prepare('SELECT payload FROM warehouse_agent_collection_jobs WHERE id=?').get(id);if(!row)throw fail('WAREHOUSE_JOB_MISSING','采集编号不存在',404);const old=JSON.parse(row.payload),job={...old,...patch,id:old.id,actorId:old.actorId,taskId:old.taskId,kind:old.kind,month:old.month,createdAt:old.createdAt,updatedAt:now().toISOString()};write(job);return job;}
  function claim(kind,month,ctx){
    // The same task/input never silently starts another browser after a lost reply.
    const key=digest([ctx.actor.id,ctx.taskId,kind,month||'']);
    const existing=database.prepare('SELECT payload FROM warehouse_agent_collection_jobs WHERE operation_key=?').get(key);
    if(existing)return {job:JSON.parse(existing.payload),claimed:false};
    // A new task is not permission to restart a previously uncertain export.
    const uncertain=database.prepare('SELECT payload FROM warehouse_agent_collection_jobs WHERE kind=? AND month=? ORDER BY rowid DESC').all(kind,month||'').map(r=>JSON.parse(r.payload)).find(j=>active.has(j.status)||j.status==='unknown');
    if(uncertain)return {job:uncertain,claimed:false};
    const time=now().toISOString(),job={id:randomUUID(),module:'warehouse',actorId:ctx.actor.id,taskId:ctx.taskId,kind,month:month||'',status:'collecting',attempt:1,createdAt:time,updatedAt:time,controllerPid:process.pid,history:[]};
    const claimed=database.prepare('INSERT OR IGNORE INTO warehouse_agent_collection_jobs VALUES(?,?,?,?,?,?,?)').run(job.id,key,job.actorId,job.taskId,kind,month||'',JSON.stringify(job));
    return claimed.changes===1?{job,claimed:true}:{job:JSON.parse(database.prepare('SELECT payload FROM warehouse_agent_collection_jobs WHERE operation_key=?').get(key).payload),claimed:false};
  }
  function retry(id,ctx){
    const job=get(id,ctx.actor,{writeAccess:true});
    if(!retryable.has(job.status))throw fail('WAREHOUSE_JOB_RETRY_DENIED','仅明确失败、已取消或已结束的登录接管可重试；处理中、完成或未知任务必须先查回');
    if(job.workerPid)try{process.kill(job.workerPid,0);throw fail('WAREHOUSE_JOB_STILL_RUNNING','采集进程仍在运行，不能重启');}catch(e){if(e.code==='WAREHOUSE_JOB_STILL_RUNNING')throw e;if(e.code!=='ESRCH')throw fail('WAREHOUSE_JOB_PROCESS_UNKNOWN','无法确认旧采集进程已结束');}
    return update(id,{status:job.sourceFile?'collected':'collecting',attempt:job.attempt+1,controllerPid:process.pid,workerPid:null,controlNonce:randomUUID(),cancelRequestedAt:null,errorCode:null,finishedAt:null,history:[...(job.history||[]),{attempt:job.attempt,status:job.status,errorCode:job.errorCode,finishedAt:job.finishedAt||job.updatedAt}]});
  }
  function list(actor){const rows=actor.role==='admin'?database.prepare('SELECT payload FROM warehouse_agent_collection_jobs ORDER BY rowid DESC LIMIT 100').all():database.prepare('SELECT payload FROM warehouse_agent_collection_jobs WHERE actor_id=? ORDER BY rowid DESC LIMIT 100').all(actor.id);return rows.map(r=>JSON.parse(r.payload));}
  function publicJob(job){return {module:'warehouse',jobId:job.id,taskId:job.taskId,kind:job.kind,month:job.month,status:job.status,complete:job.status==='completed',attempt:job.attempt,artifactId:job.artifactId||null,createdAt:job.createdAt,updatedAt:job.updatedAt,errorCode:job.errorCode||null,validation:warehouseValidationSummary(job.validation),...(job.cancelRequestedAt?{cancelRequestedAt:job.cancelRequestedAt}:{}),...(job.sha256?{sha256:job.sha256}:{})};}
  return {claim,get,update,retry,list,publicJob};
}
