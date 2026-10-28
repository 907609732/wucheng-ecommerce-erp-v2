import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {DatabaseSync} from 'node:sqlite';
import {fixture,bill} from './helpers.mjs';
import {freightWorkbook,resolveOwner,freightRows} from '../lib/freight.mjs';
import {readTable,previewTable} from '../lib/importer.mjs';
import {openStore} from '../lib/store.mjs';
import {hash} from '../lib/util.mjs';
import {createApp} from '../server.mjs';

async function workbook(bytes){const w=new ExcelJS.Workbook();await w.xlsx.load(bytes);return w;}
const preview=async(f,bytes,options={})=>previewTable(await readTable(bytes,'运费维护.xlsx'),{kind:'freight',mode:'maintenance',...options},f.s,f.sources());
const create=(f,extra={})=>f.s.createBill(bill({owner:'shop1',lines:[{lineNo:'001',label:'发货运费',amountCents:10000}],...extra}),f.sources());

test('运费按店铺和月份识别，旧库迁移不改变账单、付款与版本',()=>{
 const f=fixture();try{
  const b=create(f);f.s.run('UPDATE bills SET identity=? WHERE id=?',hash([b.kind,b.party,b.billNo]),b.id);
  const old=f.s.bills(),migrated=openStore(f.s.dir);try{assert.deepEqual(migrated.bills(),old);assert.equal(migrated.all("SELECT * FROM audit WHERE action='migration.freight_identity'").length,1);}finally{migrated.close();}
  create(f,{owner:'company'});create(f,{period:'2026-10'});
  assert.equal(f.s.bills().length,3);assert.throws(()=>create(f),/UNIQUE/);
  assert.equal(freightRows(f.s,{period:'2026-09',owner:'shop1'}).length,1);
 }finally{f.close();}
});
test('当月店铺填写表预置店铺与月份，空白行跳过；同名店铺必须区分平台',async()=>{
 const f=fixture();try{
  const d=new DatabaseSync(f.paths.sales);d.exec("INSERT INTO shops VALUES('shop2','淘宝','测试店')");d.close();
  assert.throws(()=>resolveOwner('测试店',f.sources().shops),/重复/);
  assert.equal(resolveOwner('测试店 · 淘宝',f.sources().shops),'shop2');
  const w=await workbook(await freightWorkbook(f.s,f.sources(),{period:'2026-09',template:true})),ws=w.worksheets[0];
  assert.equal(ws.getCell('A3').value,'2026-09');assert.match(ws.getCell('B3').value,/测试店/);
  const blank=await preview(f,await w.xlsx.writeBuffer());assert.equal(blank.newCount,0);assert.equal(blank.errors.length,0);
  ws.getCell('C3').value='顺丰';ws.getCell('K3').value=120.50;
  const p=await preview(f,await w.xlsx.writeBuffer());assert.equal(p.errors.length,0);assert.equal(p.newCount,1);assert.equal(p.amountCents,12050);assert.equal(p.bills[0].bill.owner,'shop1');assert.equal(p.skippedRows,2);
  assert.equal(f.s.bills().length,0);assert.equal(f.s.payments().length,0);
 }finally{f.close();}
});
test('导出回导保持多条明细，重复跳过；修改要有原因、版本，并保留金额与店铺筛选',async()=>{
 const f=fixture();try{
  const b=create(f,{lines:[{lineNo:'A',label:'发货',amountCents:7000},{lineNo:'B',label:'退货',amountCents:3000}]});
  create(f,{owner:'company',billNo:'COMP'});create(f,{period:'2026-10',billNo:'OCT'});
  const bytes=await freightWorkbook(f.s,f.sources(),{period:'2026-09',owner:'shop1'});let p=await preview(f,bytes);
  assert.equal(p.duplicateCount,1);assert.equal(p.conflictCount,0);assert.equal(p.canCommit,false);assert.equal(p.bills[0].bill.lines.length,2);
  const w=await workbook(bytes),ws=w.worksheets[0];assert.equal(ws.getCell('Q2').value,b.id);assert.equal(ws.getCell('R2').value,1);
  ws.getCell('K2').value=80;p=await preview(f,await w.xlsx.writeBuffer());assert.match(p.errors[0].message,/原因/);
  ws.getCell('P2').value='按正式月结单更正';ws.getCell('P3').value='按正式月结单更正';
  p=await preview(f,await w.xlsx.writeBuffer());assert.equal(p.canCommit,true);assert.equal(p.updateCount,1);assert.equal(p.updateDeltaCents,1000);assert.equal(p.bills[0].bill.amountCents,11000);
  assert.ok(p.bills[0].changes.some(c=>c.field==='应付金额'&&c.before===10000&&c.after===11000));
  f.s.addPayment(b.id,{version:1,date:'2026-10-01',direction:'pay',amountCents:1000,reference:'paid'});
  p=await preview(f,await w.xlsx.writeBuffer());assert.equal(p.conflictCount,1);assert.match(p.bills[0].message,/重新导出/);
 }finally{f.close();}
});
test('回导不能低于付款历史上限、不能改动已付来源；无明细旧账单原样回导仍重复',async()=>{
 const f=fixture();try{
  const b=create(f,{lines:[]});let bytes=await freightWorkbook(f.s,f.sources(),{period:'2026-09'});
  assert.equal((await preview(f,bytes)).duplicateCount,1);
  f.s.addPayment(b.id,{version:1,date:'2026-10-01',direction:'pay',amountCents:9000,reference:'pay'});
  f.s.addPayment(b.id,{version:2,date:'2026-10-03',direction:'refund',amountCents:4000,reference:'refund'});
  const w=await workbook(await freightWorkbook(f.s,f.sources(),{period:'2026-09'}));w.worksheets[0].getCell('K2').value=60;w.worksheets[0].getCell('P2').value='调整';
  const p=await preview(f,await w.xlsx.writeBuffer());assert.equal(p.canCommit,false);assert.match(p.errors[0].message,/累计付款/);
  assert.equal(f.s.bill(b.id).amountCents,10000);assert.equal(f.s.payments().length,2);
 }finally{f.close();}
});
test('同号跨店物流 CSV 分开建账；不带 ID 的冲突不能覆盖已有数据',async()=>{
 const f=fixture();try{
  const csv='账单编号,物流公司,所属月份,账单日期,运费用途,店铺,应付金额,明细编号\nS1,顺丰,2026-09,2026-09-30,销售发货,测试店 · 拼多多,100,1\nS1,顺丰,2026-09,2026-09-30,销售发货,公司共用,200,1';
  const table=await readTable(Buffer.from(csv),'物流.csv');let p=previewTable(table,{kind:'freight'},f.s,f.sources());assert.equal(p.newCount,2);
  p.bills.forEach(x=>f.s.createBill(x.bill,f.sources()));
  p=previewTable(await readTable(Buffer.from(csv.replace(',100,1',',101,1')),'物流.csv'),{kind:'freight',mode:'maintenance'},f.s,f.sources());
  assert.equal(p.conflictCount,1);assert.equal(p.duplicateCount,1);assert.equal(p.canCommit,false);
 }finally{f.close();}
});
test('API 导出、修改预览、确认保存与再次导出闭环；原件审计保留，付款不变，旧版本拒绝',async()=>{
 const f=fixture(),a=createApp({dataDir:path.join(f.dir,'freight-api'),sources:f.paths}),server=a.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const boot=await fetch(base+'/api/bootstrap').then(r=>r.json()),headers={'X-Overview-Token':boot.token,'Content-Type':'application/json'};
  const request=(url,body)=>fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});
  const b=await request('/api/bills',bill({owner:'shop1',lines:[{lineNo:'01',label:'发货',amountCents:10000}]})).then(r=>r.json());
  await request('/api/bills/'+b.id+'/payments',{version:1,amountCents:4000,date:'2026-10-10',direction:'pay',reference:'pay-1'});
  const exported=await fetch(base+'/api/freight/export?period=2026-09&owner=shop1');assert.equal(exported.status,200);
  const w=await workbook(await exported.arrayBuffer()),ws=w.worksheets[0];assert.equal(ws.getCell('L2').value,40);assert.equal(ws.getCell('M2').value,60);
  ws.getCell('K2').value=120;ws.getCell('P2').value='快递补收';const bytes=await w.xlsx.writeBuffer();
  const upload=async()=>{const fd=new FormData();fd.set('file',new Blob([bytes]),'维护.xlsx');fd.set('options',JSON.stringify({kind:'freight',mode:'maintenance'}));return fetch(base+'/api/imports/preview',{method:'POST',headers:{'X-Overview-Token':boot.token},body:fd}).then(r=>r.json());};
  const p=await upload();assert.equal(p.updateCount,1);assert.equal(a.store.bill(b.id).amountCents,10000);
  const committed=await request('/api/imports/'+p.id+'/commit',{revision:p.revision});assert.equal(committed.status,200);const c=await committed.json();assert.equal(c.updated,1);assert.equal(c.imported,0);
  assert.equal(a.store.bill(b.id).amountCents,12000);assert.equal(a.store.paid(b.id),4000);assert.equal(a.store.payments().length,1);assert.equal(a.store.bill(b.id).batchId,c.batchId);
  assert.ok(a.store.all("SELECT * FROM audit WHERE action='bill.update'").some(x=>JSON.parse(x.payload).importBatchId===c.batchId));
  const original=Buffer.from(await fetch(base+'/api/imports/'+c.batchId+'/original').then(r=>r.arrayBuffer()));assert.deepEqual(original,Buffer.from(bytes));
  const repeated=await upload();assert.equal(repeated.canCommit,false);assert.equal(repeated.conflictCount,1);
  const next=await workbook(await fetch(base+'/api/freight/export?period=2026-09&owner=shop1').then(r=>r.arrayBuffer()));assert.equal(next.worksheets[0].getCell('K2').value,120);assert.equal(next.worksheets[0].getCell('M2').value,80);assert.equal(next.worksheets[0].getCell('R2').value,3);
  assert.equal((await fetch(base+'/api/freight/export?period=bad')).status,400);
 }finally{await new Promise(r=>server.close(r));a.store.close();f.close();}
});
