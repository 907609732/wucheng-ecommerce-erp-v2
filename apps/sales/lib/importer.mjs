import ExcelJS from 'exceljs';
import {parse} from 'csv-parse/sync';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {id,hash,now,month,bounds,fail,serial} from './util.mjs';
import {normalizeLedger,normalizeOperation,insertObject,validateShop,validateManualRelation} from './ledger.mjs';

export const FIELDS={
  operations:{start:'开始日期',end:'结束日期',currency:'币种',sales:'支付金额',orders:'支付订单数',refunds:'退款金额',ad_spend:'广告消耗',ad_sales:'广告归因成交额',visitors:'期间访客数',buyers:'期间支付买家数'},
  ledger:{date:'发生日期',kind:'流水类型',amount:'金额',currency:'币种',external_id:'业务编号',match_key:'结算批次号',order_ref:'关联销售编号',category:'费用项目',deducted:'平台已扣',note:'备注'}
};
const aliases={start:['日期','统计日期','开始日期'],end:['结束日期'],sales:['支付金额','成交金额','销售额'],orders:['支付订单数'],refunds:['退款金额'],ad_spend:['广告消耗','花费'],ad_sales:['广告归因成交额'],visitors:['访客数','期间访客数'],buyers:['支付买家数'],date:['发生日期','记账日期','交易时间','到账时间'],kind:['流水类型'],amount:['金额','发生金额'],currency:['币种'],external_id:['业务编号','流水号','交易号','商户订单号'],match_key:['结算批次号'],order_ref:['关联销售编号'],category:['费用项目'],deducted:['平台已扣'],note:['备注']};
function cell(v){if(v==null)return '';if(v instanceof Date)return v.toISOString().slice(0,10);if(typeof v==='object'){if('result'in v)return cell(v.result);if(v.richText)return v.richText.map(x=>x.text).join('');if(v.text)return v.text;return '';}return v;}
export async function readTable(buffer,filename,sheetName,headerRow=1) {
  let sheets=[];
  if(/\.(csv|tsv)$/i.test(filename)) {
    let text=new TextDecoder('utf-8').decode(buffer);if(text.includes('\ufffd'))text=new TextDecoder('gb18030').decode(buffer);
    sheets=[{name:'CSV',rows:parse(text,{bom:true,delimiter:/\.tsv$/i.test(filename)?'\t':',',skip_empty_lines:true,relax_column_count:true})}];
  } else if(/\.xlsx$/i.test(filename)) {
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
    if(wb.worksheets.some(w=>w.rowCount>50001||w.columnCount>250))throw fail('单个工作表最多 50,000 行、250 列，请按月份拆分');
    sheets=wb.worksheets.map(w=>({name:w.name,rows:Array.from({length:w.rowCount},(_,i)=>Array.from({length:w.columnCount},(_,j)=>cell(w.getCell(i+1,j+1).value)))}));
  } else throw fail('请使用官方 CSV、TSV 或 XLSX；旧 XLS 请先另存为 XLSX');
  const sheet=sheetName?sheets.find(s=>s.name===sheetName):sheets[0];if(!sheet)throw fail('找不到工作表');
  if(!Number.isInteger(+headerRow)||+headerRow<1||+headerRow>100)throw fail('表头行必须为 1–100');
  const headers=(sheet.rows[+headerRow-1]||[]).map(String);if(!headers.length)throw fail('表头为空');
  const rows=sheet.rows.slice(+headerRow).filter(r=>r.some(v=>v!==''));if(rows.length>50000)throw fail('最多导入 50,000 行');
  return {sheets:sheets.map(s=>s.name),sheet:sheet.name,headers,rows};
}
export function detectMapping(headers,dataset) {return Object.fromEntries(Object.keys(FIELDS[dataset==='operations'?'operations':'ledger']).map(k=>{const i=headers.findIndex(h=>[k,FIELDS[dataset==='operations'?'operations':'ledger'][k],...(aliases[k]||[])].some(a=>a.trim().toLowerCase()===h.trim().toLowerCase()));return [k,i>=0?String(i):''];}));}
export async function stageImport(s,buffer,filename,ctx) {
  validateShop(ctx.shop_id,s.shops());month(ctx.month);if(!['operations','ledger'].includes(ctx.dataset))throw fail('导入类型无效');
  const digest=hash(buffer),ext=path.extname(filename).toLowerCase();
  const original_path=path.join('originals',digest+ext),full=path.join(s.dir,original_path);
  const table=await readTable(buffer,filename,ctx.sheet,Number(ctx.header_row||1));
  if(!existsSync(full))writeFileSync(full,buffer,{flag:'wx'});
  const importId=id(),context={...ctx,sheet:table.sheet,header_row:Number(ctx.header_row||1)};
  const meta={headers:table.headers,sheets:table.sheets,sample:table.rows.slice(0,5),total:table.rows.length,mapping:detectMapping(table.headers,ctx.dataset)};
  s.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)',importId,ctx.shop_id,ctx.dataset,path.basename(filename),digest,original_path,now(),'staged',serial(context),serial(meta));
  s.audit('import.stage',importId,{shop:ctx.shop_id,month:ctx.month,sha256:digest,rows:table.rows.length});
  return {id:importId,...meta};
}
export async function previewImport(s,importId,options) {
  const batch=s.get('SELECT * FROM imports WHERE id=?',importId);if(!batch||batch.status==='committed')throw fail('导入批次不存在或已提交');
  const ctx={...JSON.parse(batch.context_json),source:options.source,definition:options.definition,compatible:options.compatible,default_kind:options.default_kind,default_currency:options.default_currency||'CNY'};
  const table=await readTable(readFileSync(path.join(s.dir,batch.original_path)),batch.filename,ctx.sheet,ctx.header_row);
  const mapping=options.mapping||{},records=[],errors=[],duplicates=[],conflicts=[],seen=new Map();const [start,end]=bounds(ctx.month);
  for(const [i,row]of table.rows.entries()) {
    try {
      const raw={};for(const [k,col]of Object.entries(mapping))if(col!==''&&col!=null){if(!Number.isInteger(+col)||+col<0||+col>=table.headers.length)throw fail('列映射无效');raw[k]=row[+col];}
      raw.currency=raw.currency||ctx.default_currency;raw.kind=raw.kind||ctx.default_kind;
      if(typeof raw.external_id==='number'&&!Number.isSafeInteger(raw.external_id))throw fail('业务编号在文件中已丢失精度，请使用文本格式原始账单');
      const r=ctx.dataset==='operations'?normalizeOperation(raw,{shop_id:ctx.shop_id,source:ctx.source,definition:ctx.definition,compatible:ctx.compatible},s.shops()):normalizeLedger(raw,{shop_id:ctx.shop_id,source:ctx.source},s.shops());
      if((r.date||r.start)<start||(r.date||r.end)>end)throw fail('记录不在所选月份内，请拆分文件或重新选择月份');
      const key=ctx.dataset==='operations'?`${r.start}|${r.end}|${r.currency}`:`${r.kind}|${r.external_id}`;
      const old=seen.get(key)|| (ctx.dataset==='operations'?s.get('SELECT * FROM operations WHERE shop_id=? AND start=? AND end=? AND currency=?',r.shop_id,r.start,r.end,r.currency):s.get('SELECT * FROM ledger WHERE shop_id=? AND kind=? AND external_id=?',r.shop_id,r.kind,r.external_id));
      if(old) {
        const same=Object.entries(r).every(([k,v])=>old[k]===v);
        (same?duplicates:conflicts).push({row:i+ctx.header_row+1,message:same?'相同业务记录，将跳过':'相同业务编号或统计区间存在不同数值，需先处理冲突'});
      } else {seen.set(key,r);records.push({...r,_row:i+ctx.header_row+1});}
    }catch(e){errors.push({row:i+ctx.header_row+1,message:e.message});}
  }
  const locked=!!s.get('SELECT 1 FROM month_locks WHERE month=?',ctx.month);
  const preview={mapping,records,errors,duplicates,conflicts,locked,context:ctx,summary:{total:table.rows.length,valid:records.length,duplicates:duplicates.length,conflicts:conflicts.length,errors:errors.length},revision:hash(records)};
  s.run('UPDATE imports SET status=?,context_json=?,preview_json=? WHERE id=?',locked?'pending_locked':'previewed',serial(ctx),serial(preview),importId);
  return {...preview,records:records.slice(0,200),revision:preview.revision};
}
export function commitImport(s,importId,expectedRevision) {
  return s.transaction(()=>{
    const batch=s.get('SELECT * FROM imports WHERE id=?',importId);if(!batch||!['previewed','pending_locked'].includes(batch.status))throw fail('请先预览导入');
    const p=JSON.parse(batch.preview_json);if(p.revision!==expectedRevision)throw fail('预览版本已变化，请重新预览',409);
    if(p.errors.length||p.conflicts.length)throw fail('存在错误或冲突，请修正后重新预览');
    if(s.get('SELECT 1 FROM month_locks WHERE month=?',p.context.month))throw fail('月份已锁定，原件已留存待处理',423,'MONTH_LOCKED');
    let added=0,skipped=p.duplicates.length;
    for(const record of p.records) {
      const {_row,...r}=record;
      const old=batch.dataset==='operations'?s.get('SELECT * FROM operations WHERE shop_id=? AND start=? AND end=? AND currency=?',r.shop_id,r.start,r.end,r.currency):s.get('SELECT * FROM ledger WHERE shop_id=? AND kind=? AND external_id=?',r.shop_id,r.kind,r.external_id);
      if(old){if(!Object.entries(r).every(([k,v])=>old[k]===v))throw fail('预览后出现业务冲突，请重新预览',409);skipped++;continue;}
      if(batch.dataset==='ledger')validateManualRelation(s,r);
      insertObject(s,batch.dataset==='operations'?'operations':'ledger',{id:id(),...r,batch_id:importId,...(batch.dataset==='ledger'?{created_at:now(),updated_at:now()}:{})});added++;
    }
    const datasets=batch.dataset==='operations'?['operations']:[...new Set(p.records.map(r=>r.kind).filter(k=>['settlement','receipt','expense'].includes(k)))];
    for(const dataset of datasets)s.run('INSERT INTO coverage VALUES(?,?,?,?,?,?) ON CONFLICT(shop_id,month,dataset) DO UPDATE SET status=\'partial\',evidence=excluded.evidence,updated_at=excluded.updated_at',batch.shop_id,p.context.month,dataset,'partial','已导入，尚未与官方月汇总核对',now());
    s.run('UPDATE imports SET status=? WHERE id=?','committed',importId);s.audit('import.commit',importId,{added,skipped,revision:p.revision});return {added,skipped};
  });
}
export function rollbackImport(s,importId,reason) {
  if(typeof reason!=='string'||reason.trim().length<2)throw fail('请填写撤销原因');
  return s.transaction(()=>{const b=s.get('SELECT * FROM imports WHERE id=?',importId);if(!b||b.status!=='committed')throw fail('该批次尚未提交');
    const rows=s.all('SELECT * FROM ledger WHERE batch_id=?',importId);
    if(rows.some(r=>s.get('SELECT 1 FROM matches WHERE left_id=? OR right_id=?',r.id,r.id)))throw fail('请先撤销本批次的对账匹配');
    const ctx=JSON.parse(b.context_json);if(s.get('SELECT 1 FROM month_locks WHERE month=?',ctx.month))throw fail('月份已锁定',423);
    const ops=s.all('SELECT * FROM operations WHERE batch_id=?',importId);s.run('DELETE FROM operations WHERE batch_id=?',importId);s.run('DELETE FROM ledger WHERE batch_id=?',importId);
    s.run('UPDATE coverage SET status=\'partial\',evidence=?,updated_at=? WHERE shop_id=? AND month=?','导入批次已撤销，需重新核对',now(),b.shop_id,ctx.month);
    s.run('UPDATE imports SET status=? WHERE id=?','rolled_back',importId);s.audit('import.rollback',importId,{reason,rows,operations:ops});return {ok:true};});
}
