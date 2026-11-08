import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {installDataVersioning} from '../shared/data-version-capture.mjs';

test('data versions capture scoped locks and immutable lock history together',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reconciliation-recovery-')),dataDir=path.join(dir,'data'),versionDir=path.join(dir,'versions');
 fs.mkdirSync(dataDir);const db=new DatabaseSync(path.join(dataDir,'sales.sqlite'));
 try{
  db.exec('CREATE TABLE reconciliation_locks(scope_key TEXT PRIMARY KEY,snapshot TEXT); CREATE TABLE reconciliation_history(id TEXT PRIMARY KEY,scope_key TEXT,action TEXT)');
  installDataVersioning({db,module:'sales',dataDir,versionDir});
  db.exec("BEGIN; INSERT INTO reconciliation_locks VALUES('shop-month','{\"mode\":\"zero\"}'); INSERT INTO reconciliation_history VALUES('event-1','shop-month','lock'); COMMIT");
  const row=db.prepare('SELECT payload FROM data_version_events ORDER BY rowid DESC LIMIT 1').get();
  assert(row,'scoped lock creates recoverable business version');
  const event=JSON.parse(row.payload),snapshot=JSON.parse(fs.readFileSync(path.join(versionDir,'events','sales',event.id,event.snapshot.path),'utf8'));
  assert.equal(snapshot.tables.reconciliation_locks[0].scope_key,'shop-month');
  assert.equal(snapshot.tables.reconciliation_history[0].action,'lock');
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
