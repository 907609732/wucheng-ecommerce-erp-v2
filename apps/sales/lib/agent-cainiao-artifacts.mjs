import fs from 'node:fs';
import path from 'node:path';
import {classifyCainiaoMonth,readCainiaoDocuments,amountString} from './agent-cainiao-classify.mjs';
import {MAX_BYTES,safeName} from './agent-cainiao-files.mjs';
import {hash,month as checkMonth,bounds,date,beijing,fail} from './util.mjs';

const feeKeys=['shipping','packing','materials','storage','other'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=/^[a-f0-9]{64}$/;
const reports=new Set(['transactions','fees','warehouse']);
const blocked=(code,message,extra={})=>({code,message,blocking:true,...extra});
const pair=file=>JSON.stringify([file.filename,file.sha256||file.sha]);
const ordered=rows=>rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const evidenceRoot=store=>path.resolve(store.dir,'downloads','cainiao-artifacts');

function archivedPath(store,month,fingerprint,relative='manifest.json'){
 const root=evidenceRoot(store),target=path.resolve(root,month,fingerprint,relative);
 if(!target.startsWith(root+path.sep))throw fail('菜鸟交接原件路径越界');
 return target;
}

function writeOriginal(target,buffer){
 fs.mkdirSync(path.dirname(target),{recursive:true});
 if(fs.existsSync(target)){if(!fs.readFileSync(target).equals(buffer))throw fail('已固化的菜鸟原件证据发生变化',409,'CAINIAO_ARCHIVE_CHANGED');}
 else fs.writeFileSync(target,buffer,{flag:'wx'});
}

function persistManifest(store,manifest,files,documents){
 const fingerprint=hash(manifest);
 for(const file of files)writeOriginal(archivedPath(store,manifest.month,fingerprint,'sources/'+file.id+path.extname(file.filename).toLowerCase()),file.buffer);
 for(const document of documents)writeOriginal(archivedPath(store,manifest.month,fingerprint,'members/'+document.sha256+path.extname(document.filename).toLowerCase()),document.buffer);
 writeOriginal(archivedPath(store,manifest.month,fingerprint),Buffer.from(JSON.stringify(manifest)));
 return fingerprint;
}

function verifiedPrevious(store,record,sourceKey,month){
 const fingerprint=record.note.match(/\bCAINIAO-ARCHIVE=([a-f0-9]{64})\b/)?.[1];
 if(!fingerprint)throw fail('已有记录缺少可信交接原件清单');
 const manifest=JSON.parse(fs.readFileSync(archivedPath(store,month,fingerprint),'utf8'));
 if(hash(manifest)!==fingerprint||manifest.kind!=='sales.cainiao-artifacts'||manifest.version!==1||manifest.sourceKey!==sourceKey||manifest.month!==month||manifest.to!==record.note.match(/\bCAINIAO-CUTOFF=(20\d{2}-\d{2}-\d{2})\b/)?.[1]||feeKeys.some(key=>manifest.fees[key]!==record[key]))throw fail('已有记录与已固化来源、范围或分类金额不一致');
 for(const source of manifest.sourceHashes){const bytes=fs.readFileSync(archivedPath(store,month,fingerprint,'sources/'+source.id+path.extname(source.filename).toLowerCase()));if(bytes.length!==source.bytes||hash(bytes)!==source.sha256)throw fail('已有记录的交接原件校验失败');}
 const attachments=store.all('SELECT * FROM freight_attachments WHERE record_id=? AND removed_at IS NULL',record.id);
 if(attachments.length!==manifest.members.length)throw fail('已有记录有效附件与已固化来源清单不一致');
 for(const member of manifest.members){
  const matching=attachments.filter(file=>file.sha256===member.sha256&&file.filename===member.filename&&file.size===member.bytes);
  if(matching.length!==1)throw fail('已有记录附件不能唯一对应已固化原件');
  const target=path.resolve(store.dir,matching[0].original_path);
  if(!target.startsWith(path.resolve(store.dir)+path.sep))throw fail('已有记录附件路径无效');
  const bytes=fs.readFileSync(target);if(bytes.length!==member.bytes||hash(bytes)!==member.sha256)throw fail('已有记录附件原件校验失败');
 }
 return {manifest,attachments};
}

function pageEvidence(raw,report,month,from,to,issues){
 if(!raw||!Number.isSafeInteger(raw.count)||raw.count<0||!Number.isSafeInteger(raw.amountCents)){
  issues.push(blocked('PAGE_EVIDENCE_MISSING','缺少可信交接清单中已核验的平台金额和行数证据',{report}));return undefined;
 }
 if(raw.verified===false)issues.push(blocked('EXPORT_NOT_VERIFIED','可信交接清单中的平台导出尚未核验',{report}));
 if(raw.feeNames&&(!Array.isArray(raw.feeNames)||raw.feeNames.some(name=>typeof name!=='string')))issues.push(blocked('PAGE_EVIDENCE_INVALID','可信平台费用项证据格式无效',{report}));
 if(raw.period&&raw.period!==month||raw.from!==from||raw.to!==to)issues.push(blocked('PAGE_RANGE_MISMATCH','可信平台查询范围与本次运费月份或截止日不一致',{report}));
 return {period:raw.period||month,from:raw.from,to:raw.to,count:raw.count,amountCents:raw.amountCents,...(Array.isArray(raw.feeNames)?{feeNames:raw.feeNames}:{} )};
}

/**
 * Server-private bridge. The caller resolves same-task artifacts, matches them to
 * the trusted overview handoff manifest, and stages new sales IDs before calling.
 * Neither scope nor provenance stamps may be constructed from model input.
 * This prepares evidence only; the owning service still requires central review
 * and re-runs this function before using the existing saveFreight implementation.
 */
export async function prepareArchivedFreight({store,month,files=[],scope={},now=new Date()}={}){
 if(!store?.dir||!store?.db)throw TypeError('Sales archived Cainiao freight requires a sales store');
 checkMonth(month);const clock=typeof now==='function'?now():now,issues=[],[first,last]=bounds(month);
 if(!scope||typeof scope!=='object'||Array.isArray(scope))scope={};
 let from=first,to=last;
 try{if(date(scope.from)!==scope.from||date(scope.to??scope.cutoff)!==(scope.to??scope.cutoff))throw Error();from=scope.from;to=scope.to??scope.cutoff;}catch{issues.push(blocked('SCOPE_RANGE_MISSING','可信交接清单必须包含明确的业务起止日期'));}
 if(from!==first||to.slice(0,7)!==month||from>to||scope.cutoff&&scope.cutoff!==to)issues.push(blocked('SCOPE_RANGE_MISMATCH','可信交接范围必须从本月首日开始，并与截止日一致'));
 const account=typeof scope.account==='string'?scope.account.trim():'';
 if(!account||account.length>200||/[\x00-\x1f]/.test(account))issues.push(blocked('SOURCE_ACCOUNT_MISSING','可信交接清单缺少有效的菜鸟账号标识'));
 const expected={};for(const report of ['transactions','fees'])expected[report]=pageEvidence(scope.expected?.[report],report,month,from,to,issues);
 const manifestFiles=Array.isArray(scope.files)?scope.files.filter(file=>{
  if(!file||typeof file.filename!=='string'||file.filename!==safeName(file.filename)||!digest.test(file.sha256||file.sha||'')||!reports.has(file.report||file.role)){issues.push(blocked('SOURCE_MANIFEST_INVALID','可信交接原件清单含无效文件名、摘要或导出角色'));return false;}return true;
 }):[];
 if(!manifestFiles.length)issues.push(blocked('SOURCE_MANIFEST_MISSING','缺少可信交接原件清单，不能按模型提供的文件组入账'));
 if(!Array.isArray(files)||files.length>100){issues.push(blocked('SOURCE_FILES_INVALID','交接原件组格式无效或文件数量超限'));files=[];}
 const byPair=new Map();for(const file of manifestFiles){const key=pair(file);if(!byPair.has(key))byPair.set(key,[]);byPair.get(key).push(file);}
 const accepted=[],buffers=[],artifactMappings=[],seenIds=new Set(),seenArtifacts=new Set(),seenPairs=new Set(),budget={bytes:0,entries:0};let bytes=0;
 for(const file of files){
  if(!file||typeof file.filename!=='string'||file.filename!==safeName(file.filename)||!uuid.test(file.id||'')||typeof file.artifactId!=='string'||!file.artifactId||file.artifactId.length>300||/[\x00-\x1f]/.test(file.artifactId)){
   issues.push(blocked('SOURCE_FILE_INVALID','原件缺少销售本地文件ID、中央artifact ID或安全文件名'));continue;
  }
  if(file.sourceModule!=='overview'||file.sourceCapabilityId!=='overview.cainiao-file'){
   issues.push(blocked('SOURCE_PROVENANCE_INVALID','只接受运行时标注为 overview.cainiao-file 的官方原件',{fileId:file.id}));continue;
  }
  if(seenIds.has(file.id)||seenArtifacts.has(file.artifactId)||seenPairs.has(pair(file))){issues.push(blocked('DUPLICATE_ARTIFACT','交接组含重复的销售文件、artifact或原件',{fileId:file.id}));continue;}
  seenIds.add(file.id);seenArtifacts.add(file.artifactId);seenPairs.add(pair(file));
  if(!Buffer.isBuffer(file.buffer)||!file.buffer.length||file.buffer.length>50*1024*1024||!digest.test(file.sha256||'')||hash(file.buffer)!==file.sha256){issues.push(blocked('SOURCE_HASH_MISMATCH','交接原件字节与运行时SHA-256不一致或超过暂存上限',{fileId:file.id}));continue;}
  bytes+=file.buffer.length;if(bytes>MAX_BYTES){issues.push(blocked('SOURCE_FILES_TOO_LARGE','交接原件组累计大小超过解析上限'));continue;}
  const matches=byPair.get(pair(file))||[];
  if(matches.length!==1){issues.push(blocked(matches.length?'SOURCE_MANIFEST_AMBIGUOUS':'SOURCE_NOT_IN_MANIFEST','原件不能唯一匹配可信交接清单的文件名和SHA-256',{fileId:file.id}));continue;}
  const declared=matches[0],report=declared.report||declared.role;
  if(file.id===declared.fileId||file.id===declared.id){issues.push(blocked('SALES_FILE_ID_REQUIRED','总览原件ID不能作为销售暂存ID，必须先重stage',{fileId:file.id}));continue;}
  if(!reports.has(report)||file.report&&file.report!==report){issues.push(blocked('SOURCE_REPORT_MISMATCH','原件导出角色与可信交接清单不一致',{fileId:file.id}));continue;}
  let documents;try{documents=await readCainiaoDocuments(file.buffer,file.filename,{budget});}catch(error){issues.push(blocked('FILE_UNREADABLE',error.message,{fileId:file.id}));continue;}
  const tables=documents.flatMap(document=>document.tables),roles=new Set(tables.map(table=>table.role));
  const allowed=report==='transactions'?new Set(['transactions','feeDetails','goods']):report==='fees'?new Set(['feeSummary','feeDetails']):new Set(['warehouse']);
  if(!tables.length||[...roles].some(role=>!allowed.has(role))){issues.push(blocked('SOURCE_REPORT_MISMATCH','原件实际表头不属于可信清单标注的导出角色',{fileId:file.id,report,roles:[...roles]}));continue;}
  accepted.push(file);buffers.push({filename:file.filename,buffer:file.buffer,report,expected:expected[report]});
  artifactMappings.push({artifactId:file.artifactId,fileId:file.id,filename:file.filename,sha256:file.sha256,report,sourceModule:'overview',sourceCapabilityId:'overview.cainiao-file'});
 }
 for(const file of manifestFiles)if(!accepted.some(source=>pair(source)===pair(file)))issues.push(blocked('SOURCE_FILES_MISSING','可信交接清单中的原件尚未完整提供或未通过校验',{filename:file.filename,sha256:file.sha256||file.sha}));
 // Roles, business dates, currency, strict cent amounts and all independent
 // totals are read by the existing classifier, never copied from model fields.
 const classification=await classifyCainiaoMonth({month,files:buffers,cutoff:to,now:clock});issues.push(...classification.issues);
 if(store.get('SELECT 1 FROM month_locks WHERE month=?',month))issues.push(blocked('MONTH_LOCKED','本月已锁定，不能准备运费入账'));
 const documents=classification.documents,uploads=documents.map(document=>({filename:document.filename,dataBase64:document.buffer.toString('base64'),sha256:document.sha256}));
 const billNo='CAINIAO-BIZ-'+month,sourceKey=hash({sourceModule:'overview',sourceCapabilityId:'overview.cainiao-file',account});
 const existing=store.all("SELECT * FROM freight_records WHERE month=? AND channel='warehouse' AND status='active' ORDER BY id",month);
 let postingAction='create',recordId=null,previous=null,previousAttachments=[];
 if(existing.length){
  if(existing.length!==1||existing[0].bill_no!==billNo||existing[0].entry_mode!=='month'||existing[0].shop_id!==null)issues.push(blocked('OVERLAPPING_RECORDS','本月已有其他云仓记录或多条月汇总，需人工解释重叠'));
  else{
   previous=existing[0];let known;
   try{known=verifiedPrevious(store,previous,sourceKey,month);}catch(error){issues.push(blocked('EXISTING_SOURCE_UNVERIFIED','已有记录的来源及原件链未核实，不能仅按账单号或文件名覆盖',{reason:error.message}));}
   if(known){
    previousAttachments=known.attachments;
    if(feeKeys.every(key=>previous[key]===classification.fees[key])&&known.manifest.to===classification.to){postingAction='skip';issues.push(blocked('DUPLICATE_SOURCE','本月同源、同分类金额及截止日已登记，跳过重复入账',{recordId:previous.id}));}
    else if(month!==beijing(clock).month)issues.push(blocked('HISTORICAL_RECORD_CHANGED','已结束月份已有不同金额或范围，需先人工核对差异'));
    else if(known.manifest.to>classification.to)issues.push(blocked('COVERAGE_SHRINK','新原件截止日早于已有记录，不能缩小已登记范围'));
    else{postingAction='update';recordId=previous.id;}
   }
  }
 }
 const sourceHashes=ordered(accepted.map(file=>({id:file.id,artifactId:file.artifactId,filename:file.filename,report:artifactMappings.find(mapping=>mapping.fileId===file.id).report,sha256:file.sha256,bytes:file.buffer.length})));
 const mappings=ordered(artifactMappings),members=ordered(documents.map(({filename,sha256,bytes})=>({filename,sha256,bytes})));
 const sourceManifest={version:1,kind:'sales.cainiao-artifacts',sourceKey,month,account,from:classification.from,to:classification.to,sourceHashes,artifactMappings:mappings,fees:classification.fees,members,expected,recordId,recordVersion:previous?.version||null};
 const sourceFingerprint=hash(sourceManifest);
 if(!issues.some(issue=>issue.blocking))try{persistManifest(store,sourceManifest,accepted,documents);}catch(error){issues.push(blocked('ARCHIVE_CHANGED',error.message));}
 const freightInput={request_id:'cainiao-'+sourceFingerprint,channel:'warehouse',entry_mode:'month',period:month,shop_id:'shared',...Object.fromEntries(feeKeys.map(key=>[key,amountString(classification.fees[key])])),other_note:classification.otherNote,bill_no:billNo,note:`菜鸟官方账单；业务时间 ${classification.from} 至 ${classification.to}；CAINIAO-CUTOFF=${classification.to}；CAINIAO-ARCHIVE=${sourceFingerprint}；${classification.interim?'未结月，后续原件应更新本记录':'完整自然月原件核对'}；可信总览原件交接`};
 if(postingAction==='update'){freightInput.version=previous.version;freightInput.remove_attachments=JSON.stringify(previousAttachments.map(file=>file.id));}
 return {month,account,postingAction,recordId,version:previous?.version||null,sourceKey,sourceFingerprint,sourceHashes,artifactMappings:mappings,sourceManifest,from:classification.from,cutoff:classification.to,interim:classification.interim,fees:classification.fees,total:classification.total,transactionTotal:classification.transactionTotal,detailTotal:classification.detailTotal,transactionCount:classification.transactionCount,detailCount:classification.detailCount,classification:classification.classification,attachments:members,issues,ready:!issues.some(issue=>issue.blocking),freightInput,uploads,summary:'可信菜鸟原件运费分类预览：'+month,scope:{module:'sales',month,shop:'shared'},blocks:[{type:'table',title:'按原件核实的费用分类（整数分）',rows:classification.classification},{type:'table',title:'原件与可信平台查询证据核对',rows:[{transactionTotal:classification.transactionTotal,detailTotal:classification.detailTotal,classifiedTotal:classification.total,cutoff:classification.to,interim:classification.interim}]},{type:'table',title:'中央artifact与销售原件对应关系',rows:mappings}],evidence:sourceHashes.map(source=>({fileId:source.id,artifactId:source.artifactId,sha256:source.sha256,report:source.report,sourceModule:'overview',sourceCapabilityId:'overview.cainiao-file'})),changes:[]};
}
