import ExcelJS from 'exceljs';
import {parse} from 'csv-parse/sync';
import {normalizeBill,billIdentity} from './store.mjs';
import {resolveOwner} from './freight.mjs';
import {cents,fail,hash,required,sum} from './util.mjs';
export const fields={billNo:['账单编号','月结单号','工资表编号'],recordId:['记录ID'],recordVersion:['记录版本'],reason:['更正原因'],party:['收款单位/人员','物流公司','收款单位','供应商','人员','姓名'],period:['所属月份','月份','账期'],billDate:['账单日期','日期'],category:['费用项目','项目','运费用途'],owner:['归属','店铺编号','店铺','店铺名称'],title:['说明','摘要'],amount:['应付金额','账单金额','金额'],lineNo:['明细编号','运单号','员工编号'],label:['明细说明','员工姓名','运单说明'],rowType:['行类型'],gross:['应发工资','应发'],withheld:['个人代扣','代扣'],net:['实发工资','实发'],employer:['公司承担','公司社保'],linkedSource:['关联来源'],note:['备注']};
const categoryAliases={'进货运输':'inbound','销售发货':'outbound','退货运输':'returns','云仓服务':'warehouse','工资与奖金':'salary','工资':'salary','劳务':'labor','软件服务':'software','房租':'rent','报销':'reimbursement','其他费用':'other'};
const cell=v=>{if(v instanceof Date)return v.toISOString().slice(0,10);if(v&&typeof v==='object'){if('formula'in v){if(v.result==null)throw fail('表格公式缺少已计算结果，请在 Excel 中计算并保存');return cell(v.result);}if(v.richText)return v.richText.map(x=>x.text).join('');return v.text??v.hyperlink??'';}return v??'';};
export async function readTable(buffer,filename,{sheet=0,headerRow=1}={}){
 let rows,sheets=[];if(/\.csv$/i.test(filename)){let txt=new TextDecoder('utf-8').decode(buffer);if(txt.includes('\ufffd'))txt=new TextDecoder('gb18030').decode(buffer);const first=txt.split(/\r?\n/)[0];const delimiter=first.includes('\t')?'\t':first.includes(';')&&!first.includes(',')?';':',';rows=parse(txt,{bom:true,skip_empty_lines:true,relax_column_count:true,delimiter});}
 else if(/\.xlsx$/i.test(filename)){const w=new ExcelJS.Workbook();await w.xlsx.load(buffer);sheets=w.worksheets.map(s=>s.name);const ws=w.worksheets[Number(sheet)];if(!ws)throw fail('工作表不存在');rows=[];ws.eachRow({includeEmpty:true},r=>rows.push(r.values.slice(1).map(cell)));}else throw fail('请使用 XLSX 或 CSV 文件；旧 XLS 请先另存为 XLSX');
 if(!Number.isInteger(Number(headerRow))||headerRow<1||headerRow>rows.length)throw fail('表头行无效');const headers=rows[headerRow-1].map(v=>String(v??'').trim());if(headers.filter(Boolean).length!==new Set(headers.filter(Boolean)).size)throw fail('表头名称重复，请调整表头行');const records=rows.slice(headerRow).map((r,i)=>({row:Number(headerRow)+i+1,cells:headers.map((_,j)=>r[j]??'')})).filter(r=>r.cells.some(c=>c!==''));if(records.length>20000)throw fail('每次最多导入 20,000 行');const mapping=Object.fromEntries(Object.entries(fields).map(([k,aliases])=>[k,headers.findIndex(h=>aliases.includes(h))]));return {headers,records,sheets,mapping};
}
// Source row numbers identify the imported original, not the business identity.
const contentHash=b=>hash({...normalizeBill(b),lines:b.lines.map(({sourceRow,...l})=>l).sort((a,b)=>a.lineNo.localeCompare(b.lineNo))});
export function previewTable(table,options,s,sources){
 const kind=options.kind||'freight',maintenance=kind==='freight'&&options.mode==='maintenance';
 const mapping={...table.mapping,...options.mapping},groups=new Map(),errors=[],existing=s.bills();let skippedRows=0;
 for(const r of table.records){try{
  const get=k=>{const i=Number(mapping[k]);return i>=0?r.cells[i]??'':'';};
  const recordId=String(get('recordId')||'').trim();
  if(kind==='freight'&&!recordId&&String(get('amount')).trim()===''&&String(get('party')).trim()===''){skippedRows++;continue;}
  if(recordId&&!maintenance)throw fail('文件包含已有记录ID，请选择回导维护表模式');
  const billNo=required(get('billNo'),'账单编号'),party=required(get('party'),'收款单位/人员');
  const category=categoryAliases[get('category')]||get('category')||({freight:'outbound',payroll:'salary',other:'other'})[kind];
  const metadata={kind,billNo,party,period:String(get('period')||options.period),billDate:String(get('billDate')||''),category,owner:resolveOwner(get('owner'),sources.shops),title:String(get('title')||billNo),linkedSource:String(get('linkedSource')||''),note:String(get('note')||'')};
  const version=recordId?Number(get('recordVersion')):null,reason=String(get('reason')||'').trim();
  if(recordId&&(!Number.isSafeInteger(version)||version<1))throw fail('记录版本缺失或无效，请重新导出维护表');
  const key=recordId?'id:'+recordId:billIdentity(metadata);
  if(!groups.has(key))groups.set(key,{...metadata,recordId,version,reason,lines:[],summary:null,sourceRows:[]});
  const g=groups.get(key);
  for(const k of ['billNo','party','period','billDate','category','owner','title','linkedSource','note'])if(g[k]!==metadata[k])throw fail('同一账单的月份、店铺、日期、项目、说明或备注不一致');
  if(g.version!==version||g.reason!==reason)throw fail('同一账单的记录版本或更正原因不一致');
  const type=String(get('rowType')||'').trim();if(type&&!['汇总','明细','summary','detail'].includes(type))throw fail('行类型仅支持汇总或明细');
  const amount=cents(get('amount')),payroll=kind==='payroll'?{grossCents:cents(get('gross')),withheldCents:cents(get('withheld')||'0'),netCents:cents(get('net')),employerCents:cents(get('employer')||'0')}:{ };
  if(['汇总','summary'].includes(type)){if(g.summary!=null)throw fail('同一账单存在多条汇总行');g.summary=amount;g.summaryPayroll=payroll;}
  else g.lines.push({lineNo:String(get('lineNo')||r.row),label:String(get('label')||party),amountCents:amount,sourceRow:r.row,...payroll});
  g.sourceRows.push(r.row);
 }catch(e){errors.push({row:r.row,message:e.message});}}
 const bills=[];
 for(const g of groups.values()){try{
  const total=g.lines.length?sum(g.lines.map(l=>l.amountCents)):g.summary;
  if(g.summary!=null&&g.lines.length&&g.summary!==total)throw fail('汇总金额与明细合计不一致');
  const summaryOnly=!g.lines.length;
  if(summaryOnly)g.lines=[{lineNo:'summary',label:g.party,sourceRow:g.sourceRows[0],amountCents:total,...g.summaryPayroll}];
  const bill=normalizeBill({...g,amountCents:total});
  const old=g.recordId?existing.find(b=>b.id===g.recordId):existing.find(b=>s.identity(b)===s.identity(bill));
  if(g.recordId&&(!old||old.kind!=='freight'))throw fail('记录ID不存在或不是运费账单');
  if(old&&g.recordId&&summaryOnly&&!old.lines.length)bill.lines=[];
  s.validateLink(bill,sources,old?.id);
  let status='new',message='',changes=[];
  if(old){
   if(g.recordId&&(old.version!==g.version||old.voided)){status='conflict';message='记录已变化或作废，请重新导出维护表';}
   else if(contentHash(old)===contentHash(bill)&&!old.voided)status='duplicate';
   else if(g.recordId&&maintenance){
    s.validateUpdate(old,{...bill,version:g.version,reason:g.reason},sources);status='update';
    const names={billNo:'账单编号',party:'物流公司',period:'所属月份',billDate:'账单日期',category:'运费用途',owner:'店铺',title:'说明',note:'备注',linkedSource:'关联来源',amountCents:'应付金额'};
    changes=Object.keys(names).filter(k=>old[k]!==bill[k]).map(k=>({field:names[k],before:old[k],after:bill[k],money:k==='amountCents'}));
    const oldLines=new Map(old.lines.map(l=>[l.lineNo,l])),newLines=new Map(bill.lines.map(l=>[l.lineNo,l]));for(const number of new Set([...oldLines.keys(),...newLines.keys()])){const a=oldLines.get(number),b=newLines.get(number),describe=l=>l?l.label+' / '+(l.amountCents/100).toFixed(2)+' 元':'无';if(describe(a)!==describe(b))changes.push({field:'明细 '+number,before:describe(a),after:describe(b)});}
   }else {status='conflict';message='相同账单内容不同，请导出最新维护表并填写更正原因后回导';}
  }
  bills.push({bill,status,message,changes,sourceRows:g.sourceRows,existingId:old?.id,version:g.version,reason:g.reason});
 }catch(e){errors.push({row:g.sourceRows[0],message:e.message});}}
 const links=new Set(),identities=new Set();for(const b of bills){
  const key=s.identity(b.bill);if(identities.has(key))errors.push({row:b.sourceRows[0],message:'本批次多张账单具有相同店铺、月份、物流公司和编号'});identities.add(key);
  if(b.bill.linkedSource){if(links.has(b.bill.linkedSource))errors.push({row:b.sourceRows[0],message:'本批次多笔账单关联同一来源'});links.add(b.bill.linkedSource);}
 }
 const count=status=>bills.filter(b=>b.status===status).length;
 return {headers:table.headers,sheets:table.sheets,mapping,bills,errors,rows:table.records.length,skippedRows,newCount:count('new'),updateCount:count('update'),duplicateCount:count('duplicate'),conflictCount:count('conflict'),amountCents:sum(bills.filter(b=>b.status==='new').map(b=>b.bill.amountCents)),updateDeltaCents:sum(bills.filter(b=>b.status==='update').map(b=>b.bill.amountCents-existing.find(x=>x.id===b.existingId).amountCents)),canCommit:!errors.length&&!count('conflict')&&(count('new')+count('update')>0),revision:hash({bills:existing,sources:sources.revision,candidates:bills})};
}

