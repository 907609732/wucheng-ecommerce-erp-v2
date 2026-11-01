import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {businessDate,createWarehouseDaily} from '../core/erp/warehouse-daily.js';

const admin={id:'local-admin',login:'local-admin',role:'admin',local:true,channel:'ui'};
const employee=(login='worker@example.com')=>({id:'tailscale:'+login,login,role:'editor',local:false,channel:'ui'});
const person=(login='worker@example.com',extra={})=>({login,name:'员工甲',email:login,mobile:'13800000000',dingtalkUserId:'worker-1',enabled:true,deadline:'18:00',workdays:[1,2,3,4,5,6,7],channels:['email'],task:'核对库存',...extra});
const checkedAt=record=>record?.checkedInAt||record?.checkInAt||record?.signedAt||record?.record?.checkedInAt||record?.attendance?.checkedInAt;
const completedAt=record=>record?.completedAt||record?.record?.completedAt||record?.attendance?.completedAt;
async function fixture(t,{instant='2026-10-26T11:00:00.000Z',people=[person()],autoRemind=false,channels,senders}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-daily-acceptance-'));
  const databasePath=path.join(root,'erp.sqlite');let current=new Date(instant),service;const delivered=[];
  const database=new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE skus(sku TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',barcode TEXT NOT NULL DEFAULT '',low_stock_threshold INTEGER NOT NULL DEFAULT 10);
    CREATE TABLE inventory_snapshots(sku TEXT NOT NULL,warehouse_id TEXT NOT NULL,snapshot_date TEXT NOT NULL,quantity REAL NOT NULL,imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE inventory_data_validations(id INTEGER PRIMARY KEY AUTOINCREMENT,warehouse_id TEXT NOT NULL,source_date TEXT NOT NULL,source_file TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,row_count INTEGER NOT NULL,total_quantity REAL NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE monthly_outbound(sku TEXT NOT NULL,month TEXT NOT NULL,total_outbound REAL NOT NULL DEFAULT 0,near_30_days_sales REAL NOT NULL DEFAULT 0);
    INSERT INTO skus(sku,name)VALUES('A','商品甲');`);
  const now=()=>new Date(current);
  const options={databasePath,now,getChannels:async()=>channels||{email:{ready:true},dingtalk:{ready:true},sms:{ready:false},phone:{ready:false}},senders:senders||Object.fromEntries(['email','dingtalk','sms','phone'].map(channel=>[channel,async payload=>{delivered.push({channel,payload});return {receiptId:'mock-'+delivered.length};}]))};
  service=createWarehouseDaily(options);
  t.after(()=>{service.close();database.close();fs.rmSync(root,{recursive:true,force:true});});
  await service.configure(admin,{employees:people,autoRemind});
  return {get daily(){return service;},database,delivered,setTime:value=>{current=new Date(value);},restart:()=>{service.close();service=createWarehouseDaily(options);},
    async success({sourceDate=businessDate(now()),expectedSourceDate=businessDate(now()),deliveryStatus='accepted',rowCount=1,totalQuantity=12}={}){
      database.prepare('DELETE FROM inventory_snapshots').run();
      database.prepare('INSERT INTO inventory_snapshots(sku,warehouse_id,snapshot_date,quantity,imported_at)VALUES(?,?,?,?,?)').run('A','cainiao',sourceDate,12,now().toISOString());
      const validation=database.prepare('INSERT INTO inventory_data_validations(warehouse_id,source_date,status,row_count,total_quantity,created_at)VALUES(?,?,?,?,?,?)').run('cainiao',sourceDate,'valid',1,12,now().toISOString());
      const id=service.beginRun({expectedSourceDate});
      service.updateRun(id,{sourceDate,collectedAt:now().toISOString(),validatedAt:now().toISOString(),importedAt:now().toISOString(),sentAt:now().toISOString(),collectionStatus:'success',validationStatus:'success',deliveryStatus,fileHash:'a'.repeat(64),validationId:Number(validation.lastInsertRowid),rowCount,totalQuantity});
      return id;
    }};
}

test('business day follows Shanghai midnight independently of UTC',()=>{
  assert.equal(businessDate(new Date('2026-10-26T15:59:59Z')),'2026-10-26');
  assert.equal(businessDate(new Date('2026-10-26T16:00:00Z')),'2026-10-27');
});

test('today newly collected previous-day settled inventory is latest; older and future sources are rejected',async t=>{
  const f=await fixture(t),worker=employee();
  await f.success({sourceDate:'2026-10-25',expectedSourceDate:'2026-10-25'});
  assert.equal((await f.daily.status(worker)).sync.complete,true);
  assert.equal((await f.daily.status(worker)).expectedSourceDate,'2026-10-25');
  await f.success({sourceDate:'2026-10-24',expectedSourceDate:'2026-10-24'});
  assert.equal((await f.daily.status(worker)).sync.complete,false);
  await f.success({sourceDate:'2026-10-27',expectedSourceDate:'2026-10-27'});
  assert.equal((await f.daily.status(worker)).sync.complete,false);
});

test('same row count and stock total cannot hide changed snapshot contents',async t=>{
  const f=await fixture(t),worker=employee();await f.success();
  assert.equal((await f.daily.status(worker)).sync.complete,true);
  f.database.prepare("UPDATE inventory_snapshots SET sku='CHANGED'").run();
  assert.equal((await f.daily.status(worker)).sync.complete,false);
});

test('employees sign only themselves; day is unique and requires a known identity',async t=>{
  const f=await fixture(t),worker=employee();
  await assert.rejects(async()=>f.daily.action(employee('unknown@example.com'),{action:'check-in',confirmed:true}));
  await assert.rejects(async()=>f.daily.configure(worker,{employees:[],autoRemind:true}));
  await assert.rejects(async()=>f.daily.remind(worker,{logins:[worker.login],channels:['email'],confirmed:true}));
  await f.daily.action(worker,{action:'check-in',confirmed:true});
  const first=(await f.daily.status(worker)).me;
  assert.ok(checkedAt(first),'check-in records the trusted server timestamp');
  f.setTime('2026-10-26T11:01:00.000Z');
  await f.daily.action(worker,{action:'check-in',confirmed:true});
  assert.equal(checkedAt((await f.daily.status(worker)).me),checkedAt(first),'repeat check-in cannot replace the original timestamp');
  assert.equal(f.delivered.length,0);
});

test('completion requires today verified snapshot and group acceptance',async t=>{
  const f=await fixture(t),worker=employee();
  await f.daily.action(worker,{action:'check-in',confirmed:true});
  await assert.rejects(async()=>f.daily.action(worker,{action:'complete',confirmed:true}));
  const runId=await f.success();
  const state=await f.daily.status(worker);
  assert.equal(state.sync.complete,true);
  assert.equal(state.sync.runId,runId);
  await assert.rejects(async()=>f.daily.action(worker,{action:'complete',runId,confirmed:false}));
  await f.daily.action(worker,{action:'complete',runId,confirmed:true});
  assert.ok(completedAt((await f.daily.status(worker)).me));
  assert.equal(f.delivered.length,0,'completion does not itself send reminders');
});

test('stale source date and inconsistent row evidence never satisfy daily closure',async t=>{
  const f=await fixture(t),worker=employee();
  const old=await f.success({sourceDate:'2026-10-25'});
  assert.equal((await f.daily.status(worker)).sync.complete,false);
  await assert.rejects(async()=>f.daily.action(worker,{action:'complete',runId:old,confirmed:true}));
  const mismatched=await f.success({totalQuantity:13});
  assert.equal((await f.daily.status(worker)).sync.complete,false);
  await assert.rejects(async()=>f.daily.action(worker,{action:'complete',runId:mismatched,confirmed:true}));
});

test('a downloaded and validated report with skipped delivery is not group success',async t=>{
  const f=await fixture(t),worker=employee();
  await f.success({deliveryStatus:'skipped'});
  assert.equal((await f.daily.status(worker)).sync.complete,false);
  await f.success({deliveryStatus:'failed'});
  assert.equal((await f.daily.status(worker)).sync.complete,false);
});

test('group API acceptance is displayed without a claim of employee reading',async t=>{
  const f=await fixture(t),worker=employee();await f.success();
  const state=await f.daily.status(worker);
  assert.equal(state.sync.complete,true);
  assert.notEqual(state.sync.deliveryStatus,'read');
  assert.ok(!state.me?.completedAt,'a successful bot send cannot auto-complete employee work');
});

test('sign-in and verified closure survive restart but do not satisfy the next business day',async t=>{
  const f=await fixture(t),worker=employee();const runId=await f.success();
  await f.daily.action(worker,{action:'check-in',confirmed:true});
  await f.daily.action(worker,{action:'complete',runId,confirmed:true});
  f.restart();
  let state=await f.daily.status(worker);
  assert.equal(state.sync.complete,true);assert.ok(checkedAt(state.me));assert.ok(completedAt(state.me));
  f.setTime('2026-10-26T16:01:00.000Z');
  state=await f.daily.status(worker);
  assert.equal(state.sync.complete,false);assert.ok(!checkedAt(state.me));assert.ok(!completedAt(state.me));
});

test('automatic reminders default to off; manual reminders are deduplicated across restart',async t=>{
  const f=await fixture(t),worker=employee();
  await f.daily.tick();assert.equal(f.delivered.length,0);
  await assert.rejects(async()=>f.daily.remind(admin,{logins:[worker.login],channels:['email'],confirmed:false}));
  await f.daily.remind(admin,{logins:[worker.login],channels:['email'],confirmed:true});
  assert.equal(f.delivered.length,1);
  f.restart();
  await f.daily.remind(admin,{logins:[worker.login],channels:['email'],confirmed:true});
  assert.equal(f.delivered.length,1,'ordinary retry cannot re-send an accepted reminder');
});

test('rest days and already completed employees are excluded from reminders',async t=>{
  const f=await fixture(t,{people:[person('rest@example.com',{workdays:[7]}),person()],autoRemind:true});
  const runId=await f.success();
  await f.daily.action(employee(),{action:'check-in',confirmed:true});
  await f.daily.action(employee(),{action:'complete',runId,confirmed:true});
  await f.daily.tick();
  assert.equal(f.delivered.length,0);
});

test('one failed channel does not block another and is not reported as successful',async t=>{
  const delivered=[];
  const f=await fixture(t,{people:[person(undefined,{channels:['email','dingtalk']})],senders:{email:async()=>{throw Object.assign(Error('mock SMTP failure'),{definiteFailure:true});},dingtalk:async payload=>{delivered.push(payload);return {receiptId:'mock-dd-1'};}}});
  const result=await f.daily.remind(admin,{logins:[employee().login],channels:['email','dingtalk'],confirmed:true});
  assert.equal(delivered.length,1);
  const state=await f.daily.status(admin);
  const receipts=JSON.stringify({result,reminders:state.reminders});
  assert.match(receipts,/"status":"failed"/);
  assert.match(receipts,/accepted|success|成功|mock-dd-1/);
});

test('an overdue employee without reminder channels cannot block another employee',async t=>{
  const f=await fixture(t,{people:[person('no-channel@example.com',{channels:[]}),person()],autoRemind:true});
  await f.daily.tick();
  assert.equal(f.delivered.length,1);
});

test('a different validation record with matching totals cannot prove this run',async t=>{
  const f=await fixture(t),worker=employee();const runId=await f.success();
  f.daily.updateRun(runId,{validationId:999999});
  assert.equal((await f.daily.status(worker)).sync.complete,false);
});

test('a failed later attempt preserves today successful closure and records the failure',async t=>{
  const f=await fixture(t),worker=employee(),completed=await f.success();
  const failed=f.daily.beginRun({});
  f.daily.updateRun(failed,{collectionStatus:'failed',error:'mock download failure'});
  const state=await f.daily.status(worker);
  assert.equal(state.sync.complete,true);assert.equal(state.sync.runId,completed);
  assert.equal(state.sync.lastAttempt.id,failed);
  assert.equal(state.sync.lastAttempt.collectionStatus,'failed');
});

test('uncertain provider outcome is retained and never blindly retried',async t=>{
  let attempts=0;
  const f=await fixture(t,{senders:{email:async()=>{attempts++;throw Error('mock timeout after submission');}}});
  await f.daily.remind(admin,{logins:[employee().login],channels:['email'],confirmed:true});
  f.restart();
  await f.daily.remind(admin,{logins:[employee().login],channels:['email'],confirmed:true});
  assert.equal(attempts,1);
  assert.ok((await f.daily.status(admin)).reminders.some(row=>row.status==='unknown'));
});
