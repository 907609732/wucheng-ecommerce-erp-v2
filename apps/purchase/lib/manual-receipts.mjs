import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyValid=key=>typeof key==='string'&&/^[A-Za-z0-9._:-]{8,160}$/.test(key);
const formal=/^\/api\/(?:orders(?:\/|$)|month-confirmations(?:\/|$)|tasks$|task-board\/action$|supplier-management(?:\/|$)|addresses(?:\/|$)|import\/[^/]+\/commit$)/;
export function createManualReceipts(store){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS workbench_manual_receipts(actor_id TEXT NOT NULL,request_key TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,body TEXT,PRIMARY KEY(actor_id,request_key));`);
 const lookup=(actor,key)=>keyValid(key)?db.prepare('SELECT * FROM workbench_manual_receipts WHERE actor_id=? AND request_key=?').get(actor.id,key):null;
 return {read(actor,key){const row=lookup(actor,key);return row?{state:row.state,status:row.status,...(row.state==='completed'?{result:JSON.parse(row.body)}:{code:'MANUAL_OUTCOME_UNKNOWN'})}:{state:'not_found'};},middleware(req,res,next){
  if(!req.workbenchActor||req.workbenchActor.channel!=='ui'||['GET','HEAD','OPTIONS'].includes(req.method)||!formal.test(req.path)||!req.is('application/json'))return next();
  const key=req.headers['idempotency-key'];if(!keyValid(key))return res.status(400).json({code:'IDEMPOTENCY_KEY_REQUIRED',error:'人工保存缺少有效提交编号，请刷新工作台后重试'});
  const digest=hash({method:req.method,path:req.originalUrl,input:req.body}),prior=lookup(req.workbenchActor,key);
  if(prior){if(prior.digest!==digest)return res.status(409).json({code:'IDEMPOTENCY_CONFLICT',error:'同一提交编号的内容已变化，请重新核对'});if(prior.state!=='completed')return res.status(409).json({code:'MANUAL_OUTCOME_UNKNOWN',error:'上次人工保存结果尚待核对，请查询原订单和回执，不能重复写入'});return res.status(prior.status).json(JSON.parse(prior.body));}
  db.prepare('INSERT INTO workbench_manual_receipts VALUES(?,?,?,?,?,?)').run(req.workbenchActor.id,key,digest,'processing',null,null);
  const json=res.json.bind(res);res.json=value=>{
   const body=JSON.stringify(value);
   // A process crash after the domain commit leaves processing and blocks replay;
   // it never blindly reruns a possibly completed write.
   if(Buffer.byteLength(body)<=16*1024*1024)db.prepare('UPDATE workbench_manual_receipts SET state=?,status=?,body=? WHERE actor_id=? AND request_key=?').run('completed',res.statusCode,body,req.workbenchActor.id,key);
   return json(value);
  };next();
 }};
}
