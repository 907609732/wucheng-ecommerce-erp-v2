import {randomUUID} from 'node:crypto';
import {agentDigest,verifyAgentApproval,approvalFromHeaders} from './agent-approval.mjs';
import {purchaseAgentCapabilities} from './agent-adapter.mjs';
const fail=(code,message,status=400)=>Object.assign(Error(message),{code,status});
export function createPurchaseAgentService({store,key,binding,operations}){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS agent_prepared(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS agent_receipts(actor_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(actor_id,idempotency_key));`);
 const actor=ctx=>{if(!ctx?.actor?.id||!ctx.actor.modules?.includes('purchase'))throw fail('AGENT_ACTOR_REQUIRED','需要可信采购身份',403);return ctx.actor;};
 function operation(id,kind,ctx){const a=actor(ctx),cap=purchaseAgentCapabilities.find(c=>c.id===id&&c.kind===kind);if(!cap||!operations[id])throw fail('CAPABILITY_UNAVAILABLE','此能力尚未开通',404);if(kind==='prepare'&&a.role==='viewer')throw fail('READ_ONLY','只读身份不能修改',403);return operations[id];}
 const receipt=(id,ctx)=>{const a=actor(ctx),r=db.prepare('SELECT body FROM agent_receipts WHERE actor_id=? AND idempotency_key=?').get(a.id,id);return r?JSON.parse(r.body):null;};
 return {
  binding:ctx=>{actor(ctx);return binding();},receipt,
  query:(id,input,ctx)=>operation(id,'query',ctx).query(input||{},ctx),
  async prepare(capabilityId,input={},ctx){
   const op=operation(capabilityId,'prepare',ctx),before=binding();
   if('confirmed'in input||'approval'in input||'actor'in input||'password'in input)throw fail('UNTRUSTED_AUTH','模型输入不能携带授权材料',403);
   const detail=await op.prepare(input,ctx),after=binding();if(agentDigest(before)!==agentDigest(after))throw fail('REVISION_CHANGED','准备期间账本变化，请重新准备',409);
   const id=randomUUID(),commitData={preparedId:id},changes=detail.changes||[{operation:capabilityId,input}];
   const prepared={id,version:1,capabilityId,input,...before,summary:detail.summary||capabilityId,scope:detail.scope||{},blocks:detail.blocks||[],evidence:detail.evidence||[before],changes,issues:detail.issues||[],commitData,privateData:detail.commitData||{}};
   db.prepare('INSERT INTO agent_prepared VALUES(?,?,?,?)').run(id,ctx.actor.id,ctx.taskId,JSON.stringify(prepared));const {privateData,...publicPrepared}=prepared;return publicPrepared;
  },
  async commit(id,ctx){
   const a=actor(ctx),row=db.prepare('SELECT * FROM agent_prepared WHERE id=?').get(id);if(!row||row.actor_id!==a.id||row.task_id!==ctx.taskId)throw fail('PREPARED_NOT_FOUND','准备结果不存在',404);
   const p=JSON.parse(row.body),digest=agentDigest({capabilityId:p.capabilityId,input:p.input,commitData:p.commitData,changes:p.changes});
   const proof=verifyAgentApproval(ctx.approval,key,{actorId:a.id,module:'purchase',capabilityId:p.capabilityId,taskId:ctx.taskId,resultId:ctx.resultId,resultVersion:ctx.resultVersion,dataSetId:p.dataSetId,revision:p.revision,changeDigest:digest,idempotencyKey:ctx.idempotencyKey});
   const old=db.prepare('SELECT * FROM agent_receipts WHERE actor_id=? AND idempotency_key=?').get(a.id,ctx.idempotencyKey);if(old){if(old.digest!==digest)throw fail('IDEMPOTENCY_CONFLICT','重复请求内容变化',409);return JSON.parse(old.body);}
   if(agentDigest(binding())!==agentDigest({dataSetId:p.dataSetId,revision:p.revision}))throw fail('REVISION_CHANGED','账本已变化，请重新复核',409);
   const op=operation(p.capabilityId,'prepare',ctx);ctx={...ctx,verifiedApproval:proof};
   // Synchronous domain transactions include receipt persistence. Async operations
   // must provide their own durable job key and cannot be wrapped in SQLite BEGIN.
   if(op.async){
    db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?)').run(a.id,ctx.idempotencyKey,digest,JSON.stringify({state:'processing',idempotencyKey:ctx.idempotencyKey}));
    try{const value=await op.commit(p.input,p.privateData,ctx),result={receipt:{id:randomUUID(),approvalId:proof.approvalId,idempotencyKey:ctx.idempotencyKey,capabilityId:p.capabilityId,...binding(),result:value}};db.prepare('UPDATE agent_receipts SET body=? WHERE actor_id=? AND idempotency_key=?').run(JSON.stringify(result),a.id,ctx.idempotencyKey);return result;}
    catch(error){db.prepare('UPDATE agent_receipts SET body=? WHERE actor_id=? AND idempotency_key=?').run(JSON.stringify({state:'unknown',error:error.message,code:error.code,idempotencyKey:ctx.idempotencyKey}),a.id,ctx.idempotencyKey);throw error;}
   }
   return store.transaction(()=>{const value=op.commit(p.input,p.privateData,ctx);if(value?.then)throw fail('ASYNC_TRANSACTION','异步操作不可在同步事务中提交');const result={receipt:{id:randomUUID(),approvalId:proof.approvalId,idempotencyKey:ctx.idempotencyKey,capabilityId:p.capabilityId,...binding(),result:value}};db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?)').run(a.id,ctx.idempotencyKey,digest,JSON.stringify(result));return result;});
  }
 };
}
export function installPurchaseAgentRoutes(router,service){
 const ctx=q=>{if(q.integration?.role!=='agent'||!q.workbenchActor)throw fail('AGENT_ACTOR_REQUIRED','需要签名工作台身份',403);return {actor:q.workbenchActor,taskId:q.body?.taskId||q.headers['x-erp-agent-task-id'],resultId:q.body?.resultId,resultVersion:q.body?.resultVersion,idempotencyKey:q.body?.idempotencyKey||q.headers['x-erp-agent-idempotency-key'],approval:q.headers['x-erp-agent-approval']?approvalFromHeaders(q.headers):undefined};};
 const wrap=fn=>async(q,r,next)=>{try{r.json(await fn(q,ctx(q)));}catch(e){e.status??=e.statusCode;next(e);}};
 router.get('/agent/binding',wrap((q,c)=>service.binding(c)));
 router.post('/agent/query',wrap((q,c)=>service.query(q.body.capabilityId,q.body.input,c)));
 router.post('/agent/prepare',wrap((q,c)=>service.prepare(q.body.capabilityId,q.body.input,c)));
 router.post('/agent/commit',wrap((q,c)=>service.commit(q.body.preparedId,c)));
 router.get('/agent/receipts/:id',wrap((q,c)=>service.receipt(q.params.id,c)));
}
