import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeepSeekResponsesAdapter,usesDeepSeekResponses} from '../desktop/agent-runtime/deepseek-responses.mjs';
import {openCompanyModelProxy,verifyCompanyResponse} from '../desktop/agent-runtime/model-proxy.mjs';

const baseUrl='https://api.deepseek.com',namespace='mcp__wucheng_erp',wire='mcp__wucheng_erp__erp_query';
const tool={type:'namespace',name:namespace,description:'ERP only',tools:[{type:'function',name:'erp_query',parameters:{type:'object',properties:{module:{type:'string'}},additionalProperties:false},strict:true}]};
const input=extra=>({model:'deepseek-flash',tools:[structuredClone(tool)],...extra});
const event=value=>'event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n';
const done=output=>({type:'response.completed',sequence_number:8,response:{id:'response_1',status:'completed',output,usage:{input_tokens:11,output_tokens:8,total_tokens:19}}});

test('DeepSeek adapter is limited to the official host, model and known Responses base paths',()=>{
  assert.equal(usesDeepSeekResponses(baseUrl,'deepseek-flash'),true);assert.equal(usesDeepSeekResponses(baseUrl+'/v1','deepseek-flash'),true);
  for(const [url,model]of [['https://api.deepseek.com.evil.invalid','deepseek-flash'],['http://api.deepseek.com','deepseek-flash'],[baseUrl+'/other','deepseek-flash'],[baseUrl,'gpt-5.4'],['https://company.invalid/v1','deepseek-flash']])assert.equal(createDeepSeekResponsesAdapter(url,input({model})),null);
});

test('namespace, explicit choice and complete history flatten without changing arguments or call pairing',()=>{
  const original=input({tool_choice:{type:'function',namespace,name:'erp_query'},input:[{role:'user',content:'read schedules'},{type:'function_call',namespace,name:'erp_query',call_id:'call_old',arguments:'{"module":"system","note":"erp_query"}'},{type:'function_call_output',call_id:'call_old',output:'{"namespace":"unmodified data"}'}]});
  const saved=structuredClone(original),adapter=createDeepSeekResponsesAdapter(baseUrl,original);
  assert.deepEqual(original,saved);assert.deepEqual(adapter.request.tools,[{...tool.tools[0],name:wire}]);assert.deepEqual(adapter.request.tool_choice,{type:'function',name:wire});
  assert.equal(Object.hasOwn(adapter.request.input[1],'namespace'),false);assert.equal(adapter.request.input[1].name,wire);assert.equal(adapter.request.input[1].arguments,original.input[1].arguments);assert.deepEqual(adapter.request.input[2],original.input[2]);
});

test('stateful references, orphan outputs and conflicting tool declarations fail before provider dispatch',()=>{
  for(const extra of [{previous_response_id:'stored_1'},{conversation:{id:'stored_1'}},{input:[{type:'item_reference',id:'stored_1'}]},{input:[{type:'function_call_output',call_id:'absent',output:'x'}]}])assert.throws(()=>createDeepSeekResponsesAdapter(baseUrl,input(extra)),{code:'DEEPSEEK_STATELESS_HISTORY_REQUIRED'});
  assert.throws(()=>createDeepSeekResponsesAdapter(baseUrl,input({tools:[tool,{type:'function',name:wire}]})),{code:'MODEL_PROTOCOL_INVALID'});
  assert.throws(()=>createDeepSeekResponsesAdapter(baseUrl,input({tool_choice:{type:'allowed_tools',tools:[]}})),{code:'MODEL_TOOL_DENIED'});
  assert.throws(()=>createDeepSeekResponsesAdapter(baseUrl,input({input:{ref:'unknown'}})),{code:'MODEL_PROTOCOL_INVALID'});
});

test('JSON response restores the original namespace and echo metadata while preserving IDs, arguments and usage',()=>{
  const adapter=createDeepSeekResponsesAdapter(baseUrl,input()),item={id:'fc_1',call_id:'call_1',type:'function_call',name:wire,arguments:'{"module":"system"}',status:'completed'};
  const source={...done([item]).response,tools:[{...tool.tools[0],name:wire}],tool_choice:{type:'function',name:wire}};
  const restored=JSON.parse(adapter.restore(JSON.stringify(source),'application/json'));
  assert.deepEqual(restored.output,[{...item,namespace,name:'erp_query'}]);assert.deepEqual(restored.usage,source.usage);assert.deepEqual(restored.tools,[tool]);assert.deepEqual(restored.tool_choice,{type:'function',namespace,name:'erp_query'});assert.equal(verifyCompanyResponse(JSON.stringify(restored),'application/json'),true);
});

