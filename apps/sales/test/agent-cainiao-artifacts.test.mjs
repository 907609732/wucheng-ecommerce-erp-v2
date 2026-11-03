import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {openStore} from '../lib/db.mjs';
import {prepareArchivedFreight} from '../lib/agent-cainiao-artifacts.mjs';
import {saveFreight} from '../lib/freight.mjs';
import {hash,bounds} from '../lib/util.mjs';

// Intentionally deterministic fixtures: no browser, account session, download job
// or central-review bypass is needed to exercise this server-private bridge.
const now=new Date('2026-10-29T04:00:00Z'),historical='2026-09';
async function workbook(headers,rows){const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('官方原件');sheet.addRow(headers);for(const row of rows)sheet.addRow(row);return Buffer.from(await book.xlsx.writeBuffer());}
async function zip(files){const archive=new JSZip();for(const [name,buffer]of Object.entries(files))archive.file(name,buffer);return archive.generateAsync({type:'nodebuffer'});}
async function originals(month=historical,{to=bounds(month)[1],shipping='1000.00',currency='CNY',unknown=false,transactionDelta=0,businessDate=month+'-01',bare=false}={}){
 const from=month+'-01',suffix=from.replaceAll('-','')+'_'+to.replaceAll('-','');
 const costs=[[unknown?'未经验证的新费用':'正向配送费',shipping],['包装物料费','20.00'],['订单处理费','50.00'],['货值赔付','-100.00']];
 const total=costs.reduce((sum,[,amount])=>sum+Math.round(Number(amount)*100),0);
 const transactionValues=costs.map(([,amount])=>amount);transactionValues[0]=(Number(transactionValues[0])+transactionDelta/100).toFixed(2);
 const transactions=await workbook(['交易单号','物流履约单号','计费金额合计(CNY)'],costs.map((_,index)=>['000000000000000000'+index,'L'+index,transactionValues[index]]));
 const details=await workbook(['物流履约单号','费用项','计费金额','计费币种','业务时间'],costs.map(([name,amount],index)=>['L'+index,name,amount,currency,businessDate+' 12:00:00']));
 const goods=await workbook(['物流履约单号','货品ID','货品件数'],[['L0','000000000000000001',2]]);
 const fees=await workbook(['费用项','主单行数量','计费金额'],costs.map(([name,amount])=>[name,1,amount]));
 const names={transactions:'交易账单_'+suffix+'.xlsx',details:'计费明细_'+suffix+'.xlsx',goods:'货品信息_'+suffix+'.xlsx',fees:'费用项汇总_'+suffix+'.xlsx'};
 const batches=bare?[
  {report:'transactions',filename:names.transactions,buffer:transactions},{report:'transactions',filename:names.details,buffer:details},{report:'transactions',filename:names.goods,buffer:goods},{report:'fees',filename:names.fees,buffer:fees}
 ]:[
  {report:'transactions',filename:'交易导出_'+suffix+'.zip',buffer:await zip({[names.transactions]:transactions,[names.details]:details,[names.goods]:goods})},
  {report:'fees',filename:'费用导出_'+suffix+'.zip',buffer:await zip({[names.fees]:fees,[names.details]:details})}
 ];
 const files=batches.map(file=>({...file,id:randomUUID(),artifactId:'overview-artifact-'+randomUUID(),sha256:hash(file.buffer),sourceModule:'overview',sourceCapabilityId:'overview.cainiao-file'}));
 const scope={account:'cn-trusted-fixture',from,to,files:files.map(({filename,sha256,report})=>({filename,sha256,report})),expected:{transactions:{period:month,from,to,count:4,amountCents:total+transactionDelta},fees:{period:month,from,to,count:4,amountCents:total,feeNames:costs.map(([name])=>name)}}};
 return {month,files,scope,now};
}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-cainiao-artifacts-')),store=openStore(dir);t.after(()=>{store.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'sales-cainiao-artifacts-'));fs.rmSync(resolved,{recursive:true,force:true});});return {dir,store};}
const prepare=(f,input)=>prepareArchivedFreight({store:f.store,...input});
const save=(f,preview)=>saveFreight(f.store,preview.freightInput,preview.uploads.map(file=>({originalname:file.filename,buffer:Buffer.from(file.dataBase64,'base64')})),preview.recordId);
const business=store=>hash(['freight_records','freight_attachments','freight_requests','ledger','operations','matches','coverage','shops','month_locks','jobs','audit'].map(table=>[table,store.all('SELECT * FROM '+table)]));
const contains=(result,code)=>assert.ok(result.issues.some(issue=>issue.code===code),JSON.stringify(result.issues));

