import {randomUUID} from 'node:crypto';
import {agentDigest,verifyAgentApproval,approvalFromHeaders} from './agent-approval.mjs';
import {purchaseAgentCapabilities} from './agent-adapter.mjs';
import {validatePurchaseAgentInput} from './agent-schemas.mjs';
const fail=(code,message,status=400)=>Object.assign(Error(message),{code,status});
export function createPurchaseAgentService({store,key,binding,operations}){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS agent_prepared(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,task_id TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS agent_receipts(actor_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(actor_id,idempotency_key));`);
 const actor=ctx=>{if(!ctx?.actor?.id||!ctx.actor.modules?.includes('purchase'))throw fail('AGENT_ACTOR_REQUIRED','需要可信采购身份',403);return ctx.actor;};
 function operation(id,kind,ctx){const a=actor(ctx),cap=purchaseAgentCapabilities.find(c=>c.id===id&&c.kind===kind);if(!cap||!operations[id])throw fail('CAPABILITY_UNAVAILABLE','此能力尚未开通',404);return operations[id];}
 const receipt=(id,ctx)=>{
  const a=actor(ctx),row=db.prepare('SELECT * FROM agent_receipts WHERE actor_id=? AND idempotency_key=?').get(a.id,id);if(!row)return null;const prior=JSON.parse(row.body);
  if(!['unknown','processing'].includes(prior.state)||!prior.preparedId)return prior;
  const saved=db.prepare('SELECT * FROM agent_prepared WHERE id=? AND actor_id=?').get(prior.preparedId,a.id);if(!saved)return prior;
  const prepared=JSON.parse(saved.body),op=operations[prepared.capabilityId];if(typeof op?.recover!=='function')return prior;
  const result=op.recover(prepared.input,prepared.privateData,ctx);if(!result||result.ok===false||result.verified!==true||result.postVerified!==true)return prior;
  const recovered={state:'completed',ok:true,receipt:{id:randomUUID(),approvalId:prior.approvalId,idempotencyKey:id,capabilityId:prepared.capabilityId,...binding(),result}};
  db.prepare('UPDATE agent_receipts SET body=? WHERE actor_id=? AND idempotency_key=?').run(JSON.stringify(recovered),a.id,id);return recovered;
 };
 return {
  binding:ctx=>{actor(ctx);return binding();},receipt,
  async query(id,input,ctx){const op=operation(id,'query',ctx);validatePurchaseAgentInput(id,input||{});const raw=await op.query(input||{},ctx),offset=input?.offset||0,limit=input?.limit||100,paginated=Array.isArray(raw),data=paginated?raw.slice(offset,offset+limit):raw,pagination=paginated?{offset,limit,total:raw.length,nextOffset:offset+limit<raw.length?offset+limit:null}:null;return {summary:purchaseAgentCapabilities.find(c=>c.id===id).title,blocks:[{type:'table',rows:Array.isArray(data)?data:[data]}],evidence:[{...binding(),moneyUnit:'CNY-fen',dateBasis:input?.basis||'paid',...(pagination?{pagination}:{})}],data,...(pagination?{pagination}:{})};},
  async prepare(capabilityId,input={},ctx){
   const op=operation(capabilityId,'prepare',ctx),before=binding();
   validatePurchaseAgentInput(capabilityId,input);
   const cap=purchaseAgentCapabilities.find(c=>c.id===capabilityId);
   if(cap.requiresReview===false){
    if(typeof ctx.idempotencyKey!=='string'||!ctx.idempotencyKey||ctx.idempotencyKey.length>300)throw fail('IDEMPOTENCY_KEY_REQUIRED','自动步骤需要可恢复的任务幂等键');
    const digest=agentDigest({capabilityId,input,taskId:ctx.taskId}),old=db.prepare('SELECT * FROM agent_receipts WHERE actor_id=? AND idempotency_key=?').get(ctx.actor.id,ctx.idempotencyKey);
    if(old){if(old.digest!==digest)throw fail('IDEMPOTENCY_CONFLICT','任务键已用于不同操作',409);return JSON.parse(old.body);}
    db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?)').run(ctx.actor.id,ctx.idempotencyKey,digest,JSON.stringify({state:'processing',ok:false}));
    try{const detail=await op.execute(input,ctx);if(detail?.ok===false||detail?.data?.ok===false)throw fail(detail.code||detail.data?.code||'AUTOMATIC_STEP_UNVERIFIED',detail.error||detail.data?.error||'自动步骤结果尚未核实',409);const output={state:'completed',ok:true,requiresReview:false,summary:detail.summary||cap.title,blocks:detail.blocks||[{type:'table',rows:[detail.data??detail]}],evidence:detail.evidence||[binding()],...(detail.data===undefined?{}:{data:detail.data})};db.prepare('UPDATE agent_receipts SET body=? WHERE actor_id=? AND idempotency_key=?').run(JSON.stringify(output),ctx.actor.id,ctx.idempotencyKey);return output;}
    catch(e){db.prepare('UPDATE agent_receipts SET body=? WHERE actor_id=? AND idempotency_key=?').run(JSON.stringify({state:'unknown',ok:false,code:e.code,error:e.message}),ctx.actor.id,ctx.idempotencyKey);throw e;}
   }
   if('confirmed'in input||'approval'in input||'actor'in input||'password'in input)throw fail('UNTRUSTED_AUTH','模型输入不能携带授权材料',403);
   const detail=await op.prepare(input,ctx),after=binding();if(agentDigest(before)!==agentDigest(after))throw fail('REVISION_CHANGED','准备期间账本变化，请重新准备',409);
   const id=randomUUID(),commitData={preparedId:id,preparedDigest:agentDigest(detail.commitData||{})},changes=detail.changes||[{operation:capabilityId,input}];
   const prepared={id,version:1,capabilityId,input,...before,summary:detail.summary||capabilityId,scope:detail.scope||{},blocks:detail.blocks||[],evidence:detail.evidence||[before],changes,issues:detail.issues||[],commitData,privateData:detail.commitData||{}};
   db.prepare('INSERT INTO agent_prepared VALUES(?,?,?,?)').run(id,ctx.actor.id,ctx.taskId,JSON.stringify(prepared));const {privateData,...publicPrepared}=prepared;return publicPrepared;
  },
  async commit(id,ctx){
   const a=actor(ctx),row=db.prepare('SELECT * FROM agent_prepared WHERE id=?').get(id);if(!row||row.actor_id!==a.id||row.task_id!==ctx.taskId)throw fail('PREPARED_NOT_FOUND','准备结果不存在',404);
   const p=JSON.parse(row.body);if(agentDigest(p.privateData)!==p.commitData.preparedDigest)throw fail('PREPARED_CHANGED','服务端准备材料已变化，请重新复核',409);const digest=agentDigest({capabilityId:p.capabilityId,input:p.input,commitData:p.commitData,changes:p.changes});
   const proof=verifyAgentApproval(ctx.approval,key,{actorId:a.id,module:'purchase',capabilityId:p.capabilityId,taskId:ctx.taskId,resultId:ctx.resultId,resultVersion:ctx.resultVersion,dataSetId:p.dataSetId,revision:p.revision,changeDigest:digest,idempotencyKey:ctx.idempotencyKey});
   const old=db.prepare('SELECT * FROM agent_receipts WHERE actor_id=? AND idempotency_key=?').get(a.id,ctx.idempotencyKey);if(old){if(old.digest!==digest)throw fail('IDEMPOTENCY_CONFLICT','重复请求内容变化',409);return JSON.parse(old.body);}
   if(agentDigest(binding())!==agentDigest({dataSetId:p.dataSetId,revision:p.revision}))throw fail('REVISION_CHANGED','账本已变化，请重新复核',409);
   const op=operation(p.capabilityId,'prepare',ctx),rollback=[];ctx={...ctx,verifiedApproval:proof,onRollback:fn=>rollback.push(fn)};
   // Synchronous domain transactions include receipt persistence. Async operations
   // must provide their own durable job key and cannot be wrapped in SQLite BEGIN.
   if(op.async){
    db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?)').run(a.id,ctx.idempotencyKey,digest,JSON.stringify({state:'processing',ok:false,preparedId:id,approvalId:proof.approvalId,idempotencyKey:ctx.idempotencyKey}));
    try{const value=await op.commit(p.input,p.privateData,ctx);if(value?.ok===false||value?.verified===false)throw fail('COMMIT_VERIFICATION_FAILED','业务写后复核尚未通过',409);const result={state:'completed',ok:true,receipt:{id:randomUUID(),approvalId:proof.approvalId,idempotencyKey:ctx.idempotencyKey,capabilityId:p.capabilityId,...binding(),result:value}};db.prepare('UPDATE agent_receipts SET body=? WHERE actor_id=? AND idempotency_key=?').run(JSON.stringify(result),a.id,ctx.idempotencyKey);return result;}
    catch(error){db.prepare('UPDATE agent_receipts SET body=? WHERE actor_id=? AND idempotency_key=?').run(JSON.stringify({state:'unknown',ok:false,preparedId:id,approvalId:proof.approvalId,error:error.message,code:error.code,idempotencyKey:ctx.idempotencyKey}),a.id,ctx.idempotencyKey);throw error;}
   }
   try{return store.transaction(()=>{const value=op.commit(p.input,p.privateData,ctx);if(value?.then)throw fail('ASYNC_TRANSACTION','异步操作不可在同步事务中提交');const result={state:'completed',ok:true,receipt:{id:randomUUID(),approvalId:proof.approvalId,idempotencyKey:ctx.idempotencyKey,capabilityId:p.capabilityId,...binding(),result:value}};db.prepare('INSERT INTO agent_receipts VALUES(?,?,?,?)').run(a.id,ctx.idempotencyKey,digest,JSON.stringify(result));return result;});}catch(error){for(const undo of rollback.reverse()){try{undo();}catch{}}throw error;}
  }
 };
}
export function installPurchaseAgentRoutes(router,service){
 const ctx=purchaseAgentRequestContext;
 const wrap=fn=>async(q,r,next)=>{try{r.json(await fn(q,ctx(q)));}catch(e){e.status??=e.statusCode;next(e);}};
 router.get('/agent/binding',wrap((q,c)=>service.binding(c)));
 router.post('/agent/query',wrap((q,c)=>service.query(q.body.capabilityId,q.body.input,c)));
 router.post('/agent/prepare',wrap((q,c)=>service.prepare(q.body.capabilityId,q.body.input,c)));
 router.post('/agent/commit',wrap((q,c)=>service.commit(q.body.preparedId,c)));
 router.get('/agent/receipts/:id',wrap((q,c)=>service.receipt(q.params.id,c)));
}



export const purchaseAgentRequestContext=q=>{if(q.integration?.role!=='agent'||!q.workbenchActor)throw fail('AGENT_ACTOR_REQUIRED','需要签名工作台身份',403);return {actor:q.workbenchActor,taskId:q.body?.taskId||q.headers['x-erp-agent-task-id'],resultId:q.body?.resultId,resultVersion:q.body?.resultVersion,idempotencyKey:q.body?.idempotencyKey||q.headers['x-erp-agent-idempotency-key'],approval:q.headers['x-erp-agent-approval']?approvalFromHeaders(q.headers):undefined};};
