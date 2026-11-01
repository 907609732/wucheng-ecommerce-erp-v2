import {randomUUID} from 'node:crypto';
import {validateOrder} from './importer.mjs';
import {orderChanges,auditValue,sameValue,auditActions} from '../public/audit-values.mjs';
const allowed=new Set(['update','attributes','classification','supplement-source','rollback']);
const fail=(message,code='INVALID_LOG_REQUEST',status=400)=>Object.assign(Error(message),{code,status});
const auditId=value=>{const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw fail('日志编号无效');return id;};
const integer=(value,fallback,max)=>{if(value==null||value==='')return fallback;const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)throw fail('分页参数无效');return n;};
const day=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw fail('请选择有效日期');return Date.parse(value+'T00:00:00+08:00');};
export function openAuditLog(db,{get,transaction,monthLocks,persistOrder}){
 for(const [name,definition] of [['rollback_of','INTEGER'],['reason',"TEXT NOT NULL DEFAULT ''"]])if(!db.prepare('PRAGMA table_info(audit)').all().some(c=>c.name===name))db.exec(`ALTER TABLE audit ADD COLUMN ${name} ${definition}`);
 db.exec('CREATE INDEX IF NOT EXISTS audit_order_id ON audit(order_id,id); CREATE INDEX IF NOT EXISTS audit_batch_id ON audit(batch_id); CREATE INDEX IF NOT EXISTS audit_created_at ON audit(created_at);');
 const raw=id=>{const r=db.prepare('SELECT * FROM audit WHERE id=?').get(auditId(id));if(!r)throw fail('日志不存在','LOG_NOT_FOUND',404);return r;};
 const parse=r=>{const before=r.before_json?JSON.parse(r.before_json):null,after=JSON.parse(r.after_json),changes=orderChanges(before,after);return {id:r.id,orderId:r.order_id,action:r.action,actionLabel:auditActions[r.action]||r.action,createdAt:r.created_at,batchId:r.batch_id,rollbackOf:r.rollback_of,reason:r.reason,before,after,changes,canUndo:!!before&&allowed.has(r.action)&&changes.length>0};};
 function entries(input){const r=raw(input?.auditId);if(input.scope!=='entry'&&input.scope!=='batch')throw fail('请选择单笔或整批撤销');if(input.scope==='batch'&&!r.batch_id)throw fail('此记录没有批次');return (input.scope==='batch'?db.prepare('SELECT * FROM audit WHERE batch_id=? ORDER BY id').all(r.batch_id):[r]).map(parse);}
 function preview(input){
  const logs=entries(input),seen=new Set();
  const orders=logs.map(log=>{
   const current=get(log.orderId),result={auditId:log.id,orderId:log.orderId,orderNo:current?.orderNo||log.after.orderNo,supplier:current?.supplier||log.after.supplier,updatedAt:current?.updatedAt,changes:[],blockedReason:''};
   try{
    if(!log.canUndo)throw fail('首次入账、系统初始化或没有属性变化的记录仅供查看');
    if(!current)throw fail('订单不存在');if(seen.has(current.id))throw fail('同一批次有同单多次修改，请逐笔撤销');seen.add(current.id);
    const conflicts=log.changes.filter(c=>!sameValue(auditValue(current,c.key),c.after));
    if(conflicts.length)throw fail('这些字段后来又被修改，请先处理后续日志：'+conflicts.map(c=>c.label).join('、'),'LOG_FIELD_CONFLICT',409);
    const patch=Object.fromEntries(log.changes.map(c=>[c.key,c.before])),target=validateOrder({...current,...patch});
    monthLocks.assertWritable([current,target]);
    const duplicate=db.prepare('SELECT id FROM orders WHERE platform=? AND account=? AND order_no=? AND id<>?').get(target.platform,target.account,target.orderNo,current.id);
    if(duplicate)throw fail('撤销后的平台、账号和订单编号与另一笔订单重复');
    result.changes=orderChanges(current,target);result.target=target;
   }catch(e){result.blockedReason=e.message;result.code=e.code||'ROLLBACK_NOT_AVAILABLE';}
   return result;
  });
  // Catch collisions between targets as well as existing orders before showing an actionable preview.
  const keys=new Set();for(const o of orders.filter(o=>o.target)){const key=JSON.stringify([o.target.platform,o.target.account,o.target.orderNo]);if(keys.has(key)){o.blockedReason='本批撤销后的订单编号存在重复';o.code='ROLLBACK_NOT_AVAILABLE';}keys.add(key);}
  return {auditId:auditId(input.auditId),scope:input.scope,count:orders.length,canUndo:orders.every(o=>!o.blockedReason),orders};
 }
 function publicPreview(p){return {...p,orders:p.orders.map(({target,...o})=>o)};}
 return {
  list(f={}){
   const where=[],args=[],page=integer(f.page,1,1000000),pageSize=integer(f.pageSize,50,100);
   const text=(v,max=300)=>{if(typeof v!=='string'||v.length>max)throw fail('查询条件无效');return v;};
   if(f.q){const q='%'+text(f.q).trim().replace(/[!%_]/g,c=>'!'+c)+'%';where.push("(a.before_json LIKE ? ESCAPE '!' OR a.after_json LIKE ? ESCAPE '!' OR o.order_no LIKE ? ESCAPE '!' OR o.supplier LIKE ? ESCAPE '!' OR a.batch_id LIKE ? ESCAPE '!' OR a.reason LIKE ? ESCAPE '!' OR CAST(a.id AS TEXT)=?)");args.push(q,q,q,q,q,q,f.q.trim());}
   if(f.orderId){where.push('a.order_id=?');args.push(text(f.orderId));}if(f.batchId){where.push('a.batch_id=?');args.push(text(f.batchId));}
   if(f.action==='changes'||!f.action)where.push("a.action NOT IN ('create','initialize-classification')");else if(f.action!=='all'){if(!Object.hasOwn(auditActions,f.action))throw fail('日志类型无效');where.push('a.action=?');args.push(f.action);}
   if(f.platform){where.push("(json_extract(a.before_json,'$.platform')=? OR json_extract(a.after_json,'$.platform')=?)");args.push(text(f.platform,20),f.platform);}
   if(f.from){where.push('a.created_at>=?');args.push(new Date(day(f.from)).toISOString());}if(f.to){where.push('a.created_at<?');args.push(new Date(day(f.to)+86400000).toISOString());}if(f.from&&f.to&&f.from>f.to)throw fail('开始日期不能晚于结束日期');
   const sql=' FROM audit a LEFT JOIN orders o ON o.id=a.order_id'+(where.length?' WHERE '+where.join(' AND '):''),total=db.prepare('SELECT COUNT(*) AS n'+sql).get(...args).n;
   const rows=db.prepare('SELECT a.*,o.order_no AS current_order_no,o.supplier AS current_supplier'+sql+' ORDER BY a.id DESC LIMIT ? OFFSET ?').all(...args,pageSize,(page-1)*pageSize);
   return {page,pageSize,total,entries:rows.map(r=>{const {before,after,...log}=parse(r);return {...log,orderNo:r.current_order_no||after.orderNo,supplier:r.current_supplier||after.supplier,platform:after.platform,batchCount:r.batch_id?db.prepare('SELECT COUNT(*) AS n FROM audit WHERE batch_id=?').get(r.batch_id).n:1};})};
  },
  detail(id){const log=parse(raw(id));return {...log,current:get(log.orderId),batchCount:log.batchId?db.prepare('SELECT COUNT(*) AS n FROM audit WHERE batch_id=?').get(log.batchId).n:1};},
  preview:input=>publicPreview(preview(input)),
  rollback(input){return transaction(()=>{
   const p=preview(input);if(!p.canUndo)throw fail('整批未保存：'+p.orders.filter(o=>o.blockedReason).map(o=>`${o.orderNo}：${o.blockedReason}`).join('；'),'ROLLBACK_BLOCKED',409);
   const versions=input.versions;if(!Array.isArray(versions)||versions.length!==p.orders.length||new Set(versions.map(v=>v?.auditId)).size!==p.orders.length)throw fail('请重新预览本次撤销','ROLLBACK_PREVIEW_REQUIRED',409);
   for(const o of p.orders){const v=versions.find(v=>v?.auditId===o.auditId);if(!v||v.orderId!==o.orderId||v.updatedAt!==o.updatedAt)throw fail('预览后订单已变化，整批未保存，请重新预览','ORDER_VERSION_CONFLICT',409);}
   const reason=input.reason??'';if(typeof reason!=='string'||reason.length>500)throw fail('撤销原因最多 500 字');
   const batchId=randomUUID(),orders=[];
   for(const o of p.orders){const before=get(o.orderId),now=new Date(Math.max(Date.now(),Date.parse(before.updatedAt)+1)).toISOString(),after={...before,...o.target,updatedAt:now};persistOrder(after,o.orderId,now);db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,batch_id,rollback_of,reason) VALUES (?,?,?,?,?,?,?,?)').run(o.orderId,'rollback',JSON.stringify(before),JSON.stringify(after),now,batchId,o.auditId,reason.trim());orders.push(get(o.orderId));}
   return {batchId,changed:orders.length,orders};
  });}
 };
}
