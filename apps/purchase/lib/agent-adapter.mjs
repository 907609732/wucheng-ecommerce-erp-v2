// Host transport owns authentication. Prepared business payloads stay in the module.
import {purchaseSchemas} from './agent-schemas.mjs';
export function createPurchaseAgentAdapter({transport}) {
  const request=typeof transport==='function'?transport:transport?.request?.bind(transport);
  if(!request)throw new TypeError('purchase transport required');
  const base='/api/integration/v1/agent';
  const call=(method,path,body,ctx)=>request('purchase',base+path,{method,body:body?{...body,taskId:ctx?.taskId,idempotencyKey:ctx?.idempotencyKey}:undefined,ctx,signal:ctx?.signal,approval:ctx?.approval,idempotencyKey:ctx?.idempotencyKey});
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
export const purchaseAgentCapabilities=[
  ['orders','采购订单与详情','query'],['dashboard','采购支出统计','query'],
  ['sources','导入来源与原件','query'],['audit','订单审计与补充来源','query'],
  ['suppliers','供应商与历史','query'],['addresses','收货地址','query'],
  ['tasks','月度任务与分派','query'],['months','月度确认与历史','query'],
  ['attachments','订单附件与图片','query'],['export','采购报表导出','query'],
  ['ocr.text','识别采购文字','query'],['ocr.status','识别进度与结果','query'],
  ['import.preview','读取表格导入核对结果','query'],
  ['files.get','读取已上传原件的文件ID、摘要及下载链接','query'],
  ['files.upload','上传采购原件并取得受控文件ID','prepare'],
  ['files.upload.part','分片上传大原件并按摘要校验后取得文件ID','prepare'],
  ['attachment.stage','将原件暂存为订单附件','prepare'],
  ['import.analyze','识别Excel或CSV字段并生成导入核对表','prepare'],
  ['import.remap','调整原件工作表与字段映射并重新核对','prepare'],
  ['ocr.start','使用本地真实OCR识别图片或PDF原件','prepare'],
  ['ocr.commit','核对识别结果后保存采购单及所有原件','prepare'],
  ['transfers','查询导出台传入的历史订单核对批次','query'],
  ['transfer.verify','复核历史订单导入批次与当前订单差异','query'],
  ['transfer.save','补齐采集账号退款依据及冲突字段取值','prepare'],
  ['transfer.commit','中央审批后正式导入采集订单','prepare'],
  ['transfer.rollback','中央审批后撤销整批采集订单导入','prepare'],
  ['order.create','录入采购订单','prepare'],['order.update','修改采购与退款','prepare'],
  ['orders.attributes','批量采购属性','prepare'],['orders.classification','批量分类与分摊','prepare'],
  ['supplier.save','维护供应商','prepare'],['address.save','维护地址','prepare'],['address.remove','删除地址','prepare'],
  ['task.action','分派执行提交验收任务','prepare'],['task.mark','记录月度核对结果','prepare'],
  ['month.confirm','确认并锁定月份','prepare'],['month.cancel','取消月份锁定','prepare'],
  ['audit.rollback','回滚采购修改','prepare'],['import.commit','核对后导入表格','prepare'],
  ['image.prepare','提取订单来源图片','prepare'],['image.cache','缓存原始图片','prepare'],
  ['attachment.remove','删除暂存附件','prepare']
].map(([id,title,kind])=>{const automatic=['files.upload','files.upload.part','attachment.stage','import.analyze','import.remap','ocr.start','image.prepare','image.cache','transfer.save'].includes(id);return {id,title,kind,description:title+(kind==='query'?'。返回真实记录ID、版本与业务证据；金额Cents字段均为整数分。':automatic?'。自动整理材料，不正式入账；保留原件、摘要和可恢复任务键。':'。先查询原记录及版本；准备差异后由中央人审授权，旧版本、重复订单与已锁定月份继续拒绝。'),inputSchema:purchaseSchemas[id],requiresReview:kind==='prepare'&&!automatic};});
