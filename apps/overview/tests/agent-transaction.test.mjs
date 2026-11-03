import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,bill} from './helpers.mjs';
import {DatabaseSync} from 'node:sqlite';import path from 'node:path';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('async owner isolates raw handles, retained statements, prior jobs and a competing transaction',async()=>{
 const f=fixture(),entered=deferred(),release=deferred(),jobGate=deferred();
 const retained=f.s.db.prepare('INSERT INTO audit(action,entity,payload,created_at) VALUES(?,?,?,?)');
 const priorJob=(async()=>{await jobGate.promise;assert.throws(()=>retained.run('scheduler','old','{}','2026-09-30'),e=>e.code==='STORE_TRANSACTION_BUSY');})();
 try{
  const transaction=f.s.agentTransaction(async()=>{f.s.createBill(bill({billNo:'ROLLBACK-OWNER'}),f.sources());entered.resolve();await release.promise;f.s.tx(()=>f.s.createBill(bill({billNo:'NESTED-OWNER'}),f.sources()));throw Error('controlled rollback');});
  await entered.promise;
  try{
   assert.throws(()=>f.s.run('DELETE FROM bills'),e=>e.code==='STORE_TRANSACTION_BUSY');assert.throws(()=>f.s.db.exec('DELETE FROM bills'),e=>e.code==='STORE_TRANSACTION_BUSY');assert.throws(()=>f.s.bills(),e=>e.code==='STORE_TRANSACTION_BUSY');assert.throws(()=>f.s.tx(()=>{}),e=>e.code==='STORE_TRANSACTION_BUSY');await assert.rejects(f.s.agentTransaction(async()=>{}),e=>e.code==='STORE_TRANSACTION_BUSY');jobGate.resolve();await priorJob;
  }finally{release.resolve();}
  await assert.rejects(transaction,/controlled rollback/);assert.equal(f.s.bills().length,0);assert.equal(f.s.all('SELECT * FROM audit').length,0);
  const independent=f.s.createBill(bill({billNo:'INDEPENDENT-AFTER-ROLLBACK'}),f.sources());assert.equal(f.s.bill(independent.id).billNo,'INDEPENDENT-AFTER-ROLLBACK');assert.equal(f.s.bills().length,1);
 }finally{f.close();}
});

test('awaited owner commits once and inherited detached callbacks cannot write after completion',async()=>{
 const f=fixture(),detachedGate=deferred();let detached;
 try{
  const result=await f.s.agentTransaction(async()=>{const b=f.s.createBill(bill({billNo:'OWNER-COMMIT'}),f.sources());await Promise.resolve();f.s.tx(()=>f.s.audit('owner.check',b.id,{}));detached=(async()=>{await detachedGate.promise;assert.throws(()=>f.s.db.exec("INSERT INTO audit(action,entity,payload,created_at) VALUES('detached','bad','{}','2026-09-30')"),e=>e.code==='STORE_TRANSACTION_CLOSED');})();return b;});
  detachedGate.resolve();await detached;assert.equal(f.s.bill(result.id).billNo,'OWNER-COMMIT');assert.equal(f.s.all("SELECT * FROM audit WHERE action='detached'").length,0);
  await f.s.agentTransaction(async()=>f.s.audit('new.owner','allowed',{}));assert.equal(f.s.all("SELECT * FROM audit WHERE action='new.owner'").length,1);
 }finally{f.close();}
});

test('failed BEGIN and background precondition leave owner available for a later request',async()=>{
 const f=fixture(),other=new DatabaseSync(path.join(f.s.dir,'overview.sqlite'));try{
  other.exec('BEGIN IMMEDIATE');await assert.rejects(f.s.agentTransaction(async()=>f.s.audit('must.not.run','locked',{})),/locked/);other.exec('ROLLBACK');
  f.s.agentTransactionGuard=()=>{throw Object.assign(Error('background collector running'),{code:'BACKGROUND_TASK_BUSY'});};await assert.rejects(f.s.agentTransaction(async()=>{}),e=>e.code==='BACKGROUND_TASK_BUSY');f.s.agentTransactionGuard=null;
  await f.s.agentTransaction(async()=>f.s.audit('after.failed.begin','independent',{}));assert.equal(f.s.all("SELECT * FROM audit WHERE action='must.not.run'").length,0);assert.equal(f.s.all("SELECT * FROM audit WHERE action='after.failed.begin'").length,1);
 }finally{other.close();f.close();}
});
