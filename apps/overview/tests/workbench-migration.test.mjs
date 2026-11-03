import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../lib/store.mjs';
import {createWorkbenchMigration} from '../lib/workbench-migration.mjs';
import {openStore as openPurchase} from '../../purchase/lib/store.mjs';
import {createWorkbenchMigration as purchaseMigration} from '../../purchase/lib/workbench-migration.mjs';
import {hash} from '../lib/util.mjs';
test('overview migration remaps bills and payments and verifies all totals in one transaction',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'overview-migration-'))),[source,target]=dirs.map(openStore),sources=()=>({shops:[],errors:[]});
 try{
  const bill=source.createBill({kind:'other',billNo:'TEST-1',party:'软件供应商',period:'2026-09',billDate:'2026-09-01',category:'software',owner:'company',title:'软件',amountCents:10000,note:'原分类及备注'},sources());source.addPayment(bill.id,{version:bill.version,date:'2026-09-02',direction:'pay',amountCents:5000,reference:'PAY-123456789012345678901'});
  const bundle=createWorkbenchMigration(source,{sources}).exportSnapshot(),adapter=createWorkbenchMigration(target,{sources,canCommit:a=>a.role==='admin'}),p=adapter.preview(bundle);assert.equal(p.rows.filter(r=>['bill','payment'].includes(r.kind)).length,2);assert.equal(p.summary.source.find(r=>r.basis==='费用应付/other').amountCents,10000);assert.equal(p.summary.source.find(r=>r.basis==='费用实付/pay').amountCents,5000);
  const result=await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{id:'tailscale:test',role:'admin'});assert.equal(result.verification.ok,true);assert.equal(target.bills().length,1);assert.equal(target.payments()[0].billId,target.bills()[0].id);assert.equal(target.paid(target.bills()[0].id),5000);assert.equal(adapter.verify(result.migrationId).ok,true);
  const invalid=structuredClone(bundle);invalid.sourceInstance='other-source';invalid.records.find(r=>r.kind==='bill').payload.billNo='new-bill';invalid.records.find(r=>r.kind==='payment').payload.reference='new-payment';invalid.records.find(r=>r.kind==='payment').payload.amountCents=20000;const review=adapter.preview(invalid);await assert.rejects(adapter.commit({bundle:invalid,revision:review.revision,selections:review.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'}),/付款不能超过/);assert.equal(target.bills().length,1);assert.equal(target.payments().length,1);
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('voided bills and payments remain immutable history and do not reappear as active financial records',async()=>{
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'voided-migration-'))),[source,target]=dirs.map(openStore),sources=()=>({shops:[],errors:[]});
 try{
  const bill=source.createBill({kind:'other',billNo:'VOID',party:'test',period:'2026-09',billDate:'2026-09-01',category:'software',title:'已撤销',amountCents:100},sources()),payment=source.addPayment(bill.id,{version:bill.version,date:'2026-09-02',direction:'pay',amountCents:100,reference:'VOID-PAY'});source.voidPayment(payment.id,{reason:'测试撤销付款'});source.voidBill(bill.id,{version:source.bill(bill.id).version,reason:'测试作废账单'});
  const bundle=createWorkbenchMigration(source,{sources}).exportSnapshot();assert.equal(bundle.records.some(r=>r.kind==='bill'||r.kind==='payment'),false);const adapter=createWorkbenchMigration(target,{sources,canCommit:()=>true}),p=adapter.preview(bundle);await adapter.commit({bundle,revision:p.revision,selections:p.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{role:'admin'});assert.equal(target.bills().length,0);assert.equal(target.payments().length,0);assert.ok(target.get("SELECT COUNT(*) n FROM workbench_migration_evidence WHERE table_name IN ('bills','payments')").n>=2);
 }finally{source.close();target.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});
test('projected purchase references reserve the reviewed ID and validate actual records before overview commit',async()=>{
 const dirs=Array.from({length:4},()=>fs.mkdtempSync(path.join(os.tmpdir(),'linked-migration-'))),sourcePurchase=openPurchase(dirs[0]),targetPurchase=openPurchase(dirs[1]),sourceOverview=openStore(dirs[2]),targetOverview=openStore(dirs[3]);
 const sources=p=>({purchase:p.db.prepare('SELECT * FROM orders').all(),sales:[],shops:[],errors:[]});
 try{
  const order=sourcePurchase.insert({platform:'手工',account:'test',orderNo:'123456789012345678901',date:'2026-09-01',supplier:'test',status:'已完成',amountCents:10000,refundCents:1000,shippingCents:0,items:[{title:'test',qty:1,unitPriceCents:10000}]});
  sourceOverview.run('INSERT INTO overrides VALUES(?,?,?,?,?,?)','purchase:'+order.id+':refund',hash(sourcePurchase.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)),'purchase','2026-09-03','已核对退款发生日',new Date().toISOString());
  sourceOverview.createBill({kind:'other',billNo:'linked',party:'test',period:'2026-09',billDate:'2026-09-01',category:'software',owner:'company',title:'关联费用',linkedSource:'purchase:'+order.id,amountCents:2000},sources(sourcePurchase));
  const purchaseBundle=purchaseMigration(sourcePurchase).exportSnapshot(),pa=purchaseMigration(targetPurchase,{canCommit:()=>true}),pp=pa.preview(purchaseBundle),projected=pp.rows.find(r=>r.kind==='order');assert.equal(pp.plannedIdMap['order:'+order.id],projected.plannedTargetId);
  const bundle=createWorkbenchMigration(sourceOverview,{sources:()=>sources(sourcePurchase)}).exportSnapshot();bundle.references={['purchase:'+order.id]:'purchase:'+projected.plannedTargetId};bundle.plannedSources=[{key:'purchase:'+projected.plannedTargetId,currency:'CNY',amountCents:9000,payload:projected.incoming,state:'planned'}];
  const oa=createWorkbenchMigration(targetOverview,{sources:()=>sources(targetPurchase),canCommit:()=>true}),op=oa.preview(bundle);assert.equal(op.rows.find(r=>r.kind==='bill').action,'new');
  const added=await pa.commit({bundle:purchaseBundle,revision:pp.revision,selections:pp.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{id:'tailscale:test',role:'admin'});assert.equal(added.idMap['order:'+order.id],projected.plannedTargetId);
  const result=await oa.commit({bundle,revision:op.revision,selections:op.rows.map(r=>({kind:r.kind,sourceId:r.sourceId,action:r.action==='new'?'add':'skip'}))},{id:'tailscale:test',role:'admin'});assert.equal(result.verification.ok,true);assert.equal(targetOverview.bills()[0].linkedSource,'purchase:'+projected.plannedTargetId);assert.equal(targetOverview.bills()[0].id,op.rows.find(r=>r.kind==='bill').plannedTargetId);
  const override=targetOverview.get('SELECT * FROM overrides');assert.equal(override.source_key,'purchase:'+projected.plannedTargetId+':refund');assert.equal(override.refund_date,'2026-09-03');assert.equal(override.source_hash,hash(targetPurchase.db.prepare('SELECT * FROM orders').get()));
 }finally{for(const store of [sourcePurchase,targetPurchase,sourceOverview,targetOverview])store.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});

