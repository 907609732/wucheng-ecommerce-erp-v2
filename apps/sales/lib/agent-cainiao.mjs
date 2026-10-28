import fs from 'node:fs';
import path from 'node:path';
import {SalesCainiaoDownloads} from './agent-cainiao-manager.mjs';
import {resolveArchive} from './agent-cainiao-files.mjs';
import {classifyCainiaoMonth,amountString} from './agent-cainiao-classify.mjs';
import {hash,month as checkMonth,beijing,fail} from './util.mjs';

export const salesCainiaoQueryIds=['cainiao-status','cainiao-jobs','cainiao-job','cainiao-preview','cainiao-file'];
export const salesCainiaoPrepareIds=['cainiao-connect','cainiao-disconnect','cainiao-download-start','cainiao-download-stop','cainiao-download-resume'];
const blocked=(code,message,extra={})=>({code,message,blocking:true,...extra});
const cleanJob=job=>({...job,items:job.items.map(({target,...item})=>item)});
const feeKeys=['shipping','packing','materials','storage','other'];

export function createSalesCainiao({store,browser,pollMs,waitMs,now=()=>new Date()}={}){
 if(!store?.dir||!store?.db)throw TypeError('Sales Cainiao requires a sales store');
 const manager=new SalesCainiaoDownloads(store,{browser,pollMs,waitMs});
 function file(fileId){
  const source=store.get('SELECT * FROM sales_cainiao_files WHERE id=?',fileId);if(!source)throw fail('菜鸟归档原件不存在',404,'CAINIAO_FILE_NOT_FOUND');
  const bytes=fs.readFileSync(resolveArchive(store.dir,source.path));if(bytes.length!==source.bytes||hash(bytes)!==source.sha256)throw fail('菜鸟归档原件校验失败',409,'CAINIAO_FILE_CHANGED');
  return {filename:source.filename,bytes,mime:/\.zip$/i.test(source.filename)?'application/zip':/\.xlsx$/i.test(source.filename)?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/octet-stream'};
 }
 async function preview(input={}){
  const month=checkMonth(input.month),job=manager.get(input.jobId||input.id);if(!job.months.includes(month))throw fail('月份不属于本次下载任务',409,'CAINIAO_MONTH_MISMATCH');
  const issues=[],items=job.items.filter(item=>item.month===month),sources=manager.files(job).filter(source=>source.period===month);
  if(!items.length||items.some(item=>!['completed','empty','unavailable'].includes(item.status)))issues.push(blocked('DOWNLOADS_INCOMPLETE','本月下载尚未全部完成，先补齐原件'));
  for(const type of ['transactions','fees'])if(!items.some(item=>item.type===type&&item.status==='completed'&&item.verification?.verified))issues.push(blocked('EXPORT_NOT_VERIFIED','交易和费用导出均需通过页面金额与行数核对',{report:type}));
  const buffers=[];
  for(const source of sources){try{const archived=file(source.id),item=items.find(item=>item.type===source.report);buffers.push({filename:source.filename,buffer:archived.bytes,report:source.report,expected:item?.expected});}catch(error){issues.push(blocked('ARCHIVE_CHANGED',error.message,{fileId:source.id}));}}
  const cutoff=job.cutoffs?.[month]||null;
  if(input.cutoff&&input.cutoff!==cutoff)issues.push(blocked('CUTOFF_CHANGED','截止日必须与下载任务保存的范围一致'));
  const classification=await classifyCainiaoMonth({month,files:buffers,cutoff,now:now()});issues.push(...classification.issues);
  if(store.get('SELECT 1 FROM month_locks WHERE month=?',month))issues.push(blocked('MONTH_LOCKED','本月已锁定，不能准备运费入账'));
  const documents=classification.documents,uploads=documents.map(document=>({filename:document.filename,dataBase64:document.buffer.toString('base64'),sha256:document.sha256}));
  // Original ZIPs and their original workbook members remain archived separately. No generated workbook replaces evidence.
  for(const document of documents){const relative=path.join('downloads','cainiao-members',month,document.sha256+path.extname(document.filename).toLowerCase()),absolute=path.resolve(store.dir,relative);if(!absolute.startsWith(path.resolve(store.dir)+path.sep))throw fail('原件归档路径越界');fs.mkdirSync(path.dirname(absolute),{recursive:true});if(fs.existsSync(absolute)){if(hash(fs.readFileSync(absolute))!==document.sha256)throw fail('已归档原件成员校验失败',409,'CAINIAO_MEMBER_CHANGED');}else fs.writeFileSync(absolute,document.buffer,{flag:'wx'});}
  const billNo='CAINIAO-BIZ-'+month,existing=store.all("SELECT * FROM freight_records WHERE month=? AND channel='warehouse' AND status='active' ORDER BY id",month);
  let postingAction='create',recordId=null,previous=null;
  if(existing.length){
   if(existing.length!==1||existing[0].bill_no!==billNo||existing[0].entry_mode!=='month'||existing[0].shop_id!==null){issues.push(blocked('OVERLAPPING_RECORDS','本月已有其他云仓记录或多条月汇总，需人工解释重叠'));}
   else{
    previous=existing[0];const attachments=store.all('SELECT * FROM freight_attachments WHERE record_id=? AND removed_at IS NULL',previous.id),known=/菜鸟/.test(previous.note)&&/业务时间/.test(previous.note)&&attachments.some(attachment=>/交易|计费|费用项/.test(attachment.filename)&&attachment.filename.includes(month.replace('-',''))),oldCutoff=previous.note.match(/CAINIAO-CUTOFF=(20\d{2}-\d{2}-\d{2})/)?.[1]||previous.note.match(/截止(?:日|日期|至|到)?[：:\s]*(20\d{2}-\d{2}-\d{2})/)?.[1];
    if(!known||!oldCutoff)issues.push(blocked('EXISTING_SOURCE_UNVERIFIED','已有记录来源或截止范围未核实，不能仅按账单号覆盖'));
    else if(feeKeys.every(key=>previous[key]===classification.fees[key])&&oldCutoff===classification.to){postingAction='skip';issues.push(blocked('DUPLICATE_SOURCE','本月同源、同分类金额及截止日已登记，跳过重复入账',{recordId:previous.id}));}
    else if(month!==beijing(now()).month)issues.push(blocked('HISTORICAL_RECORD_CHANGED','已结束月份已有不同金额或范围，需先人工核对差异'));
    else if(oldCutoff>classification.to)issues.push(blocked('COVERAGE_SHRINK','新原件截止日早于已有记录，不能缩小已登记范围'));
    else{postingAction='update';recordId=previous.id;}
   }
  }
  const sourceHashes=sources.map(source=>({id:source.id,report:source.report,sha256:source.sha256,bytes:source.bytes})).sort((a,b)=>a.id.localeCompare(b.id));
  const sourceFingerprint=hash({jobId:job.id,account:job.account,month,from:classification.from,to:classification.to,sourceHashes,fees:classification.fees,members:uploads.map(({filename,sha256})=>({filename,sha256})),recordId,version:previous?.version||null});
  const freightInput={request_id:'cainiao-'+sourceFingerprint.slice(0,64),channel:'warehouse',entry_mode:'month',period:month,shop_id:'shared',...Object.fromEntries(feeKeys.map(key=>[key,amountString(classification.fees[key])])),other_note:classification.otherNote,bill_no:billNo,note:`菜鸟官方账单；业务时间 ${classification.from} 至 ${classification.to}；CAINIAO-CUTOFF=${classification.to}；${classification.interim?'未结月，后续原件应更新本记录':'完整自然月原件核对'}；来源 ${job.account}`};
  if(postingAction==='update'){freightInput.version=previous.version;freightInput.remove_attachments=JSON.stringify(store.all('SELECT id FROM freight_attachments WHERE record_id=? AND removed_at IS NULL',recordId).map(attachment=>attachment.id));}
  const publicSummary={jobId:job.id,month,account:job.account,postingAction,recordId,version:previous?.version||null,sourceFingerprint,sourceHashes,from:classification.from,cutoff:classification.to,interim:classification.interim,fees:classification.fees,total:classification.total,transactionTotal:classification.transactionTotal,detailTotal:classification.detailTotal,transactionCount:classification.transactionCount,detailCount:classification.detailCount,classification:classification.classification,attachments:documents.map(({filename,sha256,bytes})=>({filename,sha256,bytes})),issues,ready:!issues.some(item=>item.blocking)};
  return {...publicSummary,freightInput,uploads,summary:'菜鸟运费分类预览：'+month,scope:{module:'sales',month,shop:'shared'},blocks:[{type:'table',title:'按已验证费用项分类（整数分）',rows:classification.classification},{type:'table',title:'原件、平台与分类净额核对',rows:[{transactionTotal:classification.transactionTotal,detailTotal:classification.detailTotal,classifiedTotal:classification.total,cutoff:classification.to,interim:classification.interim}]}],evidence:sourceHashes.map(source=>({fileId:source.id,sha256:source.sha256,report:source.report})),changes:[]};
 }
 const publicPreview=prepared=>{const {uploads,freightInput,...result}=prepared;return result;};
 async function query(capabilityId,input={}){
  const key=capabilityId.replace(/^sales\./,'');
  if(key==='cainiao-status')return manager.info();
  if(key==='cainiao-jobs')return manager.list().map(job=>({...cleanJob(job),files:manager.files(job)}));
  if(key==='cainiao-job'){const job=manager.get(input.jobId||input.id);return {...cleanJob(job),files:manager.files(job)};}
  if(key==='cainiao-preview')return publicPreview(await preview(input));
  if(key==='cainiao-file')return file(input.fileId||input.id);
  throw fail('菜鸟查询能力未实现',501);
 }
 async function prepare(capabilityId,input={},ctx={}){
  const key=capabilityId.replace(/^sales\./,'');let result;
  if(key==='cainiao-connect'){if(manager.active||manager.liveLock())throw fail('下载运行中，请先停止',409);result=await manager.browser.connect();}
  else if(key==='cainiao-disconnect'){await manager.disconnect();result=manager.info();}
  else if(key==='cainiao-download-start')result=cleanJob(manager.start(input));
  else if(key==='cainiao-download-stop'){result=cleanJob(manager.cancel(input.jobId||input.id));manager.wake?.();}
  else if(key==='cainiao-download-resume')result=cleanJob(manager.resume(input.jobId||input.id));
  else throw fail('菜鸟下载操作未实现',501);
  return {summary:'菜鸟原件下载操作已记录，尚未入账',scope:{module:'sales',month:input.from||result.months?.[0]},blocks:[{type:'table',title:'原件下载状态',rows:[result]}],evidence:[],changes:[],issues:[]};
 }
 return {manager,query,prepare,preview,file,close:()=>manager.close()};
}
