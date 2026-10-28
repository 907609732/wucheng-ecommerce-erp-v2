import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {summarize} from './store.mjs';
import {extractText,validateOrder} from './importer.mjs';
import {filterOrders} from '../public/order-query.mjs';
import {attributePatch} from '../public/order-attributes.mjs';
import {normalizeClassification} from '../public/classification.mjs';
import {normalizeSupplier} from './supplier-management.mjs';
import {normalizeAddress} from './addresses.mjs';
export function purchaseAgentOperations({store,taskBoard,taskCenter,supplierManagement,addresses,attachments,jobs}){
 const request=ctx=>({workbenchActor:ctx.actor,headers:{}});
 const query=fn=>({query:fn});
 const mutation=(read,commit)=>({prepare:(input,ctx)=>({summary:'复核采购业务变更',evidence:[read(input,ctx)],changes:[{before:read(input,ctx),requested:input}],commitData:{}}),commit});
 const selected=input=>{const rows=input.orders.map(ref=>{const o=store.get(ref.id);if(!o||o.updatedAt!==ref.updatedAt)throw Error('订单不存在或版本已变化');return o;});store.monthLocks.assertWritable(rows);return rows;};
 return {
  orders:query(i=>i.id?store.get(i.id):filterOrders(store.list(),i,i.basis)),
  dashboard:query(i=>summarize(store.list(),i.year,i.basis||'paid',i.platform||'全部',i.category||'',i.month||'')),
  'source.file':query(i=>{const row=store.db.prepare('SELECT id,filename,hash,file_path FROM imports WHERE id=?').get(i.id);if(!row?.file_path)throw Error('采购来源不存在');const file=fs.realpathSync(path.join(store.dir,row.file_path)),relative=path.relative(fs.realpathSync(path.join(store.dir,'originals')),file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('来源文件不在原件目录');return {id:row.id,filename:row.filename,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),downloadUrl:'/api/source/'+encodeURIComponent(row.id)};}),
  'attachment.file':query(i=>{const resource=attachments.resource(i.id,'full');return {id:i.id,filename:resource.filename||'采购附件',downloadUrl:'/api/attachments/'+encodeURIComponent(i.id)};}),
  sources:query(()=>store.imports().map(source=>({...source,downloadUrl:'/api/source/'+encodeURIComponent(source.id)}))),
  export:query(i=>{const allowed=new Set(['orders','classification','monthly','template']),kind=i.kind||'orders';if(!allowed.has(kind))throw Error('导出类型无效');const endpoint={orders:'export',classification:'classification-export',monthly:'monthly-export',template:'template'}[kind];const params=new URLSearchParams(Object.entries(i).filter(([k,v])=>k!=='kind'&&v!==undefined));return {kind,filename:{orders:'采购订单.csv',classification:'采购支出分类明细.csv',monthly:'月度采购支出.csv',template:'采购导入模板.csv'}[kind],downloadUrl:'/api/'+endpoint+'?'+params.toString(),evidence:{orderCount:filterOrders(store.list(),i,i.basis).length}};}),
  audit:query(i=>i.id?{history:store.history(i.id),supplements:store.supplements(i.id)}:store.auditLog.list(i)),
  suppliers:query(i=>i.id?{supplier:supplierManagement.get(i.id),history:supplierManagement.history(i.id)}:supplierManagement.list(i)),
  addresses:query(i=>addresses.list(i)),
  tasks:query((i,c)=>taskBoard.overview(request(c),i.month)),
  months:query(i=>i.platform?{preview:store.monthLocks.preview(i.month,i.platform),history:store.monthLocks.history(i.month,i.platform)}:store.monthLocks.overview(i.month)),
  attachments:query(i=>attachments.list(i.id)),
  'ocr.text':query(i=>({text:String(i.text||'').slice(0,100000),order:extractText(String(i.text||'').slice(0,100000),i.platform||'其他')})),
  'ocr.status':query(i=>{const j=jobs.get(i.id);if(!j)throw Error('识别任务已过期');return {id:j.id,status:j.status,progress:j.progress,result:j.result,error:j.error};}),
  'order.create':mutation(i=>{const order=validateOrder(i);store.monthLocks.assertWritable([order]);if(store.find(order))throw Error('订单已存在，请查询原单后修改，不能重复入账');return {order};},i=>store.insert(validateOrder(i),null,i)),
  'order.update':mutation(i=>{const before=store.get(i.id),after=validateOrder(i);if(!before||before.updatedAt!==i.updatedAt)throw Error('订单不存在或版本已变化');store.monthLocks.assertWritable([before,after]);return before;},i=>store.update(i.id,i)),
  'orders.attributes':mutation(i=>{attributePatch(i.patch);return selected(i);},i=>store.attributesBatch(i)),
  'orders.classification':mutation(i=>{normalizeClassification({mode:'single',category:i.category},0,0);return selected(i);},i=>store.classifyBatch(i)),
  'supplier.save':mutation(i=>{normalizeSupplier(i);return i.id?supplierManagement.get(i.id):null;},i=>supplierManagement.save(i.id||null,i)),
  'address.save':mutation(i=>{normalizeAddress(i);return i.id?addresses.list().find(a=>a.id===i.id):null;},i=>i.id?addresses.update(i.id,i):addresses.create(i)),
  'address.remove':mutation(()=>addresses.list(),i=>addresses.remove(i.id,i)),
  'task.action':mutation((i,c)=>taskBoard.overview(request(c),i.month),(i,_d,c)=>taskBoard.act(request(c),i)),
  'task.mark':mutation((i,c)=>{if(c.actor.role!=='admin')throw Object.assign(Error('员工请通过本人分派任务提交核对结果'),{status:403});return taskCenter.overview(i.month);},i=>taskCenter.update(i)),
  'month.confirm':mutation(i=>store.monthLocks.preview(i.month,i.platform),i=>store.monthLocks.confirm(i)),
  'month.cancel':mutation(i=>({preview:store.monthLocks.preview(i.month,i.platform),confirmation:store.monthLocks.confirmations().find(c=>c.month===i.month&&c.platform===i.platform)}),(i,_d,c)=>{if(c.actor.role!=='admin')throw Object.assign(Error('仅管理员可以解除月锁'),{status:403});return store.monthLocks.cancelWithAgentReview(i,{actorId:c.actor.id,approvalId:c.verifiedApproval.approvalId});}),
  'audit.rollback':mutation(i=>store.auditLog.preview(i),i=>store.auditLog.rollback(i)),
  'attachment.remove':mutation(i=>({id:i.id}),i=>attachments.remove(i.id))
 };
}
