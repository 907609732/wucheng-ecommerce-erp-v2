import path from 'node:path';
import ExcelJS from 'exceljs';
import {parse} from 'csv-parse/sync';
import {checkedZip,memberBytes,MAX_BYTES,safeName} from './agent-cainiao-files.mjs';
import {month as checkMonth,bounds,date,money,hash,safeSum,beijing,fail} from './util.mjs';

export const CAINIAO_FEE_MAP=Object.freeze({
 '正向配送费':'shipping','逆向配送费':'shipping','正向配送费_春节不打烊':'shipping',
 '防护包装费':'packing','多品防护包装费':'packing','包装物料费':'materials','防护耗材-气枕费':'materials','仓储费':'storage',
 '订单处理费':'other','订单处理费_春节不打烊':'other','拦截费':'other','非销售出库费':'other','退货入仓费':'other','货物装卸费':'other','代贴条码费':'other','货值赔付':'other','服务赔付':'other'
});
export const amountString=cents=>(cents<0?'-':'')+Math.floor(Math.abs(cents)/100)+'.'+String(Math.abs(cents)%100).padStart(2,'0');
const value=cell=>cell?.text??cell?.result??(cell?.richText?cell.richText.map(part=>part.text).join(''):cell??'');
const normal=cell=>String(value(cell)).trim().replace(/[\s（）()]/g,'');
const issue=(code,message,details={})=>({code,message,blocking:true,...details});

function filenameRange(filename){
 const found=String(filename).match(/(20\d{6})[_-](20\d{6})/);if(!found)return null;
 const convert=text=>date(text.slice(0,4)+'-'+text.slice(4,6)+'-'+text.slice(6,8));
 const from=convert(found[1]),to=convert(found[2]);if(from>to)throw fail('原件文件名日期区间倒置');return {from,to};
}
function table(filename,sheet,rows,range){
 const head=rows.findIndex(row=>row.some(cell=>['费用项','交易单号','物流履约单号','仓库资源名称'].includes(normal(cell))));
 if(head<0)return {filename,sheet,role:'unknown',headers:[],rows:[],range};
 const headers=rows[head].map(normal),body=rows.slice(head+1).filter(row=>row.some(cell=>String(value(cell)).trim()!==''));
 const role=headers.includes('费用项')?(headers.includes('主单行数量')?'feeSummary':'feeDetails'):headers.includes('交易单号')&&headers.some(header=>/^计费金额合计(CNY)?$/.test(header))?'transactions':headers.includes('货品ID')&&headers.includes('物流履约单号')?'goods':headers.includes('仓库资源名称')?'warehouse':'unknown';
 return {filename,sheet,role,headers,rows:body,range};
}

// Reuse the downloader's ZIP bounds/CRC checks; return real original members rather than regenerated workbooks.
export async function readCainiaoDocuments(buffer,filename,{range=null,budget={bytes:0,entries:0},depth=0}={}){
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_BYTES)throw fail('原件为空或超过读取限制');
 if(depth>4)throw fail('压缩包嵌套层级过深');
 const declared=filenameRange(filename)||range,ext=path.extname(filename).toLowerCase();
 if(ext==='.zip'){
  const {entries}=await checkedZip(buffer),documents=[];
  for(const entry of entries){budget.entries++;budget.bytes+=entry._data.uncompressedSize;if(budget.entries>2000||budget.bytes>MAX_BYTES)throw fail('原件展开大小或分卷数量超限');if(!/\.(xlsx|csv|zip|xls)$/i.test(entry.name))continue;documents.push(...await readCainiaoDocuments(await memberBytes(entry),entry.name,{range:declared,budget,depth:depth+1}));}
  return documents;
 }
 let tables;
 if(ext==='.xlsx'){
  const {entries}=await checkedZip(buffer);for(const entry of entries)await memberBytes(entry);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);
  tables=workbook.worksheets.map(sheet=>{const rows=[];sheet.eachRow(row=>{if(rows.length>=500000||row.cellCount>1000)throw fail('原件行列数量超限');rows.push(row.values.slice(1));});return table(safeName(filename),sheet.name,rows,declared);});
 }else if(ext==='.csv'){
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{text=new TextDecoder('gb18030').decode(buffer);}
  const rows=parse(text,{bom:true,skip_empty_lines:true,relax_column_count:true});if(rows.length>500000)throw fail('原件行数超限');tables=[table(safeName(filename),'CSV',rows,declared)];
 }else throw fail('原件格式尚未支持分类：'+safeName(filename));
 return [{filename:safeName(filename),sha256:hash(buffer),buffer,bytes:buffer.length,mime:ext==='.xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv',tables}];
}

