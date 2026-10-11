import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { FinanceLedger, cents, dueFinanceMonth } from '../desktop/shared/finance-ledger.mjs';
const fixture = () => { const directory=fs.mkdtempSync(path.join(os.tmpdir(),'finance-ledger-'));const store=new FinanceLedger(path.join(directory,'finance'));const shop=store.saveShop({name:'测试店铺',account:'test-shop',entity:'测试企业',taxId:'TEST-NOT-A-TAX-ID',entityType:'enterprise',taxpayer:'small',cycle:'monthly',startMonth:'2026-01'});return {directory,store,shop}; };
function file(dir, rows, name='bill.xlsx') {const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['日期','收入总额','退款金额','收入净额','支出金额'],...rows]),'账单');const filename=path.join(dir,name);XLSX.writeFile(book,filename);return filename;}
const options=(kind='tax',month='2026-09',lastRow=2)=>({sheet:'账单',kind,month,firstRow:2,lastRow,confirmScope:true,mapping:{date:'A',gross:'B',refund:'C',net:'D',expense:'E'}});
function save(store,shopId,filename,opts=options()){const stage=store.stage(shopId,filename);const preview=store.preview(stage.token,opts);return {preview,result:store.commit(stage.token,true)};}

function batch(store,shopId,files,kind='income') {
  const id=store.openBatch(store.newJob(shopId,'2026-09'),shopId,'2026-09',kind);
  for(const [filename,subtype] of files) store.addPart(id,{file:filename,name:path.basename(filename),subtype});
  store.closeBatch(id,{expected:files.map(([,subtype])=>subtype)});
  return id;
}

test('restart recovery retains downloaded originals and blocks incomplete batches from accounting',()=>{
  const {directory,store,shop}=fixture();
  const source=file(directory,[['2026-09',100,10,90,3]]);
  const job=store.newJob(shop.id,'2026-09');
  const id=store.openBatch(job,shop.id,'2026-09','income',{expected:['月汇总','日汇总']});
  const part=store.addPart(id,{file:source,subtype:'月汇总'});
  const before=store.batchDetail(id).parts[0];
  store.close();
  const reopened=new FinanceLedger(path.join(directory,'finance'));
  try{
    assert.equal(reopened.recoverJobs(),1);
    assert.equal(reopened.recoverJobs(),0);
    const restored=reopened.batchDetail(id);
    assert.equal(restored.state,'interrupted');
    assert.equal(restored.parts.length,1);
    assert.equal(restored.parts[0].id,part.token);
    assert.equal(restored.parts[0].sha256,before.sha256);
    assert.equal(restored.parts[0].bytes,before.bytes);
    assert.ok(reopened.inspect(part.token).sheets.length>0,'Original remains readable after restart');
    assert.equal(reopened.report(shop.id,'2026-09').rows.length,0);
    assert.throws(()=>reopened.previewBatch(id,options('income')),/尚未完整/);
    assert.ok(reopened.retryPlan(shop.id,'2026-09').kinds.includes('income'));
  }finally{reopened.close();}
});

test('batch requires an existing running job with the same shop and month',()=>{
  const {store,shop}=fixture();try{
    const other=store.saveShop({...shop,id:undefined,name:'另一测试店铺',account:'test-other'});
    const job=store.newJob(shop.id,'2026-09');
    assert.throws(()=>store.openBatch('missing',shop.id,'2026-09','income'),/任务与批次/);
    assert.throws(()=>store.openBatch(job,other.id,'2026-09','income'),/任务与批次/);
    assert.throws(()=>store.openBatch(job,shop.id,'2026-08','income'),/任务与批次/);
    assert.equal(store.report(shop.id,'2026-09').batches.length,0);
    store.finishJob(job,'failed','合成失败');
    assert.throws(()=>store.openBatch(job,shop.id,'2026-09','income'),/任务已结束/);
  }finally{store.close();}
});

