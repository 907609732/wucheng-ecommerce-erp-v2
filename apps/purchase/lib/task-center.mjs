import {createHash} from 'node:crypto';
import {importRules} from '../public/import-rules.mjs';
import {confirmationTiming,purchaseMonth} from './month-locks.mjs';
import {unallocatedRefund} from '../public/classification.mjs';
import {allShipments} from '../public/shipments.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure=(message,code,status=400)=>Object.assign(Error(message),{code,status});
const groups=[
 {id:'collect',title:'收集并补齐各平台采购',description:'逐个平台核对全部采购账号，完成导入；没有采购的平台也需明确记录。'},
 {id:'review',title:'逐项检查本月数据',description:'按照原始订单和付款凭证逐项复核，再由经办人记录完成。'},
 {id:'confirm',title:'提交月度确认',description:'核对完成后前往月度确认，按平台确认并锁定；任务勾选不会锁定订单。'}
];
const reviews=[
 ['refunds','核对退款与订单状态','核对取消、退款及待核对订单，按实际凭证补齐退款金额；不能仅凭状态推算退款。'],
 ['dates-accounts','补齐付款日期与采购账号','按实际付款日期归月，检查缺失日期和默认账号；同平台的全部采购账号都要覆盖。'],
 ['items-amounts','核对商品、数量与整单实付','逐单检查全部商品、规格、数量、单位和整单实付；含运费实付不重复加计。'],
 ['classification','复核采购类别与不计入订单','确认商品采购、固定资产、日常支出的分类，检查混合分摊、退款分配及不计入采购支出的订单。'],
 ['attachments-logistics','补齐凭证、收货与物流信息','补充原始采购凭证或附件，核对收货信息与运单；不适用的信息在完成备注中说明。']
];
const orderRevision=orders=>hash(orders.map(o=>[o.id,o.updatedAt]).sort((a,b)=>a[0].localeCompare(b[0])));
function evidence(orders){
 return {count:orders.length,accounts:[...new Set(orders.map(o=>o.account).filter(Boolean))].sort(),reviewCount:orders.filter(o=>o.status==='待核对').length,missingPaidCount:orders.filter(o=>!o.paidAt).length,placeholderAccountCount:orders.filter(o=>!o.account||/^(?:默认账号|当前账号|未知账号|待补充)$/.test(o.account)).length,refundCents:orders.reduce((sum,o)=>sum+o.refundCents,0),amountCents:orders.reduce((sum,o)=>sum+o.amountCents,0),unallocatedRefundCents:orders.reduce((sum,o)=>sum+unallocatedRefund(o),0),excludedCount:orders.filter(o=>o.excludedFromSpend).length,missingAttachmentCount:orders.filter(o=>!o.sourceId&&!o.attachmentIds?.length).length,missingTrackingCount:orders.filter(o=>!allShipments(o).some(s=>s.trackingNo)).length};
}

