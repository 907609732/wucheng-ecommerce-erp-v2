import {schemaFor} from './agent-schemas.mjs';
const definitions={
 report:['月度经营报表',['month']],dashboard:['期间经营看板',[]],bills:['全部费用账单',[]],bill:['账单及付款详情',['id']],payments:['付款登记记录',[]],audit:['最近业务审计',[]],sources:['来源台账与分类',[]],details:['月报筛选明细',['month']],snapshot:['读取月报快照',['id']],original:['下载账单原件',['id']],template:['下载导入模板',['kind']],export:['导出月报',['month']],'freight-export':['导出运费明细',['period']],'import-preview':['检查原件与字段映射',['filename','dataBase64','sha256']], 'backup-file':['下载已有备份',['name']],'cainiao-status':['云仓连接状态',[]],'cainiao-jobs':['云仓下载任务',[]],'cainiao-job':['云仓任务及原件',['id']],'cainiao-file':['下载云仓已归档原件',['id']],
 'file-stage':['接收本任务原件',[]],'bill-create':['新增费用账单',['kind','billNo','party','period','billDate','category','amountCents']],'bill-update':['更正费用账单',['id','version','reason','kind','billNo','party','period','billDate','category','amountCents']],'bill-void':['作废费用账单',['id','version','reason']],'payment-create':['登记付款或退款流水',['id','version','date','direction','amountCents','reference']],'payment-void':['撤销付款登记',['id','reason']],'source-classify':['核对来源分类',['key','sourceHash','reason']],import:['导入原件费用账单',['filename','dataBase64','sha256']],coverage:['确认月度数据覆盖',['month','category','status','revision','reason']],'snapshot-create':['留存月报快照',['month','revision']],backup:['备份经营总览',[]],'restore-copy':['校验备份并恢复独立副本',['dataBase64','sha256']],'cainiao-start':['开始云仓逐月下载',['account','from']],'cainiao-stop':['停止云仓后续下载',['id']],'cainiao-resume':['继续已暂停云仓任务',['id']]
};
const describe=c=>{const key=c.id.slice('overview.'.length),[title,required]=definitions[key];const automated=['file-stage','backup','cainiao-start','cainiao-stop','cainiao-resume'].includes(key);c={...c,requiresReview:automated?false:c.requiresReview};return {...c,title,description:title+(c.requiresReview?'；仅生成复核草稿，中央批准后执行；不进行实际资金划转。':automated?'；自动接收原件、生成备份或推进下载任务，不登记正式费用；下载须查询实际状态。':'；只读真实账本或返回带摘要的原件。'),inputSchema:schemaFor(c.id)};};
export const overviewAgentCapabilities=[
 ...['report','dashboard','bills','bill','payments','audit','sources','details','snapshot','original','template','export','freight-export','import-preview','backup-file','cainiao-status','cainiao-jobs','cainiao-job','cainiao-file'].map(id=>({id:'overview.'+id,title:id,kind:'query',description:'读取经营总览 '+id,inputSchema:{type:'object'},requiresReview:false})),
 ...['file-stage','bill-create','bill-update','bill-void','payment-create','payment-void','source-classify','import','coverage','snapshot-create','backup','restore-copy','cainiao-start','cainiao-stop','cainiao-resume'].map(id=>({id:'overview.'+id,title:id,kind:'prepare',description:'准备经营总览 '+id,inputSchema:{type:'object'},requiresReview:true}))
].map(describe);
export function createOverviewAgentAdapter({transport}){
 const request=typeof transport==='function'?transport:transport?.request?.bind(transport);
 if(!request)throw TypeError('Overview Agent requires trusted module transport');
 const call=(route,body,ctx,method='POST')=>request('overview','/api/integration/v1/agent/'+route,{method,body,ctx,signal:ctx?.signal,approval:ctx?.approval,idempotencyKey:ctx?.idempotencyKey});
 return {id:'overview',capabilities:overviewAgentCapabilities,
  binding:ctx=>typeof transport.binding==='function'?transport.binding('overview',ctx):call('binding',undefined,ctx,'GET'),
  query:(capabilityId,input,ctx)=>call('query?'+new URLSearchParams({capabilityId,input:JSON.stringify(input||{}),taskId:ctx?.taskId||''}),undefined,ctx,'GET'),
  prepare:(capabilityId,input,ctx)=>call('prepare',{capabilityId,input,taskId:ctx?.taskId},ctx),
  commit:(prepared,ctx)=>call('commit',{prepared},ctx),
  receipt:(idempotencyKey,ctx)=>call('receipts/'+encodeURIComponent(idempotencyKey),undefined,ctx,'GET')};
}