test('already flat ERP tools retain their original flat routing and never gain a namespace',()=>{
  const adapter=createDeepSeekResponsesAdapter(baseUrl,input({tools:[{...tool.tools[0],name:namespace+'.erp_query'}]}));
  const restored=JSON.parse(adapter.restore(JSON.stringify(done([{id:'fc_1',call_id:'call_1',type:'function_call',name:wire,arguments:'{}'}]).response),'application/json'));
  assert.equal(restored.output[0].name,namespace+'.erp_query');assert.equal(Object.hasOwn(restored.output[0],'namespace'),false);assert.equal(verifyCompanyResponse(JSON.stringify(restored),'application/json'),true);
});

test('SSE restores only tool routing, preserving sequence, event IDs, argument chunks and final usage',()=>{
  const adapter=createDeepSeekResponsesAdapter(baseUrl,input()),item={id:'fc_1',call_id:'call_1',type:'function_call',name:wire,arguments:''};
  const values=[{type:'response.output_item.added',sequence_number:1,output_index:0,item},{type:'response.function_call_arguments.delta',sequence_number:2,item_id:'fc_1',output_index:0,delta:'{"module":'},{type:'response.function_call_arguments.done',sequence_number:3,item_id:'fc_1',output_index:0,arguments:'{"module":"system"}'},done([{...item,arguments:'{"module":"system"}'}])];
  const source=': heartbeat\n\nid: provider-event-1\n'+values.map(event).join(''),text=adapter.restore(source,'text/event-stream');
  assert.match(text,/: heartbeat\n\nid: provider-event-1\nevent:/);const restored=text.split(/\n\n/).map(block=>block.split('\n').find(line=>line.startsWith('data: '))).filter(Boolean).map(line=>JSON.parse(line.slice(6)));
  assert.deepEqual(restored.map(value=>value.sequence_number),values.map(value=>value.sequence_number));assert.deepEqual(restored[1],values[1]);assert.deepEqual(restored[2],values[2]);assert.equal(restored[0].item.namespace,namespace);assert.equal(restored[0].item.name,'erp_query');assert.deepEqual(restored.at(-1).response.usage,values.at(-1).response.usage);assert.equal(verifyCompanyResponse(text,'text/event-stream'),true);
});

test('unknown or late changed tool identities expose no provider response bytes but preserve billed usage',async()=>{
  let mode='unknown',seenRequest;const good={id:'fc_1',call_id:'call_1',type:'function_call',name:wire,arguments:'{}'};
  const proxy=await openCompanyModelProxy({baseUrl,apiKey:'fixture',fetchImpl:async(_url,options)=>{seenRequest=JSON.parse(options.body);return new Response(event({type:'response.output_item.added',sequence_number:1,item:good})+event({type:'response.output_item.done',sequence_number:2,item:{...good,name:mode==='unknown'?'exec_command':'mcp__wucheng_erp__erp_prepare'}})+event(done([good])),{headers:{'content-type':'text/event-stream'}});}});
  const call=()=>fetch(proxy.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+proxy.token,'content-type':'application/json'},body:JSON.stringify(input({tools:[{...tool,tools:[...tool.tools,{...tool.tools[0],name:'erp_prepare'}]}]}))});
  try{for(const next of ['unknown','changed']){mode=next;const response=await call();assert.equal(response.status,next==='unknown'?403:502);const body=await response.text();assert.match(body,next==='unknown'?/MODEL_TOOL_DENIED/:/MODEL_PROTOCOL_INVALID/);assert.equal(body.includes('output_item'),false);assert.equal(body.includes('fixture'),false);}assert.equal(seenRequest.tools[0].name,wire);assert.equal(proxy.usage().totalTokens,38);}finally{await proxy.close();}
});

test('a valid DeepSeek proxy reply remains gated and the following complete HTTP turn preserves the paired output',async()=>{
  const requests=[],item={id:'fc_1',call_id:'call_1',type:'function_call',name:wire,arguments:'{}',status:'completed'};
  const proxy=await openCompanyModelProxy({baseUrl,apiKey:'fixture',fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({...done([item]).response,tools:[{...tool.tools[0],name:wire}]}),{headers:{'content-type':'application/json'}});}});
  const call=body=>fetch(proxy.baseUrl+'/responses',{method:'POST',headers:{authorization:'Bearer '+proxy.token,'content-type':'application/json'},body:JSON.stringify(body)});
  try{const first=await call(input({input:[{role:'user',content:'read'}]}));assert.equal(first.status,200);const reply=await first.json();assert.equal(reply.output[0].namespace,namespace);const second=await call(input({input:[{role:'user',content:'read'},reply.output[0],{type:'function_call_output',call_id:'call_1',output:'{"count":0}'}]}));assert.equal(second.status,200);assert.equal(requests[1].input[1].name,wire);assert.deepEqual(requests[1].input[2],{type:'function_call_output',call_id:'call_1',output:'{"count":0}'});assert.equal(proxy.usage().totalTokens,38);}finally{await proxy.close();}
});
