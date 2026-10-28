import {WORKBENCH_TOOLS} from './ai-interface.mjs';

const MODULES=['warehouse','purchase','sales','overview','exporter'];
const fail=(message,code='INVALID_WORKBENCH_REQUEST')=>Object.assign(Error(message),{code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const extension=(action,params={},confirmSideEffect=false)=>({command:'extension-call',id:'lingtu.desks',action,params,confirmSideEffect});
function params(value){
  if(value===undefined)return {};
  if(!object(value)||Buffer.byteLength(JSON.stringify(value),'utf8')>65536)throw fail('工作台参数必须是最多 64 KiB 的 JSON 对象');
  return value;
}
function moduleId(value){if(!MODULES.includes(value))throw fail('未知工作台模块');return value;}

// One dispatcher is retained for the whole stdio session. It delegates to the
// launcher's existing local/remote adapter, so identities, audit, locks and UI
// confirmation fences are identical to normal business requests.
export function createWorkbenchDispatcher({executeLegacy,version='0.0.0'}){
  if(typeof executeLegacy!=='function')throw TypeError('executeLegacy is required');
  return async function dispatch(request){
    if(!object(request)||typeof request.command!=='string')throw fail('缺少有效工作台命令');
    if(request.command!=='workbench')return executeLegacy(request);
    const value=params(request.params);
    if(request.action==='status')return executeLegacy({command:'status'});
    if(request.action==='capabilities'){
      const response=await executeLegacy({command:'capabilities'});
      if(response?.ok===false)return response;
      return {...response,ok:true,capabilities:{...response?.capabilities,workbench:{apiVersion:1,version,commands:['status','capabilities','modules','query','tasks','prepare'],mcpTools:[...WORKBENCH_TOOLS],persistentDispatcher:true,formalWrites:'two-ui-confirmations-required',arbitraryFileRead:false,arbitraryCommandExecution:false}}};
    }
    if(request.action==='modules'){
      const response=await executeLegacy(extension('status'));
      if(response?.ok===false)return response;
      const rows=Array.isArray(response?.response)?response.response:response?.response?.modules||[];
      return {ok:true,modules:rows.map(row=>({id:row.extension||row.id,status:row.status||'unknown',version:row.version||null,...(row.installed!==undefined?{installed:!!row.installed}:{}),busy:!!row.busy,...(row.authorized!==undefined?{authorized:!!row.authorized}:{}),...(row.dataSetId?{dataSetId:row.dataSetId}:{}),...(row.revision!==undefined?{revision:row.revision}:{})}))};
    }
    const desk=moduleId(request.module);
    if(request.action==='query'){
      const {kind,id,query,path}=value;
      return executeLegacy(extension('query',{desk,...(kind!==undefined?{kind}:{}),...(id!==undefined?{id}:{}),...(query!==undefined?{query}:{}),...(path!==undefined?{path}:{})}));
    }
    if(request.action==='tasks'){
      if(!['warehouse','exporter'].includes(desk))throw fail('此模块没有采集任务接口，请使用 query 查询导入批次或编辑草稿','TASK_QUERY_UNAVAILABLE');
      if(value.id!==undefined&&(typeof value.id!=='string'||value.id.length>200))throw fail('任务 ID 无效');
      return executeLegacy(extension('query',{desk,kind:desk==='warehouse'?'task':value.id?'task':'tasks',...(value.id?{id:value.id}:{}),...(value.query?{query:value.query}:{})}));
    }
    if(request.action==='prepare'){
      if(request.confirmSideEffect!==true)throw fail('整理草稿需要本次明确确认；正式入账仍须两次页面核对','SIDE_EFFECT_CONFIRMATION_REQUIRED');
      if(!['purchase','sales','overview'].includes(desk))throw fail('此模块不支持业务编辑草稿');
      const {kind,id,source,decisions,revision,edit}=value;
      if(kind!==undefined&&!['transfer','edit'].includes(kind))throw fail('只允许整理导入或编辑草稿','UI_CONFIRMATION_REQUIRED');
      return executeLegacy(extension('prepare',{desk,...(kind!==undefined?{kind}:{}),...(id!==undefined?{id}:{}),...(source!==undefined?{source}:{}),...(decisions!==undefined?{decisions}:{}),...(revision!==undefined?{revision}:{}),...(edit!==undefined?{edit}:{})},true));
    }
    throw fail('未知工作台操作');
  };
}

// Only fixed legacy verbs and flags are serialized. No shell is involved.
export function legacyCliArgs(request){
  const command=request?.command;
  if(['help','status','capabilities','doctor','debug-bundle','extensions'].includes(command))return [command];
  if(command==='logs')return ['logs','--limit='+Math.max(1,Math.min(100,Number(request.limit)||30))];
  if(command==='debug-logs')return ['debug-logs','--limit='+Math.max(1,Math.min(100,Number(request.limit)||50)),'--level='+(['any','error','warning','info'].includes(request.level)?request.level:'any'),'--query='+String(request.query||'').slice(0,100)];
  if(command==='extension-call')return [command,'--id='+request.id,'--action='+request.action,'--params-base64='+Buffer.from(JSON.stringify(params(request.params)),'utf8').toString('base64url'),...(request.confirmSideEffect===true?['--confirm-side-effect']:[])];
  if(command==='extension-trust'&&request.confirmed===true)return [command,'--id='+request.id,'--confirm-trust-code'];
  if(['sync','send-latest-valid'].includes(command)&&request.confirmed===true)return [command,'--confirm-send'];
  if(command==='login'&&request.confirmed===true)return [command,'--confirm-open-browser'];
  throw fail('命令缺少本次确认或不支持的 CLI 操作');
}
