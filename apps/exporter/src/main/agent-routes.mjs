import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {agentDigest,verifyAgentApproval,approvalFromHeaders} from './agent-approval.mjs';
import {exporterQueries,exporterActions} from './agent-adapter.mjs';
const fail=(code,message,status=400)=>Object.assign(Error(message),{code,status});
export function installExporterAgentRoutes(router,{store,handlers,key,binding,guard,cleanTask,platformById,transferSnapshot,dataDir}){
 store.db.exec('CREATE TABLE IF NOT EXISTS agent_prepared(id TEXT PRIMARY KEY,actor TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_receipts(actor TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(actor,id))');
 const route=(name,fn)=>router.post('/agent/'+name,guard(),async(q,r,next)=>{try{r.json(await fn(q));}catch(e){e.status=e.status||e.statusCode||400;next(e);}});
 const state=()=>({...binding(),tasks:store.tasks().map(cleanTask),busy:handlers.busy()});
 router.get('/agent/state',guard(),(_q,r)=>r.json(state()));
 const query=(id,input={})=>{if(!exporterQueries.includes(id))throw fail('CAPABILITY_UNKNOWN','未知查询');if(id==='state')return state();if(id==='logs')return handlers.invoke('executionLogs',platformById(input.platform).id);const task=store.get(input.taskId);if(id==='task')return cleanTask(task);if(id==='orders')return {task:cleanTask(task),orders:store.orders(task.id)};return transferSnapshot(task,store.orders(task.id));};
 route('query',q=>query(q.body.capabilityId,q.body.input));
 route('receipt',q=>{const row=store.db.prepare('SELECT payload FROM agent_receipts WHERE actor=? AND id=?').get(q.workbenchActor.id,q.body.idempotencyKey);return row?JSON.parse(row.payload):null;});
 route('prepare',q=>{
  const {capabilityId,input={}}=q.body,actor=q.workbenchActor;
  if(!exporterActions.includes(capabilityId))throw fail('CAPABILITY_UNKNOWN','未知操作');
  if(actor.role==='viewer')throw fail('READ_ONLY','当前用户仅可查看',403);
  if(['start','pause','resume','retry','finish','enrichDetails','host-action'].includes(capabilityId)&&!(actor.role==='admin'||actor.canRunTasks))throw fail('TASK_PERMISSION_REQUIRED','无采集权限',403);
  if(capabilityId==='clear'&&actor.role!=='admin')throw fail('ADMIN_REQUIRED','清理需要管理员',403);
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('INPUT_INVALID','参数必须为对象');
  if(/"(?:actor|approval|confirmed|confirm|accountCookie|cookie|password|authorization)"\s*:/.test(JSON.stringify(input)))throw fail('INPUT_FORBIDDEN','禁止模型提供审批或身份');
  if(['start','clear','host-action'].includes(capabilityId))platformById(input.platform);
  if(capabilityId==='start'&&(!/^\d{4}-\d{2}-\d{2}$/.test(input.from)||!/^\d{4}-\d{2}-\d{2}$/.test(input.to)||input.from>input.to))throw fail('DATE_RANGE_INVALID','日期范围无效');
  if(['pause','resume','retry','finish','enrichDetails','export','transfer'].includes(capabilityId))store.get(input.taskId);
  if(['proxyStart','proxyStop'].includes(capabilityId)&&actor.role!=='admin')throw fail('ADMIN_REQUIRED','代理设置需要管理员',403);
  if(capabilityId==='proxyStart')platformById(input.platform);
  if(['setLogging','setExecutionLogVisible'].includes(capabilityId)&&typeof input.enabled!=='boolean')throw fail('BOOLEAN_REQUIRED','开关值无效');
  if(capabilityId==='export'&&!['csv','xlsx'].includes(input.format))throw fail('FORMAT_INVALID','导出格式无效');
  const current=binding();if(!current.dataSetId||current.revision===undefined)throw fail('DATASET_UNAVAILABLE','账本身份不可用',503);
  const changes=[{operation:capabilityId,input}],id=randomUUID(),commitData={id};
  const prepared={capabilityId,input,...current,summary:'导出台：'+capabilityId,scope:{taskId:input.taskId,platform:input.platform},blocks:[],evidence:input.taskId?[{task:cleanTask(store.get(input.taskId)),count:store.orders(input.taskId).length}]:[],changes,issues:capabilityId==='host-action'?[{code:'HUMAN_PLATFORM_ACTION',message:'登录、验证码及平台授权由用户在主机完成'}]:[],commitData};
  store.db.prepare('INSERT INTO agent_prepared VALUES(?,?,?)').run(id,actor.id,JSON.stringify(prepared));return prepared;
 });
 route('commit',async q=>{
  const submitted=q.body.prepared,row=store.db.prepare('SELECT * FROM agent_prepared WHERE id=?').get(submitted?.commitData?.id),actor=q.workbenchActor;
  if(!row||row.actor!==actor.id)throw fail('PREPARED_NOT_FOUND','准备结果不存在',404);
  const p=JSON.parse(row.payload),digest=agentDigest({capabilityId:p.capabilityId,input:p.input,commitData:p.commitData,changes:p.changes});
  if(agentDigest({capabilityId:submitted.capabilityId,input:submitted.input,commitData:submitted.commitData,changes:submitted.changes})!==digest)throw fail('RESULT_CHANGED','结果被修改',409);
  const proof=approvalFromHeaders(q.headers),claims=verifyAgentApproval(proof,key,{actorId:actor.id,module:'exporter',idempotencyKey:q.body.idempotencyKey,taskId:q.body.taskId,resultId:submitted.id,resultVersion:submitted.version,capabilityId:p.capabilityId,dataSetId:p.dataSetId,revision:p.revision,changeDigest:digest});
  const old=store.db.prepare('SELECT * FROM agent_receipts WHERE actor=? AND id=?').get(actor.id,claims.idempotencyKey);if(old){if(old.digest!==digest)throw fail('IDEMPOTENCY_CONFLICT','重复请求不同',409);return JSON.parse(old.payload);}
  const current=binding();if(current.dataSetId!==p.dataSetId||current.revision!==p.revision)throw fail('REVISION_CHANGED','账本已变化，请重新复核',409);
  const i=p.input,a=p.capabilityId;if(actor.role==='viewer'||a==='clear'&&actor.role!=='admin')throw fail('PERMISSION_DENIED','权限已变化',403);
  if(['start','pause','resume','retry','finish','enrichDetails','host-action'].includes(a)&&!(actor.role==='admin'||actor.canRunTasks))throw fail('TASK_PERMISSION_REQUIRED','无采集权限',403);
  store.db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?)').run(actor.id,claims.idempotencyKey,digest,JSON.stringify({receipt:{state:'processing',idempotencyKey:claims.idempotencyKey}}));
  let result;
  if(a==='start')result=cleanTask(await handlers.invoke('start',i));
  else if(['pause','resume','retry','finish','enrichDetails'].includes(a)){await handlers.invoke(a,i.taskId);result=cleanTask(store.get(i.taskId));}
  else if(a==='host-action'){if(i.taskId&&store.get(i.taskId).platform!==i.platform)throw fail('PLATFORM_MISMATCH','平台不符');await handlers.invoke(i.orderId?'openOrder':'login',...(i.orderId?[i.taskId,i.orderId]:[i.platform]));result={state:'waiting-host-action'};}
  else if(['proxyStart','proxyStop','hidePage','setLogging','setExecutionLogVisible'].includes(a)){if(['proxyStart','proxyStop'].includes(a)&&actor.role!=='admin')throw fail('ADMIN_REQUIRED','代理设置需要管理员',403);await handlers.invoke(a,...(a==='proxyStart'?[i.platform]:a.startsWith('set')?[i.enabled]:[]));result={ok:true};}
  else if(a==='transfer')result=await handlers.transfer(i.taskId,actor);
  else if(a==='clear'){if(handlers.busy())throw fail('SERVICE_BUSY','任务运行中',409);store.clear(i.platform);handlers.changed();result={ok:true};}
  else {const dir=path.join(dataDir,'workbench-exports',randomUUID());fs.mkdirSync(dir,{recursive:true});const file=await handlers.exportFile({taskId:i.taskId,format:i.format,images:i.images===true},dir),fileId=randomUUID();store.db.prepare('INSERT INTO workbench_files VALUES(?,?,?,?,?)').run(fileId,actor.id,path.basename(file.path),file.path,new Date().toISOString());result={fileId,filename:path.basename(file.path),count:file.count,missing:file.missing,downloadUrl:'/api/workbench/v1/modules/exporter/files/'+fileId};}
  store.db.prepare('INSERT INTO workbench_audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),actor.id,actor.sessionId,actor.channel,'agent.'+a,String(i.taskId||''),'completed',new Date().toISOString());
  const receipt={receipt:{state:'completed',idempotencyKey:claims.idempotencyKey,actorId:actor.id,capabilityId:a,result,...binding()}};
  store.db.prepare('UPDATE agent_receipts SET payload=? WHERE actor=? AND id=?').run(JSON.stringify(receipt),actor.id,claims.idempotencyKey);return receipt;
 });
}
