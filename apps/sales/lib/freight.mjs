import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { id, now, hash, date, month, bounds, shiftMonth, money, count, safeSum, fail, required } from './util.mjs';
import { insertObject, validateShop } from './ledger.mjs';

export const FREIGHT_CHANNELS = {warehouse:'云仓发货',merchant:'商家寄件',sf:'顺丰快递'};
export const FREIGHT_MODES = {month:'按月汇总',day:'按日汇总',single:'单笔寄件'};
export const FREIGHT_FEES = {shipping:'快递运费',packing:'打包费',materials:'耗材费',storage:'仓储费',other:'其他费用'};
const MB=1024*1024;
const mimeTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xls':'application/vnd.ms-excel','.csv':'text/csv'};
const trim=(value,max=500)=>String(value??'').trim().slice(0,max);

function freightMonth(s,m){
  const locked=s.get('SELECT snapshot FROM month_locks WHERE month=?',m);
  if(locked)return {...JSON.parse(locked.snapshot),locked:true};
  return {locked:false,freight:s.all('SELECT * FROM freight_records WHERE month=? ORDER BY id',m),freight_attachments:s.all('SELECT a.* FROM freight_attachments a JOIN freight_records f ON f.id=a.record_id WHERE f.month=? ORDER BY a.id',m)};
}

function normalize(s,input) {
  const channel=String(input.channel),entry_mode=String(input.entry_mode);
  if(!FREIGHT_CHANNELS[channel]||!FREIGHT_MODES[entry_mode])throw fail('请选择费用类型和录入方式');
  const period=entry_mode==='month'?month(input.period):date(input.period);
  const shop_id=!input.shop_id||input.shop_id==='shared'?null:validateShop(input.shop_id,s.shops());
  if(channel==='warehouse'&&shop_id)throw fail('云仓费用统一归属多店共用');
  if(channel==='merchant'&&!shop_id)throw fail('商家寄件必须选择具体店铺');
  const fees={};
  for(const key of Object.keys(FREIGHT_FEES)){
    fees[key]=money(input[key],key!=='shipping')??0;
    if(key!=='other'&&fees[key]<0)throw fail('费用请填非负金额，最多两位小数');
  }
  if(channel!=='warehouse'&&Object.keys(fees).some(k=>k!=='shipping'&&fees[k]!==0))throw fail('只有云仓可以填写附加费用');
  const other_note=trim(input.other_note);
  if(fees.other!==0&&!other_note)throw fail('请说明其他费用或赔付抵扣的用途');
  return {channel,entry_mode,period,month:period.slice(0,7),shop_id,...fees,other_note,total:safeSum(Object.values(fees)),pieces:count(input.pieces),bill_no:trim(input.bill_no,100),tracking_no:trim(input.tracking_no,100),note:trim(input.note)};
}
export {normalize as normalizeFreight};

function validateFiles(files=[]) {
  if(files.length>5)throw fail('每笔最多 5 个附件');
  return files.map(file=>{
    const filename=path.basename(file.originalname.replaceAll('\\','/')).replace(/[\x00-\x1f]/g,'').slice(0,180);
    const ext=path.extname(filename).toLowerCase(),buffer=file.buffer;
    if(!mimeTypes[ext]||!Buffer.isBuffer(buffer))throw fail('凭证支持 PNG、JPG、WebP、PDF、Excel 和 CSV');
    if(!buffer.length||buffer.length>25*MB)throw fail('附件不能为空，单文件不超过 25 MB');
    const head=buffer.subarray(0,12);
    const valid=ext==='.csv'||(ext==='.png'&&head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))||(['.jpg','.jpeg'].includes(ext)&&head.subarray(0,3).equals(Buffer.from([255,216,255])))||(ext==='.webp'&&head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP')||(ext==='.pdf'&&head.toString('ascii',0,5)==='%PDF-')||(ext==='.xlsx'&&head.subarray(0,4).equals(Buffer.from([80,75,3,4])))||(ext==='.xls'&&head.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')));
    if(!valid)throw fail('附件内容与文件类型不一致：'+filename);
    return {filename,buffer,ext,mime:mimeTypes[ext],size:buffer.length,sha256:hash(buffer)};
  });
}

