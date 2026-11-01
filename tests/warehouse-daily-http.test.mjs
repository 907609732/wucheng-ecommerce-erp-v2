import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startCloudControl} from '../desktop/modules/cloud-control.mjs';
import {provisionWorkbenchKey,signWorkbenchActor} from '../desktop/workbench/actor.mjs';
import {createWarehouseDaily} from '../core/erp/warehouse-daily.js';
import {warehouseAdapter} from '../desktop/workbench/descriptors.mjs';
import {inventoryDeliveryAccepted} from '../core/dingtalk.js';
import {createWorkbenchMigration} from '../desktop/workbench/warehouse-adapter.mjs';

test('group completion requires a recognized provider acknowledgment, never a skipped or empty response',()=>{
  for(const value of [null,{}, {skipped:true},{skipped:true,errcode:0},{errcode:1},{processQueryKey:''}])assert.equal(inventoryDeliveryAccepted(value),false);
  for(const value of [{processQueryKey:'ack-id'},{errcode:0},{report:{errcode:0},mention:null}])assert.equal(inventoryDeliveryAccepted(value),true);
});

test('warehouse migration retains attendance and original daily run UUIDs',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-daily-migration-')),sourceFile=path.join(root,'source.sqlite'),targetFile=path.join(root,'target.sqlite');
  for(const file of [sourceFile,targetFile])new DatabaseSync(file).close();
  const daily=createWarehouseDaily({databasePath:sourceFile}),targetDaily=createWarehouseDaily({databasePath:targetFile}),actor={id:'tailscale:worker@example.test',login:'worker@example.test',role:'editor',channel:'ui'};
  daily.configure({id:'local',role:'admin'},{employees:[{login:actor.login,name:'测试员工',workdays:[1,2,3,4,5,6,7],channels:[]}],autoRemind:false});
  daily.action(actor,{action:'check-in'});const runId=daily.beginRun();daily.close();targetDaily.close();
  const source=createWorkbenchMigration({databasePath:sourceFile}),target=createWorkbenchMigration({databasePath:targetFile,canCommit:()=>true});
  t.after(()=>{source.close();target.close();fs.rmSync(root,{recursive:true,force:true});});
  const bundle=source.exportSnapshot(),preview=target.preview(bundle),result=await target.commit({migrationId:randomUUID(),bundle,revision:preview.revision,selections:preview.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'add'}))},{id:'local',role:'admin',channel:'ui'});
  assert.equal(result.verification.ok,true);assert.equal(target.verify(result.migrationId).ok,true);
  const db=new DatabaseSync(targetFile);try{assert.equal(db.prepare('SELECT id FROM warehouse_sync_runs').get().id,runId);assert.equal(db.prepare('SELECT login FROM warehouse_attendance').get().login,actor.login);}finally{db.close();}
});

test('signed Tailscale employee can check in without task permission; admin-only actions and replay stay scoped',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-daily-http-')),databasePath=path.join(dir,'erp.sqlite');
  const db=new DatabaseSync(databasePath);db.close();
  const daily=createWarehouseDaily({databasePath});
  const admin={id:'local-admin',login:'local-admin',role:'admin',local:true,channel:'ui'};
  daily.configure(admin,{employees:[{login:'worker@example.test',name:'测试员工',enabled:true,workdays:[1,2,3,4,5,6,7],channels:[]}],autoRemind:false});
  const control=await startCloudControl({root:dir,dataDir:dir,version:'test',busy:()=>false,activate:async()=>{},open:async()=>{},stop:()=>{},business:{getDailyStatus:actor=>daily.status(actor),dailyAction:(actor,input)=>daily.action(actor,input),saveDailyConfig:(actor,input)=>daily.configure(actor,input),remindDaily:(actor,input)=>daily.remind(actor,input)}});
  t.after(async()=>{await control.close();daily.close();fs.rmSync(dir,{recursive:true,force:true});});
  const runtime=JSON.parse(fs.readFileSync(path.join(dir,'.integration-runtime-cloud.json'))),key=provisionWorkbenchKey(dir),token=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
  assert(runtime.workbench.operations.some(o=>o.path==='/daily/action'),'module must announce its own new routes to existing workbench hosts');
  const request=async(route,{method='POST',body={},role='editor',login='worker@example.test',requestId=randomUUID(),channel='ui'}={})=>{
    const target='/api/integration/v1/workbench'+route,now=Date.now(),actor={v:1,id:'tailscale:'+login,login,role,canRunTasks:false,modules:['warehouse'],sessionId:'daily-test-session',channel,requestId,issuedAt:now,expiresAt:now+30000,module:'warehouse',method,path:target};
    const r=await fetch(runtime.url+target,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor(actor,key)},...(method==='GET'?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};
  };
  const action=warehouseAdapter.operations.find(o=>o.path==='/daily/action');assert.equal(action.canRunTasks,undefined);assert.equal(action.uiOnly,true);
  const id=randomUUID(),first=await request('/daily/action',{body:{action:'check-in'},requestId:id});assert.equal(first.status,200,JSON.stringify(first));
  assert.deepEqual(await request('/daily/action',{body:{action:'check-in'},requestId:id}),first);
  assert.equal((await request('/daily/action',{body:{action:'complete'},requestId:id})).status,409);
  const own=await request('/daily',{method:'GET'});assert.equal(own.status,200);assert.ok(own.data.me.checkInAt);assert.equal(own.data.employees.length,1);assert.equal(own.data.reminderSettings,undefined);
  assert.equal((await request('/daily/config',{body:{employees:[]}})).status,403);
  assert.equal((await request('/daily/remind',{body:{logins:['worker@example.test'],channels:['email'],confirmed:true}})).status,403);
  assert.equal((await request('/daily/action',{role:'viewer',body:{action:'check-in'}})).status,403);
  assert.equal((await request('/daily/action',{body:{action:'check-in'},channel:'mcp'})).status,403);
  assert.equal((await request('/daily/action',{body:{action:'check-in',login:'other@example.test'}})).status,403);
  assert.equal((await request('/daily/config',{role:'admin',body:{employees:[],autoRemind:false}})).status,200);
  fs.writeFileSync(path.join(dir,'.workbench-maintenance.json'),'{}');
  assert.equal((await request('/daily/action',{body:{action:'check-in'}})).status,409);
});