test('batch preserves expected parts and cannot hide failure or rewrite a preview',()=>{
  const {directory,store,shop}=fixture();try{
    const source=file(directory,[['2026-09',100,10,90,3]]);
    const job=store.newJob(shop.id,'2026-09');
    const id=store.openBatch(job,shop.id,'2026-09','income',{expected:['月汇总','日汇总']});
    store.addPart(id,{file:source,subtype:'月汇总'});
    assert.deepEqual(store.closeBatch(id,{state:'complete'}).missing,['日汇总']);
    assert.equal(store.closeBatch(id,{expected:['月汇总'],state:'incomplete'}).state,'partial');
    assert.throws(()=>store.previewBatch(id,options('income')),/完整|缺少/);
    assert.equal(store.closeBatch(id,{expected:['月汇总'],state:'complete'}).state,'complete');
    assert.equal(store.db.prepare("SELECT state FROM job_items WHERE job=? AND kind='income' AND subtype='' ").get(job).state,'received');
    store.previewBatch(id,options('income'));
    assert.throws(()=>store.closeBatch(id,{state:'empty'}),/已核对或提交/);
    store.commitBatch(id,true);
    assert.throws(()=>store.closeBatch(id,{state:'incomplete'}),/已核对或提交/);
    assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,9000);
  }finally{store.close();}
});

test('retry uses latest attempt, preserves explicit empty and does not hide a new failure behind old data',()=>{
  const {directory,store,shop}=fixture();try{
    const source=file(directory,[['2026-09',100,10,90,3]]);
    const original=batch(store,shop.id,[[source,'月汇总']]);
    store.previewBatch(original,options('income'));store.commitBatch(original,true);
    const job=store.newJob(shop.id,'2026-09');
    const success=store.openBatch(job,shop.id,'2026-09','income');
    store.addPart(success,{file:source,subtype:'月汇总'});
    store.closeBatch(success,{expected:['月汇总'],state:'complete'});
    const empty=store.openBatch(job,shop.id,'2026-09','expense');
    store.closeBatch(empty,{state:'empty'});
    assert.equal(store.db.prepare("SELECT state FROM job_items WHERE job=? AND kind='expense' AND subtype='' ").get(job).state,'empty');
    assert.deepEqual(store.retryPlan(shop.id,'2026-09').kinds,['tax']);
    const failed=store.openBatch(job,shop.id,'2026-09','income');
    store.closeBatch(failed,{state:'incomplete',expected:['月汇总']});
    assert.deepEqual(store.retryPlan(shop.id,'2026-09').kinds,['income','tax']);
    assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,9000);
  }finally{store.close();}
});

test('view selection survives commit, duplicate detection, restore, export and restart',async()=>{
  const {directory,store,shop}=fixture();
  try {
    const daily=file(directory,[['2026-09',200,10,190,3]],'daily.xlsx');
    const monthly=file(directory,[['2026-09',100,10,90,3]],'monthly.xlsx');
    const first=batch(store,shop.id,[[daily,'日汇总'],[monthly,'月汇总']]);
    const preview=store.previewBatch(first,options('income'));
    assert.equal(preview.records,1);assert.ok(preview.parts.every(part=>part.records===1));
    assert.equal(preview.totals.net,9000);assert.equal(preview.vouchers.length,1);
    const saved=store.commitBatch(first,true);
    assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,9000);
    assert.equal(store.report(shop.id,'2026-09').history[0].parts.length,2);
    const repeat=batch(store,shop.id,[[monthly,'月汇总'],[daily,'日汇总']]);
    store.previewBatch(repeat,options('income'));assert.equal(store.commitBatch(repeat,true).duplicate,true);
    const change=batch(store,shop.id,[[daily,'日汇总'],[monthly,'月汇总']]);
    store.previewBatch(change,{...options('income'),ledgerView:'日汇总'});
    assert.notEqual(store.commitBatch(change,true).duplicate,true);
    assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,19000);
    store.restore(saved.versionId);
    assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,9000);
    const exported=new ExcelJS.Workbook();await exported.xlsx.load(await store.export(shop.id,'2026-09'));
    assert.equal(exported.getWorksheet('期间来源清单').rowCount,3);
    assert.ok(exported.getWorksheet('期间来源清单').getColumn(7).values.includes('核对凭证（不计金额）'));
    const reopened=new FinanceLedger(path.join(directory,'finance'));
    try{assert.equal(reopened.report(shop.id,'2026-09').kindTotals.income.net,9000);assert.equal(reopened.report(shop.id,'2026-09').history.length,2);}finally{reopened.close();}
  }finally{store.close();}
});