function attachments(s,recordId){return s.all('SELECT * FROM freight_attachments WHERE record_id=? ORDER BY created_at,id',recordId);}
function decorate(s,row,files=[],locked=false) {
  return {...row,shop:row.shop_id?s.shops().find(x=>x.id===row.shop_id)?.name||row.shop_id:'多店共用',platform:row.shop_id?s.shops().find(x=>x.id===row.shop_id)?.platform||'':'共用',channel_label:FREIGHT_CHANNELS[row.channel],mode_label:FREIGHT_MODES[row.entry_mode],locked,attachments:files.filter(a=>a.record_id===row.id&&!a.removed_at).map(publicAttachment),attachment_history:files.filter(a=>a.record_id===row.id&&a.removed_at).map(publicAttachment)};
}
const publicAttachment=({original_path,...a})=>({...a,url:'/api/freight/attachments/'+encodeURIComponent(a.id)});

export function freightRecord(s,recordId) {
  const live=s.get('SELECT * FROM freight_records WHERE id=?',recordId);
  if(!live)throw fail('运费记录不存在',404);
  const data=freightMonth(s,live.month),row=data.freight?.find(x=>x.id===recordId);
  if(!row)throw fail('该月份快照中未记录此笔运费',404);
  return decorate(s,row,data.freight_attachments||[],data.locked);
}

function ensureUnlocked(s,m){if(s.get('SELECT 1 FROM month_locks WHERE month=?',m))throw fail('月份已锁定，请先在月报确认中解锁',423,'MONTH_LOCKED');}
function parseRemoval(value){
  let result;try{result=typeof value==='string'?JSON.parse(value):value||[];}catch{throw fail('附件移除列表无效');}
  if(!Array.isArray(result)||result.some(x=>typeof x!=='string')||result.length>5)throw fail('附件移除列表无效');
  return [...new Set(result)].sort();
}
function replay(s,requestId,fingerprint){
  const prior=s.get('SELECT * FROM freight_requests WHERE id=?',requestId);
  if(!prior)return null;
  if(prior.fingerprint!==fingerprint)throw fail('此提交编号已用于其他内容，请刷新后重试',409,'REQUEST_REUSED');
  return JSON.parse(prior.response);
}
function saveResponse(s,requestId,fingerprint,result){
  s.run('INSERT INTO freight_requests VALUES(?,?,?,?)',requestId,fingerprint,JSON.stringify(result),now());
  return result;
}
function checkConflicts(s,row,input,excludeId,files) {
  const candidates=s.all("SELECT * FROM freight_records WHERE status='active' AND id<>? AND channel=? AND shop_id IS ?",excludeId||'',row.channel,row.shop_id);
  const conflicts=candidates.filter(old=>
    (row.bill_no&&old.bill_no===row.bill_no)||(row.tracking_no&&old.tracking_no===row.tracking_no)||
    (old.month===row.month&&(old.entry_mode==='month'||row.entry_mode==='month'))||
    (old.period===row.period&&old.total===row.total));
  if(!conflicts.length)return null;
  const token=hash({row,files:files.map(f=>f.sha256),conflicts:conflicts.map(r=>[r.id,r.version]).sort()});
  if(input.review_token!==token){
    const error=fail('发现可能重复或期间重叠的记录，请核对后再保存',409,'FREIGHT_REVIEW');
    error.details={review_token:token,conflicts:conflicts.map(r=>({id:r.id,period:r.period,entry_mode:r.entry_mode,total:r.total,bill_no:r.bill_no,tracking_no:r.tracking_no,note:r.note}))};
    throw error;
  }
  return {confirmation:'本笔不包含已登记费用',conflict_ids:conflicts.map(r=>r.id)};
}