test('可信overview原件组生成销售人审草稿，保留artifact到销售ID及不变业务表',async t=>{
 const f=fixture(t),input=await originals(),before=business(f.store),result=await prepare(f,input);
 assert.equal(result.ready,true,JSON.stringify(result.issues));assert.equal(result.postingAction,'create');assert.equal(result.recordId,null);
 assert.deepEqual(result.fees,{shipping:100000,packing:0,materials:2000,storage:0,other:-5000});assert.equal(result.total,97000);assert.equal(result.transactionTotal,result.detailTotal);
 assert.equal(result.uploads.length,3);assert.equal(result.freightInput.shipping,'1000.00');assert.equal(result.freightInput.other,'-50.00');assert.equal(result.freightInput.pieces,undefined);
 assert.match(result.freightInput.other_note,/订单处理费 50.00元；货值赔付 -100.00元/);assert.match(result.freightInput.note,/CAINIAO-ARCHIVE=[a-f0-9]{64}/);
 assert.equal(result.artifactMappings.length,2);for(const file of input.files){const mapping=result.artifactMappings.find(row=>row.artifactId===file.artifactId);assert.equal(mapping.fileId,file.id);assert.notEqual(mapping.fileId,file.artifactId);assert.equal(mapping.sha256,hash(file.buffer));}
 const root=path.join(f.dir,'downloads','cainiao-artifacts',input.month,result.sourceFingerprint),manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.artifactMappings,result.artifactMappings);assert.equal(hash(manifest),result.sourceFingerprint);
 for(const file of input.files)assert.equal(hash(fs.readFileSync(path.join(root,'sources',file.id+'.zip'))),file.sha256);
 for(const file of result.uploads)assert.equal(hash(Buffer.from(file.dataBase64,'base64')),file.sha256);
 assert.equal(business(f.store),before,'分析桥不写运费、审计或下载job');assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE name='sales_cainiao_jobs'"),undefined);
 const reordered=await prepare(f,{...input,files:[...input.files].reverse(),scope:{...input.scope,files:[...input.scope.files].reverse()}});assert.equal(reordered.sourceFingerprint,result.sourceFingerprint,'模型排列顺序不改变已核实内容');
});

test('缺少页面证据、来源stamp、原件、可信清单或SHA不符均阻断',async t=>{
 const cases=[
  ['PAGE_EVIDENCE_MISSING',input=>{delete input.scope.expected.fees;}],
  ['SOURCE_PROVENANCE_INVALID',input=>{input.files[0].sourceCapabilityId='overview.export';}],
  ['SOURCE_PROVENANCE_INVALID',input=>{input.files[0].sourceModule='sales';}],
  ['SOURCE_HASH_MISMATCH',input=>{input.files[0].buffer=Buffer.from('modified');}],
  ['SOURCE_FILES_MISSING',input=>{input.files.pop();}],
  ['SOURCE_MANIFEST_MISSING',input=>{delete input.scope.files;}],
  ['SOURCE_NOT_IN_MANIFEST',input=>{input.scope.files[0].sha256='0'.repeat(64);}],
  ['SOURCE_MANIFEST_AMBIGUOUS',input=>{input.scope.files.push({...input.scope.files[0]});}],
  ['DUPLICATE_ARTIFACT',input=>{input.files.push({...input.files[0]});}],
  ['SOURCE_REPORT_MISMATCH',input=>{input.scope.files[0].report='fees';}],
  ['PAGE_RANGE_MISMATCH',input=>{input.scope.expected.fees.to='2026-09-29';}],
  ['PAGE_COUNT_MISMATCH',input=>{input.scope.expected.fees.count=3;}],
  ['SALES_FILE_ID_REQUIRED',input=>{input.scope.files[0].fileId=input.files[0].id;}],
  ['EXPORT_NOT_VERIFIED',input=>{input.scope.expected.fees.verified=false;}]
 ];
 for(const [code,change]of cases)await t.test(code,async child=>{const f=fixture(child),input=await originals();change(input);const before=business(f.store),result=await prepare(f,input);assert.equal(result.ready,false);contains(result,code);assert.equal(business(f.store),before);assert.equal(fs.existsSync(path.join(f.dir,'downloads','cainiao-artifacts')),false,'阻断组不固化可入账来源清单');});
});

