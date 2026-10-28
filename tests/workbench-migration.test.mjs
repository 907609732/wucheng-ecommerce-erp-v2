import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {MigrationCoordinator,digest} from '../desktop/workbench-migration/coordinator.mjs';
const actor={id:'alice',login:'alice',sessionId:'session1',channel:'ui',role:'admin',modules:['purchase','sales'],canRunTasks:false};
function fixture({failCommit,failRestore}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-migration-')),state={purchase:{revision:1,rows:[],maintenance:false},sales:{revision:1,rows:[],maintenance:false}},writes=[];
  const adapters=Object.fromEntries(Object.keys(state).map(module=>[module,{
    preview:async bundle=>({revision:String(state[module].revision),rows:bundle.records.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'new',issues:[],proposed:r.payload})),counts:{new:bundle.records.length}}),
    maintenance:async enabled=>{state[module].maintenance=enabled;},
    backup:async()=>structuredClone(state[module]),
    commit:async plan=>{assert.equal(state[module].maintenance,true);writes.push(module);state[module].rows.push(...plan.bundle.records.map(r=>r.payload));state[module].revision++;if(failCommit===module)throw Error('intentional mismatch');return {verified:true,migrationId:'result-'+module};},
    verify:async()=>{},restore:async snapshot=>{if(failRestore===module)throw Error('restore blocked');state[module]=structuredClone(snapshot);}
  }]));
  const coordinator=new MigrationCoordinator({root,adapters,serverId:'server',dataSetId:'ledger'});
  const input={clientId:'client',sourceDigest:digest('source'),bundles:['purchase','sales'].map(module=>({schemaVersion:1,module,sourceInstance:'source-'+module,revision:'1',records:[{kind:'order',sourceId:'9223372036854775808123',payload:{amountCents:12345}}]}))};
  return {coordinator,root,state,writes,input,adapters};
}
async function reviewed(f){let row=await f.coordinator.stage(f.input,actor);row=await f.coordinator.select(row.id,{revision:row.revision,selections:Object.fromEntries(f.input.bundles.map(b=>[b.module,b.records.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'add'}))]))},actor);row=await f.coordinator.confirm(row.id,{revision:row.revision,step:1},actor);row=await f.coordinator.confirm(row.id,{revision:row.revision,step:2,reviewDigest:row.reviewDigest},actor);return row;}
test('two confirmations bind the same person, session and immutable source; repeat stage and commit are idempotent',async()=>{
  const f=fixture(),row=await reviewed(f);
  const repeat=await f.coordinator.stage(f.input,actor);assert.equal(repeat.id,row.id);
  await assert.rejects(f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},{...actor,sessionId:'other'}),e=>e.code==='TWO_CONFIRMATIONS_REQUIRED');
  const result=await f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},actor);assert.equal(result.status,'completed');assert.equal(result.receipt.clientId,'client');
  assert.equal(f.state.purchase.rows[0].amountCents,12345);assert.equal(f.state.purchase.maintenance,false);
  assert.equal((await f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},actor)).status,'completed');assert.deepEqual(f.writes,['purchase','sales']);
});
test('CLI and MCP cannot confirm migrations and a changed ledger invalidates reviewed totals',async()=>{
  const f=fixture(),row=await reviewed(f);f.state.purchase.revision++;
  await assert.rejects(f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},actor),e=>e.code==='REVISION_CONFLICT');assert.equal(f.writes.length,0);
  await assert.rejects(f.coordinator.confirm(row.id,{revision:row.revision,step:1},{...actor,channel:'mcp'}),e=>e.code==='UI_ADMIN_REQUIRED');
});
test('intentional second-ledger failure restores every affected ledger before reopening writes',async()=>{
  const f=fixture({failCommit:'sales'}),row=await reviewed(f),result=await f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},actor);
  assert.equal(result.status,'rolled-back');assert.deepEqual(f.state.purchase.rows,[]);assert.deepEqual(f.state.sales.rows,[]);assert.equal(f.state.purchase.maintenance,false);assert.equal(f.state.sales.maintenance,false);
});
test('failed recovery preserves maintenance and a later explicit recovery restores consistently',async()=>{
  const f=fixture({failCommit:'sales',failRestore:'sales'}),row=await reviewed(f),result=await f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},actor);
  assert.equal(result.status,'recovery-required');assert.equal(f.state.purchase.maintenance,true);assert.equal(f.state.sales.maintenance,true);
  f.adapters.sales.restore=async snapshot=>{f.state.sales=structuredClone(snapshot);};const recovered=await f.coordinator.recover(row.id,actor);assert.equal(recovered.status,'rolled-back');assert.deepEqual(f.state.sales.rows,[]);assert.equal(f.state.sales.maintenance,false);
});
test('tampered snapshots and secret-bearing migration bundles are rejected before writing',async()=>{
  const f=fixture();await assert.rejects(f.coordinator.stage({...f.input,bundles:[{...f.input.bundles[0],records:[{kind:'task',sourceId:'1',payload:{cookie:'private'}}]}]},actor),e=>e.code==='FORBIDDEN_MIGRATION_DATA');
  const row=await f.coordinator.stage(f.input,actor),file=f.coordinator.file(row.id),data=JSON.parse(fs.readFileSync(file));data.bundles[0].records[0].payload.amountCents=0;fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>f.coordinator.read(row.id),e=>e.code==='SNAPSHOT_CHANGED');assert.equal(f.writes.length,0);
});
test('partial maintenance release never authorizes restoring over later human edits',async()=>{
 const f=fixture(),row=await reviewed(f),original=f.adapters.sales.maintenance;let blocked=true;
 f.adapters.sales.maintenance=async enabled=>{if(!enabled&&blocked)throw Error('cannot release now');return original(enabled);};
 const result=await f.coordinator.commit(row.id,{revision:row.revision,reviewDigest:row.reviewDigest},actor);assert.equal(result.status,'recovery-required');assert.equal(result.receipt,undefined);
 f.state.purchase.rows.push({note:'later human edit'});blocked=false;
 const recovered=await f.coordinator.recover(row.id,actor);assert.equal(recovered.status,'completed');assert.equal(f.state.purchase.rows.at(-1).note,'later human edit');assert.equal(f.state.purchase.rows.length,2);
});