export async function template(kind){const w=new ExcelJS.Workbook();const ws=w.addWorksheet('待填写');const headers=['账单编号','收款单位/人员','所属月份','账单日期','费用项目','说明','应付金额','行类型','明细编号','明细说明',...(kind==='payroll'?['应发工资','个人代扣','实发工资','公司承担']:[]),'归属','关联来源','备注'];ws.addRow(headers);ws.columns=headers.map(h=>({width:h.includes('说明')?26:20}));ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF155E56'}};ws.views=[{state:'frozen',ySplit:1}];const help=w.addWorksheet('填写说明');['一张账单使用同一编号、收款单位和费用项目；不同明细填写不同明细编号。','行类型：明细/汇总。汇总与明细同时出现时只计明细，并核对合计。','月份：YYYY-MM；日期：YYYY-MM-DD；金额：元。账单不会自动视为已付款。','工资表应付金额 = 应发工资 + 公司承担；实发工资 = 应发工资 − 个人代扣。','归属留空为 company（公司共用）；关联来源留空为新费用。','费用项目：进货运输、销售发货、退货运输、云仓服务、工资与奖金、劳务、软件服务、房租、报销、其他费用。'].forEach(t=>help.addRow([t]));help.getColumn(1).width=110;return w.xlsx.writeBuffer();}
