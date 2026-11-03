import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {openStore} from '../lib/db.mjs';
import {createSalesCainiao} from '../lib/agent-cainiao.mjs';
import {classifyCainiaoMonth} from '../lib/agent-cainiao-classify.mjs';
import {saveFreight} from '../lib/freight.mjs';
import {bounds,beijing,shiftMonth,hash} from '../lib/util.mjs';
import {randomUUID} from 'node:crypto';

const historic=shiftMonth(beijing().month,-1);
const zip=async files=>{const archive=new JSZip();for(const [filename,bytes]of Object.entries(files))archive.file(filename,bytes);return archive.generateAsync({type:'nodebuffer'});};
async function xlsx(headers,rows){const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('官方明细');sheet.addRow(headers);rows.forEach(row=>sheet.addRow(row));return Buffer.from(await workbook.xlsx.writeBuffer());}
async function samples(period=historic,{to=bounds(period)[1],unknown=false,shipping='1000.00',currency='CNY',transactionDelta=0}={}){
 const from=period+'-01',suffix=from.replaceAll('-','')+'_'+to.replaceAll('-',''),date=from+' 12:00:00';
 const costs=[[unknown?'未知包装新费用':'正向配送费',shipping],['包装物料费','20.00'],['订单处理费','50.00'],['货值赔付','-100.00']];
 const details=await xlsx(['物流履约单号','费用项','计费金额','计费币种','业务时间'],costs.map(([name,amount],index)=>['0000000000000000000'+index,name,amount,currency,date]));
 const total=costs.reduce((sum,[,amount])=>sum+Math.round(Number(amount)*100),0),transactionAmounts=costs.map(([,amount])=>amount);transactionAmounts[0]=(Number(transactionAmounts[0])+transactionDelta/100).toFixed(2);
 const transactions=await xlsx(['交易单号','ERP单号','物流履约单号','运单号','单据类型','计费金额合计(CNY)'],costs.map((_,index)=>['0000000000000000000'+index,'ERP'+index,'L'+index,'W'+index,'费用',transactionAmounts[index]]));
 const goods=await xlsx(['物流履约单号','货品ID','货品件数'],[['L1','0000000000000000000000001',2]]);
 const summary=await xlsx(['费用项','主单行数量','计费金额'],costs.map(([name,amount])=>[name,1,amount]));
 return {period,from,to,total,feeNames:costs.map(([name])=>name),members:{transactions,details,goods},transactions:await zip({['交易账单_'+suffix+'.xlsx']:transactions,['计费明细_'+suffix+'.xlsx']:details,['货品信息_'+suffix+'.xlsx']:goods}),fees:await zip({['费用项汇总_'+suffix+'.xlsx']:summary,['计费明细_'+suffix+'.xlsx']:details}),expected:{transactions:{period,from,to,count:4,amountCents:total+transactionDelta},fees:{period,from,to,count:4,amountCents:total,feeNames:costs.map(([name])=>name)}}};
}
class FakeBrowser{
 constructor(dir,data){this.dir=path.join(dir,'fake-browser');fs.mkdirSync(this.dir,{recursive:true});this.data=data;this.tasks=[];this.submits=0;this.downloads=0;this.account='cn-isolated-fixture';this.available=true;this.connected=true;this.connections=0;this.disconnections=0;}
 status(){return {status:this.connected?'connected':'disconnected',account:this.connected?this.account:''};}async connect(){this.connected=true;this.connections++;return this.status();}async disconnect(){this.connected=false;this.disconnections++;}
 async run(operation,args){
  if(!this.connected)throw Error('connect: FakeBrowser已断开');
  if(operation==='prepare')return {...this.data.expected[args.type]||{period:args.month,count:0,amountCents:0},from:this.wrongRange?'2000-01-01':args.from,to:args.to};
  if(operation==='tasks')return this.tasks.map(task=>({...task,status:this.available?'已完成':'生成中'}));
  if(operation==='submit'){
   if(args.type==='warehouse')return {unavailable:true,reason:'仓储货品报表无单独可用导出，费用已在计费明细中'};
   this.submits++;this.tasks.push({id:String(this.submits),account:this.account,basis:'业务时间',name:'交易明细账单_'+args.from.replaceAll('-','')+'_'+args.to.replaceAll('-',''),type:args.type,status:'已完成'});
   if(this.uncertain){this.uncertain=false;throw Error('UNCERTAIN:提交返回前连接断开');}return {submitted:true};
  }
  if(operation==='download'){this.downloads++;await this.beforeDownload?.(args);fs.writeFileSync(args.target,this.data[args.task.type]);return {filename:args.task.type+'_'+this.data.from.replaceAll('-','')+'_'+this.data.to.replaceAll('-','')+'.zip'};}
  throw Error('unexpected operation '+operation);
 }
}
function fixture(t,data){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-agent-cainiao-')),store=openStore(dir),browser=new FakeBrowser(dir,data),api=createSalesCainiao({store,browser,pollMs:1,waitMs:1});t.after(async()=>{await api.close();store.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'sales-agent-cainiao-'));fs.rmSync(resolved,{recursive:true,force:true});});return {dir,store,browser,api};}
async function download(f,input={}){const out=await f.api.prepare('sales.cainiao-download-start',{from:f.browser.data.period,account:f.browser.account,...input},{taskId:'fixture-task'});await f.api.manager.running;return f.api.manager.get(out.blocks[0].rows[0].id);}
const business=s=>hash(['freight_records','freight_attachments','freight_requests','ledger','operations','matches','coverage','shops','month_locks','audit'].map(name=>[name,s.all('SELECT * FROM '+name)]));

test('真实ZIP/XLSX：自动下载、原件归档、费用分类和可人审运费草稿完整链路',async t=>{
 const data=await samples(),f=fixture(t,data),before=business(f.store),job=await download(f);assert.equal(job.status,'completed');assert.equal(f.browser.submits,2);
 const result=await f.api.preview({jobId:job.id,month:historic});assert.equal(result.ready,true,JSON.stringify(result.issues));assert.deepEqual(result.fees,{shipping:100000,packing:0,materials:2000,storage:0,other:-5000});assert.equal(result.total,97000);assert.equal(result.transactionTotal,result.detailTotal);assert.equal(result.uploads.length,3);assert.match(result.freightInput.other_note,/订单处理费 50.00元；货值赔付 -100.00元/);assert.equal(result.freightInput.bill_no,'CAINIAO-BIZ-'+historic);assert.equal(result.freightInput.shop_id,'shared');assert.equal(result.freightInput.pieces,undefined);assert.equal(result.postingAction,'create');assert.equal(business(f.store),before,'下载/分类/preview不得改变正式业务表');
 assert.ok(fs.existsSync(path.join(f.dir,'downloads','cainiao',job.accountKey,historic,job.id,'manifest.json')));for(const upload of result.uploads)assert.equal(hash(Buffer.from(upload.dataBase64,'base64')),upload.sha256);
 const visible=await f.api.query('sales.cainiao-preview',{jobId:job.id,month:historic});assert.equal(visible.uploads,undefined);assert.equal(visible.freightInput,undefined);assert.doesNotMatch(JSON.stringify(visible),/dataBase64/);
 const source=f.api.manager.files(job)[0];assert.equal(source.capabilityId,'sales.cainiao-file');assert.equal(source.fileId,source.id);assert.equal(source.url,undefined);assert.doesNotMatch(JSON.stringify(f.api.manager.files(job)),/\/api\/cainiao\/files\//);const raw=await f.api.query(source.capabilityId,{fileId:source.fileId});assert.equal(hash(raw.bytes),source.sha256);assert.equal(raw.mime,'application/zip');
 // Simulates the owning Agent's human-approved freight save, not an automatic downloader write.
 const saved=saveFreight(f.store,result.freightInput,result.uploads.map(upload=>({originalname:upload.filename,buffer:Buffer.from(upload.dataBase64,'base64')})));assert.equal(saved.total,97000);assert.equal(saved.attachments.length,3);assert.equal(saved.other,-5000);
 const duplicate=await f.api.preview({jobId:job.id,month:historic});assert.equal(duplicate.ready,false);assert.equal(duplicate.postingAction,'skip');assert.ok(duplicate.issues.some(item=>item.code==='DUPLICATE_SOURCE'));
});

test('未知费用、负快递费、非CNY、金额精度和净额不平均阻断，原件仍归档',async t=>{
 for(const [options,code]of [[{unknown:true},'UNKNOWN_FEE'],[{shipping:'-1.00'},'NEGATIVE_FEE_UNSUPPORTED'],[{currency:'USD'},'CURRENCY_UNSUPPORTED'],[{shipping:'1.001'},'AMOUNT_INVALID'],[{transactionDelta:1},'TOTAL_MISMATCH']]){
  await t.test(code,async child=>{const f=fixture(child,await samples(historic,options)),before=business(f.store),job=await download(f),result=await f.api.preview({jobId:job.id,month:historic});assert.equal(result.ready,false);assert.ok(result.issues.some(item=>item.code===code),JSON.stringify(result.issues));assert.ok(f.api.manager.files(job).length>=2);assert.equal(business(f.store),before);});
 }
});

test('月份锁定、原件被改动、页面实际日期不符均不能进入入账草稿',async t=>{
 const f=fixture(t,await samples()),job=await download(f);f.store.run('INSERT INTO month_locks VALUES(?,?,?,?)',historic,'fixture','{}',new Date().toISOString());const locked=await f.api.preview({jobId:job.id,month:historic});assert.ok(locked.issues.some(item=>item.code==='MONTH_LOCKED'));f.store.run('DELETE FROM month_locks WHERE month=?',historic);
 const source=f.api.manager.files(job)[0];fs.writeFileSync(path.join(f.dir,source.path),Buffer.from('tampered'));const changed=await f.api.preview({jobId:job.id,month:historic});assert.ok(changed.issues.some(item=>item.code==='ARCHIVE_CHANGED'));assert.throws(()=>f.api.file(source.id),/校验失败/);
 f.browser.wrongRange=true;const invalid=await download(f,{force:true});assert.equal(invalid.items[0].status,'failed');assert.match(invalid.items[0].error,/实际查询日期/);
});

test('运行中停止保留已下载原件，恢复继续；提交不明先找旧任务避免重下',async t=>{
 const f=fixture(t,await samples());let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});f.browser.beforeDownload=async()=>{enter();await held;};
 const started=await f.api.prepare('sales.cainiao-download-start',{from:historic,account:f.browser.account}),jobId=started.blocks[0].rows[0].id;await entered;await f.api.prepare('sales.cainiao-download-stop',{jobId});release();await f.api.manager.running;assert.equal(f.api.manager.get(jobId).status,'cancelled');assert.equal(f.api.manager.files(f.api.manager.get(jobId)).length,1);
 f.browser.beforeDownload=null;await f.api.prepare('sales.cainiao-download-resume',{jobId});await f.api.manager.running;assert.equal(f.api.manager.get(jobId).status,'completed');assert.equal(f.browser.submits,2);
 f.browser.uncertain=true;const uncertain=await download(f,{force:true});assert.equal(uncertain.status,'paused');const count=f.browser.submits;await f.api.prepare('sales.cainiao-download-resume',{jobId:uncertain.id});await f.api.manager.running;assert.equal(f.api.manager.get(uncertain.id).status,'completed');assert.equal(f.browser.submits,count+1,'仅为尚未提交的费用报表生成一个任务');
});