// Task acknowledgement is separate from the accounting records and month confirmations.
export function openTaskCenter(store){
 const {db}=store,platforms=Object.keys(importRules);
 db.exec(`CREATE TABLE IF NOT EXISTS monthly_tasks(month TEXT NOT NULL,task_id TEXT NOT NULL,status TEXT NOT NULL,operator TEXT NOT NULL,note TEXT NOT NULL,updated_at TEXT NOT NULL,order_revision TEXT NOT NULL,PRIMARY KEY(month,task_id));
 CREATE TABLE IF NOT EXISTS monthly_task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,month TEXT NOT NULL,task_id TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const marksFor=month=>db.prepare('SELECT * FROM monthly_tasks WHERE month=? ORDER BY task_id').all(month);
 function overview(month){
  const timing=confirmationTiming(month),orders=store.list().filter(o=>purchaseMonth(o)===month),locks=store.monthLocks.confirmations().filter(c=>c.month===month&&platforms.includes(c.platform)),marks=marksFor(month),allLocked=locks.length===platforms.length;
  const scopeFor=platform=>platform?orders.filter(o=>o.platform===platform):orders;
  function task(id,group,title,description,kind,platform){
   const scope=scopeFor(platform),saved=marks.find(m=>m.task_id===id),confirmation=platform?locks.find(c=>c.platform===platform):null,locked=platform?!!confirmation:allLocked;
   const mark=saved?{status:saved.status,operator:saved.operator,note:saved.note,updatedAt:saved.updated_at}:null;
   const status=locked?'locked':kind==='confirm'?'pending':saved?(saved.order_revision===orderRevision(scope)?saved.status:'stale'):'pending';
   return {id,group,title,description,...(platform?{platform}:{}),kind,status,evidence:evidence(scope),mark,canMark:kind!=='confirm'&&!locked,completed:['done','no_activity','locked'].includes(status),...(confirmation?{confirmation}:{})};
  }
  const tasks=[...platforms.map(platform=>task('collect:'+platform,'collect',platform+'采购数据',importRules[platform].description+' 核对本月全部账号后再记录完成。','collect',platform)),...reviews.map(([id,title,description])=>task('review:'+id,'review',title,description,'review')),...platforms.map(platform=>task('confirm:'+platform,'confirm',platform+'月度确认','完成本月此平台核对后，在月度确认中确认并锁定全部账号和状态。','confirm',platform))];
  const eventVersion=db.prepare('SELECT MAX(id) AS version FROM monthly_task_events WHERE month=?').get(month).version||0;
  const revision=hash({month,eventVersion,orders:orderRevision(orders),marks:marks.map(m=>[m.task_id,m.status,m.operator,m.note,m.updated_at,m.order_revision]),locks:locks.map(c=>[c.platform,c.version]).sort((a,b)=>a[0].localeCompare(b[0]))});
  const completed=tasks.filter(t=>t.completed).length;
  return {month,revision,tasks,groups,summary:{total:tasks.length,completed,pending:tasks.length-completed,stale:tasks.filter(t=>t.status==='stale').length,orderCount:orders.length,lockedPlatforms:locks.length},canConfirm:timing.canConfirm,availableOn:timing.availableOn};
 }
 function update(input={}){
  const {month,taskId,status,ack,revision}=input;
  const operator=typeof input.operator==='string'?input.operator.trim():'',note=typeof input.note==='string'?input.note.trim():'';
  if(!operator||operator.length>100)throw failure('请填写经办人姓名（最多100字）','TASK_OPERATOR_REQUIRED');
  if(note.length>2000)throw failure('任务备注最多2000字','TASK_NOTE_TOO_LONG');
  if(!['pending','done','no_activity'].includes(status))throw failure('任务状态无效','INVALID_TASK_STATUS');
  if(status!=='pending'&&ack!==true)throw failure('请确认已按任务说明核对本月全部范围','TASK_ACK_REQUIRED');
  return store.transaction(()=>{
   const current=overview(month),task=current.tasks.find(t=>t.id===taskId);
   if(!task)throw failure('任务不存在，请刷新任务中心','INVALID_TASK');
   if(typeof revision!=='string'||revision!==current.revision)throw failure('任务或采购数据已变化，请刷新后重新核对','TASK_REVISION_CHANGED',409);
   if(!task.canMark)throw failure(task.kind==='confirm'?'请前往月度确认完成真实确认，不能手动勾选':'本月任务范围已锁定，请先到月度确认取消确认','TASK_NOT_WRITABLE',423);
   if(status==='no_activity'&&(task.kind!=='collect'||task.evidence.count>0||!note))throw failure('仅无订单的平台可以标记本月无采购，并须填写核对说明','INVALID_NO_ACTIVITY');
   const scope=store.list().filter(o=>purchaseMonth(o)===month&&(!task.platform||o.platform===task.platform)),before=db.prepare('SELECT * FROM monthly_tasks WHERE month=? AND task_id=?').get(month,taskId)||null;
   const updatedAt=new Date(Math.max(Date.now(),before?Date.parse(before.updated_at)+1:0)).toISOString(),after={month,taskId,status,operator,note,updatedAt,orderRevision:orderRevision(scope),actualActor:store.actorContext?.()||null};
   // Reset removes acknowledgement so a later data edit cannot revive a pending task.
   if(status==='pending')db.prepare('DELETE FROM monthly_tasks WHERE month=? AND task_id=?').run(month,taskId);
   else db.prepare('INSERT INTO monthly_tasks(month,task_id,status,operator,note,updated_at,order_revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(month,task_id) DO UPDATE SET status=excluded.status,operator=excluded.operator,note=excluded.note,updated_at=excluded.updated_at,order_revision=excluded.order_revision').run(month,taskId,status,operator,note,updatedAt,after.orderRevision);
   db.prepare('INSERT INTO monthly_task_events(month,task_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run(month,taskId,before?JSON.stringify(before):null,JSON.stringify(after),updatedAt);
   return overview(month);
  });
 }
 return {overview,update};
}
