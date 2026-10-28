import JSZip from 'jszip';
import {parse} from 'csv-parse/sync';
import {writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {money,safeSum,hash,id,now,fail,bounds,month,date,beijing,required,monthsBetween} from './util.mjs';
import {insertObject} from './ledger.mjs';
import {monthData} from './report.mjs';

const HEADERS=['商户订单号','发生时间','收入金额（+元）','支出金额（-元）','账务类型','备注','业务描述'];
export async function parsePddZip(buffer) {
  const zip=await JSZip.loadAsync(buffer,{checkCRC32:true}),entries=Object.values(zip.files).filter(f=>!f.dir);
  if(entries.length!==1||!entries[0].name.toLowerCase().endsWith('.csv'))throw fail('拼多多账务包应仅含一份 CSV 明细');
  const bytes=await entries[0].async('nodebuffer');if(bytes.length>50*1024*1024)throw fail('单份账单不能超过 50 MB');
  let text=new TextDecoder('utf-8').decode(bytes);if(text.includes('\ufffd'))text=new TextDecoder('gb18030').decode(bytes);
  const rows=parse(text,{bom:true,relax_column_count:true,skip_empty_lines:false});
  const headerIndex=rows.findIndex(r=>r.length===7&&r.every((v,i)=>String(v).trim()===HEADERS[i]));if(headerIndex<0)throw fail('不是已验证的拼多多店铺账务明细格式');
  const scope=text.match(/起始时间[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+终止时间[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);if(!scope)throw fail('文件缺少导出起止时间');
  const occurrences=new Map(),records=[],groups={};
  for(let index=headerIndex+1;index<rows.length;index++) {
    const row=rows[index];if(row.length!==7)continue;
    const values=row.map(v=>String(v).trim());const [order,time,inc,exp,type,note,description]=values;
    if(!/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time))throw fail(`第 ${index+1} 行发生时间无效`);
    const income=money(inc||'0'),expense=money(exp||'0');if(income<0||expense>0||income&&expense)throw fail(`第 ${index+1} 行收支方向异常，需要人工核对`);
    if(time<scope[1]||time>scope[2])throw fail(`第 ${index+1} 行不在文件声明的日期范围内`);
    const amount=income+expense,code=description.split('|')[0];
    const digest=hash(values),ordinal=(occurrences.get(digest)||0)+1;occurrences.set(digest,ordinal);
    const kind=code==='0080001'?'withdrawal':code==='0070003'?'transfer':'platform_flow';
    records.push({shop_id:'',date:time.slice(0,10),kind,amount,currency:'CNY',external_id:`pdd-${digest}-${ordinal}`,match_key:order==='-'?'':order,order_ref:'',category:description,deducted:0,note:JSON.stringify({occurred_at:time,original_type:type,original_note:note,order_ref:order,source_row:index+1,id_basis:'原文内容哈希 + 相同行出现次数；官方文件无独立流水号'}),source:'拼多多货款账务明细'});
    groups[description]||={description,count:0,income:0,expense:0};groups[description].count++;groups[description].income+=income;groups[description].expense+=expense;
  }
  const income=safeSum(records.filter(r=>r.amount>0).map(r=>r.amount)),expense=safeSum(records.filter(r=>r.amount<0).map(r=>r.amount));
  const incomeFooter=text.match(/#收入合计[：:](\d+)笔([\d,.]+)元/),expenseFooter=text.match(/#支出合计[：:](\d+)笔(-?[\d,.]+)元/),netFooter=text.match(/#总计[：:](-?[\d,.]+)元/);
  if(!incomeFooter||!expenseFooter||!netFooter||money(incomeFooter[2])!==income||money(expenseFooter[2])!==expense||money(netFooter[1])!==income+expense||+incomeFooter[1]+ +expenseFooter[1]!==records.length)throw fail('明细与官方文件尾部笔数或金额不一致，不能导入');
  const months=[...new Set(records.map(r=>r.date.slice(0,7)))].sort();
  return {filename:path.basename(entries[0].name),csv:bytes,records,scope:{start:scope[1],end:scope[2]},months,summary:{count:records.length,income,expense,net:income+expense,income_count:+incomeFooter[1],expense_count:+expenseFooter[1],footer_verified:true},groups:Object.values(groups),duplicate_content:records.length-occurrences.size};
}

import {pddShop,mergePlan,PDD_SOURCE,pddPeriodRows} from './pdd-services.mjs';
export {pddStatementYear,setAttribution,unassignedBatches,movementsPage,movementRows,movementDetail,saveReference} from './pdd-services.mjs';
export async function stagePdd(s,buffer,filename,context){
  if(!context||!context.shop_id)throw fail('请选择拼多多店铺或待归属区');const shop=context.shop_id;if(shop!=='__unassigned__')pddShop(s,shop);
  const p=await parsePddZip(buffer);p.records=p.records.map(r=>({...r,shop_id:shop}));
  const digest=hash(buffer),original=path.join('originals',digest+'.zip');if(!existsSync(path.join(s.dir,original)))writeFileSync(path.join(s.dir,original),buffer,{flag:'wx'});
  const old=s.get("SELECT id,status FROM imports WHERE sha256=? AND dataset='pdd_funds' AND shop_id=? AND status<>'rolled_back'",digest,shop);if(old)return {id:old.id,status:old.status,...p,records:undefined,csv:undefined};
  const batchId=id(),ctx={month:p.months[0]||p.scope.start.slice(0,7),months:p.months,scope:p.scope,source:PDD_SOURCE,classification:'账户动账',original_filename:filename},preview={...p,csv:undefined,revision:hash(p.records)};
  s.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)',batchId,shop,'pdd_funds',path.basename(filename),digest,original,now(),'previewed',JSON.stringify(ctx),JSON.stringify(preview));
  s.run('INSERT INTO batch_attributions VALUES(?,?,?,?)',batchId,shop==='__unassigned__'?'unassigned':'confirmed','用户选择导入归属',now());s.audit('pdd.preview',batchId,{shop_id:shop,scope:p.scope,summary:p.summary});return {id:batchId,status:'previewed',...preview,records:undefined};
}
export function pddPreview(s,batchId){
  const b=s.get("SELECT * FROM imports WHERE id=? AND dataset='pdd_funds'",batchId);if(!b)throw fail('账单不存在',404);const p=JSON.parse(b.preview_json),attribution=s.get('SELECT status FROM batch_attributions WHERE import_id=?',batchId)?.status||'confirmed';
  const records=p.records.map(r=>({...r,shop_id:b.shop_id})),plan=attribution==='confirmed'?mergePlan(s,records,b.shop_id):{records,duplicates:0,shared_orders:0};
  return {id:batchId,status:b.status,shop_id:b.shop_id,attribution,...p,records:undefined,duplicates:plan.duplicates,merge:{added:plan.records.length,shared_orders:plan.shared_orders,rule:'同店铺按订单号、发生时间、业务代码、币种、金额及出现次数识别流水'},locked:monthsBetween(p.scope.start.slice(0,7),p.scope.end.slice(0,7)).some(m=>s.get('SELECT 1 FROM month_locks WHERE month=?',m))};
}
export function commitPdd(s,batchId,expected){return s.transaction(()=>{
  const b=s.get("SELECT * FROM imports WHERE id=? AND dataset='pdd_funds'",batchId);if(!b||b.status!=='previewed')throw fail('批次不存在或已提交');if(s.get("SELECT 1 FROM batch_attributions WHERE import_id=? AND status='unassigned'",batchId))throw fail('请先确认批次所属店铺',409);
  pddShop(s,b.shop_id);const p=JSON.parse(b.preview_json);if(p.revision!==expected)throw fail('预览版本已变化',409);for(const m of monthsBetween(p.scope.start.slice(0,7),p.scope.end.slice(0,7)))if(s.get('SELECT 1 FROM month_locks WHERE month=?',m))throw fail('涉及锁定月份，原件保留待处理',423);
  const plan=mergePlan(s,p.records.map(r=>({...r,shop_id:b.shop_id})),b.shop_id);for(const r of plan.records)insertObject(s,'ledger',{id:id(),...r,batch_id:batchId,created_at:now(),updated_at:now()});
  const result={added:plan.records.length,skipped:plan.duplicates,shared_orders:plan.shared_orders};s.run("UPDATE imports SET status='committed' WHERE id=?",batchId);s.audit('pdd.commit',batchId,{...result,shop_id:b.shop_id,scope:p.scope});return result;
});}
export function pddFundsReport(s,period,grain='month',shop){
  pddShop(s,shop);if(!['day','month','year'].includes(grain))throw fail('时间粒度无效');
  if(grain==='year'){if(!/^20\d{2}$/.test(period))throw fail('年份无效');}else if(grain==='month')month(period);else if(!/^20\d{2}-\d{2}-\d{2}$/.test(period)||date(period)!==period)throw fail('日期无效');
  const months=grain==='year'?Array.from({length:12},(_,i)=>period+'-'+String(i+1).padStart(2,'0')):[period.slice(0,7)];
  const range=grain==='year'?[period+'-01-01',period+'-12-31']:grain==='day'?[period,period]:bounds(period),rows=pddPeriodRows(s,shop,...range),daily={},groups={};
  for(const r of rows){const key=grain==='year'?r.date.slice(0,7):r.date;daily[key]||={date:key,income:0,expense:0,net:0};daily[key][r.amount>0?'income':'expense']+=r.amount;daily[key].net+=r.amount;groups[r.category]||={category:r.category,count:0,income:0,expense:0};groups[r.category].count++;groups[r.category][r.amount>0?'income':'expense']+=r.amount;}
  const labels=grain==='year'?months:grain==='day'?[period]:Array.from({length:+bounds(period)[1].slice(8)},(_,i)=>period+'-'+String(i+1).padStart(2,'0'));
  return {shop_id:shop,count:rows.length,income:rows.length?safeSum(rows.filter(r=>r.amount>0).map(r=>r.amount)):null,expense:rows.length?safeSum(rows.filter(r=>r.amount<0).map(r=>r.amount)):null,daily:labels.map(d=>daily[d]||{date:d,income:null,expense:null,net:null}),groups:Object.values(groups)};
}
