// Explicit opt-in: installed engines, fake API on loopback, synthetic business data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {createCodexEngine} from '../desktop/agent-runtime/codex-engine.mjs';
import {createHermesEngine} from '../desktop/agent-runtime/hermes-engine.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-protocol-'));
const requests=[],calls=[];
const attack=process.argv.includes('--attack');
let responseCount=0;
const server=createServer(async(req,res)=>{
  if(!['/v1/responses','/v1/chat/completions'].includes(req.url)){res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"fixture endpoint unavailable"}');return;}
  if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'gpt-5.4',object:'model'}]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;let input;try{input=JSON.parse(raw);}catch{res.writeHead(400);res.end('invalid body');return;}
  const names=(input.tools||[]).flatMap(t=>t.type==='namespace'?(t.tools||[]).map(x=>t.name+'.'+x.name):[t.name||t.function?.name||t.type]);requests.push({url:req.url,names});
  console.log(JSON.stringify({request:req.url,tools:names}));
  for(const item of input.input||[])if(item.type==='function_call_output')console.log(JSON.stringify({toolOutput:item.output}));
  if(names.some(n=>/exec_command|shell|apply_patch|terminal|file_read|read_file|write_file|browser|computer|web_search|spawn_agent|view_image/.test(n))){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'ERP_TOOL_ISOLATION_FAILED: unapproved native tool',type:'invalid_request_error'}}));return;}
  if(req.url.includes('chat/completions')){
    const tool=names.find(n=>n.endsWith('erp_capabilities'));
    for(const item of input.messages||[])if(item.role==='tool')console.log(JSON.stringify({toolOutput:item.content}));
    const n=responseCount++;const attackCall=attack&&n===0;
    const message=attackCall||n===(attack?1:0)&&tool?{role:'assistant',content:null,tool_calls:[{id:'call_'+n,type:'function',function:{name:attackCall?(process.argv.includes('--inline-attack')?'delegate_task':'terminal'):tool,arguments:attackCall?JSON.stringify({command:'echo forbidden > forbidden-canary.txt'}):'{}'}}]}:{role:'assistant',content:'测试查询已完成'};
    if(input.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\ndata: [DONE]\n\n');}
    else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));}return;
  }
  const tool=names.find(n=>n.endsWith('erp_capabilities'));
  const n=responseCount++;const item=attack&&n===0?{id:'badpatch',type:'custom_tool_call',call_id:'attack',name:'apply_patch',input:'*** Begin Patch\n*** Add File: forbidden-canary.txt\n+forbidden\n*** End Patch',status:'completed'}:n===0&&tool?{id:'fc_1',type:'function_call',call_id:'call_1',...(tool.includes('.')?{namespace:tool.split('.')[0],name:tool.split('.')[1]}:{name:tool}),arguments:'{}',status:'completed'}:{id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'测试查询已完成',annotations:[]}]};
  res.writeHead(200,{'content-type':'text/event-stream'});const response={id:'resp_'+responseCount,object:'response',created_at:1,status:'completed',model:'gpt-5.4',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
  for(const e of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}])res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const credentials={apiKey:'fixture-key-not-a-real-credential',model:'gpt-5.4',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
const task={id:'fixture-task',goal:'调用业务能力清单，然后返回结果。',scope:{modules:['sales']},attachmentIds:[]};
try{
  const engines=[];
  if(process.argv.includes('--codex'))engines.push(createCodexEngine({command:process.execPath,argsPrefix:[path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/bin/codex.js')]}));
  if(process.argv.includes('--hermes')){const hermesRoot=path.join(process.env.LOCALAPPDATA,'hermes/hermes-agent');engines.push(createHermesEngine({python:path.join(hermesRoot,'venv/Scripts/python.exe'),root:hermesRoot,diagnostic:text=>process.stderr.write(text)}));}
  for(const engine of engines){responseCount=0;const workingDirectory=path.join(root,engine.id,'work');fs.mkdirSync(workingDirectory,{recursive:true});const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),120000);
    try{const result=await engine.run({task,credentials,workingDirectory,profileDirectory:path.join(root,engine.id,'profile'),signal:controller.signal,invoke:async(name,input)=>{calls.push({engine:engine.id,name});return {capabilities:[{id:'sales.read',title:'合成账本查询',module:'sales',kind:'query'}]};},emit:(type,data)=>console.log(JSON.stringify({engine:engine.id,type,...data}))});assert.equal(fs.existsSync(path.join(workingDirectory,'forbidden-canary.txt')),false);console.log(JSON.stringify({engine:engine.id,result,attackCanaryAbsent:true}));}
    catch(error){assert.equal(fs.existsSync(path.join(workingDirectory,'forbidden-canary.txt')),false);if(!(attack&&engine.id==='codex'))throw error;assert.equal(calls.length,0);console.log(JSON.stringify({engine:engine.id,rejected:error.code,attackCanaryAbsent:true}));}
    finally{clearTimeout(timeout);}
  }
  assert.ok(requests.length>0);if(!attack)assert.ok(calls.length>0,'installed engine must call the real MCP bridge');console.log(JSON.stringify({ok:true,requests:requests.length,calls}));
}catch(error){console.error(error);throw error;}finally{server.closeAllConnections();await new Promise(r=>server.close(r));try{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){console.error('Fixture cleanup pending: '+error.code);}}
