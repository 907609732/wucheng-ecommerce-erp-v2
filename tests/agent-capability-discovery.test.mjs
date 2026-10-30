import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverAgentCapabilities} from '../desktop/agent-runtime/capability-discovery.mjs';
import {createAgentRuntime} from '../desktop/agent-runtime/index.mjs';

const cap=(id,module='sales',extra={})=>({id,module,title:id,description:'完整业务说明',kind:'query',inputSchema:{type:'object',properties:{amount:{type:'integer'}},additionalProperties:false},...extra});

test('module overview is bounded and preserves scope and unavailable counts without schemas',()=>{
  const huge='x'.repeat(200000),catalog=[cap('read'),cap('pending','sales',{available:false,unavailableReason:'待开通'}),cap('secret','purchase',{description:huge})];
  const result=discoverAgentCapabilities(catalog,{},['sales','system']);
  assert.deepEqual(result.modules,[{module:'sales',title:'销售',capabilityCount:2,availableCount:1,unavailableCount:1},{module:'system',title:'公共事务',capabilityCount:0,availableCount:0,unavailableCount:0}]);
  assert.equal(result.mode,'modules');assert.match(result.guidance,/inputSchema/);assert.ok(JSON.stringify(result).length<2000);
  assert.equal('capabilities' in result,false);assert.equal(JSON.stringify(result).includes('secret'),false);
});

test('module pages have deterministic IDs, a default of ten, maximum twenty and explicit unavailability',()=>{
  const catalog=Array.from({length:25},(_,i)=>cap('c'+String(24-i).padStart(2,'0'),'sales',i===24?{kind:'prepare',available:false,requiresReview:true}:{}));
  const first=discoverAgentCapabilities(catalog,{module:'sales'},['sales']);assert.equal(first.capabilities.length,10);assert.equal(first.nextCursor,10);
  assert.deepEqual(first.capabilities[0],{id:'c00',title:'c00',kind:'prepare',available:false,requiresReview:true});
  assert.ok(first.capabilities.every(item=>!('inputSchema' in item)&&!('description' in item)));
  const last=discoverAgentCapabilities(catalog,{module:'sales',cursor:10,limit:20},['sales']);assert.equal(last.capabilities.length,15);assert.equal(last.nextCursor,null);
  assert.deepEqual([...first.capabilities,...last.capabilities].map(item=>item.id),Array.from({length:25},(_,i)=>'c'+String(i).padStart(2,'0')));
  assert.equal(discoverAgentCapabilities(catalog,{module:'sales',cursor:25},['sales']).capabilities.length,0);
  assert.equal(discoverAgentCapabilities(catalog,{module:'sales',cursor:100},['sales']).nextCursor,null);
});

test('single-capability details return only its complete schema and preserve unavailable reasons',()=>{
  const source=cap('pending','sales',{available:false,unavailableReason:'此平台待开通',requiresReview:false,kind:'prepare'}),other=cap('other');
  const result=discoverAgentCapabilities([source,other],{module:'sales',capabilityId:'pending'},['sales']);
  assert.equal(result.mode,'capability');assert.deepEqual(result.capability.inputSchema,source.inputSchema);assert.equal(result.capability.unavailableReason,'此平台待开通');assert.equal(result.capability.available,false);assert.equal(result.capability.requiresReview,false);
  assert.equal('capabilities' in result,false);result.capability.inputSchema.properties.amount.type='number';assert.equal(source.inputSchema.properties.amount.type,'integer');
  assert.throws(()=>discoverAgentCapabilities([cap('secret','purchase')],{module:'purchase',capabilityId:'secret'},['sales']),{code:'CAPABILITY_DENIED'});
  assert.throws(()=>discoverAgentCapabilities([source],{module:'sales',capabilityId:'absent'},['sales']),{code:'CAPABILITY_DENIED'});
});

test('same IDs in different modules remain distinct but same-module duplicates fail closed',()=>{
  const catalog=[cap('read'),cap('read','purchase',{inputSchema:{type:'object',properties:{purchaseOnly:{type:'string'}}}})];
  assert.equal(discoverAgentCapabilities(catalog,{module:'purchase',capabilityId:'read'},['sales','purchase']).capability.inputSchema.properties.purchaseOnly.type,'string');
  assert.equal(discoverAgentCapabilities(catalog,{},['sales','purchase']).modules.length,2);
  assert.throws(()=>discoverAgentCapabilities([cap('read'),cap('read')],{module:'sales'},['sales']),{code:'CAPABILITY_CATALOG_INVALID'});
});

test('discovery rejects coercion, unsafe or fractional cursors and ambiguous request shapes',()=>{
  const catalog=[cap('read')],invalid=[null,[],{},...['0',-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1].map(cursor=>({module:'sales',cursor})),...[0,21,'10',1.5].map(limit=>({module:'sales',limit})),{capabilityId:'read'},{cursor:0},{limit:10},{module:'sales',capabilityId:'read',cursor:0},{module:'sales',capabilityId:'read',limit:10},{module:'sales',actor:'invented'},{module:' sales'},{module:'sales',capabilityId:''}];
  invalid.splice(2,1);for(const input of invalid)assert.throws(()=>discoverAgentCapabilities(catalog,input,['sales']),{code:'CAPABILITY_DISCOVERY_INPUT_INVALID'},String(input));
});

test('runtime discovery keeps fresh identity, task scope, unavailable entries and the full public status catalog',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-agent-discovery-'));let actor={id:'real-member',enabled:true};
  const adapters=[{id:'sales',capabilities:[cap('read'),cap('pending','sales',{available:false,unavailableReason:'待开通'})]},{id:'purchase',capabilities:[cap('private-schema','purchase')]}];
  const runtime=createAgentRuntime({storeDir:directory,adapters,autoStart:false,resolveActor:async id=>id===actor.id?actor:null});
  t.after(async()=>{await runtime.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const meta={actor,trustedUi:true},{task}=await runtime.request('tasks.create',{goal:'只读能力发现',scope:{modules:['sales']}},meta);runtime.store.update('task',task.id,{status:'running'});
  const overview=await runtime.invokeTool(task.id,'erp_capabilities',{});assert.deepEqual(overview.modules.map(item=>item.module),['sales']);
  const page=await runtime.invokeTool(task.id,'erp_capabilities',{module:'sales'});assert.equal(page.capabilities.find(item=>item.id==='pending').available,false);
  const detail=await runtime.invokeTool(task.id,'erp_capabilities',{module:'sales',capabilityId:'read'});assert.deepEqual(detail.capability.inputSchema,adapters[0].capabilities[0].inputSchema);
  await assert.rejects(runtime.invokeTool(task.id,'erp_capabilities',{module:'purchase',capabilityId:'private-schema'}),{code:'CAPABILITY_DENIED'});
  const status=await runtime.request('status',{},meta);assert.ok(status.capabilities.some(item=>item.module==='purchase'&&item.inputSchema));assert.ok(status.capabilities.find(item=>item.module==='sales'&&item.id==='read').inputSchema);
  actor={...actor,enabled:false};await assert.rejects(runtime.invokeTool(task.id,'erp_capabilities',{module:'sales'}),{code:'MEMBER_DENIED'});
});