function amounts(t,issues,{month,from,to,requireDate=false,requireCurrency=false}={}){
 const amountIndex=t.headers.findIndex(header=>/^计费金额(合计)?(CNY)?$/.test(header)),dateIndex=t.headers.findIndex(header=>['业务时间','业务日期','业务日期_分区字段'].includes(header)),currencyIndex=t.headers.findIndex(header=>['计费币种','币种'].includes(header));
 const rows=[];
 if(amountIndex<0){issues.push(issue('AMOUNT_COLUMN_MISSING','未找到明确计费金额列',{file:t.filename}));return rows;}
 if(!t.range){issues.push(issue('DECLARED_RANGE_MISSING','原件缺少可核实的声明日期区间',{file:t.filename}));}
 else if(t.range.from!==from||t.range.to!==to){issues.push(issue('DECLARED_RANGE_MISMATCH','原件声明区间与本次查询区间不一致',{file:t.filename,declared:t.range,expected:{from,to}}));}
 if(requireDate&&dateIndex<0)issues.push(issue('BUSINESS_DATE_MISSING','计费明细缺少业务时间列',{file:t.filename}));
 if(requireCurrency&&currencyIndex<0)issues.push(issue('CURRENCY_MISSING','计费明细缺少计费币种列',{file:t.filename}));
 for(let index=0;index<t.rows.length;index++){
  const row=t.rows[index];let cents,businessDate=null;
  try{cents=money(value(row[amountIndex]));}catch(error){issues.push(issue('AMOUNT_INVALID','原件存在缺失、无效或超过两位精度的金额',{file:t.filename,row:index+2}));continue;}
  if(currencyIndex>=0&&normal(row[currencyIndex])!=='CNY')issues.push(issue('CURRENCY_UNSUPPORTED','原件币种必须明确为 CNY',{file:t.filename,row:index+2}));
  if(dateIndex>=0){try{businessDate=date(value(row[dateIndex]));if(businessDate.slice(0,7)!==month||businessDate<from||businessDate>to)throw Error();}catch{issues.push(issue('BUSINESS_DATE_OUT_OF_RANGE','业务时间超出月份、声明范围或截止日',{file:t.filename,row:index+2}));}}
  rows.push({row,cents,businessDate,source:t.filename,sheet:t.sheet,table:t});
 }
 return rows;
}

