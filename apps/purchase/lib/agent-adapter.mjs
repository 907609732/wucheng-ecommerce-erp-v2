// Host transport owns authentication. Prepared business payloads stay in the module.
import {validatePurchaseAgentInput,purchaseSchemas} from './agent-schemas.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const digest=b=>createHash('sha256').update(b).digest('hex');
export function createPurchaseAgentAdapter({transport}) {
  const request=typeof transport==='function'?transport:transport?.request?.bind(transport);
  if(!request)throw new TypeError('purchase transport required');
  const base='/api/integration/v1/agent';
  const call=(method,path,body,ctx)=>request('purchase',base+path,{method,body:body?{...body,taskId:ctx?.taskId,idempotencyKey:ctx?.idempotencyKey}:undefined,ctx,signal:ctx?.signal,approval:ctx?.approval,idempotencyKey:ctx?.idempotencyKey});
  const download=async(output,ctx)=>{
    if(!output.data?.downloadUrl)return output;
    if(typeof transport.download!=='function')throw Error('主机尚未提供受控文件下载');
    const d=output.data,route=d.downloadUrl.startsWith('/apps/purchase/')?d.downloadUrl.slice('/apps/purchase'.length):d.downloadUrl;if(!route.startsWith('/api/'))throw Error('模块下载路由不在允许范围');const downloaded=await transport.download('purchase',route,{ctx,expectedSha256:d.sha256,filename:d.filename,maxBytes:50*1024*1024});
    const artifact=downloaded?.artifact||downloaded;if(!artifact?.id)throw Error('主机未返回真实文件产物ID');
    const safe={id:artifact.id,name:artifact.name,mimeType:artifact.mimeType,size:artifact.size,sha256:artifact.sha256};
    return {...output,data:{...d,artifact:safe},blocks:[...(output.blocks||[]),{type:'files',title:'采购结果文件',files:[{artifactId:safe.id,name:safe.name,mimeType:safe.mimeType,size:safe.size,sha256:safe.sha256}]}],evidence:[...(output.evidence||[]),{artifactId:safe.id,label:safe.name,name:safe.name,size:safe.size,sha256:safe.sha256}]};
  };
  const stage=async(input,ctx)=>{
    validatePurchaseAgentInput('files.stage',input);
    if(typeof ctx?.resolveAttachment!=='function'||!ctx.idempotencyKey)throw Error('主机未提供任务附件解析或持久请求键');
    const item=await ctx.resolveAttachment(input.attachmentId),file=fs.openSync(item.path,'r');
    try{
      const stat=fs.fstatSync(file);if(!stat.isFile()||stat.size<1||stat.size>50*1024*1024)throw Error('任务原件须为1字节至50MiB普通文件');
      const content=fs.readFileSync(file),sha256=digest(content);if(item.sha256!==sha256)throw Error('任务原件摘要已变化');
      const filename=path.basename(item.name||item.filename||item.path);let offset=0,uploadId,result;
      while(offset<content.length){ctx.signal?.throwIfAborted();const end=Math.min(offset+8*1024*1024,content.length),key=digest(Buffer.from(ctx.idempotencyKey+':'+sha256+':'+offset));
        const response=await call('POST','/prepare',{capabilityId:'files.upload.part',input:{...(uploadId?{uploadId}:{}),filename,totalBytes:content.length,offset,dataBase64:content.subarray(offset,end).toString('base64'),sha256}},{...ctx,parentCapabilityId:'files.stage',capabilityId:'files.upload.part',idempotencyKey:key});
        if(response.ok===false||!response.data?.uploadId)throw Error(response.error||'原件分片尚未核实');
        result=response.data;uploadId=result.uploadId;offset=result.nextOffset;if(offset!==end)throw Error('原件上传偏移不符');
      }
      if(!result.fileId||result.sha256!==sha256)throw Error('原件完整摘要尚未核实');
      const data={...result,attachmentId:input.attachmentId};return {requiresReview:false,summary:'任务原件已安全暂存到采购台',data,blocks:[{type:'table',rows:[data]}],evidence:[{attachmentId:input.attachmentId,fileId:result.fileId,sha256,bytes:content.length}]};
    }finally{fs.closeSync(file);}
  };
  return {
    id:'purchase',
    capabilities:purchaseAgentCapabilities.filter(c=>!['files.upload','files.upload.part'].includes(c.id)),
    binding:ctx=>call('GET','/binding',undefined,ctx),
    query:async(capabilityId,input,ctx)=>download(await call('POST','/query',{capabilityId,input},ctx),ctx),
    prepare:(capabilityId,input,ctx)=>capabilityId==='files.stage'?stage(input,ctx):call('POST','/prepare',{capabilityId,input},ctx),
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
  ['files.get','读取已上传原件并生成中央任务文件','query'],
  ['source.file','下载已入账采购原始凭证到任务结果','query'],
  ['attachment.file','下载订单附件到任务结果','query'],
  ['files.stage','将本次任务附件安全暂存为采购原件','prepare'],
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
].map(([id,title,kind])=>{const automatic=['files.upload','files.upload.part','files.stage','attachment.stage','import.analyze','import.remap','ocr.start','image.prepare','image.cache','transfer.save'].includes(id);return {id,title,kind,description:title+(kind==='query'?'。返回真实记录ID、版本与业务证据；金额Cents字段均为整数分。':automatic?'。自动整理材料，不正式入账；保留原件、摘要和可恢复任务键。':'。先查询原记录及版本；准备差异后由中央人审授权，旧版本、重复订单与已锁定月份继续拒绝。'),inputSchema:purchaseSchemas[id],requiresReview:kind==='prepare'&&!automatic};});