test('all shards of selected view are counted, missing or ambiguous view is rejected',()=>{
  const {directory,store,shop}=fixture();try{
    const a=file(directory,[['2026-09',100,10,90,3]],'a.xlsx');
    const b=file(directory,[['2026-09',200,10,190,3]],'b.xlsx');
    const id=batch(store,shop.id,[[a,'月汇总'],[b,'月汇总']]);
    assert.throws(()=>store.previewBatch(id,{...options('income'),ledgerView:'不存在'}),/没有/);
    assert.equal(store.previewBatch(id,options('income')).totals.net,28000);
    store.commitBatch(id,true);assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,28000);
    const ambiguous=batch(store,shop.id,[[a,'日汇总'],[b,'收入明细']]);
    assert.throws(()=>store.previewBatch(ambiguous,options('income')),/明确选择/);
    const mixed=batch(store,shop.id,[[a,'月汇总'],[b,'补贴']]);
    assert.throws(()=>store.previewBatch(mixed,options('income')),/混有汇总视图/);
  }finally{store.close();}
});

test('identical file in different views retains both associations and original metadata',()=>{
  const {directory,store,shop}=fixture();try{
    const f=file(directory,[['2026-09',100,10,90,3]]);
    const job=store.newJob(shop.id,'2026-09');const id=store.openBatch(job,shop.id,'2026-09','income');
    const a=store.addPart(id,{file:f,name:path.basename(f),subtype:'月汇总'});
    const b=store.addPart(id,{file:f,name:path.basename(f),subtype:'日汇总'});
    assert.notEqual(a.token,b.token);
    const before=store.bill(a.token);
    assert.equal(store.addPart(id,{file:f,name:path.basename(f),subtype:'月汇总'}).duplicate,true);
    assert.equal(store.bill(a.token).sha256,before.sha256);assert.ok(before.bytes>0);
    assert.equal(store.closeBatch(id,{expected:['月汇总','日汇总']}).state,'complete');
    store.previewBatch(id,options('income'));store.commitBatch(id,true);
    assert.throws(()=>store.addPart(id,{file:f,name:path.basename(f),subtype:'月汇总'}),/已提交/);
    assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,9000);
  }finally{store.close();}
});

test('confirmation must be boolean true and batch parts cannot bypass whole-batch commit',()=>{
  const {directory,store,shop}=fixture();try{
    const f=file(directory,[['2026-09',100,10,90,3]]);
    const single=store.stage(shop.id,f);store.preview(single.token,options('income'));
    for(const value of [false,'false','true',0,1,{},null,undefined])assert.throws(()=>store.commit(single.token,value),/确认/);
    const id=batch(store,shop.id,[[f,'月汇总']]);const token=store.batchDetail(id).parts[0].id;
    assert.throws(()=>store.preview(token,options('income')),/整批/);
    store.previewBatch(id,options('income'));
    assert.throws(()=>store.commit(token,true),/整批/);
    for(const value of [false,'false','true',0,1,{},null,undefined])assert.throws(()=>store.commitBatch(id,value),/确认/);
    assert.equal(store.report(shop.id,'2026-09').rows.length,0);
    store.commitBatch(id,true);assert.equal(store.report(shop.id,'2026-09').kindTotals.income.net,9000);
  }finally{store.close();}
});

test('direct staging cannot cross shops or mutate an already previewed batch',()=>{
  const {directory,store,shop}=fixture();try{
    const f=file(directory,[['2026-09',100,10,90,3]]);
    const id=batch(store,shop.id,[[f,'月汇总']]);
    const other=store.saveShop({name:'另一个合成店'});
    assert.throws(()=>store.stage(other.id,f,'bill.xlsx',{batch:id}),/不一致/);
    store.previewBatch(id,options('income'));
    assert.throws(()=>store.stage(shop.id,f,'bill.xlsx',{batch:id,subtype:'日汇总'}),/已预览/);
    assert.throws(()=>store.closeBatch(id,{expected:['月汇总','日汇总']}),/已核对或提交/);
    // 模拟旧数据或外部写入破坏批次状态，提交仍须独立检查完整性。
    store.db.prepare("UPDATE batches SET state='partial' WHERE id=?").run(id);
    assert.throws(()=>store.commitBatch(id,true),/尚未完整/);
    assert.equal(store.report(shop.id,'2026-09').rows.length,0);
    assert.equal(store.report(other.id,'2026-09').pending.length,0);
  }finally{store.close();}
});

