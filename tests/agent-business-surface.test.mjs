import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {controlledBusinessLocator,businessSurfaceRequest,businessSurfaceScript,parseBusinessSurfaceResult} from '../desktop/agent-host/business-surface.mjs';
import {assertLauncherOperationAllowed} from '../desktop/agent-host/launcher-policy.mjs';

const draft=()=>({dirty:true,busy:false,canSave:false,persistence:'memory-only',openForms:[{id:'bill-form',kind:'bill-form',recordId:null,open:true,dirty:true}]});
const context=()=>({module:'overview',route:'overview',period:'2026-10',basis:'来源记录日期',confirmed:true,selectionMode:'current-filter',selectedIds:[],recordCount:0,filters:{grain:'month',bucket:'all',search:'',allPeriods:false},sourceLocator:null});

test('controlled source locator retains declared scope and refuses URL, identity and invalid record paths',()=>{
  const value={module:'overview',recordId:'bill-1',sourceId:'purchase:2',batchId:'batch-3',period:'2026-10',basis:'来源记录日期',view:'expenses'};
  assert.deepEqual(controlledBusinessLocator(value),value);
  for(const bad of [{...value,url:'https://example.test'}, {...value,actor:'another-person'}, {...value,recordId:'../bill'}, {...value,sourceId:'http://localhost/secret'}, {...value,period:'2026-13'}, {...value,module:'purchase',view:'expenses'}])assert.throws(()=>controlledBusinessLocator(bad),{code:'BUSINESS_SURFACE_INPUT_INVALID'});
});

test('surface operation cannot select arbitrary code or navigate through another module',()=>{
  for(const value of [{module:'overview',action:'executeJavaScript'}, {module:'overview',action:'navigate',locator:{module:'purchase'}}, {module:'overview',action:'navigate',locator:{module:'overview'},discardDraft:true}, {module:'overview',action:'getContext',locator:{module:'overview'}}])assert.throws(()=>businessSurfaceRequest(value),{code:'BUSINESS_SURFACE_INPUT_INVALID'});
});

test('fixed navigation passes one data argument, preserves dirty blocking and never evaluates locator text',async()=>{
  const locator={module:'overview',sourceId:'";globalThis.executed=true;"',period:'2026-10'},request={module:'overview',action:'navigate',locator},calls=[];
  const globals={window:{wuchengBusinessSurface:{protocolVersion:1,module:'overview',navigate:async(...args)=>{calls.push(args);return {status:'blocked',reason:'unsaved-draft',draft:draft()};}}},JSON};
  const serialized=await vm.runInNewContext(businessSurfaceScript(request),globals);
  assert.equal(globals.executed,undefined);assert.equal(calls[0].length,1);assert.equal(calls[0][0].sourceId,locator.sourceId);
  const result=parseBusinessSurfaceResult(serialized,request);assert.equal(result.status,'blocked');assert.equal(result.draft.dirty,true);
});

test('context and draft replies reject secrets, raw form data and excessive scope without truncation',()=>{
  const request={module:'overview',action:'getContext'},value={status:'ok',module:'overview',context:context()};
  assert.equal(parseBusinessSurfaceResult(JSON.stringify(value),request).context.recordCount,0);
  assert.throws(()=>parseBusinessSurfaceResult(JSON.stringify({...value,context:{...context(),token:'do-not-export'}}),request),{code:'BUSINESS_SURFACE_RESULT_INVALID'});
  assert.throws(()=>parseBusinessSurfaceResult(JSON.stringify({...value,context:{...context(),filters:{search:'x'.repeat(70000)}}}),request),{code:'BUSINESS_SURFACE_RESULT_INVALID'});
  assert.throws(()=>parseBusinessSurfaceResult(JSON.stringify({status:'ok',module:'overview',draft:{...draft(),values:{amount:'not-exported'}}}),{module:'overview',action:'getDraftState'}),{code:'BUSINESS_SURFACE_RESULT_INVALID'});
  assert.throws(()=>parseBusinessSurfaceResult(JSON.stringify({status:'located'}),{module:'overview',action:'navigate',locator:{module:'overview'}}),{code:'BUSINESS_SURFACE_RESULT_INVALID'});
});

function preloadHarness(isMainFrame=true){
  const listeners=new Map(),calls=[],events=[];
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/extension-preload.cjs',import.meta.url),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{invoke:async(...args)=>{calls.push(args);return {status:'dispatched'};},on(){}}}),process:{isMainFrame},window:{addEventListener:(name,handler)=>listeners.set(name,handler),dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type,{detail}){Object.assign(this,{type,detail});}}});
  return {listeners,calls,events};
}

test('only main-frame preload forwards a bounded locator, with no URL or draft command',async()=>{
  const h=preloadHarness(),target={module:'purchase',recordId:'order-1',period:'2026-10',basis:'来源记录日期'};
  await h.listeners.get('wucheng-business-navigate')({detail:target});assert.equal(h.calls[0][0],'desks:child-navigate');assert.equal(h.calls[0][1].recordId,'order-1');assert.equal(h.events[0].detail.status,'dispatched');
  await h.listeners.get('wucheng-business-navigate')({detail:{...target,url:'http://127.0.0.1:17868/'}});assert.equal(h.calls.length,1);assert.equal(h.events.at(-1).detail.status,'blocked');
  assert.equal(preloadHarness(false).listeners.has('wucheng-business-navigate'),false);
});

test('surface policy is limited to three registered business modules and leaves maintenance closed',()=>{
  for(const name of ['desks:surface','desks:child-navigate']){for(const moduleId of ['overview','purchase','sales'])assert.doesNotThrow(()=>assertLauncherOperationAllowed(name,{moduleId}));for(const moduleId of ['warehouse','exporter','bank'])assert.throws(()=>assertLauncherOperationAllowed(name,{moduleId}),{code:'BETA_MAINTENANCE_DISABLED'});}
  assert.throws(()=>assertLauncherOperationAllowed('desks:stop',{moduleId:'overview'}),{code:'BETA_MAINTENANCE_DISABLED'});
});
