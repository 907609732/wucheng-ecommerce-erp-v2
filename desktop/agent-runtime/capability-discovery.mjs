import {agentError} from './approval.mjs';

const moduleTitles=Object.freeze({warehouse:'云仓',purchase:'采购',sales:'销售',overview:'经营总览',exporter:'订单导出',system:'公共事务'});
const discoveryKeys=new Set(['module','capabilityId','cursor','limit']);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const validName=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value;
const invalid=()=>agentError('CAPABILITY_DISCOVERY_INPUT_INVALID','能力查询参数无效；按模块分页查询，再取得单项参数说明',400);
const denied=()=>agentError('CAPABILITY_DENIED','此能力未登记或不在本次任务范围',403);
const needsReview=cap=>cap.requiresReview===true||cap.kind==='prepare'&&cap.requiresReview!==false;
const available=cap=>cap.available!==false;
const byId=(left,right)=>left.id<right.id?-1:left.id>right.id?1:0;

/** Pure presentation of an actor-filtered catalog. Identity is checked by the runtime. */
export function discoverAgentCapabilities(capabilities,input={},scopeModules=[]){
  if(!isObject(input)||Object.keys(input).some(key=>!discoveryKeys.has(key)))throw invalid();
  const {module,capabilityId}=input;
  if(module!==undefined&&!validName(module,64)||capabilityId!==undefined&&!validName(capabilityId,200))throw invalid();
  if(input.cursor!==undefined&&(!Number.isSafeInteger(input.cursor)||input.cursor<0))throw invalid();
  if(input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>20))throw invalid();
  if(module===undefined&&(capabilityId!==undefined||input.cursor!==undefined||input.limit!==undefined))throw invalid();
  if(capabilityId!==undefined&&(input.cursor!==undefined||input.limit!==undefined))throw invalid();
  if(!Array.isArray(capabilities)||!Array.isArray(scopeModules)||scopeModules.some(value=>!validName(value,64)))throw agentError('CAPABILITY_CATALOG_INVALID','业务能力目录无效',503);
  const moduleIds=[...new Set(scopeModules)],groups=new Map(moduleIds.map(id=>[id,[]])),keys=new Set();
  if(module!==undefined&&!groups.has(module))throw denied();
  for(const cap of capabilities){
    if(!groups.has(cap?.module))continue;
    if(!validName(cap.id,200)||!['query','prepare'].includes(cap.kind))throw agentError('CAPABILITY_CATALOG_INVALID','业务能力目录无效',503);
    const key=JSON.stringify([cap.module,cap.id]);
    if(keys.has(key))throw agentError('CAPABILITY_CATALOG_INVALID','同一模块存在重复能力编号，无法安全选择参数说明',503);
    keys.add(key);groups.get(cap.module).push(cap);
  }
  if(module===undefined)return {
    mode:'modules',
    modules:moduleIds.map(id=>{
      const items=groups.get(id),availableCount=items.filter(available).length;
      return {module:id,title:moduleTitles[id]||id,capabilityCount:items.length,availableCount,unavailableCount:items.length-availableCount};
    }),
    guidance:'使用 erp_capabilities({module,cursor:0,limit:10}) 分页查找能力；默认10项，最多20项。选中后使用 erp_capabilities({module,capabilityId}) 取得完整说明与 inputSchema。available=false 表示待开通，不得调用。'
  };
  const items=groups.get(module).slice().sort(byId);
  if(capabilityId!==undefined){
    const cap=items.find(item=>item.id===capabilityId);if(!cap)throw denied();
    return {mode:'capability',module,capability:{...structuredClone(cap),module,title:cap.title||cap.id,description:cap.description||'',available:available(cap),requiresReview:needsReview(cap),inputSchema:cap.inputSchema?structuredClone(cap.inputSchema):null},
      guidance:available(cap)?'依据本项 inputSchema 构造 input；query 使用 erp_query，prepare 使用 erp_prepare。':'此能力待开通；保留 unavailableReason，向用户说明，不能把占位能力当作已实现。'};
  }
  const cursor=input.cursor??0,limit=input.limit??10,page=items.slice(cursor,cursor+limit);
  return {mode:'capabilities',module,total:items.length,cursor,limit,nextCursor:cursor+page.length<items.length?cursor+page.length:null,
    capabilities:page.map(cap=>({id:cap.id,title:cap.title||cap.id,kind:cap.kind,available:available(cap),requiresReview:needsReview(cap)})),
    guidance:'需要更多能力时用 nextCursor 继续；选中能力后传入相同 module 与 capabilityId 取得 inputSchema，再执行。available=false 表示待开通。'};
}
