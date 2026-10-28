// Host transport owns authentication. Prepared business payloads stay in the module.
export function createPurchaseAgentAdapter({transport}) {
  const request=typeof transport==='function'?transport:transport?.request?.bind(transport);
  if(!request)throw new TypeError('purchase transport required');
  const base='/api/integration/v1/agent';
  const call=(method,path,body,ctx)=>request('purchase',base+path,{method,body:body?{...body,taskId:ctx?.taskId}:undefined,ctx,signal:ctx?.signal,approval:ctx?.approval,idempotencyKey:ctx?.idempotencyKey});
  return {
    id:'purchase',
    capabilities:purchaseAgentCapabilities,
    binding:ctx=>call('GET','/binding',undefined,ctx),
    query:(capabilityId,input,ctx)=>call('POST','/query',{capabilityId,input},ctx),
    prepare:(capabilityId,input,ctx)=>call('POST','/prepare',{capabilityId,input},ctx),
    commit:(prepared,ctx)=>{const claims=JSON.parse(Buffer.from(ctx.approval.payload,'base64url').toString('utf8'));return call('POST','/commit',{preparedId:prepared.commitData?.preparedId??prepared.id,resultId:claims.resultId,resultVersion:claims.resultVersion,idempotencyKey:ctx.idempotencyKey},ctx);},
    receipt:(key,ctx)=>call('GET','/receipts/'+encodeURIComponent(key),undefined,ctx)
  };
}
const schema={type:'object',additionalProperties:true};
export const purchaseAgentCapabilities=[
  ['orders','采购订单与详情','query'],['dashboard','采购支出统计','query'],
  ['sources','导入来源与原件','query'],['audit','订单审计与补充来源','query'],
  ['suppliers','供应商与历史','query'],['addresses','收货地址','query'],
  ['tasks','月度任务与分派','query'],['months','月度确认与历史','query'],
  ['attachments','订单附件与图片','query'],['export','采购报表导出','query'],
  ['ocr.text','识别采购文字','query'],['ocr.status','识别进度与结果','query'],
  ['import.preview','读取表格导入核对结果','query'],
  ['order.create','录入采购订单','prepare'],['order.update','修改采购与退款','prepare'],
  ['orders.attributes','批量采购属性','prepare'],['orders.classification','批量分类与分摊','prepare'],
  ['supplier.save','维护供应商','prepare'],['address.save','维护地址','prepare'],['address.remove','删除地址','prepare'],
  ['task.action','分派执行提交验收任务','prepare'],['task.mark','记录月度核对结果','prepare'],
  ['month.confirm','确认并锁定月份','prepare'],['month.cancel','取消月份锁定','prepare'],
  ['audit.rollback','回滚采购修改','prepare'],['import.commit','核对后导入表格','prepare'],
  ['image.prepare','提取订单来源图片','prepare'],['image.cache','缓存原始图片','prepare'],
  ['attachment.remove','删除暂存附件','prepare']
].map(([id,title,kind])=>({id,title,kind,description:title,inputSchema:schema,requiresReview:kind==='prepare'}));
