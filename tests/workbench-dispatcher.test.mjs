import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {parseCliRequest,WORKBENCH_TOOLS} from '../desktop/shared/ai-interface.mjs';
import {createWorkbenchDispatcher,legacyCliArgs} from '../desktop/shared/workbench-dispatcher.mjs';
import {createLocalWorkbenchManager} from '../desktop/shared/local-workbench-adapter.mjs';
import {verifyWorkbenchActor} from '../desktop/workbench/actor.mjs';
import {createActions} from '../desktop/extensions/lingtu-desks/extension.mjs';

test('workbench CLI parses bounded objects and rejects unknown modules and confirmation bypasses',()=>{
  const request=parseCliRequest(['workbench','query','--module=purchase','--params-json={"kind":"orders","query":{"month":"2026-10"}}']);
  assert.deepEqual(request,{command:'workbench',action:'query',module:'purchase',params:{kind:'orders',query:{month:'2026-10'}},confirmSideEffect:false});
  assert.throws(()=>parseCliRequest(['workbench','commit','--module=purchase']),/命令支持/);
  assert.throws(()=>parseCliRequest(['workbench','query','--module=system']),/未知/);
  assert.throws(()=>parseCliRequest(['workbench','query']),/--module/);
  assert.throws(()=>parseCliRequest(['workbench','query','--module=purchase','--params-json=[]']),/JSON 对象/);
  assert.throws(()=>parseCliRequest(['workbench','query','--module=purchase','--params-base64=e30','--params-json={}']),/一种/);
});

test('dispatcher shares the existing adapter, keeps old calls and only prepares drafts after confirmation',async()=>{
  const calls=[];const dispatch=createWorkbenchDispatcher({version:'0.11.0',executeLegacy:async r=>{calls.push(r);return r.command==='capabilities'?{ok:true,capabilities:{apiVersion:'1.0.0'}}:{ok:true,response:[{extension:'purchase',status:'running',version:'1.6.1',root:'private',pid:123}]};}});
  await dispatch({command:'workbench',action:'query',module:'purchase',params:{kind:'orders',desk:'sales',confirm:true,commit:true}});
  assert.deepEqual(calls.at(-1),{command:'extension-call',id:'lingtu.desks',action:'query',params:{desk:'purchase',kind:'orders'},confirmSideEffect:false});
  const caps=await dispatch({command:'workbench',action:'capabilities'});
  assert.deepEqual(caps.capabilities.workbench.mcpTools,[...WORKBENCH_TOOLS]);assert.equal(caps.capabilities.workbench.persistentDispatcher,true);
  const modules=await dispatch({command:'workbench',action:'modules'});assert.equal(modules.modules[0].root,undefined);assert.equal(modules.modules[0].pid,undefined);
  await assert.rejects(dispatch({command:'workbench',action:'prepare',module:'purchase',params:{source:{}}}),e=>e.code==='SIDE_EFFECT_CONFIRMATION_REQUIRED');
  await assert.rejects(dispatch({command:'workbench',action:'prepare',module:'purchase',params:{kind:'commit'},confirmSideEffect:true}),e=>e.code==='UI_CONFIRMATION_REQUIRED');
  await dispatch({command:'workbench',action:'prepare',module:'purchase',params:{source:{orders:[]},commit:true},confirmSideEffect:true});
  assert.deepEqual(calls.at(-1).params,{desk:'purchase',source:{orders:[]}});
  await dispatch({command:'status'});assert.equal(calls.at(-1).command,'status');
});

test('legacy argument serialization preserves checks and literal JSON without invoking a shell',()=>{
  for(const args of [['status'],['capabilities'],['doctor'],['logs','--limit=4'],['sync','--confirm-send'],['send-latest-valid','--confirm-send'],['login','--confirm-open-browser']]){
    const parsed=parseCliRequest(args);assert.deepEqual(parseCliRequest(legacyCliArgs(parsed)),parsed);
  }
  const r={command:'extension-call',id:'lingtu.desks',action:'prepare',params:{desk:'purchase',edit:{note:'literal $(never run) ` text'}},confirmSideEffect:true};
  assert.deepEqual(parseCliRequest(legacyCliArgs(r)),r);
  assert.throws(()=>legacyCliArgs({command:'sync'}),/确认/);
});

test('local adapter signs the real local actor and cannot reach unlisted/admin/confirmation paths',{timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-local-adapter-'));
  const key=randomBytes(32).toString('hex'),integrationKey=randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(root,'.workbench-key'),key);fs.writeFileSync(path.join(root,'.integration-key'),integrationKey);
  const operations=[
    {method:'GET',path:'/api/orders',kind:'read',remote:true},
    {method:'GET',path:'/api/integration/v1/workbench/task',kind:'read',remote:true},
    {method:'POST',path:'/api/integration/v1/edits',kind:'write',remote:true},
    {method:'POST',path:'/api/integration/v1/transfers',kind:'write',remote:true},
    {method:'POST',path:'/api/integration/v1/transfers/:id/confirm',kind:'confirmation',uiOnly:true,remote:true},
    {method:'POST',path:'/api/integration/v1/workbench/jobs',kind:'write',remote:true},
    {method:'GET',path:'/api/admin/config',kind:'read',remote:true}
  ];
  const received=[];
  const server=http.createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.authorization,'Bearer '+integrationKey);
      const actor=verifyWorkbenchActor(req.headers,key,{module:req.url.includes('workbench/task')?'warehouse':'purchase',method:req.method,path:req.url});
      let raw='';for await(const chunk of req)raw+=chunk;
      received.push({actor,body:raw?JSON.parse(raw):null,headers:req.headers});
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,actorId:actor.id}));
    }catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const cap={url:'http://127.0.0.1:'+server.address().port,workbench:{protocolVersion:1,operations}};
  const manager=createLocalWorkbenchManager({config:()=>({root,dataDir:root}),ensure:async()=>cap,status:async()=>[],stop:async()=>({ok:true})},{username:'isolated-test-user',channel:'mcp'});
  const response=await manager.business('purchase','/api/orders?month=2026-10');assert.equal(response.actorId,'local:isolated-test-user');
  assert.equal(received[0].actor.channel,'mcp');assert.equal(received[0].actor.canRunTasks,false);
  await manager.request('purchase','/edits',{method:'POST',body:{note:'draft only'}});
  assert.equal(received[1].headers['idempotency-key'],received[1].actor.requestId);
  await assert.rejects(manager.request('purchase','/transfers/id/confirm',{method:'POST',body:{confirm:true}}),e=>e.code==='UI_CONFIRMATION_REQUIRED');
  await assert.rejects(manager.request('purchase','/workbench/jobs',{method:'POST',body:{confirm:true}}),e=>e.code==='UI_CONFIRMATION_REQUIRED');
  await assert.rejects(manager.business('purchase','/api/admin/config'),e=>e.code==='OPERATION_UNLISTED');
  await assert.rejects(manager.business('purchase','/api/orders?path=C%3A%2Fsecret'),/文件访问/);
  await assert.rejects(manager.business('purchase','/api/%2e%2e/orders'),/路径/);
  assert.equal(received.length,2);
  const actions=createActions(manager);await actions.query({desk:'warehouse',kind:'task'});assert.equal(received.at(-1).actor.module,'warehouse');
});
