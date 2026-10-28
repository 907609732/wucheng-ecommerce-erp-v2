import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../lib/db.mjs';
import {DatabaseSync} from 'node:sqlite';

for(const rollback of [false,true])test(`async Agent owner isolates other actors and jobs; rollback=${rollback}`,async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'sales-owner-')),s=openStore(dir);
 try{
  const retained=s.db.prepare('INSERT INTO settings VALUES(?,?)');
  let resume;const gate=new Promise(resolve=>{resume=resolve;});
  const pending=s.agentTransaction(async()=>{s.setSetting('agent',1);await gate;s.transaction(()=>s.setSetting('nested',2));if(rollback)throw Error('abort');});
  const rejected=fn=>assert.throws(fn,{code:'AGENT_COMMIT_BUSY'});
  rejected(()=>s.run('INSERT INTO settings VALUES(?,?)','other','3'));
  rejected(()=>s.transaction(()=>s.setSetting('other',3)));
  rejected(()=>retained.run('scheduled','4'));
  rejected(()=>s.db.exec("INSERT INTO settings VALUES('raw','5')"));
  await assert.rejects(s.agentTransaction(async()=>{}),{code:'AGENT_COMMIT_BUSY'});
  resume();if(rollback)await assert.rejects(pending,/abort/);else await pending;
  s.transaction(()=>s.setSetting('other',3));retained.run('scheduled','4');
  assert.equal(s.setting('agent'),rollback?null:1);assert.equal(s.setting('nested'),rollback?null:2);
  assert.equal(s.setting('other'),3);assert.equal(s.setting('scheduled'),4);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed BEGIN releases owner and detached callbacks cannot write after commit',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'sales-owner-')),s=openStore(dir),other=new DatabaseSync(path.join(dir,'sales.sqlite'));
 try{
  s.db.exec('PRAGMA busy_timeout=1');other.exec('BEGIN IMMEDIATE');await assert.rejects(s.agentTransaction(async()=>{}),/locked/);other.exec('ROLLBACK');
  s.setSetting('after-begin-failure',1);
  let release;const delayed=new Promise(resolve=>{release=resolve;});let inherited;
  await s.agentTransaction(async()=>{inherited=delayed.then(()=>s.setSetting('detached',1));});release();await assert.rejects(inherited,{code:'AGENT_COMMIT_BUSY'});
  assert.equal(s.setting('detached'),null);assert.equal(s.setting('after-begin-failure'),1);
 }finally{other.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
