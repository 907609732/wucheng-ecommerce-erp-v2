import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ExcelJS from 'exceljs';
import {fixture,bill} from './helpers.mjs';
import {dashboard} from '../lib/dashboard.mjs';
import {report,selectRows} from '../lib/report.mjs';
import {exportReport} from '../lib/files.mjs';
import {createApp} from '../server.mjs';

const today='2026-10-18';
function confirm(f,m,category,status='full'){
 const r=report(f.s,f.sources(),m),c=r.coverage.find(x=>x.category===category);
 f.s.run('INSERT INTO coverage VALUES(?,?,?,?,?,?)',m,category,status,'测试核对',c.signature,today);
}
function pay(f,b,amount,date,direction='pay'){
 return f.s.addPayment(b.id,{version:f.s.bill(b.id).version,amountCents:amount,date,direction,reference:date+'-'+amount});
}
test('年度汇总与月度相加一致；跨年账单、跨月付款和退款只按发生日期计入，待付取期末余额',()=>{
 const f=fixture();try{
  const b=f.s.createBill(bill({period:'2025-12',billDate:'2025-12-31'}),f.sources());
  pay(f,b,4000,'2026-09-30');pay(f,b,5000,'2026-10-10');pay(f,b,2000,'2026-10-15','refund');
  pay(f,b,1000,'2027-01-02');
  const r=dashboard(f.s,f.sources(),{grain:'year',period:'2026',today});
  assert.equal(r.trend.length,12);assert.equal(r.totals.freight,-7000);assert.equal(r.pendingCents,3000);
  assert.equal(r.difference,30500);assert.equal(r.trend[8].difference,33500);assert.equal(r.trend[9].difference,-3000);
  assert.equal(r.trend[0].difference,null);assert.equal(r.trend[11].status,'future');
  assert.equal(r.difference,r.trend.reduce((n,x)=>n+(x.difference??0),0));
  assert.equal(r.pendingRefunds.length,1);assert.equal(r.issues.filter(x=>x.type==='refund_dates').length,1);
  assert.equal(selectRows(r,{bucket:'reference'}).amountCents,r.difference);
  assert.equal(r.shopIncome[0].amountCents,50000);assert.equal(r.snapshots.length,0);
 }finally{f.close();}
});
test('日趋势保留空白、闰月与退款方向；完整性确认变化后恢复待补',()=>{
 const f=fixture();try{
  let r=dashboard(f.s,f.sources(),{period:'2026-09',today});
  assert.equal(r.trend.length,30);assert.equal(r.trend[0].income,null);assert.equal(r.trend[1].outflow,10000);
  assert.equal(r.trend[4].difference,47500);assert.equal(r.trend[4].outflow,2500);
  assert.equal(r.trend.reduce((n,x)=>n+(x.difference??0),0),r.difference);
  assert.equal(selectRows(r,{date:'2026-09-05',bucket:'income',owner:'shop1'}).amountCents,50000);
  confirm(f,'2026-09','sales');
  r=dashboard(f.s,f.sources(),{period:'2026-09',today});assert.equal(r.trend[0].income,0);assert.equal(r.trend[0].totals.payroll,null);
  const d=new DatabaseSync(f.paths.sales);d.exec("UPDATE ledger SET amount=60000 WHERE id='sale'");d.close();
  r=dashboard(f.s,f.sources(),{period:'2026-09',today});assert.equal(r.trend[0].income,null);assert.equal(r.trend[4].income,60000);
  assert.equal(dashboard(f.s,f.sources(),{period:'2024-02',today}).trend.length,29);
  confirm(f,'2026-10','sales');
  r=dashboard(f.s,f.sources(),{period:'2026-10',today});assert.equal(r.trend[17].income,0);assert.equal(r.trend[18].income,null);
 }finally{f.close();}
});
test('明确确认无费用显示零，未录入仍待补；无数据年份不伪造差额',()=>{
 const f=fixture();try{
  confirm(f,'2026-08','payroll','zero');
  const r=dashboard(f.s,f.sources(),{grain:'year',period:'2026',today});
  assert.equal(r.trend[7].totals.payroll,0);assert.equal(r.trend[6].totals.payroll,null);
  assert.equal(r.trend[7].difference,0);assert.equal(r.trend[7].outflow,0);assert.equal(r.totals.other,null);
  const empty=dashboard(f.s,f.sources(),{grain:'year',period:'2024',today});
  assert.equal(empty.difference,null);assert.ok(empty.trend.every(x=>x.income===null&&x.outflow===null&&x.difference===null));
 }finally{f.close();}
});
test('年度导出趋势、总览与下钻明细相等；源故障图表全部为空',async()=>{
 const f=fixture();try{
  const r=dashboard(f.s,f.sources(),{grain:'year',period:'2026',today}),w=new ExcelJS.Workbook();
  await w.xlsx.load(await exportReport(r,{bucket:'reference'}));
  assert.equal(w.getWorksheet('年度看板').getCell('B1').value,'2026');
  assert.equal(w.getWorksheet('月度趋势').rowCount,13);
  assert.equal(w.getWorksheet('月度趋势').getCell('B2').value,'待补');
  let detail=0,trend=0;w.getWorksheet('筛选明细').eachRow((r,i)=>{if(i>1)detail+=Math.round(r.getCell(3).value*100);});
  w.getWorksheet('月度趋势').eachRow((r,i)=>{if(i>1&&typeof r.getCell(4).value==='number')trend+=Math.round(r.getCell(4).value*100);});
  assert.equal(detail,r.difference);assert.equal(trend,r.difference);
  const w2=new ExcelJS.Workbook();await w2.xlsx.load(await exportReport(r,{bucket:'income',date:'2026-09-05',owner:'shop1'}));
  assert.equal(w2.getWorksheet('筛选明细').rowCount,2);
  fs.renameSync(f.paths.sales,f.paths.sales+'.unavailable');
  const broken=dashboard(f.s,f.sources(),{grain:'year',period:'2026',today});
  assert.ok(broken.unavailable);assert.equal(broken.difference,null);assert.ok(broken.trend.every(x=>x.income===null&&x.outflow===null&&x.difference===null));
  assert.ok(broken.shopIncome.every(x=>x.amountCents===null));
 }finally{f.close();}
});
test('看板 API 验证周期，支持年度下钻及 Excel；旧月报接口保持兼容',async()=>{
 const f=fixture(),a=createApp({dataDir:path.join(f.dir,'api-dashboard'),sources:f.paths});
 const server=a.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const year=await fetch(base+'/api/dashboard?grain=year&period=2026').then(r=>r.json());
  const monthly=await fetch(base+'/api/overview?month=2026-09').then(r=>r.json());
  assert.equal(year.difference,monthly.difference);
  const details=await fetch(base+'/api/details?grain=year&period=2026&bucket=reference').then(r=>r.json());
  assert.equal(details.amountCents,year.difference);
  assert.equal((await fetch(base+'/api/dashboard?grain=year&period=2026-09')).status,400);
  assert.equal((await fetch(base+'/api/dashboard?grain=week&period=2026')).status,400);
  const exported=await fetch(base+'/api/export?grain=year&period=2026&bucket=income&owner=shop1');
  assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/2026.xlsx/);
  const w=new ExcelJS.Workbook();await w.xlsx.load(await exported.arrayBuffer());
  assert.ok(w.getWorksheet('年度看板'));assert.equal(w.getWorksheet('筛选明细').rowCount,2);
 }finally{await new Promise(resolve=>server.close(resolve));a.store.close();f.close();}
});
