import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {createOwnedTarget,closeOwnedTarget,observeTransport} from '../server/collector-owned-page.mjs';
import {CainiaoBrowser as SalesBrowser} from '../apps/sales/lib/agent-cainiao-browser.mjs';
import {CainiaoBrowser as OverviewBrowser} from '../apps/overview/lib/cainiao-browser.mjs';

for (const [module, Browser] of [['sales',SalesBrowser],['overview',OverviewBrowser]]) {
 test(`${module}: native shared operations resolve their owned target instead of MCP current page`,async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-page-')),previous=process.env.LINGTU_SHARED_BROWSER;
  process.env.LINGTU_SHARED_BROWSER='1';
  const b=new Browser(dir);let code;
  b.ownedTarget={targetId:'target-owner'};
  b.client={callTool:async value=>{code=value.arguments.code;return {content:[{type:'text',text:'### Result\n{"account":"fixture"}'}]};}};
  try {
   await b.run('account');
   const fallback={context:()=>({pages:()=>[owner,sibling],newCDPSession:async p=>({send:async()=>({targetInfo:{targetId:p.id}}),detach:async()=>{}})})};
   const owner={id:'target-owner',isClosed:()=>false},sibling={id:'target-sibling',isClosed:()=>false};
   // Replace only the fixed business operation body, exercising the actual owner resolver.
   const operationStart=code.indexOf('return await (');
   assert.ok(operationStart>=0);
   const resolver=code.slice(0,operationStart)+'return page.id; }';
   assert.equal(await (0,eval)('('+resolver+')')(fallback),'target-owner');
  } finally {previous===undefined?delete process.env.LINGTU_SHARED_BROWSER:process.env.LINGTU_SHARED_BROWSER=previous;fs.rmSync(dir,{recursive:true,force:true});}
 });
 test(`${module}: a closed owned target never falls back to a sibling tab`,async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-closed-')),previous=process.env.LINGTU_SHARED_BROWSER;
  process.env.LINGTU_SHARED_BROWSER='1';const b=new Browser(dir);let code;
  b.ownedTarget={targetId:'target-gone'};b.client={callTool:async value=>{code=value.arguments.code;return {content:[{type:'text',text:'### Result\n{}'}]};}};
  try {
   await b.run('account');
   const sibling={id:'target-sibling',isClosed:()=>false};
   const fallback={context:()=>({pages:()=>[sibling],newCDPSession:async p=>({send:async()=>({targetInfo:{targetId:p.id}}),detach:async()=>{}})})};
   const operationStart=code.indexOf('return await (');const resolver=code.slice(0,operationStart)+'return page.id; }';
   await assert.rejects((0,eval)('('+resolver+')')(fallback),/BROWSER_PAGE_CLOSED/);
  } finally {previous===undefined?delete process.env.LINGTU_SHARED_BROWSER:process.env.LINGTU_SHARED_BROWSER=previous;fs.rmSync(dir,{recursive:true,force:true});}
 });
}

async function cdpFixture(){
 const targets=new Set(['sibling-target']),calls=[];let base;
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({webSocketDebuggerUrl:base.replace('http:','ws:')+'/devtools/browser/fixture-generation'}));});
 const ws=new WebSocketServer({server});
 ws.on('connection',socket=>socket.on('message',raw=>{const request=JSON.parse(raw),{method,params}=request;calls.push(method);let result;
  if(method==='Target.createTarget'){targets.add('owned-target');result={targetId:'owned-target'};}
  else if(method==='Target.getTargets')result={targetInfos:[...targets].map(targetId=>({targetId}))};
  else if(method==='Target.closeTarget'){assert.equal(params.targetId,'owned-target');targets.delete(params.targetId);result={success:true};}
  else throw Error('unexpected CDP command');
  socket.send(JSON.stringify({id:request.id,result}));
 }));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 return {base,targets,calls,async close(){for(const client of ws.clients)client.terminate();await new Promise(resolve=>ws.close(resolve));await new Promise(resolve=>server.close(resolve));}};
}
test('owned CDP cleanup closes only its target and confirms absence in the same browser generation',async()=>{
 const f=await cdpFixture();try{
  const target=await createOwnedTarget(f.base);assert.equal(target.targetId,'owned-target');
  await closeOwnedTarget(target);assert.deepEqual([...f.targets],['sibling-target']);
  assert.ok(f.calls.indexOf('Target.closeTarget')<f.calls.lastIndexOf('Target.getTargets'));
 }finally{await f.close();}
});
test('transport teardown waits for public onclose even when SDK close has already returned',async()=>{
 let closed=false,notify;
 const transport={async start(){},async close(){},onclose:null};
 const observer=observeTransport(transport);await transport.start();
 const close=observer.close({async close(){notify=()=>{closed=true;transport.onclose();};}});
 let resolved=false;void close.then(()=>{resolved=true;});await new Promise(resolve=>setTimeout(resolve,15));
 assert.equal(resolved,false);notify();await close;assert.equal(closed,true);
});
for(const [module,Browser] of [['sales',SalesBrowser],['overview',OverviewBrowser]])test(`${module}: RPC timeout retains the slot until MCP exit and owned target closure`,async()=>{
 const f=await cdpFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-timeout-'));
 const b=new Browser(dir);let releaseExit;
 try {
  b.nativeShared=true;b.ownedTarget=await createOwnedTarget(f.base);
  b.client={async callTool(){throw Error('MCP timeout');}};
  b.transportObserver={close:()=>new Promise(resolve=>{releaseExit=resolve;})};
  const pending=b.run('account');let settled=false;const result=pending.catch(error=>{settled=true;return error;});
  while(!releaseExit)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(settled,false);assert.equal(f.targets.has('owned-target'),true);
  releaseExit();const error=await result;assert.match(error.message,/MCP timeout/);
  assert.equal(f.targets.has('owned-target'),false);assert.equal(f.targets.has('sibling-target'),true);assert.equal(b.client,null);
 }finally{await f.close();fs.rmSync(dir,{recursive:true,force:true});}
});
for(const [module,Browser] of [['sales',SalesBrowser],['overview',OverviewBrowser]])test(`${module}: MCP tool error is isolated before releasing potentially still-running unsafe code`,async()=>{
 const f=await cdpFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-tool-error-'));
 const b=new Browser(dir);let releaseExit;
 try {
  b.nativeShared=true;b.ownedTarget=await createOwnedTarget(f.base);
  b.client={async callTool(){return {isError:true,content:[{type:'text',text:'### Error\nunhandled asynchronous failure'}]};}};
  b.transportObserver={close:()=>new Promise(resolve=>{releaseExit=resolve;})};
  const result=b.run('account').catch(error=>error);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(typeof releaseExit,'function');
  releaseExit();await result;assert.equal(f.targets.has('owned-target'),false);assert.equal(f.targets.has('sibling-target'),true);
 }finally{releaseExit?.();await f.close();fs.rmSync(dir,{recursive:true,force:true});}
});
