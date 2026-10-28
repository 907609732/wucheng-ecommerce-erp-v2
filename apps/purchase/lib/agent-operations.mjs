import {summarize} from './store.mjs';
import {extractText,validateOrder} from './importer.mjs';
import {filterOrders} from '../public/order-query.mjs';
export function purchaseAgentOperations({store,taskBoard,taskCenter,supplierManagement,addresses,attachments,jobs}){
 const request=ctx=>({workbenchActor:ctx.actor,headers:{}});
 const query=fn=>({query:fn});
 const mutation=(read,commit)=>({prepare:(input,ctx)=>({summary:'复核采购业务变更',evidence:[read(input,ctx)],changes:[{before:read(input,ctx),requested:input}],commitData:{}}),commit});
 return {
  orders:query(i=>i.id?store.get(i.id):filterOrders(store.list(),i,i.basis)),
  dashboard:query(i=>summarize(store.list(),i.year,i.basis||'paid',i.platform||'全部',i.category||'',i.month||'')),
  sources:query(()=>store.imports().map(source=>({...source,downloadUrl:'/api/source/'+encodeURIComponent(source.id)}))),
  export:query(i=>{const allowed=new Set(['orders','classification','monthly','template']),kind=i.kind||'orders';if(!allowed.has(kind))throw Error('导出类型无效');const endpoint={orders:'export',classification:'classification-export',monthly:'monthly-export',template:'template'}[kind];const params=new URLSearchParams(Object.entries(i).filter(([k,v])=>k!=='kind'&&v!==undefined));return {kind,downloadUrl:'/api/'+endpoint+'?'+params.toString(),evidence:{orderCount:filterOrders(store.list(),i,i.basis).length}};}),
  audit:query(i=>i.id?{history:store.history(i.id),supplements:store.supplements(i.id)}:store.auditLog.list(i)),
  suppliers:query(i=>i.id?{supplier:supplierManagement.get(i.id),history:supplierManagement.history(i.id)}:supplierManagement.list(i)),
  addresses:query(i=>addresses.list(i)),
  tasks:query((i,c)=>taskBoard.overview(request(c),i.month)),
  months:query(i=>i.platform?{preview:store.monthLocks.preview(i.month,i.platform),history:store.monthLocks.history(i.month,i.platform)}:store.monthLocks.overview(i.month)),
  attachments:query(i=>attachments.list(i.id)),
  'ocr.text':query(i=>({text:String(i.text||'').slice(0,100000),order:extractText(String(i.text||'').slice(0,100000),i.platform||'其他')})),
  'ocr.status':query(i=>{const j=jobs.get(i.id);if(!j)throw Error('识别任务已过期');return {id:j.id,status:j.status,progress:j.progress,result:j.result,error:j.error};}),
  'order.create':mutation(i=>({order:validateOrder(i)}),i=>store.insert(validateOrder(i),null,i)),
  'order.update':mutation(i=>store.get(i.id),i=>store.update(i.id,i)),
  'orders.attributes':mutation(()=>({}),i=>store.attributesBatch(i)),
  'orders.classification':mutation(()=>({}),i=>store.classifyBatch(i)),
  'supplier.save':mutation(i=>i.id?supplierManagement.get(i.id):null,i=>supplierManagement.save(i.id||null,i)),
  'address.save':mutation(()=>addresses.list(),i=>i.id?addresses.update(i.id,i):addresses.create(i)),
  'address.remove':mutation(()=>addresses.list(),i=>addresses.remove(i.id,i)),
  'task.action':mutation((i,c)=>taskBoard.overview(request(c),i.month),(i,_d,c)=>taskBoard.act(request(c),i)),
  'task.mark':mutation(i=>taskCenter.overview(i.month),i=>taskCenter.update(i)),
  'month.confirm':mutation(i=>store.monthLocks.preview(i.month,i.platform),i=>store.monthLocks.confirm(i)),
  'month.cancel':mutation(i=>({preview:store.monthLocks.preview(i.month,i.platform),confirmation:store.monthLocks.confirmations().find(c=>c.month===i.month&&c.platform===i.platform)}),(i,_d,c)=>{if(c.actor.role!=='admin')throw Object.assign(Error('仅管理员可以解除月锁'),{status:403});return store.monthLocks.cancelWithAgentReview(i,{actorId:c.actor.id,approvalId:c.verifiedApproval.approvalId});}),
  'audit.rollback':mutation(i=>store.auditLog.preview(i),i=>store.auditLog.rollback(i)),
  'attachment.remove':mutation(i=>({id:i.id}),i=>attachments.remove(i.id))
 };
}
