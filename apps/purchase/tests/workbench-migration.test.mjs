import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../lib/store.mjs';
import {createWorkbenchMigration} from '../lib/workbench-migration.mjs';
import {openOrderImages} from '../lib/order-images.mjs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
const order=(n,amount=10000)=>({platform:'手工',account:'测试账号',orderNo:String(n),date:'2026-09-01',paidAt:'2026-09-02',supplier:'测试供应商',status:'已完成',amountCents:amount,refundCents:0,shippingCents:0,note:'原备注',items:[{title:'测试商品',qty:2,unitPriceCents:5000}]});
test('migration preserves strings and files, requires coordinator, compares fields, invalidates revisions and rolls back',async()=>{
 const a=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-source-')),b=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-target-')),source=openStore(a),target=openStore(b);
 try{
  const first=source.insert(order('123456789012345678901234567890'));
  const attachment=await source.attachments.stash(Buffer.from('verified attachment'),'test.txt','text/plain');source.update(first.id,{...first,attachmentIds:[attachment.id]});
  const snapshot=createWorkbenchMigration(source).exportSnapshot(),factory=()=>createWorkbenchMigration(target,{canCommit:a=>a.role==='admin',resolveFile:(_id,f)=>fs.readFileSync(path.join(a,f.sourcePath))}),adapter=factory(),p=adapter.preview(snapshot),selections=p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'add'}));
  await assert.rejects(createWorkbenchMigration(target).commit({bundle:snapshot,revision:p.revision,selections},{role:'admin'}),/两次界面确认/);
  const r=await adapter.commit({bundle:snapshot,revision:p.revision,selections},{id:'tailscale:tester',role:'admin'});assert.equal(r.verified.filter(v=>v.kind==='order').length,1);assert.equal(target.list()[0].orderNo,first.orderNo);assert.equal(target.attachments.list(target.list()[0].id).length,1);
  const duplicate=adapter.preview(snapshot);assert.equal(duplicate.rows.filter(r=>r.kind==='order'&&r.action==='duplicate').length,1);
  const changed=structuredClone(snapshot);changed.records[0].payload.amountCents=12000;changed.records[0].payload.note='传入备注';const review=adapter.preview(changed);assert.equal(review.rows.filter(r=>r.kind==='order'&&r.action==='conflict').length,1);
  await adapter.commit({bundle:changed,revision:review.revision,selections:review.rows.map(r=>r.kind==='order'?{kind:r.kind,sourceId:r.sourceId,action:'update',fields:{amountCents:'incoming'}}:{kind:r.kind,sourceId:r.sourceId,action:'skip'})},{id:'tailscale:tester',role:'admin'});assert.equal(target.list()[0].amountCents,12000);assert.equal(target.list()[0].note,'原备注');
  const stale=adapter.preview(changed);target.update(target.list()[0].id,{...target.list()[0],note:'后续人工修改'});await assert.rejects(adapter.commit({bundle:changed,revision:stale.revision,selections:stale.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:'skip'}))},{role:'admin'}),/已变化/);
  const denied=structuredClone(snapshot);denied.sourceInstance='corrupt-source';denied.records.find(r=>r.kind==='order').payload.orderNo='new';denied.records.find(r=>r.kind==='order_attachment').files[0].sha256='0'.repeat(64);const bad=adapter.preview(denied);await assert.rejects(adapter.commit({bundle:denied,revision:bad.revision,selections:bad.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'}),/摘要/);assert.equal(target.list().length,1);
 }finally{source.close();target.close();fs.rmSync(a,{recursive:true,force:true});fs.rmSync(b,{recursive:true,force:true});}
});
test('older immutable evidence and controlled files survive repeated migrations without nested origins or losing business amounts',async()=>{
 const dirs=Array.from({length:3},()=>fs.mkdtempSync(path.join(os.tmpdir(),'retained-evidence-'))),stores=dirs.map(openStore);
 try{
  const initial=createWorkbenchMigration(stores[0]);fs.writeFileSync(path.join(dirs[0],'originals','old.txt'),'original evidence bytes');stores[0].db.prepare('INSERT INTO workbench_migration_evidence VALUES(?,?,?,?,?,?,?)').run('legacy-evidence','legacy_finance',JSON.stringify({amountCents:123,receipt:456,token:'remove-me'}),'old-hash','original-book','original-record',new Date().toISOString());stores[0].db.exec('CREATE TABLE IF NOT EXISTS workbench_migration_evidence_files(evidence_id TEXT,source_file_id TEXT,local_path TEXT,PRIMARY KEY(evidence_id,source_file_id))');stores[0].db.prepare('INSERT INTO workbench_migration_evidence_files VALUES(?,?,?)').run('legacy-evidence','stable-original-file','originals/old.txt');
  for(let i=0;i<2;i++){const bundle=(i?createWorkbenchMigration(stores[i]):initial).exportSnapshot(),legacy=bundle.records.find(r=>r.kind==='evidence'&&r.payload.table==='legacy_finance');assert.equal(legacy.payload.record.amountCents,123);assert.equal(legacy.payload.record.receipt,456);assert.equal(legacy.payload.record.token,undefined);assert.deepEqual(legacy.payload.origin,{sourceInstance:'original-book',sourceId:'original-record'});assert.equal(legacy.files[0].id,'stable-original-file');const adapter=createWorkbenchMigration(stores[i+1],{canCommit:()=>true,resolveFile:(_id,f)=>fs.readFileSync(path.join(dirs[i],f.sourcePath))}),preview=adapter.preview(bundle);await adapter.commit({bundle,revision:preview.revision,selections:preview.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'});}
  const proof=stores[2].db.prepare("SELECT * FROM workbench_migration_evidence WHERE table_name='legacy_finance'").get(),file=stores[2].db.prepare('SELECT * FROM workbench_migration_evidence_files WHERE evidence_id=?').get(proof.id);assert.equal(proof.source_instance,'original-book');assert.equal(proof.source_id,'original-record');assert.equal(fs.readFileSync(path.join(dirs[2],file.local_path),'utf8'),'original evidence bytes');
 }finally{for(const store of stores)store.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('duplicate orders still import independent new attachments; fully duplicate locked records safely skip',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'duplicate-attachment-'))),[source,target]=dirs.map(openStore);
 try{
  let original=source.insert(order('same-order'));const existing=target.insert(order('same-order')),a=await source.attachments.stash(Buffer.from('client attachment'),'client.txt','text/plain');source.update(original.id,{...original,attachmentIds:[a.id]});
  const adapter=createWorkbenchMigration(target,{canCommit:()=>true,resolveFile:(_id,f)=>fs.readFileSync(path.join(dirs[0],f.sourcePath))}),bundle=createWorkbenchMigration(source).exportSnapshot(),p=adapter.preview(bundle);assert.equal(p.rows.find(r=>r.kind==='order').action,'duplicate');assert.equal(p.rows.find(r=>r.kind==='order_attachment').action,'new');
  await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'});assert.equal(target.attachments.list(existing.id).length,1);
  target.db.prepare('INSERT INTO month_confirmations(month,platform,confirmed_at,snapshot_json) VALUES(?,?,?,?)').run('2026-09','手工',new Date().toISOString(),'{}');const duplicate=adapter.preview(bundle);assert.equal(duplicate.rows.find(r=>r.kind==='order').action,'duplicate');assert.equal(duplicate.rows.find(r=>r.kind==='order_attachment').action,'duplicate');
  original=source.get(original.id);const second=await source.attachments.stash(Buffer.from('new client attachment'),'client-2.txt','text/plain');source.update(original.id,{...original,attachmentIds:[...original.attachmentIds,second.id]});const more=adapter.preview(createWorkbenchMigration(source).exportSnapshot());assert.equal(more.rows.find(r=>r.kind==='order_attachment'&&r.sourceId===second.id).action,'blocked');
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('migrated cached product images remain functional offline and prepare does not duplicate associations',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'image-migration-'))),[source,target]=dirs.map(openStore);
 try{
  const png=await sharp({create:{width:24,height:18,channels:3,background:'red'}}).png().toBuffer(),sourceImages=openOrderImages(source,{downloader:async()=>png}),bytes=Buffer.from('商品名称,商品图\n测试商品,https://images.example.test/p.png'),hash=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(path.join(dirs[0],'originals','image.csv'),bytes);
  source.importBatch([{order:order('image-source'),original:{headers:['商品名称','商品图'],rows:[{row:2,cells:['测试商品','https://images.example.test/p.png']}],sheet:'CSV'}}],{filename:'image.csv',hash,filePath:'originals/image.csv',lineCount:1,metadata:{sheet:'CSV'}});const original=source.list()[0],prepared=await sourceImages.prepare(original.id);await sourceImages.cache(original.id,prepared.images[0].id);
  const bundle=createWorkbenchMigration(source).exportSnapshot(),adapter=createWorkbenchMigration(target,{canCommit:()=>true,resolveFile:(_id,f)=>fs.readFileSync(path.join(dirs[0],f.sourcePath))}),p=adapter.preview(bundle);assert.equal(p.rows.find(r=>r.kind==='image_asset').action,'new');
  const result=await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'}),targetImages=openOrderImages(target,{downloader:async()=>{throw Error('offline');}}),targetId=result.idMap['order:'+original.id],images=await targetImages.prepare(targetId);assert.equal(images.images.length,1);assert.equal(images.images[0].status,'ready');assert.equal(target.db.prepare('SELECT COUNT(*) n FROM order_images').get().n,1);assert.deepEqual(fs.readFileSync(targetImages.resource(images.images[0].assetId,'full').path),png);assert.equal(adapter.verify(result.migrationId).ok,true);
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
