import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createWarehouseDaily,businessDate,expectedInventoryDate} from '../../core/erp/warehouse-daily.js';
import {readCainiaoInventory,inventorySnapshotFingerprint} from '../shared/inventory-store.mjs';
import {WAREHOUSE_TABLES} from '../../core/erp/warehouse-schema.js';
import {terminateProcessTree} from '../shared/task-process.mjs';
import {warehouseCapabilitySchema,validateWarehouseAgentInput} from './warehouse-agent-schema.mjs';
import {readWarehouseLegacySchedules} from './warehouse-agent-schedules.mjs';
import {createWarehouseArtifactMaterializer} from './warehouse-agent-artifacts.mjs';
import {createWarehouseCollectionJournal,warehouseValidationSummary} from './warehouse-agent-jobs.mjs';

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(x=>canonical(x??null)).join(',')+']':'{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export const warehouseAgentDigest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const error=(code,message,statusCode=409)=>Object.assign(Error(message),{code,statusCode,workbenchPublic:true});
const schema=properties=>({type:'object',properties,additionalProperties:false});
const str={type:'string',minLength:1,maxLength:160};
const employeeEditFields=['name','email','mobile','dingtalkUserId','task','deadline','workdays','channels','enabled'];
const cap=(id,title,kind,properties={},requiresReview=kind==='prepare')=>({id,title,kind,description:title,inputSchema:warehouseCapabilitySchema(id),requiresReview,...(id==='employees.configure'?{resultEditFields:employeeEditFields}:{})});
const taskCapabilities=new Set(['inventory.collect','inventory.import','inventory.send','inventory.send-latest-valid','sales.collect','sales.backfill','sales.import','sales.send','login.refresh','collection.retry','collection.cancel']);
const adminCapabilities=new Set(['employees.configure','remind','backup','debug.bundle']);
export const WAREHOUSE_AGENT_CAPABILITIES=[
  cap('inventory','查看云仓库存与补货预警','query'),cap('sales','查询云仓月销量与缺失月份','query',{from:str,to:str,sku:str}),
  cap('login.refresh','在主机刷新菜鸟登录，验证码由本人处理','prepare'),
  cap('daily','查看今日闭环、本人任务与提醒记录','query'),cap('sources','核验原件与同步批次','query',{artifactId:str}),
  cap('schedules.legacy','读取旧日/月/催办计划及统一调度迁移建议（不更改配置）','query'),
  cap('diagnostics','只读检查云仓配置、浏览器、锁和登录态结构；不联网、不回显秘密','query'),
  cap('logs','搜索固定云仓运行日志；脱敏且不接受任意路径','query'),
  cap('configuration','读取业务设置与凭据就绪标记；密码和密钥仅在主机录入','query'),
  cap('debug.bundle','生成脱敏诊断包并登记可下载原件','prepare',{},false),
  cap('collection.jobs','按持久编号回查采集终态，不重启未知任务','query'),
  cap('collection.retry','仅重试本人明确失败、已取消或等待登录的采集；未知先查回','prepare',{},false),
  cap('collection.cancel','按持久编号请求停止本人采集，并回查真实取消终态','prepare',{},false),
  cap('inventory.collect','采集并校验最新库存原件，不入库或发送','prepare',{},false),
  cap('inventory.import','复核并导入已采集库存','prepare',{artifactId:str}),
  cap('sales.collect','采集并校验完整月份原件，不入库','prepare',{month:str},false),
  cap('sales.backfill','采集并复核指定范围的缺失月份','prepare',{from:str,to:str}),
  cap('sales.import','复核并导入已采集月销量','prepare',{artifactId:str}),
  cap('inventory.send','预览并发送当前有效库存报告','prepare'),cap('sales.send','预览并发送月销量报告','prepare',{month:str}),
  cap('inventory.send-latest-valid','沿用最近有效快照发送；明确标注非今日新采集，不计入今日日结','prepare'),
  cap('attendance.check-in','本人今日签到','prepare'),cap('attendance.complete','本人核对今日批次并确认完成','prepare',{note:{type:'string',maxLength:500}}),
  cap('employees.configure','复核员工安排与催办配置','prepare',{employees:{type:'array',maxItems:300,items:{type:'object'}},autoRemind:{type:'boolean'}}),
  cap('remind','复核指定员工与渠道后催办','prepare',{logins:{type:'array',items:str,maxItems:300},channels:{type:'array',items:{enum:['email','dingtalk','sms','phone']},maxItems:4}}),
  cap('backup','创建可核对的云仓账本备份','prepare',{},false)
];

function actor(ctx,write=false,admin=false){
  const a=ctx?.actor;
  if(!a?.id)throw error('WAREHOUSE_FORBIDDEN','当前身份无云仓访问权限',403);
  if(!ctx.taskId)throw error('WAREHOUSE_CONTEXT_REQUIRED','缺少可信任务上下文',400);
  ctx.signal?.throwIfAborted();return a;
}
async function inputFor(id,input,nowValue){
  const c=WAREHOUSE_AGENT_CAPABILITIES.find(c=>c.id===id);if(!c)throw error('WAREHOUSE_CAPABILITY_UNKNOWN','未知云仓能力',400);
  if(!input||typeof input!=='object'||Array.isArray(input))throw error('WAREHOUSE_INPUT_INVALID','参数必须为对象',400);
  const reserved=new Set(['actor','approval','confirmed','confirmSend','proof','channel','role','commitData']);
  function scan(v){if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){if(reserved.has(k))throw error('WAREHOUSE_INPUT_INVALID','模型不得提供身份或确认凭据',400);scan(x);}}
  scan(input);
  for(const k of Object.keys(input))if(!Object.hasOwn(c.inputSchema.properties,k))throw error('WAREHOUSE_INPUT_INVALID','不支持的参数：'+k,400);
  await validateWarehouseAgentInput(id,input,{now:nowValue});
  return c;
}