test('restoring a broken historical selection rolls back without changing current amounts',()=>{
  const {directory,store,shop}=fixture();try{
    const old=save(store,shop.id,file(directory,[['2026-09',100,10,90,3]]));
    save(store,shop.id,file(directory,[['2026-09',200,10,190,3]],'new.xlsx'));
    // 模拟旧修复曾写出的“版本已保存，但所有文件都仅作凭证”状态。
    store.db.prepare("UPDATE bills SET state='retained' WHERE version=?").run(old.result.versionId);
    assert.throws(()=>store.restore(old.result.versionId),/入账口径缺失/);
    assert.equal(store.report(shop.id,'2026-09').platformTotals.net,19000);
    assert.equal(store.bill(old.result.id).active,0);assert.ok(fs.existsSync(store.bill(old.result.id).file));
  }finally{store.close();}
});

test('batch repeat preserves saved history, multiplicity, source files and complete totals',()=>{
  const {directory,store,shop}=fixture();try{
    const a=file(directory,[['2026-09',100,10,90,3]],'a.xlsx');
    const b=file(directory,[['2026-09',200,10,190,4]],'b.xlsx');
    const first=batch(store,shop.id,[[a,'货款'],[b,'补贴']]);
    store.previewBatch(first,options('income'));store.commitBatch(first,true);
    const before=store.report(shop.id,'2026-09');
    assert.equal(before.history.length,1);assert.equal(before.kindTotals.income.net,28000);
    const again=batch(store,shop.id,[[b,'补贴'],[a,'货款']]);
    store.previewBatch(again,options('income'));assert.equal(store.commitBatch(again,true).duplicate,true);
    const after=store.report(shop.id,'2026-09');
    assert.equal(after.history.length,1);assert.equal(after.rows.length,2);assert.equal(after.signature,before.signature);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM versions WHERE state='saved'").get().n,1);
    assert.equal(after.pending.length,0);
    // One part of a saved batch is not a duplicate of the complete monthly version.
    assert.equal(save(store,shop.id,a,options('income')).result.duplicate,undefined);
    assert.equal(store.report(shop.id,'2026-09').rows.length,1);
    store.restore(before.history[0].versionId);assert.equal(store.report(shop.id,'2026-09').rows.length,2);
  }finally{store.close();}
});

test('batch refuses overlapping All and subtype scopes without changing the ledger',()=>{
  const {directory,store,shop}=fixture();try{
    const a=file(directory,[['2026-09',100,10,90,3]],'all.xlsx');
    const b=file(directory,[['2026-09',50,10,40,3]],'subtype.xlsx');
    const id=batch(store,shop.id,[[a,'全部'],[b,'货款']]);
    assert.throws(()=>store.previewBatch(id,options('income')),/重复计账/);
    const report=store.report(shop.id,'2026-09');assert.equal(report.rows.length,0);assert.equal(report.pending.length,2);
  }finally{store.close();}
});

test('old saved bill migration retains active data and historical restore after restart',()=>{
  const {directory,store,shop}=fixture();
  const a=save(store,shop.id,file(directory,[['2026-09',100,10,90,3]]));
  const b=save(store,shop.id,file(directory,[['2026-09',200,10,190,3]],'new.xlsx'));
  // Recreate the pre-batch schema state; only temporary synthetic data is modified.
  store.db.exec('UPDATE bills SET version=NULL; DELETE FROM versions');store.close();
  const reopened=new FinanceLedger(path.join(directory,'finance'));try{
    assert.equal(reopened.report(shop.id,'2026-09').platformTotals.net,19000);
    assert.equal(reopened.report(shop.id,'2026-09').history.length,2);
    assert.equal(save(reopened,shop.id,reopened.bill(b.result.id).file).result.duplicate,true);
    reopened.restore(a.result.id);assert.equal(reopened.report(shop.id,'2026-09').platformTotals.net,9000);
  }finally{reopened.close();}
});

