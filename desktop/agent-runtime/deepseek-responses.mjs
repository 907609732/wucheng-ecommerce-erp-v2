import {ERP_TOOLS} from './engine-common.mjs';
import {agentError} from './approval.mjs';

const namespace='mcp__wucheng_erp',prefix=namespace+'__',allowed=new Set(ERP_TOOLS);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const denied=()=>agentError('MODEL_TOOL_DENIED','模型请求或返回了未授权业务工具',403);
const invalid=()=>agentError('MODEL_PROTOCOL_INVALID','公司模型工具协议无效，未执行其中的调用',502);
const historyRequired=()=>agentError('DEEPSEEK_STATELESS_HISTORY_REQUIRED','DeepSeek 需要完整会话输入，不能使用服务端会话引用；任务进度已保留',409);

export function usesDeepSeekResponses(baseUrl,model){
  try{const url=new URL(baseUrl);return model==='deepseek-flash'&&url.origin==='https://api.deepseek.com'&&!url.username&&!url.password&&!url.search&&!url.hash&&['/','/v1','/v1/'].includes(url.pathname);}catch{return false;}
}
function leaf(item){
  if(!object(item)||typeof item.name!=='string')throw denied();
  if(item.namespace!=null){if(item.namespace!==namespace||!allowed.has(item.name))throw denied();return item.name;}
  for(const start of [prefix,namespace+'.'])if(item.name.startsWith(start)&&allowed.has(item.name.slice(start.length)))return item.name.slice(start.length);
  throw denied();
}
function flattenCall(item){const {namespace:ignored,...rest}=item;return {...rest,name:prefix+leaf(item)};}

/** A wire-format adapter, never an execution layer. The caller still verifies the entire response. */
export function createDeepSeekResponsesAdapter(baseUrl,input){
  if(!usesDeepSeekResponses(baseUrl,input?.model))return null;
  if(input.previous_response_id!=null||input.conversation!=null)throw historyRequired();
  const request=structuredClone(input),routes=new Map(),originalTools=structuredClone(input.tools);
  if(!Array.isArray(request.tools))throw invalid();
  request.tools=[];
  function add(tool,routing){
    if(!object(tool)||tool.type!=='function'||tool.namespace!=null)throw denied();
    const name=prefix+leaf(routing);if(routes.has(name))throw invalid();
    const {namespace:ignored,...declaration}=tool;
    routes.set(name,routing.namespace?{namespace:routing.namespace,name:routing.name}:{name:routing.name});
    request.tools.push({...declaration,name});
  }
  for(const tool of originalTools){
    if(tool?.type==='namespace'){
      if(tool.name!==namespace||!Array.isArray(tool.tools))throw denied();
      for(const nested of tool.tools)add(nested,{namespace,name:nested.name});
    }else add(tool,{name:tool?.name});
  }
  if(!routes.size)throw denied();
  if(request.input!=null&&typeof request.input!=='string'&&!Array.isArray(request.input))throw invalid();
  if(request.tool_choice!=null){
    if(typeof request.tool_choice==='string'){if(!['none','auto','required'].includes(request.tool_choice))throw denied();}
    else{
      if(!object(request.tool_choice)||request.tool_choice.type!=='function')throw denied();
      const name=prefix+leaf(request.tool_choice);if(!routes.has(name))throw denied();
      const {namespace:ignored,...choice}=request.tool_choice;request.tool_choice={...choice,name};
    }
  }
  if(Array.isArray(request.input)){
    const calls=new Set(),outputs=new Set();
    request.input=request.input.map(item=>{
      if(!object(item))throw invalid();
      if(['item_reference','compaction'].includes(item.type))throw historyRequired();
      if(item.type==='function_call'){
        if(typeof item.call_id!=='string'||!item.call_id||calls.has(item.call_id))throw invalid();
        calls.add(item.call_id);return flattenCall(item);
      }
      if(item.type==='function_call_output'){
        if(typeof item.call_id!=='string'||!calls.has(item.call_id)||outputs.has(item.call_id))throw historyRequired();
        outputs.add(item.call_id);return item;
      }
      if(!['message','reasoning'].includes(item.type)&&!(item.type===undefined&&['user','assistant','system','developer'].includes(item.role)))throw denied();
      return item;
    });
  }
  function restoreToolChoice(choice){
    if(!object(choice))return choice;
    if(choice.type!=='function'||choice.namespace!=null||!routes.has(choice.name))throw denied();
    const {namespace:ignored,...rest}=choice;return {...rest,...routes.get(choice.name)};
  }
  function restoreTools(tools){
    if(!Array.isArray(tools))throw invalid();const seen=new Set();
    for(const tool of tools){if(tool?.type!=='function'||tool.namespace!=null||!routes.has(tool.name)||seen.has(tool.name))throw denied();seen.add(tool.name);}
    return originalTools.flatMap(tool=>{
      if(tool.type==='namespace'){const nested=tool.tools.filter(item=>seen.has(prefix+item.name));return nested.length?[{...tool,tools:nested}]:[];}
      return seen.has(prefix+leaf(tool))?[tool]:[];
    });
  }
  function restore(body,contentType){
    const identities=new Map();
    function restoreItem(item){
      if(!object(item))throw invalid();if(item.type!=='function_call')return item;
      if(item.namespace!=null||!routes.has(item.name))throw denied();
      for(const key of ['id','call_id'])if(item[key]!=null){if(typeof item[key]!=='string'||!item[key])throw invalid();const identity=key+':'+item[key],previous=identities.get(identity);if(previous&&previous!==item.name)throw invalid();identities.set(identity,item.name);}
      const {namespace:ignored,...rest}=item;return {...rest,...routes.get(item.name)};
    }
    function restoreResponse(value){
      if(!object(value))throw invalid();const result={...value};
      if(value.output!==undefined){if(!Array.isArray(value.output))throw invalid();result.output=value.output.map(restoreItem);}
      if(value.tools!==undefined)result.tools=restoreTools(value.tools);
      if(value.tool_choice!==undefined)result.tool_choice=restoreToolChoice(value.tool_choice);
      return result;
    }
    function parse(text){try{return JSON.parse(text);}catch{throw invalid();}}
    if(!contentType.includes('text/event-stream'))return JSON.stringify(restoreResponse(parse(body)));
    return body.split(/(\r?\n\r?\n)/).map((block,index)=>{
      if(index%2)return block;const lines=block.split(/\r?\n/),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data||data==='[DONE]')return block;const value=parse(data);if(!object(value))throw invalid();
      const result={...value};if(value.item!==undefined)result.item=restoreItem(value.item);if(value.response!==undefined)result.response=restoreResponse(value.response);
      const newline=block.includes('\r\n')?'\r\n':'\n';let written=false;
      return lines.flatMap(line=>{if(!line.startsWith('data:'))return [line];if(written)return [];written=true;return ['data: '+JSON.stringify(result)];}).join(newline);
    }).join('');
  }
  return {request,restore};
}