/** Host-side proxy: transport(module,route,options) MUST derive actor from its authenticated
 * session and send approval through the signed module transport, never from model input.
 * Module-side factory: databasePath/workspace/getEnvironment/verifyApproval/workbenchKey.
 * getEnvironment() is host-only; verifyApproval is central verifyAgentApproval.
 */
export function createWarehouseAgentAdapter(deps={}){
  if(deps.transport){const materialize=createWarehouseArtifactMaterializer(deps.transport);const call=(op,payload,ctx)=>{const read=['binding','query','receipt'].includes(op),params={...payload,taskId:ctx.taskId},route='/api/integration/v1/agent/'+op;return deps.transport('warehouse',read?route+'?payload='+encodeURIComponent(JSON.stringify(params)):route,{method:read?'GET':'POST',...(read?{}:{body:params}),ctx,signal:ctx?.signal});};return {id:'warehouse',capabilities:structuredClone(WAREHOUSE_AGENT_CAPABILITIES),binding:ctx=>call('binding',{},ctx),query:async(capabilityId,input,ctx)=>materialize(await call('query',{capabilityId,input},ctx),ctx),prepare:async(capabilityId,input,ctx)=>materialize(await call('prepare',{capabilityId,input},ctx),ctx),commit:(prepared,ctx)=>call('commit',{prepared},ctx),receipt:(idempotencyKey,ctx)=>call('receipt',{idempotencyKey},ctx),cancel:async ctx=>{const control={...ctx,signal:undefined,capabilityId:'collection.cancel'},state=await call('query',{capabilityId:'collection.jobs',input:{}},control),results=[];for(const job of state.data.jobs.filter(j=>j.taskId===ctx.taskId&&['collecting','collected','validating','cancelling','unknown'].includes(j.status)))results.push(await call('prepare',{capabilityId:'collection.cancel',input:{jobId:job.jobId}},control));return {results};}};}
  const {databasePath,workspace,verifyApproval,workbenchKey,getEnvironment=async()=>({}),now=()=>new Date()}=deps;
  if(!databasePath||!workspace||!fs.existsSync(databasePath))throw error('WAREHOUSE_LEDGER_MISSING','必须绑定现有云仓账本，不能创建空账本',503);
  const db=new DatabaseSync(databasePath,{timeout:5000});
  db.exec(`CREATE TABLE IF NOT EXISTS warehouse_agent_artifacts(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS warehouse_agent_prepared(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS warehouse_agent_receipts(key TEXT PRIMARY KEY,actor_id TEXT NOT NULL,task_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL);`);
  const dir=path.join(path.resolve(workspace),'agent-warehouse');fs.mkdirSync(dir,{recursive:true});
  const configurationFiles=[deps.settingsPath||path.join(path.dirname(workspace),'settings.json'),deps.secretsPath||path.join(path.dirname(workspace),'secrets.bin'),path.join(workspace,'config.json')];
  const configurationDigest=()=>warehouseAgentDigest(configurationFiles.map(file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):'missing'));
  function notificationScope(){try{const s=JSON.parse(fs.readFileSync(configurationFiles[0]));return Object.fromEntries(['deliveryMode','dingtalkRobotCode','dingtalkConversationId','dingtalkTargetUserId','dingtalkTargetName'].map(k=>[k,s[k]||'']));}catch{return {configured:false};}}
  const daily=createWarehouseDaily({databasePath,now,senders:deps.senders,getChannels:deps.getChannels});
  const collections=createWarehouseCollectionJournal({database:db,now,digest:warehouseAgentDigest}),activeCollections=new Map();
  function taskLock(collectionJobId){const file=path.join(workspace,'state','desktop-task.lock');fs.mkdirSync(path.dirname(file),{recursive:true});const runId=randomUUID();
    try{fs.writeFileSync(file,JSON.stringify({pid:process.pid,runId,kind:'agent-warehouse',...(collectionJobId?{jobId:collectionJobId}:{}),startedAt:now().toISOString()}),{flag:'wx'});}catch(e){if(e.code==='EEXIST')throw error('WAREHOUSE_BUSY','云仓旧任务或其他Agent任务正在运行；先核对锁及回执，不并行重试');throw e;}
    if(collectionJobId)collections.update(collectionJobId,{lockRunId:runId});
    return ()=>{try{if(JSON.parse(fs.readFileSync(file)).runId===runId)fs.unlinkSync(file);}catch{}};}
  const save=(table,id,value)=>db.prepare('INSERT INTO '+table+' VALUES(?,?)').run(id,JSON.stringify(value));
  const load=(table,id)=>{const r=db.prepare('SELECT payload FROM '+table+' WHERE id=?').get(id);if(!r)throw error('WAREHOUSE_ARTIFACT_MISSING','云仓准备结果不存在',404);return JSON.parse(r.payload);};
  function binding(ctx){actor(ctx);const identity=db.prepare("SELECT value FROM workbench_identity WHERE key='ledger-instance'").get();if(!identity?.value)throw error('WAREHOUSE_IDENTITY_MISSING','现有账本缺少数据集身份，须由主机迁移工具处理',503);
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name).filter(n=>WAREHOUSE_TABLES.has(n)).sort();
    const revision=warehouseAgentDigest({records:names.map(n=>[n,db.prepare('SELECT * FROM "'+n+'"').all().map(r=>canonical(r)).sort()]),configuration:configurationDigest()});return {dataSetId:identity.value,revision};}
  function sameBinding(b,ctx){if(canonical(binding(ctx))!==canonical(b))throw error('WAREHOUSE_STALE','云仓账本已变化，请重新生成复核结果');}
  async function worker(op,input,ctx,collectionJobId){actor(ctx);ctx.emit?.('progress',{phase:op,module:'warehouse',...(collectionJobId?{jobId:collectionJobId}:{})});
    const job=path.join(dir,randomUUID()+'.json'),out=job+'.result';let env;try{env=await getEnvironment();}catch{throw error('WAREHOUSE_WORKER_NOT_STARTED','主机配置读取失败，子进程未启动');}
    let collectionControl;if(collectionJobId){const saved=collections.get(collectionJobId,ctx.actor,{writeAccess:true});const controlPath=saved.controlPath||path.join(dir,'collection-'+collectionJobId+'.control.json'),controlNonce=saved.controlNonce||randomUUID();collections.update(collectionJobId,{controlPath,controlNonce});collectionControl={path:controlPath,nonce:controlNonce};}
    fs.writeFileSync(job,JSON.stringify({op,input,databasePath,workspace,now:now().toISOString(),...(collectionControl?{collectionControl}:{})}),{flag:'wx'});
    if(collectionJobId)collections.update(collectionJobId,{manifestPath:job,outputPath:out});
    try{ctx.signal?.throwIfAborted();return await new Promise((resolve,reject)=>{
      const child=spawn(deps.nodePath||process.execPath,[fileURLToPath(new URL('../../core/warehouse-agent-worker.mjs',import.meta.url)),job,out],{env:{...process.env,...env,ELECTRON_RUN_AS_NODE:'1',CAINIAO_APP_DATA_DIR:workspace,ERP_DATA_DIR:path.dirname(databasePath)},windowsHide:true,stdio:['ignore','ignore','ignore']});
      if(collectionJobId&&child.pid)collections.update(collectionJobId,{workerPid:child.pid});
      let settled=false;const finish=(e,value)=>{if(settled)return;settled=true;ctx.signal?.removeEventListener('abort',onAbort);e?reject(e):resolve(value);};
      const onAbort=()=>{void terminateProcessTree(child).then(()=>finish(ctx.signal.reason||error('WAREHOUSE_ABORTED','云仓任务已中止')),()=>finish(error('WAREHOUSE_STOP_UNKNOWN','子进程停止结果未知，请核对任务锁和回执')));};
      ctx.signal?.addEventListener('abort',onAbort,{once:true});if(ctx.signal?.aborted)onAbort();
      child.once('error',e=>finish(child.pid?e:error('WAREHOUSE_WORKER_NOT_STARTED','采集子进程未启动')));child.once('exit',code=>{if(ctx.signal?.aborted)return;try{const r=JSON.parse(fs.readFileSync(out));if(!r.ok)throw error(r.code||'WAREHOUSE_DOMAIN_ERROR',r.message||'云仓领域任务失败');if(code!==0)throw error('WAREHOUSE_WORKER_EXIT','云仓进程异常退出');finish(null,r.value);}catch(e){finish(e);}});
    });}finally{if(!collectionJobId){fs.rmSync(job,{force:true});fs.rmSync(out,{force:true});}}}
  function collectionFailure(jobId,e,ctx){const status=e.code==='WAREHOUSE_COLLECTION_CANCELLED'||ctx.signal?.aborted&&e.code!=='WAREHOUSE_STOP_UNKNOWN'?'cancelled':e.code==='CAINIAO_AUTH_REQUIRED'?'waiting-host-action':['WAREHOUSE_WORKER_NOT_STARTED','WAREHOUSE_BUSY'].includes(e.code)?'failed':'unknown';return collections.update(jobId,{status,errorCode:status==='cancelled'?'WAREHOUSE_COLLECTION_CANCELLED':String(e.code||'WAREHOUSE_COLLECTION_UNKNOWN'),finishedAt:now().toISOString()});}
  async function finalizeCollection(job,ctx){
    if(collections.get(job.id,ctx.actor).cancelRequestedAt)throw error('WAREHOUSE_COLLECTION_CANCELLED','采集已取消，原件保留，未入库或发送');
    const id=job.artifactId||randomUUID(),file=fs.realpathSync(job.sourceFile),root=fs.realpathSync(workspace)+path.sep;
    if(!file.startsWith(root))throw error('WAREHOUSE_SOURCE_OUTSIDE','采集文件不在云仓工作目录');
    const folder=path.join(dir,'sources');fs.mkdirSync(folder,{recursive:true});const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex'),stored=job.storedFile||path.join(folder,id+path.extname(file));
    if(fs.existsSync(stored)){if(createHash('sha256').update(fs.readFileSync(stored)).digest('hex')!==hash)throw error('WAREHOUSE_SOURCE_CHANGED','恢复原件摘要不一致');}else fs.writeFileSync(stored,bytes,{flag:'wx'});
    collections.update(job.id,{status:'validating',artifactId:id,storedFile:stored,sha256:hash});
    const validation=await worker('validate',{kind:job.kind,file:stored,...(job.month?{month:job.month}:{})},ctx);
    if(collections.get(job.id,ctx.actor).cancelRequestedAt)throw error('WAREHOUSE_COLLECTION_CANCELLED','校验等待已取消，原件保留，未入库或发送');
    const a={id,kind:job.kind,file:stored,hash,validation,month:job.month,createdAt:job.createdAt,actorId:job.actorId,taskId:job.taskId,jobId:job.id};
    const previous=db.prepare('SELECT payload FROM warehouse_agent_artifacts WHERE id=?').get(id);if(!previous)save('warehouse_agent_artifacts',id,a);else if(JSON.parse(previous.payload).hash!==hash)throw error('WAREHOUSE_SOURCE_CHANGED','恢复原件登记冲突');
    releaseRecoveredLock(job);return {artifact:a,job:collections.update(job.id,{status:(validation.ok??validation.valid)?'completed':'invalid',validation,artifactId:id,sha256:hash,workerPid:null,finishedAt:now().toISOString()})};
  }
  function releaseRecoveredLock(job){
    // Only an exact journal-owned lock can be archived, after both tracked
    // processes are confirmed gone. Legacy locks and unknown owners are untouched.
    if(!job.lockRunId||!job.controllerPid||job.controllerPid===process.pid)return;
    for(const pid of [job.controllerPid,job.workerPid].filter(Boolean))try{process.kill(pid,0);return;}catch(e){if(e.code!=='ESRCH')return;}
    const file=path.join(workspace,'state','desktop-task.lock');let held;try{held=JSON.parse(fs.readFileSync(file));}catch{return;}
    if(held.kind!=='agent-warehouse'||held.pid!==job.controllerPid||held.jobId!==job.id||held.runId!==job.lockRunId)return;
    fs.renameSync(file,path.join(dir,'recovered-lock-'+job.id+'-'+randomUUID()+'.json'));
  }
  async function recoverCollection(job,ctx){
    if(job.actorId!==ctx.actor.id)return {job};
    if(['completed','invalid'].includes(job.status)){const a=artifact(job.artifactId,ctx);releaseRecoveredLock(job);return {job,artifact:a};}
    if(activeCollections.has(job.id))return {job};
    if(['cancelled','failed','waiting-host-action'].includes(job.status)){releaseRecoveredLock(job);return {job};}
    if(job.workerPid)try{process.kill(job.workerPid,0);return {job};}catch(e){if(e.code!=='ESRCH')return {job:collections.update(job.id,{status:'unknown',errorCode:'WAREHOUSE_JOB_PROCESS_UNKNOWN'})};}
    if(!job.sourceFile&&job.outputPath&&fs.existsSync(job.outputPath)){
      let result;try{result=JSON.parse(fs.readFileSync(job.outputPath,'utf8'));}catch{return {job:collections.update(job.id,{status:'unknown',errorCode:'WAREHOUSE_COLLECTION_OUTPUT_INVALID'})};}
      if(!result.ok){const status=result.code==='WAREHOUSE_COLLECTION_CANCELLED'?'cancelled':result.code==='CAINIAO_AUTH_REQUIRED'?'waiting-host-action':result.code==='WAREHOUSE_WORKER_NOT_STARTED'?'failed':'unknown';if(status!=='unknown')releaseRecoveredLock(job);return {job:collections.update(job.id,{status,errorCode:result.code||'WAREHOUSE_COLLECTION_FAILED',finishedAt:now().toISOString()})};}
      if(result.value?.file)job=collections.update(job.id,{status:'collected',sourceFile:result.value.file,workerPid:null});
    }
    if(!job.sourceFile)return {job:collections.update(job.id,{status:'unknown',errorCode:'WAREHOUSE_COLLECTION_RESULT_UNKNOWN'})};
    if(job.cancelRequestedAt){releaseRecoveredLock(job);return {job:collections.update(job.id,{status:'cancelled',finishedAt:now().toISOString()})};}
    const work=finalizeCollection(job,ctx).catch(e=>({job:collectionFailure(job.id,e,ctx)}));activeCollections.set(job.id,work);try{return await work;}finally{activeCollections.delete(job.id);}
  }
  async function collectArtifact(kind,input,ctx,{retry=false}={}){
    const claim=input.jobId?{job:collections.get(input.jobId,ctx.actor,{writeAccess:true}),claimed:false}:collections.claim(kind,input.month,ctx);
    if(claim.job.actorId!==ctx.actor.id)throw error('WAREHOUSE_OTHER_COLLECTION_PENDING','另一人员的采集尚未确定终态，须原执行者或管理员先查回；不能冒用身份重启');
    if(claim.job.kind!==kind||claim.job.month!==(input.month||''))throw error('WAREHOUSE_JOB_INPUT_CHANGED','采集编号与月份或业务类型不一致');
    if(!claim.claimed&&!retry)return recoverCollection(claim.job,ctx);
    let job=claim.job;if(retry){if(job.outputPath&&fs.existsSync(job.outputPath)){try{const r=JSON.parse(fs.readFileSync(job.outputPath));if(r.ok&&r.value?.file)job=collections.update(job.id,{sourceFile:r.value.file});}catch{}}releaseRecoveredLock(job);job=collections.retry(job.id,ctx);}
    const work=(async()=>{try{if(!job.sourceFile){const release=taskLock(job.id);try{const value=await worker('collect',{kind,...(job.month?{month:job.month}:{})},ctx,job.id);job=collections.update(job.id,{status:'collected',sourceFile:value.file,workerPid:null});}finally{release();}}return await finalizeCollection(job,ctx);}catch(e){return {job:collectionFailure(job.id,e,ctx)};}})();
    activeCollections.set(job.id,work);try{return await work;}finally{activeCollections.delete(job.id);}
  }
  function cancelCollection(jobId,ctx){
    let job=collections.get(jobId,ctx.actor,{writeAccess:false});if(['completed','invalid','failed','cancelled','waiting-host-action'].includes(job.status))return {job};
    const controlPath=job.controlPath||path.join(dir,'collection-'+job.id+'.control.json'),controlNonce=job.controlNonce||randomUUID();
    job=collections.update(jobId,{status:'cancelling',controlPath,controlNonce,cancelRequestedAt:now().toISOString(),cancelRequestedBy:ctx.actor.id});
    fs.writeFileSync(controlPath,JSON.stringify({nonce:controlNonce,action:'cancel'}),{mode:0o600});
    // The worker authenticates the nonce and closes its own browser. Never kill
    // an unverified historical PID that may now belong to another application.
    if(!job.manifestPath&&!job.workerPid&&!activeCollections.has(job.id))job=collections.update(job.id,{status:'cancelled',finishedAt:now().toISOString()});
    return {job};
  }
  function artifact(id,ctx){const a=load('warehouse_agent_artifacts',id);if(a.actorId!==ctx.actor.id)throw error('WAREHOUSE_ARTIFACT_FORBIDDEN','不能使用其他人员采集的原件',403);if(createHash('sha256').update(fs.readFileSync(a.file)).digest('hex')!==a.hash)throw error('WAREHOUSE_SOURCE_CHANGED','采集原件摘要已变化');return a;}
  async function rawQuery(id,input={},ctx){actor(ctx);await inputFor(id,input,now());switch(id){
    case 'inventory':return readCainiaoInventory(databasePath);
    case 'sales':return worker('sales.query',input,ctx);
    case 'daily':return daily.status(ctx.actor);
    case 'diagnostics':{if(typeof deps.collectDiagnostics!=='function')throw error('WAREHOUSE_HOST_DIAGNOSTICS_UNAVAILABLE','主机尚未注入只读诊断服务',503);const d=await deps.collectDiagnostics();return {generatedAt:d.generatedAt,version:d.version,runtime:d.runtime,health:d.health,checks:d.checks,configuration:d.configuration,recommendations:d.recommendations,safety:d.safety};}
    case 'logs':{if(typeof deps.searchDebugLogs!=='function')throw error('WAREHOUSE_HOST_DIAGNOSTICS_UNAVAILABLE','主机尚未注入脱敏日志服务',503);return {lines:await deps.searchDebugLogs({level:input.level||'any',query:input.query||'',limit:input.limit||30})};}
    case 'configuration':{actor(ctx,false,true);if(typeof deps.getConfiguration!=='function')throw error('WAREHOUSE_HOST_CONFIGURATION_UNAVAILABLE','主机尚未注入脱敏配置服务',503);const s=await deps.getConfiguration();return {lowStockThreshold:s.lowStockThreshold,deliveryMode:s.deliveryMode,dingtalkRobotCode:s.dingtalkRobotCode,dingtalkConversationId:s.dingtalkConversationId,dingtalkTargetUserId:s.dingtalkTargetUserId,dingtalkTargetName:s.dingtalkTargetName,secretFlags:s.secretFlags,credentialEntry:'host-only',schedulingOwner:process.env.LINGTU_AGENT_MANAGED==='1'?'agent':'legacy'};}
    case 'collection.jobs':{const jobs=input.jobId?[collections.get(input.jobId,ctx.actor)]:collections.list(ctx.actor);const outcomes=[];for(const job of jobs)outcomes.push(await recoverCollection(job,ctx));return {jobs:outcomes.map(o=>collections.publicJob(o.job)),artifacts:outcomes.filter(o=>o.artifact).map(o=>({jobId:o.job.id,artifactId:o.artifact.id,sha256:o.artifact.hash,filename:path.basename(o.artifact.file)}))};}
    case 'schedules.legacy':{actor(ctx,false,true);const state=await daily.status(ctx.actor);return readWarehouseLegacySchedules({settingsPath:configurationFiles[0],dailyConfig:state.config,dataSetId:binding(ctx).dataSetId,requestedBy:ctx.actor,configurationRevision:warehouseAgentDigest({configuration:configurationDigest(),dailyConfig:state.config})});}
    case 'sources':{if(input.artifactId){const a=artifact(input.artifactId,ctx);return {artifactId:a.id,sha256:a.hash,filename:path.basename(a.file),validation:a.validation,createdAt:a.createdAt};}return {runs:db.prepare('SELECT id,business_date,started_at,payload FROM warehouse_sync_runs ORDER BY started_at DESC LIMIT 100').all().map(r=>JSON.parse(r.payload))};}
    default:throw error('WAREHOUSE_NOT_QUERY','该能力需要准备结果',400);}}
  async function query(id,input={},ctx){const data=await rawQuery(id,input,ctx),blocks=[{type:'table',title:id,rows:id==='inventory'?data.items:id==='sales'?data.monthly:id==='daily'?data.employees:data.runs||[data]}];
    if(id==='inventory')blocks.push({type:'table',title:'库存来源与校验',rows:[{sourceDate:data.sourceDate,skuCount:data.skuCount,totalQuantity:data.totalQuantity,validation:data.validation}]});
    if(id==='sales')blocks.push({type:'table',title:'SKU销量趋势',rows:data.skuSeries},{type:'table',title:'销量排名',rows:data.ranking},{type:'table',title:'月度汇总',rows:[data.summary]});
    if(id==='daily')blocks.push({type:'table',title:'今日同步闭环',rows:[data.sync]},{type:'table',title:'员工任务统计',rows:[data.team]},{type:'table',title:'提醒回执',rows:data.reminders});
    if(id==='diagnostics')blocks.push({type:'table',title:'只读环境检查',rows:data.checks},{type:'table',title:'建议',rows:(data.recommendations||[]).map(message=>({message}))});
    if(id==='logs')blocks.push({type:'table',title:'脱敏日志',rows:(data.lines||[]).map(line=>typeof line==='string'?{line}:line)});
    if(id==='schedules.legacy')blocks.push({type:'table',title:'可迁入统一调度的计划',rows:data.candidates},{type:'table',title:'原设置和时区',rows:[{...data.source,localTimeZone:data.localTimeZone,businessTimeZone:data.businessTimeZone,legacyTimersDisabled:data.legacyTimersDisabled}]});
    if(id==='collection.jobs'){for(const job of data.jobs)blocks.push({type:'job',title:'采集任务',...job});return {summary:'已按持久采集编号回查；没有启动新的导出',scope:{module:'warehouse',...binding(ctx)},blocks,evidence:data.artifacts.map(a=>({...a,module:'warehouse',complete:data.jobs.find(j=>j.jobId===a.jobId)?.complete===true,status:data.jobs.find(j=>j.jobId===a.jobId)?.status})),issues:data.jobs.filter(j=>!j.complete).map(j=>({blocking:true,module:'warehouse',jobId:j.jobId,code:'WAREHOUSE_COLLECTION_'+j.status.toUpperCase().replaceAll('-','_'),message:'采集尚未取得可入库终态：'+j.status})),data};}
    return {summary:WAREHOUSE_AGENT_CAPABILITIES.find(c=>c.id===id).title,scope:{module:'warehouse',...binding(ctx),businessDate:businessDate(now()),timeZone:'Asia/Shanghai'},blocks,evidence:id==='sources'&&data.sha256?[{artifactId:data.artifactId,sha256:data.sha256,filename:data.filename}]:[],data};}
  async function prepare(id,input={},ctx){const c=await inputFor(id,input,now());actor(ctx,true,adminCapabilities.has(id));if(c.kind!=='prepare')throw error('WAREHOUSE_NOT_PREPARE','该能力只可查询',400);
    const before=binding(ctx);let commitData={id,input:structuredClone(input)},blocks=[],evidence=[],changes=[],issues=[];
    if(id.endsWith('.collect')||id==='collection.retry'||id==='collection.cancel'){const original=id.startsWith('collection.')?collections.get(input.jobId,ctx.actor,{writeAccess:id!=='collection.cancel'}):null;const outcome=id==='collection.cancel'?cancelCollection(input.jobId,ctx):await collectArtifact(original?.kind||(id.startsWith('inventory')?'inventory':'sales'),original?{jobId:original.id,month:original.month}:input,ctx,{retry:id==='collection.retry'}),j=collections.publicJob(outcome.job),a=outcome.artifact;blocks=[{type:'job',title:'菜鸟采集',...j}];if(a){commitData.artifactIds=[a.id];blocks.push({type:'table',title:'采集校验结果',rows:[{artifactId:a.id,kind:a.kind,sha256:a.hash,...warehouseValidationSummary(a.validation)}]});evidence=[{module:'warehouse',jobId:j.jobId,complete:j.complete,status:j.status,artifactId:a.id,sha256:a.hash,filename:path.basename(a.file)}];}if(!j.complete)issues.push({blocking:true,module:'warehouse',jobId:j.jobId,code:'WAREHOUSE_COLLECTION_'+j.status.toUpperCase().replaceAll('-','_'),message:j.status==='waiting-host-action'?'采集需要在主机完成登录或验证码；完成后按原编号显式重试':'采集未取得可入库终态，请按原编号查回；禁止盲目重启',errors:a?.validation?.errors});}
    else if(id==='inventory.import'||id==='sales.import'){const a=artifact(input.artifactId,ctx);if(a.kind!==(id.startsWith('inventory')?'inventory':'sales'))throw error('WAREHOUSE_SOURCE_KIND','原件业务类型不符');if(a.kind==='inventory'&&businessDate(new Date(a.createdAt))!==businessDate(now()))throw error('WAREHOUSE_COLLECTION_STALE','库存原件不是今天新采集，请重新采集');const v=await worker('validate',{kind:a.kind,file:a.file,month:a.month},ctx);if(!(v.ok??v.valid))throw error('WAREHOUSE_VALIDATION_FAILED','原件未通过校验');commitData.artifactIds=[a.id];evidence=[{artifactId:a.id,sha256:a.hash,filename:path.basename(a.file)}];changes=[{operation:id,...warehouseValidationSummary(v)}];}
    else if(id==='sales.backfill'){const months=await worker('missing-months',input,ctx);if(!months.length)issues.push({code:'NO_MISSING_MONTHS',message:'指定范围没有缺失月份'});commitData.artifactIds=[];for(const month of months){const outcome=await collectArtifact('sales',{month},ctx),j=collections.publicJob(outcome.job),a=outcome.artifact;blocks.push({type:'job',title:month+' 月采集',...j});if(a)evidence.push({module:'warehouse',jobId:j.jobId,complete:j.complete,status:j.status,artifactId:a.id,sha256:a.hash,filename:path.basename(a.file)});if(!j.complete){issues.push({blocking:true,module:'warehouse',jobId:j.jobId,code:'WAREHOUSE_BACKFILL_COLLECTION_BLOCKED',message:month+' 月尚未完成采集校验；按原编号查询或明确重试，不重新抓取已有月份'});break;}commitData.artifactIds.push(a.id);changes.push({month,...warehouseValidationSummary(a.validation)});}}
    else if(id.endsWith('.send')||id==='inventory.send-latest-valid'){commitData.report=await worker('report',{kind:id.startsWith('inventory')?'inventory':'sales',historical:id==='inventory.send-latest-valid',...input},ctx);blocks=[{type:'markdown',title:commitData.report.title,text:commitData.report.text}];changes=[{operation:'send',channel:'dingtalk',target:notificationScope(),report:commitData.report}];}
    else if(id.startsWith('attendance.')){const status=await daily.status(ctx.actor);if(ctx.actor.local||!ctx.actor.id.startsWith('tailscale:')||!status.me)throw error('WAREHOUSE_SELF_REQUIRED','员工需以本人工作台身份操作',403);commitData.runId=status.sync.runId;commitData.businessDate=status.businessDate;changes=[{login:ctx.actor.login,action:id,runId:commitData.runId,businessDate:status.businessDate}];}
    else if(id==='remind'){const status=await daily.status(ctx.actor);const requested=new Set(input.logins.map(v=>v.trim().toLowerCase()));changes=status.employees.filter(e=>requested.has(e.login)&&e.status!=='off'&&!e.completedAt).map(e=>({login:e.login,name:e.name,channels:input.channels.filter(c=>e.channels.includes(c)),task:e.task,deadline:e.deadline}));commitData.businessDate=status.businessDate;}
    else if(id==='employees.configure'){changes=[{operation:'employees.configure',...input}];blocks=[{id:'warehouse-employees-draft-'+randomUUID(),type:'table',title:'员工任务安排草稿',rowKey:'login',editableFields:employeeEditFields,rows:structuredClone(input.employees)}];}
    else if(id==='backup'){const id=randomUUID(),file=path.join(dir,'backup-'+id+'.sqlite'),release=taskLock();try{await backup(db,file);}finally{release();}const sha256=createHash('sha256').update(fs.readFileSync(file)).digest('hex');save('warehouse_agent_artifacts',id,{id,kind:'backup',file,hash:sha256,validation:{backup:true},createdAt:now().toISOString(),actorId:ctx.actor.id,taskId:ctx.taskId});commitData.backup={backupId:path.basename(file),artifactId:id,sha256};evidence=[{artifactId:id,sha256,filename:path.basename(file)}];blocks=[{type:'table',title:'账本备份已生成',rows:[{artifactId:id,sha256,dataSetId:before.dataSetId}]}];}
    else if(id==='debug.bundle'){if(typeof deps.exportDebugBundle!=='function')throw error('WAREHOUSE_HOST_DIAGNOSTICS_UNAVAILABLE','主机尚未注入脱敏诊断包服务',503);const bundle=await deps.exportDebugBundle(),source=fs.realpathSync(bundle.path),root=fs.realpathSync(workspace)+path.sep;if(!source.startsWith(root))throw error('WAREHOUSE_SOURCE_OUTSIDE','诊断包不在当前云仓范围');const id=randomUUID(),bytes=fs.readFileSync(source),sha256=createHash('sha256').update(bytes).digest('hex');if(bundle.sha256!==sha256)throw error('WAREHOUSE_SOURCE_CHANGED','诊断包摘要不匹配');const file=path.join(dir,'debug-'+id+'.json');fs.writeFileSync(file,bytes,{flag:'wx'});save('warehouse_agent_artifacts',id,{id,kind:'debug',file,hash:sha256,validation:{redacted:true},createdAt:now().toISOString(),actorId:ctx.actor.id,taskId:ctx.taskId});evidence=[{artifactId:id,sha256,filename:path.basename(file)}];blocks=[{type:'table',title:'脱敏诊断包',rows:[{artifactId:id,sha256,size:bytes.length}]}];}
    else if(id==='login.refresh')changes=[{operation:'login.refresh',hostInteractionRequired:true,message:'主机浏览器出现验证码或授权时由本人处理，失败不循环重试'}];
    sameBinding(before,ctx);const result={id:randomUUID(),version:1,capabilityId:id,input:structuredClone(input),summary:c.title,scope:{module:'warehouse',...before,businessDate:businessDate(now()),timeZone:'Asia/Shanghai'},blocks,evidence,changes,issues,commitData};
    commitData.preparedId=result.id;result.changeDigest=warehouseAgentDigest({capabilityId:id,input:result.input,commitData,changes});save('warehouse_agent_prepared',result.id,{...result,actorId:ctx.actor.id,taskId:ctx.taskId});
    if(c.requiresReview===false){const {commitData:privateCommit,changeDigest:privateDigest,...automatic}=result;return {...automatic,state:issues.some(i=>i.blocking)?'blocked':'completed',requiresReview:false};}return result;
  }
  function receipt(key,ctx){actor(ctx);const row=db.prepare('SELECT * FROM warehouse_agent_receipts WHERE key=?').get(key);if(!row)return null;if(row.actor_id!==ctx.actor.id||row.task_id!==ctx.taskId)throw error('WAREHOUSE_RECEIPT_FORBIDDEN','不能读取其他任务回执',403);return JSON.parse(row.payload);}
  async function commitInner(proposed,ctx){actor(ctx,true);const p=load('warehouse_agent_prepared',proposed.commitData?.preparedId||proposed.id);if(p.actorId!==ctx.actor.id||p.taskId!==ctx.taskId)throw error('WAREHOUSE_PREPARED_FORBIDDEN','结果不属于当前人员或任务',403);
    if(proposed.version!==undefined&&p.version!==proposed.version||p.capabilityId!==proposed.capabilityId||p.changeDigest!==proposed.changeDigest||canonical(p.input)!==canonical(proposed.input)||canonical(p.changes)!==canonical(proposed.changes)||canonical(p.commitData)!==canonical(proposed.commitData))throw error('WAREHOUSE_RESULT_CHANGED','服务端准备结果与提交内容不符');
    const prior=receipt(ctx.idempotencyKey,ctx);if(prior){const row=db.prepare('SELECT digest FROM warehouse_agent_receipts WHERE key=?').get(ctx.idempotencyKey);if(row.digest!==p.changeDigest)throw error('WAREHOUSE_IDEMPOTENCY_CONFLICT','幂等标识已用于其他准备结果');return receiptResult(ctx.idempotencyKey,ctx);}
    const c=WAREHOUSE_AGENT_CAPABILITIES.find(c=>c.id===p.capabilityId);actor(ctx,true,adminCapabilities.has(c.id));
    if(c.requiresReview===false)throw error('WAREHOUSE_AUTOMATIC_NO_COMMIT','自动产物无需正式提交，请读取已经生成的原件',400);
    sameBinding({dataSetId:p.scope.dataSetId,revision:p.scope.revision},ctx);
    if(c.requiresReview){if(typeof verifyApproval!=='function')throw error('WAREHOUSE_APPROVAL_UNAVAILABLE','主机尚未接入中央审批验证器',503);
      // Central results aggregate module steps under their own result id/version.
      // These two claims are authenticated by verifyApproval below; every domain
      // field and digest is independently checked against our persisted preparation.
      let envelope;try{envelope=JSON.parse(Buffer.from(ctx.approval?.payload||'','base64url').toString('utf8'));}catch{}
      await verifyApproval(ctx.approval,typeof workbenchKey==='function'?await workbenchKey():workbenchKey,{v:1,actorId:ctx.actor.id,module:'warehouse',capabilityId:c.id,taskId:ctx.taskId,resultId:proposed.resultId||envelope?.resultId||p.id,resultVersion:proposed.resultVersion||envelope?.resultVersion||p.version,dataSetId:p.scope.dataSetId,revision:p.scope.revision,changeDigest:p.changeDigest,idempotencyKey:ctx.idempotencyKey});}
    ctx.signal?.throwIfAborted();const unknown={id:ctx.idempotencyKey,idempotencyKey:ctx.idempotencyKey,state:'unknown',status:'unknown',capabilityId:c.id,taskId:ctx.taskId,createdAt:now().toISOString(),message:'执行结果尚未核对；先查询回执，禁止自动重放'};
    const claim=db.prepare('INSERT OR IGNORE INTO warehouse_agent_receipts VALUES(?,?,?,?,?)').run(ctx.idempotencyKey,ctx.actor.id,ctx.taskId,p.changeDigest,JSON.stringify(unknown));if(claim.changes!==1)return receiptResult(ctx.idempotencyKey,ctx);
    let outcome;try{
      const d=p.commitData;
      if(c.id.endsWith('.collect'))outcome={status:'completed',artifactIds:d.artifactIds};
      else if(c.id.endsWith('.import')||c.id==='sales.backfill'){const artifacts=d.artifactIds.map(id=>artifact(id,ctx));const snapshot=path.join(dir,'backup-'+randomUUID()+'.sqlite');await backup(db,snapshot);sameBinding({dataSetId:p.scope.dataSetId,revision:p.scope.revision},ctx);outcome=await worker('import',{artifacts,backupPath:snapshot},ctx);}
      else if(c.id.endsWith('.send')||c.id==='inventory.send-latest-valid')outcome=await worker('send',{report:d.report,month:d.input.month,kind:c.id.startsWith('inventory')?'inventory':'sales'},ctx);
      else if(c.id==='employees.configure')outcome={status:'completed',config:daily.configure(ctx.actor,d.input)};
      else if(c.id.startsWith('attendance.')){if(d.businessDate!==businessDate(now()))throw error('WAREHOUSE_DAY_CHANGED','业务日已变化，请重新复核');outcome={status:'completed',...daily.action(ctx.actor,{action:c.id==='attendance.check-in'?'check-in':'complete',runId:d.runId,note:d.input.note},{approvalVerified:true})};}
      else if(c.id==='remind'){if(d.businessDate!==businessDate(now()))throw error('WAREHOUSE_DAY_CHANGED','业务日已变化，请重新复核');outcome=await daily.remind(ctx.actor,d.input,false,{approvalVerified:true});outcome.status=outcome.results.some(r=>r.status==='unknown')?'unknown':outcome.results.some(r=>r.status==='failed'||r.status==='unconfigured')?'partial':'completed';}
      else if(c.id==='backup'){artifact(d.backup.artifactId,ctx);outcome={status:'completed',...d.backup};}
      else if(c.id==='login.refresh')outcome=await worker('login',{},ctx);
      const result={...unknown,...outcome,state:['completed','accepted'].includes(outcome.status)?'completed':'unknown',message:outcome.status==='accepted'?'服务商已受理，不代表收件人已阅读或接听':outcome.status==='completed'?'操作已完成并可核对业务记录':unknown.message,finishedAt:now().toISOString()};db.prepare('UPDATE warehouse_agent_receipts SET payload=? WHERE key=?').run(JSON.stringify(result),ctx.idempotencyKey);return {state:result.state,idempotencyKey:ctx.idempotencyKey,receipt:result};
    }catch(e){const result={...unknown,errorCode:e.code||'WAREHOUSE_EXECUTION_INTERRUPTED'};db.prepare('UPDATE warehouse_agent_receipts SET payload=? WHERE key=?').run(JSON.stringify(result),ctx.idempotencyKey);throw e;}}
  async function commit(proposed,ctx){actor(ctx,true);if(!ctx.idempotencyKey)throw error('WAREHOUSE_CONTEXT_REQUIRED','提交缺少可信幂等标识',400);const release=taskLock();try{return await commitInner(proposed,ctx);}finally{release();}}
  // A successful receipt query is not a successful delivery. Keep uncertain and
  // partial domain outcomes readable over transport, but never runtime-completed.
  const receiptResult=(key,ctx)=>{const r=receipt(key,ctx);return r?{state:['completed','accepted'].includes(r.status)?'completed':'unknown',idempotencyKey:key,receipt:{...r,idempotencyKey:key,state:['completed','accepted'].includes(r.status)?'completed':'unknown'}}:null;};
  function download(id,ctx){actor(ctx);const a=artifact(id,ctx);if(['backup','debug'].includes(a.kind))actor(ctx,false,true);const file=fs.realpathSync(a.file),base=fs.realpathSync(workspace)+path.sep;if(!file.startsWith(base)||fs.lstatSync(a.file).isSymbolicLink())throw error('WAREHOUSE_SOURCE_OUTSIDE','原件路径越界',403);return {stream:fs.createReadStream(file),size:fs.statSync(file).size,sha256:a.hash,name:a.id+path.extname(file)};}
  return {id:'warehouse',capabilities:structuredClone(WAREHOUSE_AGENT_CAPABILITIES),binding,query,prepare,commit,download,receipt:receiptResult,cancel:async ctx=>{actor(ctx,true);return {jobs:collections.list(ctx.actor).filter(j=>j.taskId===ctx.taskId&&['collecting','collected','validating','cancelling','unknown'].includes(j.status)).map(j=>collections.publicJob(cancelCollection(j.id,ctx).job))};},close(){daily.close();db.close();}};
}
