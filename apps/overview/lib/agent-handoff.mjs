import fs from 'node:fs';
import {month,date,hash,fail} from './util.mjs';
import {resolveArchive,inspectBill,reconcile} from './cainiao-files.mjs';

// No browser or sales calls: hand off only already persisted, freshly rechecked archives.
export async function cainiaoHandoff({store,manager,input}){
 const jobId=input.jobId||input.id;if(input.jobId&&input.id&&input.jobId!==input.id)throw fail('任务编号不一致');
 const period=month(input.month),job=manager.get(jobId),issues=[],files=[],evidence=[];
 const block=(code,message,extra={})=>issues.push({code,message,blocking:true,...extra});
 if(typeof job.account!=='string'||!job.account||job.accountKey!==hash(job.account).slice(0,16))block('CAINIAO_ACCOUNT_UNVERIFIED','持久任务账户及账户摘要不一致');
 if(!job.months?.includes(period))block('CAINIAO_MONTH_OUTSIDE_JOB','所选月份不属于此持久下载任务');
 const items=(job.items||[]).filter(x=>x.month===period),archived=manager.files(job);
 const safeDate=value=>{if(typeof value!=='string')return null;try{return date(value);}catch{return null;}};
 const range=(item,record)=>{
  const expected=item.expected||{},scope=expected.scope||item.scope||job.ranges?.[period];
  let from=safeDate(scope?.from||scope?.start||expected.from),cutoff=safeDate(scope?.cutoff||scope?.to||scope?.end||expected.cutoff||expected.to);
  let basis='persisted-query-scope';const task=record.details?.task||item.remoteTask;
  const declared=task?.account===job.account&&task?.basis==='业务时间'&&String(task.name||'').match(/(20\d{6})_(20\d{6})/);
  if(from&&cutoff&&declared){const compact=value=>value.replaceAll('-','');if(compact(from)!==declared[1]||compact(cutoff)!==declared[2])return null;}
  if(!from||!cutoff){const match=task?.account===job.account&&task?.basis==='业务时间'&&String(task.name||'').match(/(20\d{6})_(20\d{6})/);if(match){const iso=v=>v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6);from=safeDate(iso(match[1]));cutoff=safeDate(iso(match[2]));basis='verified-platform-task-name';}}
  if(!from||!cutoff||from>cutoff||from.slice(0,7)!==period||cutoff.slice(0,7)!==period)return null;
  // An old current-month whole-month request is not proof of a real historical cutoff.
  if(job.interimMonths?.includes(period)){const created=Date.parse(job.createdAt);if(!Number.isFinite(created))return null;const yesterday=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(created-86400000));if(cutoff>yesterday)return null;}
  return {from,cutoff,basis,platformTaskId:task?.id||null};
 };
 for(const role of ['transactions','fees','warehouse']){
  const item=items.find(x=>x.type===role),required=role!=='warehouse';
  if(!item){if(required)block('CAINIAO_REPORT_MISSING','缺少交易或费用持久任务',{role});continue;}
  const records=archived.filter(f=>(item.fileIds||[]).includes(f.id));
  if(required&&records.length>1)block('CAINIAO_ARCHIVE_AMBIGUOUS','同一报表存在多份原件，不能猜测合计或重复关系',{role});
  if(required&&(item.status!=='completed'||item.verification?.verified!==true||!records.length))block('CAINIAO_REPORT_UNVERIFIED','交易或费用原件尚未完整核对',{role});
  if(required&&(!Number.isSafeInteger(item.expected?.count)||!Number.isSafeInteger(item.expected?.amountCents)||item.expected.period!==period))block('CAINIAO_EXPECTED_MISSING','缺少该月页面行数及金额核对依据',{role});
  for(const record of records){
   if(record.account_key!==job.accountKey||record.period!==period||record.report!==role){block('CAINIAO_ARCHIVE_BINDING','原件账户、月份或报表角色不一致',{fileId:record.id,role});continue;}
   try{
    const bytes=fs.readFileSync(resolveArchive(store.dir,record.path));if(bytes.length!==record.bytes||hash(bytes)!==record.sha256)throw Error('归档原件大小或摘要变化');
    const inspection=await inspectBill(bytes,record.filename),verification=reconcile(role,inspection,{...item.expected,period}),scope=range(item,record);
    if(record.details?.verification?.verified!==true||!verification.verified){block('CAINIAO_RECHECK_FAILED','归档原件重新核对未通过：'+verification.reason,{fileId:record.id,role});continue;}
    if(required&&!scope)block('CAINIAO_RANGE_UNVERIFIED','缺少真实查询范围或平台任务范围证据；不会按月份猜测截止日',{fileId:record.id,role});
    const ref={id:'overview:cainiao-file:'+record.id+':'+record.sha256,module:'overview',capabilityId:'overview.cainiao-file',input:{id:record.id},sha256:record.sha256,filename:record.filename,metadata:{purpose:'cainiao-freight-handoff',jobId:job.id,month:period,role,account:job.account,from:scope?.from||null,cutoff:scope?.cutoff||null}};
    const expected={count:item.expected?.count??null,amountCents:item.expected?.amountCents??null};
    files.push({fileId:record.id,role,postingRelevant:required,filename:record.filename,sha256:record.sha256,bytes:record.bytes,account:job.account,from:scope?.from||null,cutoff:scope?.cutoff||null,rangeVerified:!!scope,rangeEvidence:scope,expected,verification,sourceRef:ref});evidence.push({...ref,expected});
   }catch(error){block('CAINIAO_ARCHIVE_INVALID','归档原件不可用：'+error.message,{fileId:record.id,role});}
  }
 }
 const requiredFiles=files.filter(f=>f.postingRelevant),ranges=new Set(requiredFiles.map(f=>JSON.stringify([f.from,f.cutoff])));
 if(ranges.size!==1||requiredFiles.some(f=>!f.from||!f.cutoff))block('CAINIAO_RANGE_MISMATCH','交易与费用原件范围缺失或不一致');
 const transaction=items.find(x=>x.type==='transactions'),fees=items.find(x=>x.type==='fees');
 if(!Number.isSafeInteger(transaction?.expected?.amountCents)||transaction.expected.amountCents!==fees?.expected?.amountCents)block('CAINIAO_TOTAL_MISMATCH','交易与费用页面核对金额不一致');
 const ready=!issues.some(x=>x.blocking),scope=ready?requiredFiles[0]:null;
 return {version:1,module:'overview',jobId:job.id,month:period,account:job.account,accountKey:job.accountKey,basis:'业务时间',from:scope?.from||null,cutoff:scope?.cutoff||null,ready,complete:ready,files,sourceRefs:evidence.map(e=>e.id),evidence,handoffEvidence:evidence,issues,summary:ready?'已核实的官方归档可交接复核；尚未入账':'官方归档交接存在阻断项，尚未入账'};
}