export async function classifyCainiaoMonth({month,files,cutoff=null,now=new Date()}){
 checkMonth(month);const issues=[],[from,last]=bounds(month),today=beijing(now),interim=month===today.month,to=cutoff?date(cutoff):last;
 if(month>today.month)issues.push(issue('FUTURE_MONTH','不能准备未来月份运费'));
 if(interim&&!cutoff)issues.push(issue('CUTOFF_REQUIRED','当前月必须有下载时保存的明确截止日'));
 if(to.slice(0,7)!==month||to>beijing(new Date(+now-86400000)).date&&interim)issues.push(issue('CUTOFF_INVALID','截止日不属于所选月份或晚于北京时间昨天'));
 if(!interim&&to!==last)issues.push(issue('HISTORICAL_RANGE_INCOMPLETE','历史月份尚未覆盖完整自然月，请更新原件'));
 const groups=new Map(),allDocuments=new Map();
 for(const file of files){
  let documents;try{documents=await readCainiaoDocuments(file.buffer,file.filename);}catch(error){issues.push(issue('FILE_UNREADABLE',error.message,{file:file.filename}));continue;}
  if(!groups.has(file.report))groups.set(file.report,new Map());
  for(const document of documents){groups.get(file.report).set(document.sha256,document);allDocuments.set(document.sha256,document);}
 }
 const reportTables=report=>[...(groups.get(report)?.values()||[])].flatMap(document=>document.tables);
 const transactions=reportTables('transactions').filter(t=>t.role==='transactions');
 const transactionDetails=reportTables('transactions').filter(t=>t.role==='feeDetails');
 const feeDetails=reportTables('fees').filter(t=>t.role==='feeDetails');
 const canonicalDetails=transactionDetails.length?transactionDetails:feeDetails;
 const goods=reportTables('transactions').filter(t=>t.role==='goods');
 if(!transactions.length)issues.push(issue('TRANSACTIONS_MISSING','缺少交易账单原件'));
 if(!canonicalDetails.length)issues.push(issue('FEE_DETAILS_MISSING','缺少计费明细原件'));
 if(!goods.length)issues.push(issue('GOODS_EVIDENCE_MISSING','缺少货品信息原件，分卷可能未下载齐'));
 const transactionRows=transactions.flatMap(t=>amounts(t,issues,{month,from,to})),detailRows=canonicalDetails.flatMap(t=>amounts(t,issues,{month,from,to,requireDate:true,requireCurrency:true}));
 const transactionTotal=safeSum(transactionRows.map(row=>row.cents)),detailTotal=safeSum(detailRows.map(row=>row.cents));
 if(transactionTotal!==detailTotal)issues.push(issue('TOTAL_MISMATCH','交易账单与计费明细净额不一致',{transactionTotal,detailTotal}));
 for(const report of ['transactions','fees']){
  const bundle=files.find(file=>file.report===report),expected=bundle?.expected;
  if(!expected||!Number.isSafeInteger(expected.amountCents)||!Number.isSafeInteger(expected.count))issues.push(issue('PAGE_EVIDENCE_MISSING','缺少下载时保存的平台金额和行数证据',{report}));
  else{
   if(expected.period!==month||expected.from!==from||expected.to!==to)issues.push(issue('PAGE_RANGE_MISMATCH','平台查询范围与拟入账范围不一致',{report}));
   if(expected.amountCents!==detailTotal)issues.push(issue('PAGE_TOTAL_MISMATCH','原件净额与平台页面不一致',{report,pageTotal:expected.amountCents,detailTotal}));
   const summaries=report==='transactions'?transactions:reportTables('fees').filter(t=>t.role==='feeSummary');
   if(!summaries.length)issues.push(issue('PAGE_TABLE_MISSING','缺少对应平台查询的汇总原件',{report}));
   const summaryRows=report==='transactions'?transactionRows:summaries.flatMap(t=>amounts(t,issues,{month,from,to}));
   if(summaryRows.length!==expected.count)issues.push(issue('PAGE_COUNT_MISMATCH','原件行数与平台页面不一致',{report,count:summaryRows.length,expected:expected.count}));
   if(safeSum(summaryRows.map(row=>row.cents))!==detailTotal)issues.push(issue('SUMMARY_TOTAL_MISMATCH','费用汇总与计费明细净额不一致',{report}));
   for(const name of expected.feeNames||[])if(!Object.hasOwn(CAINIAO_FEE_MAP,name))issues.push(issue('UNKNOWN_FEE','平台出现未验证费用项：'+name,{fee:name}));
  }
 }
 if(transactionDetails.length&&feeDetails.length){const otherRows=feeDetails.flatMap(t=>amounts(t,issues,{month,from,to,requireDate:true,requireCurrency:true}));if(otherRows.length!==detailRows.length||safeSum(otherRows.map(row=>row.cents))!==detailTotal)issues.push(issue('DETAIL_EXPORTS_DISAGREE','两类导出中的计费明细数量或净额不一致'));}
 const fees={shipping:0,packing:0,materials:0,storage:0,other:0},byName=new Map();
 for(const t of canonicalDetails){const feeIndex=t.headers.indexOf('费用项');for(const row of detailRows.filter(row=>row.table===t)){
  const name=String(value(row.row[feeIndex])).trim(),category=CAINIAO_FEE_MAP[name];if(!category){issues.push(issue('UNKNOWN_FEE','发现未验证费用项：'+name,{fee:name}));continue;}
  if(category!=='other'&&row.cents<0)issues.push(issue('NEGATIVE_FEE_UNSUPPORTED','只有其他费用可保留赔付负数抵扣',{fee:name,amount:row.cents}));
  fees[category]=safeSum([fees[category],row.cents]);byName.set(name,safeSum([byName.get(name)||0,row.cents]));
 }}
 const total=safeSum(Object.values(fees));if(total!==detailTotal)issues.push(issue('CLASSIFICATION_UNBALANCED','分类净额与计费明细合计不平',{total,detailTotal}));
 const otherNote=[...byName].filter(([name])=>CAINIAO_FEE_MAP[name]==='other').map(([name,cents])=>name+' '+amountString(cents)+'元').join('；');if(otherNote.length>500)issues.push(issue('NOTE_TOO_LONG','其他费用及赔付说明超过 500 字，需要人工处理'));
 const requiredTables=new Set([...transactions,...canonicalDetails,...goods]);
 const documents=[...new Map([...groups.values()].flatMap(group=>[...group.values()]).filter(document=>document.tables.some(t=>requiredTables.has(t))).map(document=>[document.sha256,document])).values()];
 if(documents.length>5||documents.some(document=>document.bytes>25*1024*1024)||safeSum(documents.map(document=>document.bytes))>50*1024*1024)issues.push(issue('ATTACHMENT_LIMIT','全部原件超过运费附件上限，不能丢弃分卷或重复拆账'));
 const classification=[...byName].map(([name,cents])=>({name,category:CAINIAO_FEE_MAP[name],amountCents:cents}));
 return {month,from,to,interim,fees,total,transactionTotal,detailTotal,transactionCount:transactionRows.length,detailCount:detailRows.length,classification,otherNote,documents,issues};
}
