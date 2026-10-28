import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from './helpers.mjs';
import {addLedger,createMatch} from '../lib/ledger.mjs';
import {createWorkbenchMigration} from '../lib/workbench-migration.mjs';
import {saveFreight} from '../lib/freight.mjs';
test('sales migration keeps original monetary units, reviewed fields, locks and provenance',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'sales-migration-'))),[source,target]=dirs.map(openStore);
 try{
  const record=addLedger(source,{shop_id:'offline',kind:'sale',date:'2026-09-01',amount:'123.45',currency:'CNY',external_id:'123456789012345678901',note:'保留备注'}),bundle=createWorkbenchMigration(source).exportSnapshot(),adapter=createWorkbenchMigration(target,{canCommit:a=>a.role==='admin'}),p=adapter.preview(bundle),selections=p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}));
  assert.equal(p.summary.source.find(r=>r.basis==='销售流水/sale').amountCents,12345);
  const result=await adapter.commit({bundle,revision:p.revision,selections},{id:'tailscale:test',role:'admin'});assert.equal(result.verification.ok,true);assert.equal(target.get('SELECT * FROM ledger').amount,12345);assert.equal(adapter.verify(result.migrationId).ok,true);
  const incoming=structuredClone(bundle);incoming.records.find(r=>r.kind==='ledger').payload.amount=20000;incoming.records.find(r=>r.kind==='ledger').payload.note='来源备注';let review=adapter.preview(incoming);assert.equal(review.counts.conflict,1);
  await adapter.commit({bundle:incoming,revision:review.revision,selections:review.rows.map(r=>r.kind==='ledger'?{kind:r.kind,sourceId:r.sourceId,action:'update',fields:{amount:'incoming'}}:{kind:r.kind,sourceId:r.sourceId,action:'skip'})},{id:'tailscale:test',role:'admin'});assert.equal(target.get('SELECT * FROM ledger').amount,20000);assert.equal(target.get('SELECT * FROM ledger').note,'保留备注');
  target.run('INSERT INTO month_locks VALUES(?,?,?,?)','2026-09','revision','{}',new Date().toISOString());review=adapter.preview(incoming);assert.equal(review.rows.filter(r=>r.kind==='ledger'&&r.action==='blocked').length,1);assert.match(review.rows.find(r=>r.kind==='ledger').issues[0],/锁定/);
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('pending and rolled-back imports retain original bytes only as evidence and cannot acquire commit authority',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'pending-import-migration-'))),[source,target]=dirs.map(openStore);
 try{
  fs.writeFileSync(path.join(dirs[0],'originals','pending.csv'),'pending original');source.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)','pending-id','tb-diankou','ledger','pending.csv','a'.repeat(64),'originals/pending.csv',new Date().toISOString(),'previewed','{}','{"revision":"old-source-review"}');
  const bundle=createWorkbenchMigration(source).exportSnapshot();assert.equal(bundle.records.some(r=>r.kind==='import'),false);assert.ok(bundle.records.some(r=>r.kind==='evidence'&&r.payload.table==='imports'&&r.files.length));const adapter=createWorkbenchMigration(target,{canCommit:()=>true,resolveFile:(_id,f)=>fs.readFileSync(path.join(dirs[0],f.sourcePath))}),p=adapter.preview(bundle);await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'});assert.equal(target.get('SELECT COUNT(*) n FROM imports').n,0);assert.equal(target.get("SELECT COUNT(*) n FROM workbench_migration_evidence WHERE table_name='imports'").n,1);
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('reconciliation allocations and fixed official exchange rates retain their active behavior',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'match-migration-'))),[source,target]=dirs.map(openStore);
 try{
  const left=addLedger(source,{shop_id:'tb-diankou',kind:'settlement',date:'2026-09-01',amount:'1.23',currency:'CNY',external_id:'settlement-1'}),right=addLedger(source,{shop_id:'tb-diankou',kind:'receipt',date:'2026-09-01',amount:'1.23',currency:'CNY',external_id:'receipt-1'});createMatch(source,{left_id:left.id,right_id:right.id,left_amount:'1.23',right_amount:'1.23',reason:'原始银行到账核对'});source.run('INSERT INTO rates VALUES(?,?,?,?,?,?)','2026-09-01','RUB',10000000,'2026-09-01','https://www.cbr.ru/scripts/XML_daily.asp?date_req=01/09/2026','1'.repeat(64));
  const bundle=createWorkbenchMigration(source).exportSnapshot(),adapter=createWorkbenchMigration(target,{canCommit:()=>true}),p=adapter.preview(bundle);const result=await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'}),match=target.get('SELECT * FROM matches');assert.equal(match.left_id,result.idMap['ledger:'+left.id]);assert.equal(match.right_id,result.idMap['ledger:'+right.id]);assert.equal(match.left_amount,123);assert.equal(target.get('SELECT rate FROM rates').rate,10000000);assert.equal(adapter.verify(result.migrationId).ok,true);
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('colliding source shop IDs use the reviewed natural identity and new reserved target ID',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'shop-migration-'))),[source,target]=dirs.map(openStore);
 try{
  source.run("UPDATE shops SET name='来源另一家线下店' WHERE id='offline'");const ledger=addLedger(source,{shop_id:'offline',kind:'sale',date:'2026-09-01',amount:'1.23',external_id:'collision-safe'}),bundle=createWorkbenchMigration(source).exportSnapshot(),adapter=createWorkbenchMigration(target,{canCommit:()=>true}),p=adapter.preview(bundle),shop=p.rows.find(r=>r.kind==='shop'&&r.sourceId==='offline');assert.equal(shop.action,'new');assert.notEqual(shop.plannedTargetId,'offline');
  const result=await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'});const actual=target.get('SELECT * FROM ledger WHERE id=?',result.idMap['ledger:'+ledger.id]);assert.equal(actual.shop_id,shop.plannedTargetId);assert.equal(target.get('SELECT COUNT(*) n FROM ledger WHERE shop_id=?','offline').n,0);
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('freight migrations use the existing validated saver and retain verified attachment bytes',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'freight-migration-'))),[source,target]=dirs.map(openStore);
 try{
  const file=Buffer.from('%PDF-1.4\ntest migration'),freight=saveFreight(source,{channel:'warehouse',entry_mode:'month',period:'2026-09',shipping:'1.23',request_id:'source-request'},[{originalname:'bill.pdf',buffer:file}]),bundle=createWorkbenchMigration(source).exportSnapshot(),adapter=createWorkbenchMigration(target,{canCommit:()=>true,resolveFile:(_id,f)=>fs.readFileSync(path.join(dirs[0],f.sourcePath))}),p=adapter.preview(bundle),row=p.rows.find(r=>r.kind==='freight');assert.equal(row.action,'new');assert.equal(p.summary.source.find(r=>r.basis==='额外运费/warehouse').amountCents,123);
  const result=await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'});assert.equal(result.idMap['freight:'+freight.id],row.plannedTargetId);assert.equal(target.get('SELECT total FROM freight_records').total,123);const attachment=target.get('SELECT * FROM freight_attachments');assert.deepEqual(fs.readFileSync(path.join(dirs[1],attachment.original_path)),file);assert.ok(result.newFiles.includes(attachment.original_path));
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
