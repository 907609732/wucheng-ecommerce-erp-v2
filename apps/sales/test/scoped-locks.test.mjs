import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from './helpers.mjs';
import {scopedPreview,lockScope,unlockScope} from '../lib/scoped-locks.mjs';
import {addLedger} from '../lib/ledger.mjs';
import {saveFreight} from '../lib/freight.mjs';
import {report} from '../lib/report.mjs';
import {closePreview,lockMonth,unlockMonth} from '../lib/close.mjs';
function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'scope-cases-')),s=openStore(dir);s.monthAdmin={configured:()=>true,status:()=>({configured:true}),verify:async p=>p==='secret'};t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
const sale=(s,shop,date,amount='10')=>addLedger(s,{shop_id:shop,date,kind:'sale',amount,currency:'CNY',external_id:crypto.randomUUID(),source:'manual'});
const lock=async(s,scope,mode='normal')=>lockScope(s,{...scope,revision:scopedPreview(s,scope).revision,mode,confirmed:true});
test('scoped sales lock checks OLD/NEW, zero facts, credential and immutable history',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'scoped-lock-')),s=openStore(dir);
 s.monthAdmin={configured:()=>true,status:()=>({configured:true}),verify:async p=>p==='secret'};
 const scope={month:'2025-01',kind:'sales',shop_id:'tb-diankou'};
 try{
  const p=scopedPreview(s,scope);assert.equal(p.zeroAllowed,true);
  const result=await lockScope(s,{...scope,revision:p.revision,mode:'zero',confirmed:true});
  assert.throws(()=>s.run("INSERT INTO coverage VALUES(?,?,?,?,?,?)",scope.shop_id,scope.month,'receipt','full','test','now'),/MONTH_LOCKED/);
  s.run("INSERT INTO coverage VALUES(?,?,?,?,?,?)",'tb-xishi',scope.month,'receipt','full','test','now');
  assert.throws(()=>s.run("UPDATE coverage SET shop_id=?",scope.shop_id),/MONTH_LOCKED/);
  await assert.rejects(unlockScope(s,{...scope,version:result.lock.version,password:'wrong',reason:'纠错'}));
  await unlockScope(s,{...scope,version:result.lock.version,password:'secret',reason:'纠错'});
  assert.throws(()=>s.run('DELETE FROM reconciliation_history'),/IMMUTABLE/);
  assert.equal(s.get('SELECT count(*) n FROM ledger').n,0);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('freight lock is independent, protects old/new records and attachments, preserves negative compensation',async t=>{
 const s=fixture(t),scope={kind:'freight',month:'2025-01',channel:'warehouse',shop_id:null};
 const row=saveFreight(s,{request_id:'negative-bill',channel:'warehouse',entry_mode:'month',period:scope.month,shipping:'0',other:'-10',other_note:'赔付抵扣'},[{originalname:'bill.csv',buffer:Buffer.from('month,fee\n2025-01,-10')}]);
 const p=scopedPreview(s,scope);assert.equal(p.zeroAllowed,true);assert.equal(p.totals.total,-1000);
 await lock(s,scope,'zero');
 assert.throws(()=>s.run('UPDATE freight_records SET month=?,period=? WHERE id=?','2025-02','2025-02',row.id),/MONTH_LOCKED/);
 assert.throws(()=>s.run('UPDATE freight_attachments SET removed_at=? WHERE record_id=?','now',row.id),/MONTH_LOCKED/);
 sale(s,'offline','2025-01-01');
 const merchant=saveFreight(s,{request_id:'merchant',channel:'merchant',shop_id:'offline',entry_mode:'month',period:scope.month,shipping:'1'},[]);
 assert.throws(()=>s.run("UPDATE freight_records SET channel='warehouse',shop_id=NULL WHERE id=?",merchant.id),/MONTH_LOCKED/);
 assert.equal(s.get('SELECT total FROM freight_records WHERE id=?',row.id).total,-1000);
});
test('positive official income and individual positive fees cannot be zero confirmed even when net zero',async t=>{
 const s=fixture(t),scope={kind:'sales',month:'2025-01',shop_id:'tb-diankou'};
 s.run("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",'income',scope.shop_id,'2025-01-01','settlement',100,'CNY','income','','','',0,'','淘宝原件',null,'now','now');
 // No synthetic zero row is added by lock.
 const p=scopedPreview(s,scope);assert.equal(p.zeroAllowed,false);await assert.rejects(lock(s,scope,'zero'),e=>e.code==='POSITIVE_FACTS');
 s.run("UPDATE ledger SET source='淘宝官方交易货款账单（账期口径）' WHERE id='income'");
 s.run("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",'refund',scope.shop_id,'2025-01-02','settlement',-30,'CNY','refund','','','',0,'','淘宝官方交易货款账单（账期口径）',null,'now','now');
 const official=scopedPreview(s,scope);assert.equal(official.totals.income,100);assert.equal(official.totals.expense,-30);assert.equal(official.totals.net,70);
 const freight={kind:'freight',month:'2025-01',channel:'warehouse',shop_id:null};saveFreight(s,{request_id:'offset',channel:'warehouse',entry_mode:'month',period:'2025-01',shipping:'10',other:'-10',other_note:'赔付'},[]);assert.equal(scopedPreview(s,freight).zeroAllowed,false);
});
test('batch transaction atomically rejects one locked shop and immutable snapshot freezes earlier receivables',async t=>{
 const s=fixture(t),scope={kind:'sales',month:'2025-01',shop_id:'offline'};
 const previous=sale(s,'offline','2024-12-01');sale(s,'offline','2025-01-01');await lock(s,scope);
 const before=report(s,{period:scope.month,shop:'offline'});
 s.run('UPDATE ledger SET amount=50000 WHERE id=?',previous.id);
 assert.deepEqual(report(s,{period:scope.month,shop:'offline'}).reconciliation,before.reconciliation);
 const whole=closePreview(s,scope.month);await lockMonth(s,{month:scope.month,revision:whole.revision,confirmation:'锁定 '+scope.month},{skipBackup:true});
 assert.deepEqual(report(s,{period:scope.month,shop:'offline'}).reconciliation,before.reconciliation);
 await unlockMonth(s,{month:scope.month,confirmation:'解锁 '+scope.month,password:'secret',reason:'继续隔离验证'},{skipBackup:true});
 assert.throws(()=>s.transaction(()=>{sale(s,'dropship','2025-01-02');sale(s,'offline','2025-01-02');}),/MONTH_LOCKED/);
 assert.equal(s.get("SELECT count(*) n FROM ledger WHERE shop_id='dropship'").n,0);
 assert.throws(()=>s.run("INSERT INTO platform_references VALUES(?,?,?,?,?)",'ref','offline',scope.month,'{}','now'),/MONTH_LOCKED/);
 assert.throws(()=>s.run("INSERT INTO rates VALUES(?,?,?,?,?,?)",'2025-01-01','USD',100000000,'2025-01-01','test','hash'),/MONTH_LOCKED/);
 assert.throws(()=>s.run("UPDATE shops SET name='changed' WHERE id='offline'"),/MONTH_LOCKED/);
});
test('receipt-only manual income cannot zero-confirm or double count sale plus receipt; password change invalidates verification',async t=>{
 const s=fixture(t),scope={kind:'sales',month:'2025-01',shop_id:'offline'};
 const prior=sale(s,'offline','2024-12-01','20');
 addLedger(s,{shop_id:'offline',date:'2025-01-01',kind:'receipt',amount:'20',currency:'CNY',external_id:'receipt',order_ref:prior.external_id,source:'manual'});
 let p=scopedPreview(s,scope);assert.equal(p.zeroAllowed,false);assert.equal(p.totals.income,2000);
 sale(s,'offline','2025-01-01','20');p=scopedPreview(s,scope);assert.equal(p.totals.income,2000);
 const locked=await lock(s,scope);let version=1;s.monthAdmin.status=()=>({configured:true,passwordVersion:version});s.monthAdmin.verify=async()=>{version++;return true;};
 await assert.rejects(unlockScope(s,{...scope,version:locked.lock.version,password:'old',reason:'旧密码不得竞争通过'}),e=>e.code==='ADMIN_PASSWORD_CHANGED');assert.ok(scopedPreview(s,scope).locked);
});
test('lock requires configured password and ended month; unlock reason/password/version and whole month dominate',async t=>{
 const s=fixture(t),scope={kind:'sales',month:'2025-01',shop_id:'tb-diankou'};
 s.monthAdmin.configured=()=>false;await assert.rejects(lock(s,scope),e=>e.code==='MONTH_ADMIN_UNCONFIGURED');s.monthAdmin.configured=()=>true;
 await assert.rejects(lock(s,{...scope,month:'2099-01'}),/结束/);
 const first=await lock(s,scope,'zero');
 await assert.rejects(unlockScope(s,{...scope,version:first.lock.version,password:'secret',reason:''}),/原因/);
 await assert.rejects(unlockScope(s,{...scope,version:'old',password:'secret',reason:'修订'}),e=>e.code==='REVISION_CHANGED');
 const p=closePreview(s,scope.month);await lockMonth(s,{month:scope.month,revision:p.revision,confirmation:'锁定 '+scope.month},{skipBackup:true});
 await assert.rejects(unlockScope(s,{...scope,version:first.lock.version,password:'secret',reason:'修订'}),/整月/);
 await assert.rejects(unlockMonth(s,{month:scope.month,confirmation:'解锁 '+scope.month,reason:'修订'},{skipBackup:true}),/密码/);
 await unlockMonth(s,{month:scope.month,confirmation:'解锁 '+scope.month,reason:'修订',password:'secret'},{skipBackup:true});
 await unlockScope(s,{...scope,version:first.lock.version,password:'secret',reason:'修订'});
 const second=await lock(s,scope,'zero');assert.notEqual(first.lock.version,second.lock.version);
 await assert.rejects(unlockScope(s,{...scope,version:first.lock.version,password:'secret',reason:'旧授权'}),e=>e.code==='REVISION_CHANGED');
});