export function saveFreight(s,input,uploads=[],recordId=null,{reservedId}={}) {
  if(reservedId&&!/^[a-f0-9-]{36}$/i.test(reservedId))throw fail('内部预留运费标识无效');
  const requestId=required(input.request_id,'提交编号',80),row=normalize(s,input),files=validateFiles(uploads),remove=parseRemoval(input.remove_attachments);
  const fingerprint=hash({action:recordId?'edit':'create',recordId,row,remove,version:recordId?Number(input.version):null,files:files.map(({buffer,ext,...f})=>f)});
  const createdPaths=[];
  try{return s.transaction(()=>{
    const prior=replay(s,requestId,fingerprint);if(prior)return prior;
    const old=recordId?s.get('SELECT * FROM freight_records WHERE id=?',recordId):null;
    if(recordId&&!old)throw fail('运费记录不存在',404);
    if(old?.status==='void')throw fail('已作废记录不能编辑');
    if(old&&old.version!==Number(input.version))throw fail('记录已被修改，请重新打开后再编辑',409,'STALE_RECORD');
    ensureUnlocked(s,row.month);if(old)ensureUnlocked(s,old.month);
    const previous=old?attachments(s,old.id):[];
    if(remove.some(a=>!previous.some(x=>x.id===a&&!x.removed_at)))throw fail('要移除的附件不属于本笔记录');
    const kept=previous.filter(a=>!a.removed_at&&!remove.includes(a.id));
    if(kept.length+files.length>5)throw fail('每笔最多保留 5 个附件，请先移除多余附件');
    if(safeSum([...kept,...files].map(a=>a.size))>50*MB)throw fail('每笔附件合计不能超过 50 MB');
    const review=checkConflicts(s,row,input,recordId,files),stamp=now(),entity=recordId||reservedId||id();
    if(old){
      s.run(`UPDATE freight_records SET ${Object.keys(row).map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=?`,...Object.values(row),stamp,entity);
    }else insertObject(s,'freight_records',{id:entity,...row,status:'active',void_reason:'',version:1,created_at:stamp,updated_at:stamp});
    for(const aid of remove)s.run('UPDATE freight_attachments SET removed_at=? WHERE id=?',stamp,aid);
    for(const file of files){
      const aid=id(),relative=path.join('originals','freight-'+aid+file.ext),absolute=path.join(s.dir,relative);
      writeFileSync(absolute,file.buffer,{flag:'wx'});createdPaths.push(absolute);
      insertObject(s,'freight_attachments',{id:aid,record_id:entity,filename:file.filename,original_path:relative,sha256:file.sha256,size:file.size,mime:file.mime,created_at:stamp,removed_at:null});
    }
    const result=decorate(s,s.get('SELECT * FROM freight_records WHERE id=?',entity),attachments(s,entity));
    s.audit(old?'freight.edit':'freight.create',entity,{before:old,after:result,review,removed_attachments:remove});
    return saveResponse(s,requestId,fingerprint,result);
  });}catch(error){for(const file of createdPaths)try{unlinkSync(file);}catch{/* Preserve the original failure. */}throw error;}
}

export function voidFreight(s,recordId,input) {
  const reason=required(input.reason,'作废原因',500),requestId=required(input.request_id,'提交编号',80),fingerprint=hash({recordId,reason,version:Number(input.version),action:'void'});
  return s.transaction(()=>{
    const prior=replay(s,requestId,fingerprint);if(prior)return prior;
    const old=s.get('SELECT * FROM freight_records WHERE id=?',recordId);if(!old)throw fail('运费记录不存在',404);
    if(old.status==='void')throw fail('记录已经作废');
    if(old.version!==Number(input.version))throw fail('记录已被修改，请重新打开',409,'STALE_RECORD');
    ensureUnlocked(s,old.month);
    s.run("UPDATE freight_records SET status='void',void_reason=?,version=version+1,updated_at=? WHERE id=?",reason,now(),recordId);
    s.audit('freight.void',recordId,{before:old,reason});
    return saveResponse(s,requestId,fingerprint,{ok:true,id:recordId});
  });
}