test('文件内容核对角色、金额精度、业务日期、币种、未知费用及净额',async t=>{
 const cases=[
  [{unknown:true},'UNKNOWN_FEE'],[{currency:'USD'},'CURRENCY_UNSUPPORTED'],[{shipping:'-1.00'},'NEGATIVE_FEE_UNSUPPORTED'],[{shipping:'1.001'},'AMOUNT_INVALID'],[{transactionDelta:1},'TOTAL_MISMATCH'],[{businessDate:'2026-08-31'},'BUSINESS_DATE_OUT_OF_RANGE']
 ];
 for(const [options,code]of cases)await t.test(code,async child=>{const f=fixture(child),result=await prepare(f,await originals(historical,options));assert.equal(result.ready,false);contains(result,code);});
 const f=fixture(t),input=await originals();input.scope.expected.transactions.amountCents=1;const wrong=await prepare(f,input);assert.equal(wrong.ready,false);contains(wrong,'PAGE_TOTAL_MISMATCH');assert.equal(wrong.total,97000,'可信页面差异不能替换原件计算金额');
});

test('完整独立XLSX组也按实际表头核对，不能凭manifest角色伪装原件',async t=>{
 const f=fixture(t),input=await originals(historical,{bare:true}),result=await prepare(f,input);assert.equal(result.ready,true,JSON.stringify(result.issues));assert.equal(result.uploads.length,3);
 const impostor=await originals(historical,{bare:true});impostor.scope.files[0].report='fees';impostor.files[0].report='fees';const invalid=await prepare(f,impostor);assert.equal(invalid.ready,false);contains(invalid,'SOURCE_REPORT_MISMATCH');
});

test('当前月截止日最多到北京昨天，历史月份必须完整覆盖，月份锁定阻断',async t=>{
 const f=fixture(t),current=await originals('2026-10',{to:'2026-10-28'}),preview=await prepare(f,current);assert.equal(preview.ready,true,JSON.stringify(preview.issues));assert.equal(preview.cutoff,'2026-10-28');assert.equal(preview.interim,true);assert.match(preview.freightInput.note,/未结月/);
 const today=await prepare(f,await originals('2026-10',{to:'2026-10-29'}));assert.equal(today.ready,false);contains(today,'CUTOFF_INVALID');
 const incomplete=await prepare(f,await originals(historical,{to:'2026-09-29'}));assert.equal(incomplete.ready,false);contains(incomplete,'HISTORICAL_RANGE_INCOMPLETE');
 const invalidScope=await originals();invalidScope.scope.from='2026-09-02';const invalid=await prepare(f,invalidScope);contains(invalid,'SCOPE_RANGE_MISMATCH');assert.equal(invalid.ready,false);
 f.store.run('INSERT INTO month_locks VALUES(?,?,?,?)',historical,'fixture','{}',now.toISOString());const locked=await prepare(f,await originals());assert.equal(locked.ready,false);contains(locked,'MONTH_LOCKED');
});