test('当前月必须保存截止日且最多到北京昨天，分类要求截止范围一致',async t=>{
 const current=beijing(),yesterday=beijing(new Date(Date.now()-86400000)).date;if(yesterday.slice(0,7)!==current.month){t.skip('本月第一天，平台尚无可查询的本月截止日');return;}
 const data=await samples(current.month,{to:yesterday}),f=fixture(t,data);
 await assert.rejects(f.api.prepare('sales.cainiao-download-start',{from:current.month,account:f.browser.account}),/截止日/);
 await assert.rejects(f.api.prepare('sales.cainiao-download-start',{from:current.month,account:f.browser.account,cutoff:current.date}),/北京时间昨天/);
 const job=await download(f,{cutoff:yesterday}),result=await f.api.preview({jobId:job.id,month:current.month});assert.equal(result.ready,true,JSON.stringify(result.issues));assert.equal(result.cutoff,yesterday);assert.equal(result.interim,true);assert.match(result.freightInput.note,/未结月/);assert.equal(job.items[0].expected.to,yesterday);
 const invalid=await f.api.preview({jobId:job.id,month:current.month,cutoff:current.date});assert.ok(invalid.issues.some(item=>item.code==='CUTOFF_CHANGED'));
});

test('未结月只更新已核实同源记录，保留ID/version与旧附件历史，缩小范围阻断',async t=>{
 const current=beijing(),yesterday=beijing(new Date(Date.now()-86400000)).date,first=current.month+'-01';if(yesterday<=first){t.skip('当前月尚无两个可验证的截止范围');return;}
 const f=fixture(t,await samples(current.month,{to:first})),oldJob=await download(f,{cutoff:first}),oldPreview=await f.api.preview({jobId:oldJob.id,month:current.month});assert.equal(oldPreview.ready,true,JSON.stringify(oldPreview.issues));
 const old=saveFreight(f.store,oldPreview.freightInput,oldPreview.uploads.map(upload=>({originalname:upload.filename,buffer:Buffer.from(upload.dataBase64,'base64')})));
 f.browser.data=await samples(current.month,{to:yesterday,shipping:'1100.00'});const newJob=await download(f,{cutoff:yesterday}),preview=await f.api.preview({jobId:newJob.id,month:current.month});assert.equal(preview.ready,true,JSON.stringify(preview.issues));assert.equal(preview.postingAction,'update');assert.equal(preview.recordId,old.id);assert.equal(preview.freightInput.version,1);assert.equal(JSON.parse(preview.freightInput.remove_attachments).length,3);
 const updated=saveFreight(f.store,preview.freightInput,preview.uploads.map(upload=>({originalname:upload.filename,buffer:Buffer.from(upload.dataBase64,'base64')})),preview.recordId);assert.equal(updated.id,old.id);assert.equal(updated.version,2);assert.equal(updated.total,107000);assert.equal(updated.attachments.length,3);assert.equal(updated.attachment_history.length,3);
 const shrink=await f.api.preview({jobId:oldJob.id,month:current.month});assert.equal(shrink.ready,false);assert.ok(shrink.issues.some(item=>item.code==='COVERAGE_SHRINK'));
});