function queryScope(s,q) {
  const grain=q.grain||'month',period=String(q.period||''),shop=q.shop||'all',channel=q.channel||'all';
  if(!['day','month','year'].includes(grain))throw fail('时间粒度无效');
  if(grain==='year'){if(!/^20\d{2}$/.test(period))throw fail('年份无效');}else if(grain==='month')month(period);else date(period);
  if(shop!=='all'&&shop!=='shared')validateShop(shop,s.shops());
  if(channel!=='all'&&!FREIGHT_CHANNELS[channel])throw fail('运费类型无效');
  return {grain,period,shop,channel};
}
function matchesScope(row,q){return (q.shop==='all'||(q.shop==='shared'?row.shop_id===null:row.shop_id===q.shop))&&(q.channel==='all'||row.channel===q.channel);}
function readMonths(s,months) {
  const rows=[],legacy=[],locked=[];
  for(const m of months){const data=freightMonth(s,m);if(data.locked)locked.push(m);if(!Object.hasOwn(data,'freight'))legacy.push(m);
    rows.push(...(data.freight||[]).map(r=>decorate(s,r,data.freight_attachments||[],data.locked)));
  }
  return {rows,legacy,locked};
}
function periodMonths(q){return q.grain==='year'?Array.from({length:12},(_,i)=>q.period+'-'+String(i+1).padStart(2,'0')):[q.period.slice(0,7)];}
function inPeriod(row,q){return q.grain!=='day'||(row.entry_mode!=='month'&&row.period===q.period);}
export function aggregateFreight(rows) {
  const count=rows.length,out={count,total:count?safeSum(rows.map(r=>r.total)):null};
  for(const k of Object.keys(FREIGHT_FEES))out[k]=count?safeSum(rows.map(r=>r[k])):null;
  out.extras=count?safeSum(rows.map(r=>r.total-r.shipping)):null;
  out.pieces=count&&rows.every(r=>r.pieces!==null)?safeSum(rows.map(r=>r.pieces)):null;
  out.average=out.pieces>0?out.shipping/out.pieces:null;
  return out;
}
export function freightRows(s,query) {
  const q=queryScope(s,query),data=readMonths(s,periodMonths(q));
  const rows=data.rows.filter(r=>matchesScope(r,q)&&inPeriod(r,q)&&(query.status==='all'||r.status==='active')).sort((a,b)=>b.period.localeCompare(a.period)||b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
  return {...q,rows,legacy_months:data.legacy,locked_months:data.locked};
}
export function freightList(s,query) {
  const result=freightRows(s,query),page=Number(query.page||1),pageSize=Number(query.page_size||25);
  if(!Number.isSafeInteger(page)||page<1||![25,50,100].includes(pageSize))throw fail('分页参数无效');
  return {...result,rows:result.rows.slice((page-1)*pageSize,page*pageSize),count:result.rows.length,page,page_size:pageSize};
}
export function freightReport(s,query) {
  const q=queryScope(s,query),months=periodMonths(q),data=readMonths(s,months);
  const scoped=data.rows.filter(r=>r.status==='active'&&matchesScope(r,q)),rows=scoped.filter(r=>inPeriod(r,q));
  const monthly=q.grain==='day'?aggregateFreight(scoped.filter(r=>r.entry_mode==='month')):null;
  const channels=Object.fromEntries(Object.keys(FREIGHT_CHANNELS).map(c=>[c,aggregateFreight(rows.filter(r=>r.channel===c))]));
  const groups=q.shop==='all'?[...s.shops().map(s=>s.id),'shared']:[q.shop];
  const by_shop=groups.map(shop=>({shop_id:shop,shop:shop==='shared'?'多店共用':s.shops().find(s=>s.id===shop)?.name,platform:shop==='shared'?'共用':s.shops().find(s=>s.id===shop)?.platform,...aggregateFreight(rows.filter(r=>(r.shop_id||'shared')===shop))}));
  let trend;
  if(q.grain==='day')trend=Array.from({length:Number(bounds(months[0])[1].slice(8))},(_,i)=>{const label=months[0]+'-'+String(i+1).padStart(2,'0');return {label,...aggregateFreight(scoped.filter(r=>r.entry_mode!=='month'&&r.period===label))};});
  else {const trendMonths=q.grain==='year'?months:Array.from({length:12},(_,i)=>shiftMonth(months[0],i-11));
    const trendRows=q.grain==='year'?data.rows:readMonths(s,trendMonths).rows;
    trend=trendMonths.map(label=>({label,...aggregateFreight(trendRows.filter(r=>r.month===label&&r.status==='active'&&matchesScope(r,q)))}));
  }
  return {...q,totals:aggregateFreight(rows),channels,by_shop,trend,monthly_unallocated:monthly,legacy_months:data.legacy,locked_months:data.locked,locked:data.locked.length===months.length};
}

export function freightAttachment(s,attachmentId) {
  const a=s.get('SELECT * FROM freight_attachments WHERE id=?',attachmentId);if(!a)throw fail('附件不存在',404);
  const record=freightRecord(s,a.record_id);
  if(![...record.attachments,...record.attachment_history].some(x=>x.id===a.id))throw fail('快照中没有此附件',404);
  const absolute=path.resolve(s.dir,a.original_path);
  if(!absolute.startsWith(path.resolve(s.dir,'originals')+path.sep))throw fail('附件路径无效');
  return {...a,absolute};
}

export async function exportFreight(s,query) {
  const data=freightRows(s,query),report=freightReport(s,query),wb=new ExcelJS.Workbook();wb.creator='灵兔电商销售台';
  const summary=wb.addWorksheet('筛选与汇总');
  summary.addRows([['项目','内容'],['期间',data.period],['粒度',data.grain],['归属',data.shop==='all'?'全部店铺与共用':data.shop==='shared'?'多店共用':s.shops().find(x=>x.id===data.shop)?.name],['类型',FREIGHT_CHANNELS[data.channel]||'全部'],['费用合计（元）',report.totals.total==null?'尚未录入':report.totals.total/100],['纯快递运费（元）',report.totals.shipping==null?'尚未录入':report.totals.shipping/100],['云仓附加费用（元）',report.totals.extras==null?'尚未录入':report.totals.extras/100],['有效记录条数',report.totals.count],['包含作废明细',query.status==='all'?'是（不计入汇总）':'否'],['统计说明','仅已登记费用，不代表账单完整；共用不分摊，未参与资金对账扣费。'],['日视图未分配月账单',report.monthly_unallocated?.count?`${report.monthly_unallocated.count} 条，${(report.monthly_unallocated.total/100).toFixed(2)} 元`:'无'],['旧快照未记录运费月份',data.legacy_months.join('、')||'无']]);
  summary.columns=[{width:30},{width:80}];
  const detail=wb.addWorksheet('运费明细',{views:[{state:'frozen',ySplit:1}]});
  detail.addRow(['期间','录入方式','费用类型','平台','归属','快递运费（元）','打包费（元）','耗材费（元）','仓储费（元）','其他费用（元）','合计（元）','件数','账单号','运单号','其他费用说明','备注','状态','作废原因','附件','记录编号']);
  for(const r of data.rows)detail.addRow([r.period,r.mode_label,r.channel_label,r.platform,r.shop,...Object.keys(FREIGHT_FEES).map(k=>r[k]/100),r.total/100,r.pieces,String(r.bill_no),String(r.tracking_no),r.other_note,r.note,r.status==='void'?'已作废':'有效',r.void_reason,r.attachments.map(a=>a.filename).join('\n'),r.id]);
  detail.columns=Array.from({length:20},(_,i)=>({width:[4,14,15,17,18,19].includes(i)?32:18}));
  for(let i=6;i<=11;i++)detail.getColumn(i).numFmt='#,##0.00';
  detail.getColumn(13).numFmt='@';detail.getColumn(14).numFmt='@';
  if(data.rows.length)detail.autoFilter={from:'A1',to:'T'+(data.rows.length+1)};
  for(const sheet of wb.worksheets){sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}};sheet.eachRow(r=>{r.alignment={vertical:'middle',wrapText:true};});}
  return Buffer.from(await wb.xlsx.writeBuffer());
}
