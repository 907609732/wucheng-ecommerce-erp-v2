import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installFreightSchema} from '../lib/freight-schema.mjs';
import {openStore} from './helpers.mjs';
import {saveFreight,freightReport} from '../lib/freight.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('legacy freight migration retains rows, attachments, locks and revision triggers',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE shops(id TEXT PRIMARY KEY); CREATE TABLE revisions(n INTEGER); INSERT INTO revisions VALUES(0)');
  installFreightSchema(db);
  const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name='freight_records'").get().sql;
  db.exec('DROP TABLE freight_records');
  db.exec(sql.replace("CHECK(channel='warehouse' OR other=0)",'CHECK(other>=0)'));
  db.exec(`INSERT INTO freight_records(id,channel,entry_mode,period,month,shipping,packing,materials,storage,other,total,created_at,updated_at)
   VALUES('old','warehouse','month','2026-06','2026-06',10000,0,0,0,0,10000,'stamp','stamp');
   INSERT INTO freight_attachments VALUES('file','old','bill.csv','originals/file.csv','hash',10,'text/csv','stamp',NULL);
   CREATE TRIGGER retained_revision AFTER UPDATE ON freight_records BEGIN UPDATE revisions SET n=n+1; END;
   CREATE TRIGGER retained_lock BEFORE DELETE ON freight_records BEGIN SELECT RAISE(ABORT,'MONTH_LOCKED'); END;
   PRAGMA foreign_keys=ON;`);
  const before=db.prepare('SELECT * FROM freight_records').all(),attachments=db.prepare('SELECT * FROM freight_attachments').all();
  installFreightSchema(db);
  assert.deepEqual(db.prepare('SELECT * FROM freight_records').all(),before);
  assert.deepEqual(db.prepare('SELECT * FROM freight_attachments').all(),attachments);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>db.exec("DELETE FROM freight_records WHERE id='old'"),/MONTH_LOCKED/);
  db.exec("UPDATE freight_records SET other=-2000,total=8000 WHERE id='old'");
  assert.equal(db.prepare('SELECT n FROM revisions').get().n,1);
  assert.throws(()=>db.exec("UPDATE freight_attachments SET record_id='missing'"),/FOREIGN KEY/);
  installFreightSchema(db);
  assert.equal(db.prepare('SELECT total FROM freight_records').get().total,8000);
 }finally{db.close();}
});

test('warehouse compensation keeps pure shipping and exact net monthly cost',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'sales-compensation-')),s=openStore(dir);
 try{
  const input={request_id:'cloud-june',channel:'warehouse',entry_mode:'month',period:'2026-06',shipping:'1051.20',materials:'25.01',other:'-232.32',other_note:'订单处理273.50、拦截25.20、退货入仓8.10、货值赔付-534.12、服务赔付-5.00'};
  const saved=saveFreight(s,input);
  assert.equal(saved.total,84389);assert.equal(saved.shipping,105120);assert.equal(saved.other,-23232);
  assert.equal(saveFreight(s,input).id,saved.id);
  assert.equal(freightReport(s,{period:'2026-06',grain:'month',shop:'shared'}).totals.total,84389);
  assert.throws(()=>saveFreight(s,{...input,request_id:'missing-note',other_note:''}),/说明/);
  assert.throws(()=>saveFreight(s,{...input,request_id:'sf',channel:'sf'}),/只有云仓/);
  assert.throws(()=>saveFreight(s,{...input,request_id:'negative-shipping',shipping:'-1'}),/非负/);
 }finally{s.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'sales-compensation-')));rmSync(dir,{recursive:true,force:true});}
});