test('downloaded filename type conflict and incomplete batch cannot enter ledger',()=>{
  const {directory,store,shop}=fixture();try{
    const f=file(directory,[['2026-09',100,10,90,3]],'收入账单.xlsx');
    const id=store.openBatch(store.newJob(shop.id,'2026-09'),shop.id,'2026-09','tax');
    assert.throws(()=>store.addPart(id,{file:f,name:path.basename(f),kind:'tax'}),/原文件名/);
    store.closeBatch(id,{expected:['涉税信息报送账单']});
    assert.throws(()=>store.previewBatch(id,options('tax')),/尚未完整/);
    assert.equal(store.report(shop.id,'2026-09').rows.length,0);assert.ok(fs.existsSync(f));
  }finally{store.close();}
});

test('integer cents; missing is null and invalid precision is rejected',()=>{assert.equal(cents('1,234.56'),123456);assert.equal(cents('(10.10)'),-1010);assert.equal(cents(''),null);assert.equal(cents(0),0);assert.throws(()=>cents('1.234'));assert.throws(()=>cents('NaN'));assert.equal(cents('0.29'),29);});
test('schedule uses Beijing 15th 09:00, handles rollover and catches latest cycle',()=>{assert.equal(dueFinanceMonth(new Date('2026-10-15T00:59:59Z')),'2026-08');assert.equal(dueFinanceMonth(new Date('2026-10-15T01:00:00Z')),'2026-09');assert.equal(dueFinanceMonth(new Date('2027-01-15T01:00:00Z')),'2026-12');assert.equal(dueFinanceMonth(new Date('2026-11-02T01:00:00Z')),'2026-09');});
test('independent store, version replacement, duplicate prevention, restore and restart',()=>{const {directory,store,shop}=fixture();try{assert.equal(store.report(shop.id,'2026-09').rows.length,0);const f=file(directory,[['2026-09',100,10,90,3]]);const first=save(store,shop.id,f);assert.equal(store.report(shop.id,'2026-09').platformTotals.net,9000);assert.equal(save(store,shop.id,f).result.duplicate,true);const f2=file(directory,[['2026-09',110,10,100,3]],'update.xlsx');const second=save(store,shop.id,f2);assert.notEqual(second.result.id,first.result.id);assert.equal(store.report(shop.id,'2026-09').platformTotals.net,10000);store.restore(first.result.id);assert.equal(store.report(shop.id,'2026-09').platformTotals.net,9000);assert.equal(store.report(shop.id,'2026-09').history.length,2);const other=store.saveShop({name:'其他店铺'});assert.equal(store.report(other.id,'2026-09').rows.length,0);store.close();const reopened=new FinanceLedger(path.join(directory,'finance'));assert.equal(reopened.report(shop.id,'2026-09').platformTotals.net,9000);reopened.close();}catch(e){try{store.close();}catch{}throw e;}});
test('incomplete values, date mismatch, duplicate rows, and conflicting net remain visible',()=>{const {directory,store,shop}=fixture();try{const f=file(directory,[['2026-08',100,10,80,null],['2026-08',100,10,80,null],['2026-09',null,0,null,0]]);const {preview}=save(store,shop.id,f,options('income','2026-09',4));assert.equal(preview.totals.net,null);assert.ok(preview.issues.some(x=>x.includes('账期')));assert.ok(preview.issues.some(x=>x.includes('不一致')));assert.ok(preview.issues.some(x=>x.includes('完全相同')));assert.ok(preview.issues.some(x=>x.includes('金额缺失')));}finally{store.close();}});
test('formula cache missing not zero; source formula and exact cell preserved',()=>{const {directory,store,shop}=fixture();try{const f=file(directory,[['2026-09',100,10,90,null]]);const b=XLSX.readFile(f);b.Sheets['账单'].D2={t:'n',f:'B2-C2'};XLSX.writeFile(b,f);const {preview}=save(store,shop.id,f);assert.equal(preview.totals.net,null);assert.ok(preview.issues.some(x=>x.includes('公式缺少缓存')));const row=store.report(shop.id,'2026-09').rows[0];assert.equal(row.raw.D2.formula,'B2-C2');assert.equal(row.source.net,'D2');}finally{store.close();}});
test('preview concurrency prevents lost updates; unpreviewed and invalid inputs rejected',()=>{const {directory,store,shop}=fixture();try{const f=file(directory,[['2026-09',100,10,90,3]]);const a=store.stage(shop.id,f),b=store.stage(shop.id,f);assert.throws(()=>store.commit(a.token,true));store.preview(a.token,options());store.preview(b.token,options());store.commit(a.token,true);assert.throws(()=>store.commit(b.token,true),/版本已变化/);assert.throws(()=>store.preview(b.token,{...options(),month:'2026-13'}));assert.throws(()=>store.preview(b.token,{...options(),mapping:{gross:'B',net:'B'}}));assert.throws(()=>store.preview(b.token,{...options(),confirmScope:false}));fs.writeFileSync(path.join(directory,'bad.xlsx'),'broken');assert.throws(()=>store.stage(shop.id,path.join(directory,'bad.xlsx')));}finally{store.close();}});
test('quarterly drafts block partial totals, require basis, invalidate on bill/profile changes and warn shared entity',async()=>{const {directory,store,shop}=fixture();try{store.saveShop({...shop,cycle:'quarterly'});save(store,shop.id,file(directory,[['2026-09',100,10,90,3]]));let r=store.report(shop.id,'2026-09');assert.equal(r.period.key,'2026-Q3');assert.equal(r.platformTotals.net,null);assert.ok(r.draftIssues.some(i=>i.includes('2026-07')));assert.throws(()=>store.saveDraft(shop.id,'2026-09',{signature:r.signature,values:{taxable:{amount:'90'}}}),/依据/);store.saveDraft(shop.id,'2026-09',{signature:r.signature,values:{taxable:{amount:'90',basis:'测试发票核对'}},note:'测试草稿'});save(store,shop.id,file(directory,[['2026-09',110,10,100,3]],'new.xlsx'));r=store.report(shop.id,'2026-09');assert.ok(r.draftIssues.some(i=>i.includes('发生变化')));store.saveShop({name:'同主体另店',taxId:shop.taxId});assert.ok(store.report(shop.id,'2026-09').draftIssues.some(i=>i.includes('相同税号')));const bytes=await store.export(shop.id,'2026-09');const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);assert.equal(wb.getWorksheet('填表草稿').getCell('B2').value,90);assert.equal(wb.getWorksheet('平台报送参考').getCell('D2').value,null);assert.equal(wb.getWorksheet('期间来源清单').rowCount,2);assert.ok(wb.getWorksheet('原值与公式').rowCount>1);}finally{store.close();}});
test('persisted jobs deduplicate due cycle, no login retry storm, interrupted work recoverable',()=>{const {store,shop}=fixture();try{store.saveShop({...shop,schedule:true});const now=new Date('2026-10-15T01:00:00Z');assert.equal(store.due(now).length,1);const id=store.newJob(shop.id,'2026-09');assert.equal(store.due(now).length,0);store.finishJob(id,'needs_login','请登录');assert.equal(store.due(now).length,0);const another=store.newJob(shop.id,'2026-08');store.recoverJobs();assert.equal(store.report(shop.id,'2026-09').jobs.find(j=>j.id===another).state,'interrupted');assert.equal(store.due(new Date('2026-11-15T01:00:00Z')).length,1);}finally{store.close();}});
test('UTF-8 Chinese CSV and legacy XLS preserve source headers and numeric values',()=>{const {directory,store,shop}=fixture();try{const csv=path.join(directory,'bill.csv');fs.writeFileSync(csv,'日期,收入总额,退款,收入净额,支出\n2026-09,100.10,10.10,90.00,2.00\n');const stage=store.stage(shop.id,csv);assert.equal(stage.sheets[0].sample[0][0],'日期');const parsed=store.preview(stage.token,{...options(),sheet:stage.sheets[0].name});assert.equal(parsed.totals.net,9000);const xls=file(directory,[['2026-09',100.10,10.10,90,2]],'legacy.xls');assert.equal(store.stage(shop.id,xls).sheets[0].sample[0][0],'日期');}finally{store.close();}});
