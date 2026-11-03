import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../lib/store.mjs';
import {savePayrollSheet} from '../lib/payroll-sheet.mjs';
import {parsePayrollAmount,payrollRows,isEmptyPayrollDraft} from '../public/payroll-model.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-payroll-sheet-')),s=openStore(dir);t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});return s;}
const sources={shops:[]},row=(extra={})=>({key:randomUUID(),date:'2026-10-31',name:'测试人员',amount:'1234.56',note:'测试',...extra});
const request=rows=>({requestId:randomUUID(),month:'2026-10',rows});
test('金额严格校验，不补零、不接受超精度和浮点误差',()=>{assert.equal(parsePayrollAmount('1,234.56'),123456);for(const v of ['',null,'-1','0','1.001','1e3','Infinity','10000000000.01'])assert.throws(()=>parsePayrollAmount(v));});
test('空白新增占位行可忽略，清空已有工资绝不能当成空白占位行',()=>{const empty={date:'',name:'',amount:'',note:''};assert.equal(isEmptyPayrollDraft(empty),true);assert.equal(isEmptyPayrollDraft({...empty,billId:'saved-bill'}),false);assert.equal(isEmptyPayrollDraft({...empty,name:'待填写'}),false);});
test('批量新增应付不自动付款；相同请求幂等，不同内容拒绝',t=>{const s=fixture(t),input=request([row(),row({name:'另一人员',amount:'20'})]);const result=savePayrollSheet(s,sources,input);assert.equal(s.bills().length,2);assert.equal(s.payments().length,0);assert.equal(s.bills().reduce((n,b)=>n+b.amountCents,0),125456);assert.deepEqual(savePayrollSheet(s,sources,input),result);assert.equal(s.bills().length,2);assert.throws(()=>savePayrollSheet(s,sources,{...input,rows:[row()]}),/请求.*内容/);});
test('一行错误整批回滚，并标明错误行',t=>{const s=fixture(t);assert.throws(()=>savePayrollSheet(s,sources,request([row(),row({amount:'1.001'})])),e=>e.row===2);assert.equal(s.bills().length,0);assert.equal(s.all('SELECT * FROM audit').length,0);});
test('版本冲突不覆盖；旧记录更正需要原因',t=>{const s=fixture(t);savePayrollSheet(s,sources,request([row()]));const b=s.bills()[0],edit=row({billId:b.id,version:b.version,amount:'1500'});assert.throws(()=>savePayrollSheet(s,sources,request([edit])),/更正原因/);savePayrollSheet(s,sources,{...request([edit]),reason:'修正测试金额'});assert.equal(s.bill(b.id).amountCents,150000);assert.throws(()=>savePayrollSheet(s,sources,{...request([edit]),reason:'重复旧版本'}),e=>e.status===409);});
test('已有付款不能被工资更正改成超付；同批新增与审计同时回滚',t=>{const s=fixture(t);savePayrollSheet(s,sources,request([row({amount:'100'})]));let b=s.bills()[0];s.addPayment(b.id,{version:b.version,date:'2026-10-31',direction:'pay',amountCents:5000,reference:'synthetic-payroll-payment'});b=s.bill(b.id);const before={bills:s.bills(),payments:s.payments(),audit:s.all('SELECT * FROM audit')};assert.throws(()=>savePayrollSheet(s,sources,{...request([row({name:'不应保存的新人员'}),row({billId:b.id,version:b.version,amount:'40'})]),reason:'不允许超付'}),/超过账单应付/);assert.deepEqual({bills:s.bills(),payments:s.payments(),audit:s.all('SELECT * FROM audit')},before);});
test('复杂工资只读展示应发，拒绝三列覆盖；拒绝跨期和付款字段',t=>{const s=fixture(t);const b=s.createBill({kind:'payroll',billNo:'TEST-COMPLEX',party:'人员',period:'2026-10',billDate:'2026-10-31',category:'salary',owner:'company',grossCents:10000,withheldCents:1000,netCents:9000,employerCents:2000},sources);const mapped=payrollRows([{...b,paidCents:0}],'2026-10');assert.equal(mapped[0].amount,'100.00');assert.equal(mapped[0].editable,false);assert.throws(()=>savePayrollSheet(s,sources,{...request([row({billId:b.id,version:b.version})]),reason:'不应允许'}),/明细/);assert.throws(()=>savePayrollSheet(s,sources,request([row({payments:[]})])),/字段/);assert.equal(s.bill(b.id).amountCents,12000);});
