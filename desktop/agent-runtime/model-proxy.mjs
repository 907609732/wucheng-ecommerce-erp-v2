import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {ERP_TOOLS} from './engine-common.mjs';
import {agentError} from './approval.mjs';

const names=new Set(ERP_TOOLS.flatMap(name=>['mcp__wucheng_erp__'+name,'mcp__wucheng_erp.'+name]));
const permitted=name=>typeof name==='string'&&names.has(name);
export function filterCompanyTools(tools){
  if(!Array.isArray(tools))throw agentError('ERP_TOOL_CATALOG_MISSING','缺少 ERP 业务工具清单',503);
  const allowed=[];
  for(const tool of tools){
    if(tool.type==='function'&&permitted(tool.name))allowed.push(tool);
    else if(tool.type==='namespace'&&tool.name==='mcp__wucheng_erp'){
      const nested=(tool.tools||[]).filter(t=>t.type==='function'&&ERP_TOOLS.includes(t.name));if(nested.length)allowed.push({...tool,tools:nested});
    }
  }
  if(!allowed.length)throw agentError('ERP_TOOL_CATALOG_MISSING','Codex 未暴露受控 ERP 工具，已拒绝模型请求',503);
  return allowed;
}
function verifyItem(item,known){
  if(!item||typeof item!=='object')throw agentError('MODEL_PROTOCOL_INVALID','模型返回无效结果',502);
  if(item.type==='function_call'){
    const name=item.namespace?item.namespace+'.'+item.name:item.name;if(!permitted(name))throw agentError('MODEL_TOOL_DENIED','模型尝试调用未授权工具，执行已停止',403);
    if(item.id)known.add(item.id);if(item.call_id)known.add(item.call_id);return;
  }
  if(!['message','reasoning','compaction'].includes(item.type))throw agentError('MODEL_TOOL_DENIED','模型返回了未授权的执行项目',403);
}
export function verifyCompanyResponse(body,contentType){
  const known=new Set();let completed=false;
  if(contentType.includes('text/event-stream')){
    const events=body.split(/\r?\n\r?\n/);for(const event of events){const data=event.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')continue;let value;try{value=JSON.parse(data);}catch{throw agentError('MODEL_PROTOCOL_INVALID','模型流式事件格式无效',502);}
      if(value.item)verifyItem(value.item,known);
      if(value.type==='response.function_call_arguments.delta'||value.type==='response.function_call_arguments.done'){if(!known.has(value.item_id))throw agentError('MODEL_TOOL_DENIED','模型工具参数缺少已验证的业务工具身份',403);}
      if(/custom_tool_call|computer_call|shell_call|code_interpreter_call|tool_search_call/.test(value.type||''))throw agentError('MODEL_TOOL_DENIED','模型尝试调用非业务执行工具',403);
      if(value.response?.output)for(const item of value.response.output)verifyItem(item,known);
      if(value.type==='response.completed')completed=true;
      if(['response.failed','error'].includes(value.type))throw agentError('MODEL_REQUEST_FAILED','公司模型请求失败，任务进度已保留',502);
    }
    if(!completed)throw agentError('MODEL_RESPONSE_INCOMPLETE','模型结果未完整结束，未执行其中的工具调用',502);
  }else{
    let value;try{value=JSON.parse(body);}catch{throw agentError('MODEL_PROTOCOL_INVALID','模型返回无效 JSON',502);}
    if(value.status!=='completed'||!Array.isArray(value.output))throw agentError('MODEL_RESPONSE_INCOMPLETE','模型结果未完整结束',502);
    for(const item of value.output)verifyItem(item,known);
  }
  return true;
}
async function boundedBody(stream,max){let size=0;const chunks=[];for await(const chunk of stream||[]){size+=chunk.length;if(size>max)throw agentError('MODEL_MESSAGE_LIMIT','模型消息超过受控大小',413);chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks).toString('utf8');}
/** No model-produced byte reaches App Server until the entire response is checked. */
export async function openCompanyModelProxy({baseUrl,apiKey,fetchImpl=fetch,signal,onUsage=()=>{}}){
  const token=randomBytes(32).toString('hex');
  let totalTokens=0,unknownUsage=false;
  function recordUsage(body,type){let values=[];try{values=type.includes('text/event-stream')?body.split(/\r?\n\r?\n/).map(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(value=>value&&value!=='[DONE]').map(value=>JSON.parse(value)):[JSON.parse(body)];}catch{unknownUsage=true;return;}
    const final=type.includes('text/event-stream')?values.findLast(value=>value.type==='response.completed')?.response:values[0];const count=final?.usage?.total_tokens;
    if(Number.isSafeInteger(count)&&count>=0){totalTokens+=count;onUsage({totalTokens});}else unknownUsage=true;
  }
  const server=createServer(async(req,res)=>{
    const supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
    if(req.method!=='POST'||req.url!=='/v1/responses'||req.headers.origin||supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){res.writeHead(403);res.end('{}');return;}
    let sent=false,accounted=false;try{
      const input=JSON.parse(await boundedBody(req,8*1024*1024));input.tools=filterCompanyTools(input.tools);if(input.tool_choice&&typeof input.tool_choice==='object'&&!permitted(input.tool_choice.name))throw agentError('MODEL_TOOL_DENIED','模型指定了未授权工具',403);
      sent=true;const upstream=await fetchImpl(baseUrl.replace(/\/$/,'')+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+apiKey},body:JSON.stringify(input),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000)});
      const text=await boundedBody(upstream.body,16*1024*1024),type=upstream.headers.get('content-type')||'application/json';if(!upstream.ok)throw agentError('COMPANY_MODEL_HTTP_ERROR','公司模型服务返回 '+upstream.status,upstream.status===429?429:502);
      recordUsage(text,type);accounted=true;
      verifyCompanyResponse(text,type);res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(text);
    }catch(error){if(sent&&!accounted)unknownUsage=true;res.writeHead(error.statusCode||502,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:error.code||'MODEL_PROXY_ERROR',message:error.code?error.message:'公司模型连接失败'}}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {baseUrl:`http://127.0.0.1:${server.address().port}/v1`,token,usage:()=>unknownUsage?undefined:{totalTokens},close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