test('同月同源同金额截止日跳过，重新stage及重新导出不能重复入账',async t=>{
 const f=fixture(t),first=await prepare(f,await originals()),saved=save(f,first),next=await prepare(f,await originals());
 assert.equal(next.ready,false);assert.equal(next.postingAction,'skip');contains(next,'DUPLICATE_SOURCE');assert.equal(next.issues.find(issue=>issue.code==='DUPLICATE_SOURCE').recordId,saved.id);assert.equal(f.store.all('SELECT * FROM freight_records').length,1);
 const changed=await prepare(f,await originals(historical,{shipping:'1100.00'}));assert.equal(changed.ready,false);contains(changed,'HISTORICAL_RECORD_CHANGED');
});

test('已有其他云仓月记录时不能把交接组直接新增或覆盖',async t=>{
 const f=fixture(t),first=await prepare(f,await originals());save(f,{...first,freightInput:{...first.freightInput,bill_no:'OTHER-WAREHOUSE-BILL'}});
 const result=await prepare(f,await originals());assert.equal(result.ready,false);contains(result,'OVERLAPPING_RECORDS');assert.equal(f.store.all('SELECT * FROM freight_records').length,1);
});

test('未结月仅更新可信同源且不缩小覆盖，保留记录版本和附件历史',async t=>{
 const f=fixture(t),firstInput=await originals('2026-10',{to:'2026-10-01'}),old=save(f,await prepare(f,firstInput));
 const nextInput=await originals('2026-10',{to:'2026-10-28',shipping:'1100.00'}),next=await prepare(f,nextInput);
 assert.equal(next.ready,true,JSON.stringify(next.issues));assert.equal(next.postingAction,'update');assert.equal(next.recordId,old.id);assert.equal(next.freightInput.version,1);assert.equal(JSON.parse(next.freightInput.remove_attachments).length,3);
 const updated=save(f,next);assert.equal(updated.id,old.id);assert.equal(updated.version,2);assert.equal(updated.total,107000);assert.equal(updated.attachments.length,3);assert.equal(updated.attachment_history.length,3);
 const shrink=await prepare(f,firstInput);assert.equal(shrink.ready,false);contains(shrink,'COVERAGE_SHRINK');
 const otherAccount=await originals('2026-10',{to:'2026-10-28',shipping:'1200.00'});otherAccount.scope.account='different-account';const foreign=await prepare(f,otherAccount);assert.equal(foreign.ready,false);contains(foreign,'EXISTING_SOURCE_UNVERIFIED');
});

test('旧来源清单、附件或人工猜测来源不可信时禁止自动更新',async t=>{
 for(const corrupt of ['manifest','attachment','legacy-note'])await t.test(corrupt,async child=>{
  const f=fixture(child),first=await prepare(f,await originals('2026-10',{to:'2026-10-01'}));let saved;
  if(corrupt==='legacy-note')saved=save(f,{...first,freightInput:{...first.freightInput,note:'菜鸟官方账单；业务时间 2026-10-01 至 2026-10-01；CAINIAO-CUTOFF=2026-10-01'}});
  else saved=save(f,first);
  if(corrupt==='manifest'){const file=path.join(f.dir,'downloads','cainiao-artifacts','2026-10',first.sourceFingerprint,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));manifest.account='modified';fs.writeFileSync(file,JSON.stringify(manifest));}
  if(corrupt==='attachment'){const attachment=f.store.get('SELECT * FROM freight_attachments WHERE record_id=?',saved.id);fs.writeFileSync(path.join(f.dir,attachment.original_path),Buffer.from('changed'));}
  const result=await prepare(f,await originals('2026-10',{to:'2026-10-28',shipping:'1100.00'}));assert.equal(result.ready,false);contains(result,'EXISTING_SOURCE_UNVERIFIED');assert.equal(f.store.get('SELECT version FROM freight_records WHERE id=?',saved.id).version,1);
 });
});
