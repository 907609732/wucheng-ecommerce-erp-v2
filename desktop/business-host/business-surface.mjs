import {hostError} from './common.mjs';

const modules=new Set(['overview','purchase','sales']);
const views=new Set(['overview','freight','expenses','payroll','gaps']);
const actions=new Set(['getContext','getDraftState','navigate']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const invalid=()=>hostError('BUSINESS_SURFACE_INPUT_INVALID','业务来源参数无效',400);
const badResult=()=>hostError('BUSINESS_SURFACE_RESULT_INVALID','业务页面返回的范围或状态无法核实，请重新读取或缩小范围',409);
const keys=(value,allowed,error=badResult)=>{if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw error();};
const text=(value,max=500)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const period=value=>typeof value==='string'&&/^20\d{2}(?:-(?:0[1-9]|1[0-2]))?$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;

export function controlledBusinessLocator(input){
  keys(input,['module','recordId','sourceId','batchId','period','basis','view'],invalid);
  if(!modules.has(input.module))throw invalid();
  const result={module:input.module};
  for(const key of ['recordId','sourceId','batchId','basis','view'])if(input[key]!=null){
    if(!text(input[key])||/[\r\n]/.test(input[key]))throw invalid();result[key]=input[key];
  }
  for(const key of ['recordId','sourceId','batchId'])if(result[key]!==undefined&&(!result[key]||/[\/\\?#]/.test(result[key])||/^\.{1,2}$/.test(result[key])))throw invalid();
  if(result.view!==undefined&&(result.module!=='overview'||!views.has(result.view)))throw invalid();
  if(input.period!=null){if(!period(input.period))throw invalid();result.period=input.period;}
  if(Buffer.byteLength(JSON.stringify(result))>4096)throw invalid();return result;
}

export function businessSurfaceRequest(input){
  keys(input,['module','action','locator'],invalid);
  if(!modules.has(input.module)||!actions.has(input.action)||input.action!=='navigate'&&input.locator!==undefined)throw invalid();
  const result={module:input.module,action:input.action};
  if(input.action==='navigate'){result.locator=controlledBusinessLocator(input.locator);if(result.locator.module!==input.module)throw invalid();}
  return result;
}

/** The caller selects an enum, never JavaScript, a URL or an arbitrary global member. */
export function businessSurfaceScript(input){
  const request=businessSurfaceRequest(input),module=JSON.stringify(request.module),action=JSON.stringify(request.action);
  const call=request.action==='getContext'?"({status:'ok',module,context:await surface.getContext()})":request.action==='getDraftState'?"({status:'ok',module,draft:await surface.getDraftState()})":`await surface.navigate(${JSON.stringify(request.locator)})`;
  return `(async()=>{const module=${module},action=${action},surface=window.wuchengBusinessSurface;if(!surface||surface.protocolVersion!==1||surface.module!==module||typeof surface[action]!=='function')return JSON.stringify({status:'unsupported',module,action,openedOnly:true,reason:'surface-unavailable'});return JSON.stringify(${call});})()`;
}

function draftMetadata(value){
  keys(value,['dirty','busy','canSave','persistence','openForms']);
  if(typeof value.dirty!=='boolean'||typeof value.busy!=='boolean'||value.canSave!==false||value.persistence!=='memory-only'||!Array.isArray(value.openForms)||value.openForms.length>100)throw badResult();
  for(const form of value.openForms){
    keys(form,['id','kind','recordId','open','dirty']);
    if(!text(form.id,100)||!text(form.kind,100)||form.recordId!==null&&!text(form.recordId)||typeof form.open!=='boolean'||typeof form.dirty!=='boolean')throw badResult();
  }
  return value;
}

function contextMetadata(value,module){
  keys(value,['module','route','period','basis','confirmed','selectionMode','selectedIds','recordCount','filters','sourceLocator']);
  if(value.module!==module||module==='overview'&&!views.has(value.route)||value.period!==null&&!period(value.period)||!text(value.basis)||typeof value.confirmed!=='boolean'||!['selected-records','current-filter'].includes(value.selectionMode)||!Array.isArray(value.selectedIds)||value.selectedIds.some(id=>!text(id)||!id)||value.recordCount!==null&&!count(value.recordCount))throw badResult();
  keys(value.filters,['grain','bucket','search','allPeriods','date','owner','q','recordCount']);
  for(const [key,filter]of Object.entries(value.filters)){
    if(key==='allPeriods'){if(typeof filter!=='boolean')throw badResult();}
    else if(key==='recordCount'){if(filter!==null&&!count(filter))throw badResult();}
    else if(!text(filter,1000))throw badResult();
  }
  if(value.sourceLocator!==null)controlledBusinessLocator(value.sourceLocator);
  return value;
}

export function parseBusinessSurfaceResult(serialized,input){
  const request=businessSurfaceRequest(input);
  if(typeof serialized!=='string'||Buffer.byteLength(serialized)>64*1024)throw badResult();
  let result;try{result=JSON.parse(serialized);}catch{throw badResult();}
  if(result?.status==='unsupported'){
    keys(result,['status','module','action','openedOnly','reason']);
    if(result.module!==request.module||result.action!==request.action||result.openedOnly!==true||result.reason!=='surface-unavailable')throw badResult();return result;
  }
  if(request.action==='getContext'){
    keys(result,['status','module','context']);if(result.status!=='ok'||result.module!==request.module)throw badResult();contextMetadata(result.context,request.module);return result;
  }
  if(request.action==='getDraftState'){
    keys(result,['status','module','draft']);if(result.status!=='ok'||result.module!==request.module)throw badResult();draftMetadata(result.draft);return result;
  }
  keys(result,['status','target','draft','reason','message','recordCount']);
  if(!['located','navigated','not-found','blocked','error'].includes(result.status))throw badResult();
  if(result.target!==undefined&&controlledBusinessLocator(result.target).module!==request.module)throw badResult();
  if(['located','navigated'].includes(result.status)&&result.target===undefined)throw badResult();
  if(result.draft!==undefined)draftMetadata(result.draft);
  if(result.reason!==undefined&&!text(result.reason,100)||result.message!==undefined&&!text(result.message,1000)||result.recordCount!==undefined&&!count(result.recordCount))throw badResult();
  return result;
}
