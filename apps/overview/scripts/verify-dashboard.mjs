import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {readDb,loadSources} from '../lib/sources.mjs';
import {dashboard} from '../lib/dashboard.mjs';
import {selectRows} from '../lib/report.mjs';
import {exportReport} from '../lib/files.mjs';
import {hash} from '../lib/util.mjs';

const root=path.resolve(import.meta.dirname,'..'),year=process.argv[2]||'2026';
const before=loadSources();assert.equal(before.errors.length,0);
const result=readDb(path.join(root,'data/overview.sqlite'),db=>{
 const all=(sql,...args)=>db.prepare(sql).all(...args);
 // This adapter is read-only: it never initializes or migrates the real expense book.
 const s={all,bills:()=>all('SELECT * FROM bills ORDER BY created_at DESC,id').map(r=>({...JSON.parse(r.payload),id:r.id,version:r.version,voided:!!r.voided,batchId:r.batch_id,createdAt:r.created_at})),payments:()=>all('SELECT * FROM payments ORDER BY created_at,id').map(r=>({...JSON.parse(r.payload),id:r.id,billId:r.bill_id,voided:!!r.voided,createdAt:r.created_at}))};
 const localHash=()=>hash(['bills','payments','coverage','overrides','snapshots','audit'].map(table=>all('SELECT * FROM '+table+' ORDER BY rowid')));
 const localBefore=localHash(),annual=dashboard(s,before,{grain:'year',period:year});
 const months=annual.trend.map(point=>{
  const m=dashboard(s,before,{grain:'month',period:point.period});
  assert.equal(point.difference,m.difference);assert.deepEqual(point.totals,m.totals);
  const daily=m.trend.filter(x=>x.difference!=null);
  assert.equal(daily.length?daily.reduce((n,x)=>n+x.difference,0):null,m.difference);
  for(const day of m.trend)if(day.difference!=null)assert.equal(selectRows(m,{bucket:'reference',date:day.period}).amountCents,day.difference);
  return {month:m.period,difference:m.difference,records:m.rows.length,days:m.trend.length};
 });
 assert.equal(selectRows(annual,{bucket:'reference'}).amountCents,annual.difference);
 assert.equal(months.reduce((n,m)=>n+(m.difference??0),0),annual.difference);
 assert.equal(localHash(),localBefore);
 return {annual,months,localBefore};
});
const bytes=await exportReport(result.annual,{bucket:'reference'}),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);
let amount=0;workbook.getWorksheet('筛选明细').eachRow((r,i)=>{if(i>1)amount+=Math.round(r.getCell(3).value*100);});assert.equal(amount,result.annual.difference);
assert.deepEqual(loadSources().sourceVersions,before.sourceVersions,'读取期间来源变化，需要重新核对');
const output=path.join(root,'test-output');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,year+'年度看板核对.xlsx'),bytes);
const evidence={verifiedAt:new Date().toISOString(),year,sourceLogicalHashesUnchanged:true,expenseBookReadOnly:true,sourceVersions:before.sourceVersions,expenseLogicalHash:result.localBefore,months:result.months,annualTotals:result.annual.totals,annualDifference:result.annual.difference,referenceExportRows:workbook.getWorksheet('筛选明细').rowCount-1,trendMatchesMonthlyAndDaily:true};
fs.writeFileSync(path.join(output,'dashboard-verification.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
