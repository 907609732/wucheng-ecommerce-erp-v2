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
  const seed=new DatabaseSync(sourceFile);seed.prepare('INSERT INTO warehouse_attendance(login,business_date,check_in_at) VALUES(?,?,?)').run(actor.login,'2026-10-26','2026-10-26T01:00:00Z');seed.close();const runId=daily.beginRun();daily.close();targetDaily.close();
  const source=createWorkbenchMigration({databasePath:sourceFile}),target=createWorkbenchMigration({databasePath:targetFile,canCommit:()=>true});
  t.after(()=>{source.close();target.close();fs.rmSync(root,{recursive:true,force:true});});
  const bundle=source.exportSnapshot(),preview=target.preview(bundle),result=await target.commit({migrationId:randomUUID(),bundle,revision:preview.revision,selections:preview.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'add'}))},{id:'local',role:'admin',channel:'ui'});
  assert.equal(result.verification.ok,true);assert.equal(target.verify(result.migrationId).ok,true);
  const db=new DatabaseSync(targetFile);try{assert.equal(db.prepare('SELECT id FROM warehouse_sync_runs').get().id,runId);assert.equal(db.prepare('SELECT login FROM warehouse_attendance').get().login,actor.login);}finally{db.close();}
});

test('attendance routes are no longer advertised by warehouse',()=>{
 assert.ok(!warehouseAdapter.operations.some(o=>o.path==='/daily'||o.path.startsWith('/daily/')));
});
