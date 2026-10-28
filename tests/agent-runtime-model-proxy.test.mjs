import test from 'node:test';
import assert from 'node:assert/strict';
import {filterCompanyTools,verifyCompanyResponse,openCompanyModelProxy} from '../desktop/agent-runtime/model-proxy.mjs';

const allowed={type:'function',name:'mcp__wucheng_erp__erp_query',parameters:{type:'object'}};
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const complete=output=>event({type:'response.completed',response:{status:'completed',output}});
test('model input only receives fixed ERP MCP names, no tools with matching suffix in other namespaces',()=>{
  const result=filterCompanyTools([allowed,{type:'custom',name:'apply_patch'},{type:'function',name:'evil__erp_query'},{type:'namespace',name:'functions',tools:[{type:'function',name:'erp_query'}]}]);assert.deepEqual(result,[allowed]);assert.throws(()=>filterCompanyTools([{type:'function',name:'exec_command'}]),{code:'ERP_TOOL_CATALOG_MISSING'});
});
test('untrusted model cannot execute native or unknown calls through any output item variant',()=>{
  for(const item of [{type:'function_call',name:'exec_command'},{type:'function_call',namespace:'functions',name:'apply_patch'},{type:'custom_tool_call',name:'apply_patch'},{type:'shell_call'},{type:'computer_call'},{type:'tool_search_call'},{type:'function_call',name:'mcp__other__erp_query'}]){
    assert.throws(()=>verifyCompanyResponse(event({type:'response.output_item.done',item})+complete([]),'text/event-stream'),{code:'MODEL_TOOL_DENIED'});
  }
  assert.throws(()=>verifyCompanyResponse(event({type:'response.function_call_arguments.delta',item_id:'unseen',delta:'{}'})+complete([]),'text/event-stream'),{code:'MODEL_TOOL_DENIED'});
});
test('valid ERP call followed by a forbidden late event delivers zero upstream response bytes',async()=>{
  const good={id:'tool-1',type:'function_call',name:allowed.name,arguments:'{}'};
  const model=event({type:'response.output_item.added',item:good})+event({type:'response.output_item.done',item:good})+event({type:'response.output_item.done',item:{type:'function_call',name:'exec_command',arguments:'{}'}})+complete([good]);
  const proxy=await openCompanyModelProxy({baseUrl:'https://company.example.invalid/v1',apiKey:'private-key',fetchImpl:async(url,options)=>{assert.equal(options.headers.authorization,'Bearer private-key');const input=JSON.parse(options.body);assert.deepEqual(input.tools,[allowed]);return new Response(new ReadableStream({start(controller){for(let i=0;i<model.length;i+=7)controller.enqueue(new TextEncoder().encode(model.slice(i,i+7)));controller.close();}}),{headers:{'content-type':'text/event-stream'}});}});
  try{const response=await fetch(proxy.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+proxy.token,'content-type':'application/json'},body:JSON.stringify({tools:[allowed,{type:'custom',name:'apply_patch'}]})});assert.equal(response.status,403);const text=await response.text();assert.equal(text.includes('output_item.done'),false);assert.equal(text.includes('private-key'),false);assert.match(text,/MODEL_TOOL_DENIED/);}finally{await proxy.close();}
});
test('truncated or malformed model responses fail before any call is exposed',()=>{
  assert.throws(()=>verifyCompanyResponse(event({type:'response.output_item.done',item:{id:'x',type:'function_call',name:allowed.name}}),'text/event-stream'),{code:'MODEL_RESPONSE_INCOMPLETE'});
  assert.throws(()=>verifyCompanyResponse('data: {invalid}\n\n','text/event-stream'),{code:'MODEL_PROTOCOL_INVALID'});
  assert.equal(verifyCompanyResponse(complete([{id:'x',type:'function_call',name:allowed.name,arguments:'{}'}]),'text/event-stream'),true);
});

test('rejected model tool calls still count upstream usage, lost usage stays unknown',async()=>{
  let mode='rejected';const observed=[];
  const proxy=await openCompanyModelProxy({baseUrl:'https://company.example.invalid/v1',apiKey:'synthetic',onUsage:value=>observed.push(value),fetchImpl:async()=>new Response(JSON.stringify(mode==='rejected'?{status:'completed',output:[{type:'custom_tool_call',name:'apply_patch'}],usage:{total_tokens:19}}:{status:'completed',output:[]}),{headers:{'content-type':'application/json'}})});
  const call=()=>fetch(proxy.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+proxy.token,'content-type':'application/json'},body:JSON.stringify({tools:[allowed]})});
  try{assert.equal((await call()).status,403);assert.equal(proxy.usage().totalTokens,19);assert.equal(observed[0].totalTokens,19);mode='unknown';assert.equal((await call()).status,200);assert.equal(proxy.usage(),undefined);}finally{await proxy.close();}
});
