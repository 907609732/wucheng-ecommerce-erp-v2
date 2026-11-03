import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../lib/store.mjs';
import {savePayrollSheet} from '../lib/payroll-sheet.mjs';
import {packPayrollGrid,flattenPayrollGrid,payrollRows,payrollYearSummary,emptyPayrollMonthRow} from '../public/payroll-model.mjs';
import {controlledLocator} from '../public/business-surface.js';
const sources={shops:[]};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-payroll-year-')),s=openStore(dir);t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});return s;}
const row=(period,name='测试人员')=>({key:randomUUID(),period,date:period+'-20',name,amount:'100',note:''});
const request=rows=>({requestId:randomUUID(),year:'2026',rows});
test('年度人力看板属于受控导航，任意未知页面仍拒绝',()=>{assert.equal(controlledLocator({module:'overview',view:'payroll-dashboard',period:'2026'}).view,'payroll-dashboard');assert.throws(()=>controlledLocator({module:'overview',view:'unknown-payroll'}),/白名单/);});

test('年度空表固定12个月，不产生草稿；月末日期支持闰年',()=>{
 const g=packPayrollGrid([],2,'2024');assert.equal(g.rows.length,12);assert.equal(g.count,2);
 assert.deepEqual(g.rows.map(r=>r.month),Array.from({length:12},(_,i)=>'2024-'+String(i+1).padStart(2,'0')));
 assert.equal(flattenPayrollGrid(g.rows,2).length,0);assert.equal(g.rows[1].date,'2024-02-29');
 const r=emptyPayrollMonthRow('2026-02');r.p1_name='乙';r.p1_amount='10';const [f]=flattenPayrollGrid([r],2);assert.equal(f.date,'2026-02-28');assert.equal(f.period,'2026-02');
});
test('年度按账期归月，保留原日期、身份和同人同月多笔',()=>{
 const bills=[{id:'a',kind:'payroll',period:'2026-01',billDate:'2026-02-02',party:'甲',amountCents:10000,version:1,lines:[{grossCents:10000,netCents:10000,amountCents:10000,withheldCents:0,employerCents:0}]},
 {id:'b',kind:'payroll',period:'2026-01',billDate:'2026-01-20',party:'甲',amountCents:10000,version:1,lines:[{grossCents:10000,netCents:10000,amountCents:10000,withheldCents:0,employerCents:0}]}];
 const flat=payrollRows(bills,'2026'),g=packPayrollGrid(flat,2,'2026'),out=flattenPayrollGrid(g.rows,g.count);
 assert.equal(g.rows.length,13);assert.equal(out.length,2);assert.deepEqual(out.map(r=>[r.billId,r.date,r.period]),[['a','2026-02-02','2026-01'],['b','2026-01-20','2026-01']]);
 const first=g.rows.find(r=>r.p0_meta?.billId==='a');first.p0_name='';first.p0_amount='';assert.equal(flattenPayrollGrid(g.rows,g.count).length,2);
});
test('年度跨月保存保持原账期/日期，幂等且不自动付款',t=>{
 const s=fixture(t),input=request([row('2026-01','甲'),row('2026-12','乙')]);const result=savePayrollSheet(s,sources,input);
 assert.equal(s.bills().length,2);assert.deepEqual(new Set(s.bills().map(b=>b.period)),new Set(['2026-01','2026-12']));assert.equal(s.payments().length,0);
 assert.deepEqual(savePayrollSheet(s,sources,input),result);assert.equal(s.bills().length,2);
 const b=s.bills()[0];savePayrollSheet(s,sources,{...request([{...row(b.period),billId:b.id,version:b.version,date:b.billDate,amount:'101'}]),reason:'调整金额'});
 assert.equal(s.bill(b.id).billDate,b.billDate);assert.equal(s.bill(b.id).amountCents,10100);
});
test('年度越年、月份迁移、旧版本冲突都整批回滚',t=>{
 const s=fixture(t);assert.throws(()=>savePayrollSheet(s,sources,request([row('2026-01'),row('2027-01')])),/年度/);assert.equal(s.bills().length,0);
 savePayrollSheet(s,sources,request([row('2026-02')]));const b=s.bills()[0];
 assert.throws(()=>savePayrollSheet(s,sources,{...request([row('2026-01'),{...row('2026-03'),billId:b.id,version:b.version}]),reason:'不允许迁移'}),/账期/);
 assert.equal(s.bills().length,1);
 assert.throws(()=>savePayrollSheet(s,sources,{...request([row('2026-01'),{...row('2026-02'),billId:b.id,version:0}]),reason:'版本冲突'}),e=>e.status===409);
 assert.equal(s.bills().length,1);
 assert.throws(()=>savePayrollSheet(s,sources,{...request([row('2026-01')]),month:'2026-01'}),/年度|月份|期间/);
});
test('看板应付按账期，净付款按日期，退款/作废与公司承担不重复',()=>{
 const bill=(id,period,amountCents,payments=[],extra={})=>({id,kind:'payroll',period,party:id,amountCents,lines:[],payments,...extra});
 const bills=[bill('今年','2026-01',12000,[{date:'2026-02-01',amountCents:5000,direction:'pay'},{date:'2026-03-01',amountCents:1000,direction:'refund'},{date:'2026-01-02',amountCents:6000,direction:'pay',voided:true}]),
 bill('往年','2025-12',8000,[{date:'2026-01-15',amountCents:8000,direction:'pay'}]),
 bill('以后付款','2026-12',10000,[{date:'2027-01-15',amountCents:10000,direction:'pay'}]),
 bill('作废','2026-04',90000,[],{voided:true}),{...bill('其他','2026-05',70000),kind:'other'}];
 const s=payrollYearSummary(bills,'2026');assert.equal(s.months.length,12);assert.equal(s.payableCents,22000);assert.equal(s.paidCents,12000);assert.equal(s.pendingCents,8000);assert.equal(s.billCount,2);
 assert.equal(s.months[0].payableCents,12000);assert.equal(s.months[0].paidCents,8000);assert.equal(s.months[1].payableCents,null);assert.equal(s.months[1].paidCents,5000);assert.equal(s.months[2].paidCents,-1000);assert.equal(s.months[3].payableCents,null);
});
test('作废工资账单仍保留跨年付款和退款的真实发生额',()=>{
 const b={kind:'payroll',voided:true,period:'2025-12',party:'已退工资',amountCents:10000,payments:[{date:'2025-12-31',amountCents:10000,direction:'pay'},{date:'2026-01-15',amountCents:10000,direction:'refund'}]};
 const s=payrollYearSummary([b],'2026');assert.equal(s.payableCents,0);assert.equal(s.billCount,0);assert.equal(s.paidCents,-10000);assert.equal(s.months[0].paidCents,-10000);
});
