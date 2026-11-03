import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {readTable} from '../lib/importer.mjs';
import {buildTaobaoSupplement} from '../lib/taobao-supplement.mjs';
import {openStore,summarize} from '../lib/store.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file=process.argv.find((v,i)=>i>=2&&!v.startsWith('--'));
if(!file)throw Error('用法：node scripts/supplement-taobao.mjs <淘宝数据库导出.xlsx> [--commit]');
const buffer=fs.readFileSync(file),hash=createHash('sha256').update(buffer).digest('hex');
const table=await readTable(buffer,path.basename(file),'订单明细');
const base='http://127.0.0.1:17868';
const b=await fetch(base+'/api/bootstrap').then(r=>{if(!r.ok)throw Error('灵兔采购台服务不可用');return r.json();});
let plan=buildTaobaoSupplement(table,b.orders);
console.log(JSON.stringify({phase:'preview',...plan.summary}));
if(process.argv.includes('--commit')){
 if(!plan.entries.length||plan.skipped.length||plan.summary.fieldConflicts)throw Error('存在未解决差异，本脚本不自动提交');
 const backupResponse=await fetch(base+'/api/backup',{method:'POST',headers:{'x-purchase-token':b.token,'content-type':'application/json'},body:'{}'});
 const backup=await backupResponse.json();if(!backupResponse.ok)throw Error(backup.error||'备份失败');
 const dir=path.join(root,'data'),store=openStore(dir);
 try{
  const before=store.list(),rawBefore=store.db.prepare('SELECT * FROM orders').all();
  plan=buildTaobaoSupplement(table,before);
  if(plan.skipped.length||plan.summary.fieldConflicts)throw Error('备份期间订单有变化，请重新核对');
  const relative=`originals/taobao-supplement-${hash}.xlsx`,saved=path.join(dir,relative);
  if(fs.existsSync(saved))assert.equal(createHash('sha256').update(fs.readFileSync(saved)).digest('hex'),hash);
  else fs.writeFileSync(saved,buffer,{flag:'wx'});
  const result=store.supplementBatch(plan.entries,{filename:path.basename(file),hash,filePath:relative,lineCount:table.rows.length,summary:plan.summary,skipped:plan.skipped});
  const after=store.list(),rawAfter=store.db.prepare('SELECT * FROM orders').all(),matched=new Set(plan.entries.map(e=>e.id));
  assert.deepEqual(after.map(o=>o.id).sort(),before.map(o=>o.id).sort());
  const unchanged=['platform','orderNo','date','supplier','status','amountCents','refundCents','shippingCents','note','items','sourceId','createdAt'];
  for(const old of before){const current=after.find(o=>o.id===old.id);for(const key of unchanged)assert.deepEqual(current[key],old[key],`Unexpected change: ${key}`);if(!matched.has(old.id))assert.deepEqual(current,old);}
  for(const old of rawBefore)assert.equal(rawAfter.find(o=>o.id===old.id).original,old.original);
  for(const entry of plan.entries){
   const savedSource=store.supplements(entry.id).find(s=>s.sourceId===result.id);
   assert.deepEqual(savedSource.original,entry.original);
   const savedOrder=after.find(o=>o.id===entry.id);for(const [key,value] of Object.entries(entry.patch))assert.equal(savedOrder[key],value);
  }
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash);
  const allPaid=list=>list.reduce((s,o)=>s+o.amountCents,0);
  assert.equal(allPaid(after),allPaid(before));
  const monthlyBefore=summarize(before,'2026'),monthlyAfter=summarize(after,'2026');
  assert.equal(monthlyBefore.netCents,monthlyAfter.netCents);
  const report={...result,sourceFile:path.basename(file),sourceHash:hash,backupFile:backup.filename,ordersBefore:before.length,ordersAfter:after.length,itemsBefore:before.reduce((s,o)=>s+o.items.length,0),itemsAfter:after.reduce((s,o)=>s+o.items.length,0),allPaidCentsBefore:allPaid(before),allPaidCentsAfter:allPaid(after),effectiveCentsBefore:monthlyBefore.netCents,effectiveCentsAfter:monthlyAfter.netCents,sourceColumns:table.headers.length,rawRowsPreserved:table.rows.length,originalsPreserved:true,notesPreserved:true,sourceFileUnchanged:true,monthChanges:monthlyAfter.months.flatMap((m,i)=>m.netCents===monthlyBefore.months[i].netCents?[]:[{month:m.month,before:monthlyBefore.months[i].netCents,after:m.netCents}])};
  fs.writeFileSync(path.join(root,'outputs','淘宝原始数据补充-完成报告.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({phase:'complete',...report},null,2));
 }finally{store.close();}
}
