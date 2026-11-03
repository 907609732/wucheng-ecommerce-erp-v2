import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {openStore} from './helpers.mjs';
import {id} from '../lib/util.mjs';
import {saveFreight,voidFreight,freightRecord,freightReport,freightRows,freightList,exportFreight,freightAttachment} from '../lib/freight.mjs';
import {report} from '../lib/report.mjs';
import {closePreview,lockMonth,unlockMonth} from '../lib/close.mjs';
import {makeBackup,verifyBackup,restoreBackup} from '../lib/backup.mjs';
import {createApp,createSessionFetch} from './helpers.mjs';

function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'sales-freight-test-')),s=openStore(dir);t.after(()=>{s.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sales-freight-test-'));rmSync(dir,{recursive:true,force:true});});return s;}
const input=(extra={})=>({request_id:id(),channel:'warehouse',entry_mode:'month',period:'2026-09',shipping:'100.25',...extra});
const csv=(name='bill.csv',content='date,fee\n2026-09,100.25')=>({originalname:name,buffer:Buffer.from(content)});
const q=(extra={})=>({period:'2026-09',grain:'month',shop:'all',...extra});
const reviewSave=(s,value,files=[],recordId=null)=>{try{return saveFreight(s,value,files,recordId);}catch(e){if(e.code!=='FREIGHT_REVIEW')throw e;return saveFreight(s,{...value,review_token:e.details.review_token},files,recordId);}};

test('freight keeps shared charges separate, cents exact, and existing reports unchanged',t=>{
  const s=setup(t),before=report(s,q());
  saveFreight(s,input({packing:'1.10',materials:'2.20',storage:'3.30',other:'4.40',other_note:'退件处理',pieces:'10'}));
  saveFreight(s,input({channel:'merchant',shop_id:'tb-diankou',shipping:'20',pieces:'2'}));
  saveFreight(s,input({channel:'merchant',shop_id:'tb-xishi',shipping:'30'}));
  saveFreight(s,input({channel:'sf',entry_mode:'single',period:'2026-09-15',shop_id:'tb-diankou',shipping:'25',pieces:1}));
  saveFreight(s,input({channel:'sf',entry_mode:'single',period:'2026-09-16',shipping:'35',pieces:1}));
  const r=freightReport(s,q());assert.equal(r.totals.total,22125);assert.equal(r.totals.shipping,21025);assert.equal(r.totals.extras,1100);assert.equal(r.totals.count,5);assert.equal(r.totals.pieces,null);assert.equal(r.totals.average,null);
  assert.equal(freightReport(s,q({shop:'shared'})).totals.total,14625);
  assert.equal(freightReport(s,q({shop:'tb-diankou'})).totals.total,4500);
  assert.equal(r.by_shop.find(x=>x.shop_id==='tb-xishi').total,3000);
  assert.equal(r.by_shop.find(x=>x.shop_id==='ozon').total,null);
  assert.deepEqual(report(s,q()),before);
});

test('freight monthly bills do not become daily expenses, annual totals and missing differ from zero',t=>{
  const s=setup(t);saveFreight(s,input());
  reviewSave(s,input({entry_mode:'day',period:'2026-09-15',shipping:'12'}));
  reviewSave(s,input({entry_mode:'single',period:'2026-09-15',shipping:'3'}));
  saveFreight(s,input({period:'2026-10',shipping:'50'}));
  saveFreight(s,input({period:'2026-08',shipping:'0'}));
  const day=freightReport(s,q({grain:'day',period:'2026-09-15'}));assert.equal(day.totals.total,1500);assert.equal(day.monthly_unallocated.total,10025);assert.equal(day.trend[0].total,null);assert.equal(day.trend[14].total,1500);
  assert.equal(freightReport(s,q({grain:'year',period:'2026'})).totals.total,16525);
  assert.equal(freightReport(s,q({period:'2026-08'})).totals.total,0);
  assert.equal(freightReport(s,q({period:'2026-07'})).totals.total,null);
  assert.equal(freightRows(s,q({grain:'day',period:'2026-09-15'})).rows.length,2);
});

test('freight retries are idempotent and overlap confirmation is bound to current contents',t=>{
  const s=setup(t),a=input(),one=saveFreight(s,a,[csv()]);
  assert.equal(saveFreight(s,a,[csv()]).id,one.id);assert.equal(s.get('SELECT COUNT(*) n FROM freight_records').n,1);assert.equal(readdirSync(path.join(s.dir,'originals')).length,1);
  assert.throws(()=>saveFreight(s,{...a,shipping:'200'},[csv()]),e=>e.code==='REQUEST_REUSED');
  const day=input({entry_mode:'single',period:'2026-09-20'});let conflict;
  assert.throws(()=>saveFreight(s,day),e=>{conflict=e.details;return e.code==='FREIGHT_REVIEW'&&e.details.conflicts[0].id===one.id;});
  assert.throws(()=>saveFreight(s,{...day,shipping:'1',review_token:conflict.review_token}),e=>e.code==='FREIGHT_REVIEW');
  const two=saveFreight(s,{...day,review_token:conflict.review_token});assert.notEqual(two.id,one.id);
  assert.equal(JSON.parse(s.get("SELECT details FROM audit WHERE entity_id=? AND action='freight.create'",two.id).details).review.confirmation,'本笔不包含已登记费用');
});

test('freight rejects invalid scope, amounts, dates, other fees, attachment counts/types/size',t=>{
  const s=setup(t);
  for(const value of [{channel:'merchant'},{shop_id:'tb-diankou'},{channel:'sf',shop_id:'missing'},{shipping:'-1'},{shipping:'1.001'},{period:'2026-13'},{entry_mode:'day',period:'2026-02-30'},{other:'2'},{channel:'sf',packing:'1'},{pieces:'1.5'}])assert.throws(()=>saveFreight(s,input(value)));
  assert.throws(()=>saveFreight(s,input(),[csv('bad.html')]),/凭证支持/);
  assert.throws(()=>saveFreight(s,input(),[csv('bad.pdf')]),/内容与文件类型/);
  assert.throws(()=>saveFreight(s,input(),Array.from({length:6},()=>csv())),/最多/);
  assert.throws(()=>saveFreight(s,input(),[{originalname:'large.csv',buffer:Buffer.alloc(25*1024*1024+1)}]),/25 MB/);
  assert.throws(()=>saveFreight(s,input(),Array.from({length:3},(_,i)=>({originalname:i+'.csv',buffer:Buffer.alloc(18*1024*1024)}))),/50 MB/);
  assert.equal(s.get('SELECT COUNT(*) n FROM freight_records').n,0);assert.equal(readdirSync(path.join(s.dir,'originals')).length,0);
  assert.throws(()=>freightList(s,q({page_size:'10000'})),/分页/);
});

test('freight edit, stale edits, soft void and attachment history retain originals',t=>{
  const s=setup(t),one=saveFreight(s,input(),[csv()]);
  const edit=input({shipping:'120',version:one.version,remove_attachments:JSON.stringify([one.attachments[0].id])});
  const two=saveFreight(s,edit,[csv('second.csv')],one.id);
  assert.equal(two.version,2);assert.equal(two.attachments.length,1);assert.equal(two.attachment_history.length,1);
  assert.equal(saveFreight(s,edit,[csv('second.csv')],one.id).version,2);
  assert.throws(()=>saveFreight(s,input({version:1}),[],one.id),e=>e.code==='STALE_RECORD');
  const voidInput={reason:'重复登记',version:2,request_id:id()};voidFreight(s,one.id,voidInput);assert.equal(voidFreight(s,one.id,voidInput).ok,true);
  assert.equal(freightReport(s,q()).totals.total,null);assert.equal(freightRows(s,q({status:'all'})).rows.length,1);
  assert.equal(freightRecord(s,one.id).void_reason,'重复登记');assert.ok(existsSync(freightAttachment(s,one.attachments[0].id).absolute));
  assert.throws(()=>saveFreight(s,input({version:3}),[],one.id),/作废/);
  assert.equal(s.get("SELECT COUNT(*) n FROM audit WHERE action LIKE 'freight.%'").n,3);
});

test('freight participates in revision and SQL month locks including attachment changes and month moves',async t=>{
  const s=setup(t),stale=closePreview(s,'2026-09'),one=saveFreight(s,input(),[csv()]);
  await assert.rejects(lockMonth(s,{month:'2026-09',revision:stale.revision,confirmation:'锁定 2026-09'}),/变化/);
  const p=closePreview(s,'2026-09');assert.equal(p.freight.total,10025);
  await lockMonth(s,{month:'2026-09',revision:p.revision,confirmation:'锁定 2026-09'});
  const before=freightReport(s,q());assert.equal(before.locked,true);
  assert.throws(()=>s.run('UPDATE freight_records SET period=?,month=? WHERE id=?','2026-10','2026-10',one.id),/MONTH_LOCKED/);
  assert.throws(()=>s.run('DELETE FROM freight_records WHERE id=?',one.id),/MONTH_LOCKED/);
  assert.throws(()=>s.run('UPDATE freight_attachments SET removed_at=? WHERE id=?','now',one.attachments[0].id),/MONTH_LOCKED/);
  assert.throws(()=>saveFreight(s,input()),/锁定/);
  assert.throws(()=>voidFreight(s,one.id,{reason:'test',version:1,request_id:id()}),/锁定/);
  const later=saveFreight(s,input({period:'2026-10'}));
  assert.throws(()=>saveFreight(s,input({version:1}),[],later.id),/锁定/);
  assert.deepEqual(freightReport(s,q()),before);
  await unlockMonth(s,{month:'2026-09',reason:'补充凭证',confirmation:'解锁 2026-09'});
  saveFreight(s,input({version:1,shipping:'111'}),[],one.id);assert.equal(freightReport(s,q()).totals.total,11100);
});

test('older locked snapshots report freight as unrecorded without rewriting history',t=>{
  const s=setup(t);s.run('INSERT INTO month_locks VALUES(?,?,?,?)','2026-08','old',JSON.stringify({month:'2026-08',shops:s.shops(),operations:[],ledger:[],matches:[],coverage:[],rates:[]}),'2026-09-01');
  const result=freightReport(s,q({period:'2026-08'}));assert.deepEqual(result.legacy_months,['2026-08']);assert.equal(result.totals.total,null);assert.equal(freightRows(s,q({period:'2026-08'})).rows.length,0);
});

test('freight backup restores active/removed/void attachments and filtered export includes every row',async t=>{
  const s=setup(t),one=saveFreight(s,input(),[csv()]);
  saveFreight(s,input({version:1,remove_attachments:[one.attachments[0].id]}),[csv('new.csv')],one.id);
  voidFreight(s,one.id,{version:2,reason:'作废测试',request_id:id()});
  for(let i=1;i<=28;i++)saveFreight(s,input({channel:'sf',entry_mode:'single',period:'2026-09-'+String(i).padStart(2,'0'),shop_id:'tb-xishi',shipping:'1.25',tracking_no:'012345678901234567890'+i}));
  assert.equal(freightList(s,q({shop:'tb-xishi'})).rows.length,25);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await exportFreight(s,q({shop:'tb-xishi'})));
  const sheet=workbook.getWorksheet('运费明细');assert.equal(sheet.rowCount,29);assert.equal(typeof sheet.getCell('N2').value,'string');assert.ok(sheet.getCell('N2').value.startsWith('01234567890'));assert.equal(sheet.getCell('K2').value,1.25);
  const backup=await makeBackup(s,'freight-test');assert.equal(verifyBackup(s,backup.name).ok,true);
  const dest=path.join(s.dir,'restored');restoreBackup(s,backup.name,dest);const copy=openStore(dest);try{const r=freightRecord(copy,one.id);assert.equal(r.status,'void');assert.equal(r.attachment_history.length,1);assert.equal(readFileSync(freightAttachment(copy,one.attachments[0].id).absolute,'utf8'),csv().buffer.toString());assert.deepEqual(freightReport(copy,q()),freightReport(s,q()));}finally{copy.close();}
});

test('freight HTTP mutations require token; multipart, review response, details and Excel work',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'sales-freight-test-'));const {app,store}=createApp({dataDir:dir,port:18862,demo:true});
  const server=app.listen(18862,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sales-freight-test-'));rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const fetch=await createSessionFetch(base,'boss');
  const boot=await (await fetch(base+'/api/bootstrap')).json();
  const headers={'x-sales-token':boot.token};
  const denied=await fetch(base+'/api/freight/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input())});assert.equal(denied.status,403);
  const form=new FormData();for(const [key,value]of Object.entries(input({bill_no:'00012345678901234567890'})))form.set(key,value);form.append('files',new Blob(['bill,amount\ncloud,100.25'],{type:'text/csv'}),'运费凭证.csv');
  const added=await fetch(base+'/api/freight/records',{method:'POST',headers,body:form});assert.equal(added.status,200);const record=await added.json();assert.equal(record.attachments.length,1);assert.equal(record.attachments[0].filename,'运费凭证.csv');
  assert.equal((await fetch(base+record.attachments[0].url,{headers})).status,200);
  const conflict=await fetch(base+'/api/freight/records',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(input())});assert.equal(conflict.status,409);const error=await conflict.json();assert.equal(error.code,'FREIGHT_REVIEW');assert.ok(error.details.review_token);
  const reportResult=await (await fetch(base+'/api/freight/report?period=2026-09',{headers})).json();assert.equal(reportResult.totals.total,10025);
  const exported=await fetch(base+'/api/freight/export?period=2026-09',{headers});assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/freight-2026-09.xlsx/);const wb=new ExcelJS.Workbook();await wb.xlsx.load(await exported.arrayBuffer());assert.equal(wb.getWorksheet('运费明细').getCell('M2').value,'00012345678901234567890');
});
