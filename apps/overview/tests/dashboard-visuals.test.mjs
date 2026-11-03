import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardVisuals,defaultDashboardPeriod} from '../public/dashboard-model.mjs';
import {fixture,bill} from './helpers.mjs';
import {dashboard} from '../lib/dashboard.mjs';
import ExcelJS from 'exceljs';
import {exportReport} from '../lib/files.mjs';

test('默认周期是今年；累计保持整数和空月份，净退款保留负支出',()=>{
 assert.deepEqual(defaultDashboardPeriod('2026-11-04'),{grain:'year',period:'2026'});
 const data={unavailable:false,shops:[],coverage:[],rows:[],expenseBreakdown:[],trend:[{period:'2026-01',income:null,outflow:null,difference:null,totals:{}},{period:'2026-02',income:10025,outflow:3000,difference:7025,totals:{income:10025,payroll:-3000}},{period:'2026-03',income:null,outflow:null,difference:null,totals:{}},{period:'2026-04',income:0,outflow:-1000,difference:1000,totals:{income:0,payroll:1000}}]};
 const v=dashboardVisuals(data);assert.deepEqual(v.cumulative.map(p=>p.difference),[null,7025,null,8025]);assert.deepEqual(v.expenseSeries.find(s=>s.key==='payroll').values,[null,3000,null,-1000]);
 assert.deepEqual(v.cumulative.map(p=>p.income),[null,10025,null,10025]);
});
test('店铺收支只使用当前结果的人民币有效收支，公司共用单列',()=>{
 const data={unavailable:false,shops:[{id:'a',name:'A店'},{id:'b',name:'B店'}],coverage:[],trend:[],rows:[{owner:'a',bucket:'income',amountCents:10000,currency:'CNY'},{owner:'a',bucket:'refund',amountCents:-2000,currency:'CNY'},{owner:'a',bucket:'transfer',amountCents:-9000,currency:'CNY'},{owner:'a',bucket:'income',amountCents:99999,currency:'USD'},{owner:'company',bucket:'purchase',amountCents:-3000,currency:'CNY'}]};
 const v=dashboardVisuals(data),a=v.owners.find(o=>o.id==='a'),b=v.owners.find(o=>o.id==='b'),company=v.owners.find(o=>o.id==='company');
 assert.equal(a.income,10000);assert.equal(a.outflow,2000);assert.equal(a.difference,8000);assert.equal(company.difference,-3000);assert.equal(b.difference,null);
 data.unavailable=true;assert.ok(dashboardVisuals(data).owners.every(o=>o.income===null&&o.difference===null));
});
test('年份、月份记录与期末待付严格隔离；往期账单本期付款仍按发生日期',()=>{
 const f=fixture();try{
  const old=f.s.createBill(bill({billNo:'OLD',period:'2025-12',billDate:'2025-12-31'}),f.sources());
  const jan=f.s.createBill(bill({billNo:'JAN',period:'2026-01',billDate:'2026-01-31'}),f.sources());
  const feb=f.s.createBill(bill({billNo:'FEB',period:'2026-02',billDate:'2026-02-28'}),f.sources());
  const future=f.s.createBill(bill({billNo:'NEXT',period:'2027-01',billDate:'2027-01-31'}),f.sources());
  f.s.addPayment(old.id,{version:old.version,amountCents:1000,date:'2026-01-10',direction:'pay',reference:'old-paid-in-year'});
  const year=dashboard(f.s,f.sources(),{grain:'year',period:'2026'}),month=dashboard(f.s,f.sources(),{grain:'month',period:'2026-01'});
  assert.deepEqual(new Set(year.debts.map(b=>b.id)),new Set([jan.id,feb.id]));assert.equal(year.pendingCents,20000);assert.equal(year.totals.freight,-1000);
  assert.deepEqual(month.debts.map(b=>b.id),[jan.id]);assert.equal(month.pendingCents,10000);assert.equal(month.totals.freight,-1000);
  assert.ok(year.rows.every(r=>r.date.startsWith('2026-')));assert.ok(month.rows.every(r=>r.date.startsWith('2026-01-')));
  assert.ok(!year.debts.some(b=>b.id===future.id));
 }finally{f.close();}
});
test('导出包含新增分类、累计趋势和归属收支，与所选期间一致',async()=>{
 const f=fixture();try{
  const r=dashboard(f.s,f.sources(),{grain:'year',period:'2026'}),w=new ExcelJS.Workbook();await w.xlsx.load(await exportReport(r));
  assert.equal(w.getWorksheet('月度趋势').getCell('F1').value,'交易退款（元）');assert.equal(w.getWorksheet('月度趋势').getCell('F10').value,20);
  assert.equal(w.getWorksheet('累计趋势').getCell('D10').value,r.difference/100);
  const owner=w.getWorksheet('归属收支');let total=0;owner.eachRow((row,i)=>{if(i>1&&typeof row.getCell(4).value==='number')total+=Math.round(row.getCell(4).value*100);});assert.equal(total,r.difference);
 }finally{f.close();}
});