test('任意已验证历史月启用多月，不硬编码2026-09；ZIP路径及缺分卷阻断',async t=>{
 const f=fixture(t,await samples());assert.equal(f.api.manager.multiMonthReady(),false);const job=await download(f);assert.equal(f.api.manager.multiMonthReady(),true);assert.equal(job.months[0],historic);
 const hostile=await zip({'../原件.xlsx':f.browser.data.members.details});await assert.rejects((await import('../lib/agent-cainiao-classify.mjs')).readCainiaoDocuments(hostile,'坏.zip'),/路径无效/);
 const insufficient=await classifyCainiaoMonth({month:historic,files:[{filename:'不完整_'+f.browser.data.from.replaceAll('-','')+'_'+f.browser.data.to.replaceAll('-','')+'.xlsx',buffer:f.browser.data.members.details,report:'transactions',expected:f.browser.data.expected.transactions}]});assert.ok(insufficient.issues.some(item=>item.code==='TRANSACTIONS_MISSING'));assert.ok(insufficient.issues.some(item=>item.code==='GOODS_EVIDENCE_MISSING'));
});

test('真实签名HTTP：后台下载→原件预览→中央人审→入账/附件SHA/回执重放；无审批与重复均拒绝',async t=>{
 const [{createApp},{signWorkbenchActor},{signAgentApproval,agentDigest,approvalHeaders}]=await Promise.all([import('../server.mjs'),import('../lib/workbench-actor.mjs'),import('../lib/agent-approval.mjs')]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-agent-cainiao-http-')),browser=new FakeBrowser(dir,await samples()),app=createApp({dataDir:dir,port:0,demo:true,cainiaoBrowser:browser,cainiaoOptions:{pollMs:1,waitMs:1}}),server=app.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await app.cainiao.close();await new Promise(resolve=>server.close(resolve));app.store.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'sales-agent-cainiao-http-'));fs.rmSync(resolved,{recursive:true,force:true});});
 const key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim(),base='http://127.0.0.1:'+server.address().port;
 const call=(route,{method='GET',body,headers={}}={})=>{const url='/api/integration/v1/agent/'+route,issuedAt=Date.now();return fetch(base+url,{method,headers:{...signWorkbenchActor({v:1,id:'cainiao-owner',login:'cainiao-owner',role:'admin',channel:'mcp',modules:['sales'],module:'sales',canRunTasks:true,sessionId:'cainiao-http-session',requestId:randomUUID(),issuedAt,expiresAt:issuedAt+60000,method,path:url},key),'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});};
 const query=(capabilityId,input)=>call('query?'+new URLSearchParams({capabilityId,input:JSON.stringify(input)}));
 const prepare=async(capabilityId,input)=>{const binding=await(await call('binding')).json(),response=await call('prepare',{method:'POST',body:{taskId:'cainiao-http-task',capabilityId,input}});assert.equal(response.status,200,await response.clone().text());return {binding,capabilityId,input,...await response.json()};};
 const signedCommit=(prepared,idempotencyKey)=>{const issuedAt=Date.now(),proof=signAgentApproval({v:1,approvalId:'cainiao-real-http-review',actorId:'cainiao-owner',module:'sales',capabilityId:prepared.capabilityId,taskId:'cainiao-http-task',resultId:'cainiao-result',resultVersion:1,...prepared.binding,changeDigest:agentDigest({capabilityId:prepared.capabilityId,input:prepared.input,commitData:prepared.commitData,changes:prepared.changes}),idempotencyKey,issuedAt,expiresAt:issuedAt+60000},key);return call('commit',{method:'POST',body:{prepared},headers:{'Idempotency-Key':idempotencyKey,...approvalHeaders(proof)}});};
 const before=business(app.store);
 let response=await query('sales.cainiao-status',{});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).status,'connected');
 const disconnected=await prepare('sales.cainiao-disconnect',{});assert.equal(disconnected.commitData,undefined);assert.equal(disconnected.blocks[0].rows[0].status,'disconnected');assert.equal(browser.disconnections,1);
 response=await query('sales.cainiao-status',{});assert.equal(response.status,200);assert.equal((await response.json()).status,'disconnected');
 const connected=await prepare('sales.cainiao-connect',{});assert.equal(connected.commitData,undefined);assert.equal(connected.blocks[0].rows[0].status,'connected');assert.equal(browser.connections,1);
 const started=await prepare('sales.cainiao-download-start',{from:historic,account:browser.account}),jobId=started.blocks[0].rows[0].id;assert.equal(started.commitData,undefined);await app.cainiao.manager.running;
 response=await query('sales.cainiao-jobs',{});assert.equal(response.status,200,await response.clone().text());const jobs=await response.json();assert.ok(jobs.data.some(job=>job.id===jobId&&job.status==='completed'));
 response=await query('sales.cainiao-job',{jobId});assert.equal(response.status,200,await response.clone().text());const job=await response.json();assert.equal(job.status,'completed');assert.ok(job.files.length>=2);assert.ok(job.files.every(file=>file.capabilityId==='sales.cainiao-file'&&file.fileId===file.id&&file.url===undefined));assert.doesNotMatch(JSON.stringify(job),/\/api\/cainiao\/files\//);
 response=await query('sales.cainiao-preview',{jobId,month:historic});assert.equal(response.status,200,await response.clone().text());const preview=await response.json();assert.equal(preview.ready,true,JSON.stringify(preview.issues));assert.equal(preview.total,97000);assert.equal(preview.uploads,undefined);assert.doesNotMatch(JSON.stringify(preview),/dataBase64/);
 response=await query(job.files[0].capabilityId,{fileId:job.files[0].fileId});assert.equal(response.status,200,await response.clone().text());const original=(await response.json()).artifact;response=await call('files/'+original.id);assert.equal(hash(Buffer.from(await response.arrayBuffer())),job.files[0].sha256);
 const prepared=await prepare('sales.cainiao-posting',{jobId,month:historic});assert.equal(prepared.issues.length,0);assert.equal(prepared.changes[0].operation,'freight-create');assert.doesNotMatch(JSON.stringify(prepared),/dataBase64/);assert.equal(business(app.store),before,'后台下载、查询和人审准备不能提前入账');
 response=await call('commit',{method:'POST',body:{prepared},headers:{'Idempotency-Key':'cainiao-posted-once'}});assert.equal(response.status,403);assert.equal(app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);
 response=await signedCommit(prepared,'cainiao-posted-once');assert.equal(response.status,200,await response.clone().text());const booked=await response.json(),record=booked.receipt.result;assert.equal(record.total,97000);assert.equal(record.other,-5000);assert.equal(record.attachments.length,3);assert.equal(booked.receipt.verification.ok,true);
 for(const attachment of record.attachments){response=await query('sales.freight-attachment',{id:attachment.id});assert.equal(response.status,200);const artifact=(await response.json()).artifact;response=await call('files/'+artifact.id);assert.equal(hash(Buffer.from(await response.arrayBuffer())),attachment.sha256);assert.ok(preview.attachments.some(source=>source.sha256===attachment.sha256));}
 response=await signedCommit(prepared,'cainiao-posted-once');assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),booked);assert.equal(app.store.get('SELECT COUNT(*) n FROM freight_records').n,1);
 response=await call('receipts/cainiao-posted-once');assert.equal((await response.json()).receipt.id,booked.receipt.id);
 const duplicate=await prepare('sales.cainiao-posting',{jobId,month:historic});assert.ok(duplicate.issues.some(item=>item.code==='DUPLICATE_SOURCE'));response=await signedCommit(duplicate,'cainiao-must-not-duplicate');assert.equal(response.status,409);assert.equal(app.store.get('SELECT COUNT(*) n FROM freight_records').n,1);
 const current=beijing(),yesterday=beijing(new Date(Date.now()-86400000)).date;
 await t.test('FakeBrowser边界：当前月cutoff/cutoffs经签名HTTP成功下载，真实manager保存并回读北京昨天范围',{skip:yesterday.slice(0,7)!==current.month?'本月第一天尚无本月可用截止日':false},async()=>{
  browser.data=await samples(current.month,{to:yesterday});const beforeCurrent=business(app.store);
  for(const extra of [{cutoff:yesterday},{cutoffs:{[current.month]:yesterday}}]){
   const preparedDownload=await prepare('sales.cainiao-download-start',{from:current.month,account:browser.account,...extra}),currentJobId=preparedDownload.blocks[0].rows[0].id;assert.equal(preparedDownload.commitData,undefined);await app.cainiao.manager.running;
   response=await query('sales.cainiao-job',{jobId:currentJobId});assert.equal(response.status,200,await response.clone().text());const currentJob=await response.json();assert.equal(currentJob.status,'completed');assert.equal(currentJob.cutoffs[current.month],yesterday);assert.ok(currentJob.items.filter(item=>item.type!=='warehouse').every(item=>item.expected.from===current.month+'-01'&&item.expected.to===yesterday));
   response=await query('sales.cainiao-preview',{jobId:currentJobId,month:current.month});assert.equal(response.status,200,await response.clone().text());const currentPreview=await response.json();assert.equal(currentPreview.ready,true,JSON.stringify(currentPreview.issues));assert.equal(currentPreview.interim,true);assert.equal(currentPreview.cutoff,yesterday);assert.equal(business(app.store),beforeCurrent,'当前月下载和分类不自动入账');
  }
 });
});
