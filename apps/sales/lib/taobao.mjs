import {readTable,stageImport,commitImport} from './importer.mjs';
import {hash,now,month,bounds,date,fail,safeSum,beijing} from './util.mjs';
import {pddPeriodRows,aggregateMovements} from './pdd-services.mjs';
export const TAOBAO_SOURCE='淘宝官方交易货款账单（账期口径）';
const HEADERS=['账期','账单大类','业务大类','业务小类','订单号','子订单号','下单时间','确认收货时间','商品ID','sku','商品名称','数量','单价（元）','订单实际金额（元）','退款单号','退款金额（元）','收/付渠道','业务流水号','商户订单号','打款时间','打款更新时间','备注'];
import {money} from './util.mjs';
function shop(s,id){if(!s.shops().some(x=>x.id===id&&x.platform==='淘宝'))throw fail('请选择已登记的淘宝店铺');}
export async function parseTaobao(buffer,filename){
 const table=await readTable(buffer,filename);if(table.headers.length!==HEADERS.length||!HEADERS.every((h,i)=>table.headers[i].trim()===h))throw fail('不是已验证的淘宝交易货款 CSV 格式');
 const match=filename.match(/^交易货款_(20\d{2})(\d{2})_\1\2\.csv$/);if(!match)throw fail('请保留官方单月文件名：交易货款_YYYYMM_YYYYMM.csv');const m=month(match[1]+'-'+match[2]),records=[],seen=new Map();
 for(const [index,row] of table.rows.entries()){
  if(row.length!==HEADERS.length)throw fail(`第 ${index+2} 行列数异常`);const raw=Object.fromEntries(HEADERS.map((h,i)=>[h,String(row[i]??'').trim()])),bill=raw.账期;if(!/^20\d{6}$/.test(bill))throw fail(`第 ${index+2} 行账期异常`);
  const day=date(bill.slice(0,4)+'-'+bill.slice(4,6)+'-'+bill.slice(6));if(!day.startsWith(m))throw fail('账期与文件名月份不同');if(raw.账单大类!=='货款收入'||raw.业务大类!=='交易货款')throw fail('包含尚未识别的账单业务');
  if(!raw.订单号||!raw.子订单号||!raw.业务流水号)throw fail('缺少主订单、子订单或业务流水号');
  const income=money(raw['订单实际金额（元）']),refund=money(raw['退款金额（元）']);if(income<0||refund<0)throw fail('原件出现负数金额，需要核对');
  for(const [direction,amount] of [['income',income],['expense',-refund]]){if(!amount)continue;const key=hash([raw.业务流水号,raw.订单号,raw.子订单号,raw.退款单号,day,direction]),ordinal=(seen.get(key)||0)+1;seen.set(key,ordinal);
   const occurred=/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.打款时间)&&raw.打款时间.startsWith(day)?raw.打款时间:day+' 00:00:00';
   records.push({date:day,kind:'settlement',amount,currency:'CNY',external_id:'tb-'+key+'-'+ordinal,match_key:raw.业务流水号,order_ref:raw.订单号,category:direction==='income'?'tb_income|交易收入':'tb_refund|退款',deducted:0,source:TAOBAO_SOURCE,note:JSON.stringify({occurred_at:occurred,order_ref:raw.订单号,original_type:direction==='income'?'交易收入':'退款',original_note:`${raw.商品名称}；数量 ${raw.数量}；子订单 ${raw.子订单号}；渠道 ${raw['收/付渠道']}；备注 ${raw.备注}`,source_row:index+2,raw})});
  }
 }
 return {month:m,records,original_rows:table.rows.length,summary:{count:records.length,income:safeSum(records.filter(r=>r.amount>0).map(r=>r.amount)),expense:safeSum(records.filter(r=>r.amount<0).map(r=>r.amount)),order_count:new Set(records.filter(r=>r.amount>0).map(r=>r.order_ref)).size}};
}
function same(a,b){return ['shop_id','date','kind','amount','currency','external_id','match_key','order_ref','category','deducted','source'].every(k=>a[k]===b[k])&&JSON.stringify(JSON.parse(a.note).raw)===JSON.stringify(JSON.parse(b.note).raw);}
export async function stageTaobao(s,buffer,filename,shop_id){
 shop(s,shop_id);const parsed=await parseTaobao(buffer,filename),old=s.get("SELECT id,status FROM imports WHERE shop_id=? AND sha256=? AND status<>'rolled_back' AND dataset='ledger'",shop_id,hash(buffer));if(old)return {...old,month:parsed.month,summary:parsed.summary};
 const batch=await stageImport(s,buffer,filename,{shop_id,month:parsed.month,dataset:'ledger'}),records=[],duplicates=[],conflicts=[];
 for(const r of parsed.records.map(r=>({...r,shop_id}))){const old=s.get('SELECT * FROM ledger WHERE shop_id=? AND kind=? AND external_id=?',shop_id,r.kind,r.external_id);if(old)(same(old,r)?duplicates:conflicts).push({row:JSON.parse(r.note).source_row,message:'相同货款流水'});else records.push(r);}
 const context={shop_id,month:parsed.month,dataset:'ledger',source:TAOBAO_SOURCE,definition:'官方账期口径；收入与退款分行保存，不等同支付销售额；文件名声明月份，完整性待平台月汇总核对',scope:{start:bounds(parsed.month)[0]+' 00:00:00',end:bounds(parsed.month)[1]+' 23:59:59'},scope_basis:'官方文件名声明，尚未对照平台汇总'};
 const locked=!!s.get('SELECT 1 FROM month_locks WHERE month=?',parsed.month),preview={context,records,errors:[],duplicates,conflicts,locked,source_summary:parsed.summary,summary:{total:parsed.original_rows,valid:records.length,duplicates:duplicates.length,conflicts:conflicts.length,errors:0},revision:hash(records)};
 s.run('UPDATE imports SET status=?,context_json=?,preview_json=? WHERE id=?',locked?'pending_locked':'previewed',JSON.stringify(context),JSON.stringify(preview),batch.id);s.audit('taobao.preview',batch.id,{month:parsed.month,summary:preview.summary,source_summary:parsed.summary});return {id:batch.id,status:locked?'pending_locked':'previewed',month:parsed.month,...preview,records:undefined};
}
export {commitImport as commitTaobao};
function totals(rows){const t=aggregateMovements(rows);return {...t,income:rows.length?t.income:null,expense:rows.length?t.expense:null,net:rows.length?t.net:null};}
export function taobaoFunds(s,period,grain,shop_id){shop(s,shop_id);if(!['day','month','year'].includes(grain))throw fail('时间粒度无效');let range;if(grain==='year'){if(!/^20\d{2}$/.test(period))throw fail('年份无效');range=[period+'-01-01',period+'-12-31'];}else if(grain==='month')range=bounds(month(period));else{if(date(period)!==period)throw fail('日期无效');range=[period,period];}
 const rows=pddPeriodRows(s,shop_id,...range,TAOBAO_SOURCE),groups=new Map(),daily=new Map();for(const r of rows){const key=grain==='year'?r.date.slice(0,7):r.date;if(!daily.has(key))daily.set(key,[]);daily.get(key).push(r);if(!groups.has(r.category))groups.set(r.category,{category:r.category,count:0,income:0,expense:0});const g=groups.get(r.category);g.count++;g[r.amount>0?'income':'expense']+=r.amount;}
 const labels=grain==='year'?Array.from({length:12},(_,i)=>period+'-'+String(i+1).padStart(2,'0')):grain==='day'?[period]:Array.from({length:+range[1].slice(8)},(_,i)=>period+'-'+String(i+1).padStart(2,'0'));return {shop_id,...totals(rows),groups:[...groups.values()],daily:labels.map(d=>({date:d,...totals(daily.get(d)||[])}))};
}
export function taobaoStatement(s,year,shop_id){shop(s,shop_id);if(!/^20\d{2}$/.test(year))throw fail('年份无效');const current=beijing(),limit=year===current.date.slice(0,4)?+current.month.slice(5):year>current.date.slice(0,4)?0:12;
 const batches=s.all("SELECT id,filename,context_json FROM imports WHERE shop_id=? AND dataset='ledger' AND status='committed'",shop_id).map(b=>({...b,ctx:JSON.parse(b.context_json)})).filter(b=>b.ctx.source===TAOBAO_SOURCE);
 return {year,shop_id,shop:s.shops().find(x=>x.id===shop_id).name,currency:'CNY',months:Array.from({length:limit},(_,i)=>{const m=year+'-'+String(limit-i).padStart(2,'0'),sources=batches.filter(b=>b.ctx.month===m),rows=pddPeriodRows(s,shop_id,...bounds(m),TAOBAO_SOURCE);return {month:m,...totals(rows),coverage:{status:sources.length?'partial':'missing',intervals:[],sources:sources.map(b=>({id:b.id,filename:b.filename})),gaps:[]},comparison:'no_reference'};})};
}
export function taobaoMovementRows(s,q){shop(s,q.shop_id);const from=q.from?date(q.from):q.month?bounds(month(q.month))[0]:'2000-01-01',to=q.to?date(q.to):q.month?bounds(month(q.month))[1]:'2099-12-31';if(from>to)throw fail('开始日期不能晚于结束日期');if(q.direction&&!['income','expense'].includes(q.direction))throw fail('收支无效');
 const batches=new Map(s.all('SELECT id,filename,original_path FROM imports WHERE shop_id=?',q.shop_id).map(b=>[b.id,b]));
 let rows=pddPeriodRows(s,q.shop_id,from,to,TAOBAO_SOURCE).map(r=>{const m=JSON.parse(r.note),batch=batches.get(r.batch_id),b=batch?{filename:batch.filename,original_path:batch.original_path}:{};return {...r,...b,occurred_at:m.occurred_at,order_no:r.order_ref,category_label:m.original_type,original_type:m.original_type,business_code:'原件未提供',original_note:m.original_note,source_row:m.source_row,raw:m.raw};});const facets={categories:[...new Set(rows.map(r=>r.category_label))],batches:[...new Map(rows.map(r=>[r.batch_id,{id:r.batch_id,filename:r.filename}])).values()]};
 if(q.q)rows=rows.filter(r=>r.order_no.includes(q.q)||r.raw.子订单号.includes(q.q));if(q.batch_id)rows=rows.filter(r=>r.batch_id===q.batch_id);if(q.category)rows=rows.filter(r=>r.category_label===q.category);if(q.direction)rows=rows.filter(r=>q.direction==='income'?r.amount>0:r.amount<0);
 const sort=q.sort||'occurred_at';if(!['occurred_at','amount','order_no','category'].includes(sort)||q.sort_dir&&!['asc','desc'].includes(q.sort_dir))throw fail('排序无效');rows.sort((a,b)=>{const k=sort==='category'?'category_label':sort,sign=q.sort_dir==='asc'?1:-1;return (a[k]<b[k]?-1:a[k]>b[k]?1:a.id.localeCompare(b.id))*sign;});return {rows,facets,from,to,unassigned:false};
}
export function taobaoMovements(s,q){const all=taobaoMovementRows(s,q),size=+(q.page_size||50),page=+(q.page||1);if(![50,100].includes(size)||!Number.isSafeInteger(page)||page<1)throw fail('分页无效');return {...all,rows:all.rows.slice((page-1)*size,page*size),total:all.rows.length,totals:aggregateMovements(all.rows),page,page_size:size,attribution:'confirmed'};}
export function taobaoMovement(s,id,q){const row=taobaoMovementRows(s,{shop_id:q.shop_id}).rows.find(r=>r.id===id);if(!row)throw fail('流水不存在',404);return row;}
