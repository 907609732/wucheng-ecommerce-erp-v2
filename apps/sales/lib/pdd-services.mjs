import {hash,id,now,fail,bounds,month,date,beijing,required,safeSum,monthsBetween} from './util.mjs';


export const PDD_SOURCE='拼多多货款账务明细';
// Read only the requested shop and period; closed months use their saved ledger.
export function pddPeriodRows(s,shop,start,end,source=PDD_SOURCE){
 const locks=s.all('SELECT month,snapshot FROM month_locks WHERE month>=? AND month<=?',start.slice(0,7),end.slice(0,7)),locked=new Set(locks.map(x=>x.month));
 const matches=r=>r.shop_id===shop&&r.source===source&&r.date>=start&&r.date<=end;
 const live=s.all('SELECT * FROM active_ledger WHERE shop_id=? AND source=? AND date>=? AND date<=? ORDER BY date,id',shop,source,start,end).filter(r=>!locked.has(r.date.slice(0,7)));
 return [...live,...locks.flatMap(l=>JSON.parse(l.snapshot).ledger.filter(matches))].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
}
export function pddShop(s,shop){if(!s.shops().some(x=>x.id===shop&&x.platform==='拼多多'))throw fail('请选择已登记的拼多多店铺');return shop;}
export function pddMeta(r){try{return JSON.parse(r.note||'{}');}catch{return {};}}
export function movementKey(r){const m=pddMeta(r),order=String(m.order_ref||r.match_key||'').trim(),valid=order&&order!=='-';return hash([r.shop_id,valid?order:'',m.occurred_at||r.date,(r.category||'').split('|')[0],r.currency,r.amount,valid?'':String(m.original_note||'').trim()]);}
export function mergePlan(s,records,shop){
  pddShop(s,shop);const existing=s.all('SELECT * FROM active_ledger WHERE shop_id=? AND source=?',shop,PDD_SOURCE),counts=new Map(),seen=new Map(),ids=new Set(existing.map(r=>r.external_id)),orders=new Set(existing.map(r=>r.match_key).filter(x=>x&&x!=='-')),shared=new Set(),added=[];
  for(const r of existing){const k=movementKey(r);counts.set(k,(counts.get(k)||0)+1);}
  for(const r of records){const k=movementKey(r),n=(seen.get(k)||0)+1;seen.set(k,n);if(r.match_key&&orders.has(r.match_key))shared.add(r.match_key);if(ids.has(r.external_id)||n<=(counts.get(k)||0))continue;added.push(r);}
  return {records:added,duplicates:records.length-added.length,shared_orders:shared.size};
}
export function setAttribution(s,importId,{status,shop_id,reason}){
  if(!['confirmed','unassigned'].includes(status))throw fail('归属状态无效');required(reason,'调整原因',500);if(status==='confirmed')pddShop(s,shop_id);
  return s.transaction(()=>{
    const b=s.get("SELECT * FROM imports WHERE id=? AND dataset='pdd_funds'",importId);if(!b)throw fail('拼多多批次不存在',404);
    const rows=s.all('SELECT * FROM ledger WHERE batch_id=?',importId),context=JSON.parse(b.context_json),months=new Set([...rows.map(x=>x.date.slice(0,7)),...(context.months||[])]);
    if(context.scope)for(const m of monthsBetween(context.scope.start.slice(0,7),context.scope.end.slice(0,7)))months.add(m);
    for(const m of months)if(s.get('SELECT 1 FROM month_locks WHERE month=?',m))throw fail('涉及锁定月份，请先明确解锁',423);
    if(rows.some(r=>s.get('SELECT 1 FROM matches WHERE left_id=? OR right_id=?',r.id,r.id)))throw fail('批次存在对账匹配，请先处理匹配',409);
    const before={shop_id:b.shop_id,status:s.get('SELECT status FROM batch_attributions WHERE import_id=?',importId)?.status||'confirmed'};
    if(status==='confirmed'){
      const others=s.all('SELECT * FROM active_ledger WHERE shop_id=? AND source=? AND (batch_id<>? OR batch_id IS NULL)',shop_id,PDD_SOURCE,importId),keys=new Set(others.map(movementKey)),ids=new Set(others.map(x=>x.external_id));
      if(rows.some(r=>keys.has(movementKey({...r,shop_id}))||ids.has(r.external_id)))throw fail('目标店铺已存在重复流水，请先核对原件；未更改归属',409);
      s.run('UPDATE ledger SET shop_id=?,updated_at=? WHERE batch_id=?',shop_id,now(),importId);s.run('UPDATE imports SET shop_id=? WHERE id=?',shop_id,importId);
    }else{
      const holding='unassigned-'+importId;s.run('INSERT OR IGNORE INTO shops VALUES(?,?,?,?,?)',holding,'待归属','店铺待确认','待核实',0);
      s.run('UPDATE ledger SET shop_id=?,updated_at=? WHERE batch_id=?',holding,now(),importId);s.run('UPDATE imports SET shop_id=? WHERE id=?',holding,importId);
    }
    s.run('INSERT INTO batch_attributions VALUES(?,?,?,?) ON CONFLICT(import_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at',importId,status,reason,now());
    if(b.status==='previewed'){const preview=JSON.parse(b.preview_json);preview.revision=hash({records:preview.records,shop_id:status==='confirmed'?shop_id:null,attribution:status});s.run('UPDATE imports SET preview_json=? WHERE id=?',JSON.stringify(preview),importId);}
    for(const m of months)s.run("UPDATE coverage SET status='partial',evidence=?,updated_at=? WHERE month=? AND shop_id IN (?,?)",'账单归属调整后需重新核对',now(),m,b.shop_id,shop_id||b.shop_id);
    s.audit('import.attribution',importId,{before,after:{status,shop_id:status==='confirmed'?shop_id:null},reason,preserved_rows:rows.length,months:[...months]});return {ok:true,status,rows:rows.length};
  });
}
export function unassignedBatches(s){return s.all("SELECT i.id,i.filename,i.created_at,i.status,a.reason,i.preview_json FROM imports i JOIN batch_attributions a ON a.import_id=i.id WHERE a.status='unassigned' ORDER BY i.created_at DESC").map(({preview_json,...b})=>{const p=JSON.parse(preview_json);return {...b,summary:p.summary,scope:p.scope};});}
export function categoryLabel(r){const code=(r.category||'').split('|')[0],income=r.amount>0;
  const common={'0010002':'交易收入','0010005':'优惠券补贴','0020002':'退款','0020005':'退款退优惠券','0050002':'其他服务','0110001':'服务消费支出','0080001':'提现','0040001':'其他支出','0040002':'扣款','0040004':'扣款','0040003':'运费补偿'};
  if(code==='0030002')return income?'技术服务费返还':'技术服务费';if(income&&['0030001','0130005','0070001'].includes(code))return code==='0070001'?'转账收入':'其他收入';if(code.startsWith('007'))return '转账';return common[code]||pddMeta(r).original_type||(r.category||'未分类').split('|').at(-1);
}
export function aggregateMovements(rows){const groups=new Map();for(const r of rows){const name=categoryLabel(r),direction=r.amount>0?'income':'expense',key=direction+'|'+name;if(!groups.has(key))groups.set(key,{name,direction,count:0,amount:0});const g=groups.get(key);g.count++;g.amount+=r.amount;}
  const incomeRows=rows.filter(r=>r.amount>0),expenseRows=rows.filter(r=>r.amount<0);return {count:rows.length,income:safeSum(incomeRows.map(r=>r.amount)),expense:safeSum(expenseRows.map(r=>r.amount)),income_count:incomeRows.length,expense_count:expenseRows.length,net:safeSum(rows.map(r=>r.amount)),groups:[...groups.values()]};}
function seconds(t){return Date.parse(t.replace(' ','T')+'Z')/1000;}
function timestamp(t){return new Date(t*1000).toISOString().slice(0,19).replace('T',' ');}
export function pddCoverage(s,shop,m){
  const [a,b]=bounds(m),start=seconds(a+' 00:00:00'),end=seconds(b+' 23:59:59');
  const sources=s.all("SELECT i.id,i.filename,i.context_json FROM imports i WHERE i.dataset='pdd_funds' AND i.status='committed' AND i.shop_id=? AND NOT EXISTS(SELECT 1 FROM batch_attributions x WHERE x.import_id=i.id AND x.status='unassigned')",shop).map(x=>({...x,scope:JSON.parse(x.context_json).scope})).filter(x=>x.scope&&x.scope.start<=b+' 23:59:59'&&x.scope.end>=a+' 00:00:00');
  const intervals=sources.map(x=>[Math.max(start,seconds(x.scope.start)),Math.min(end,seconds(x.scope.end))]).sort((x,y)=>x[0]-y[0]),merged=[];
  for(const [a,b] of intervals){const last=merged.at(-1);if(last&&a<=last[1]+1)last[1]=Math.max(last[1],b);else merged.push([a,b]);}
  let cursor=start;const gaps=[];for(const [a,b] of merged){if(a>cursor)gaps.push({start:timestamp(cursor),end:timestamp(a-1)});cursor=b+1;}if(cursor<=end)gaps.push({start:timestamp(cursor),end:timestamp(end)});
  return {status:!merged.length?'missing':gaps.length?'partial':'full',intervals:merged.map(([a,b])=>({start:timestamp(a),end:timestamp(b)})),gaps,sources:sources.map(({context_json,...x})=>x)};
}
export function pddStatementYear(s,year,shop){
  if(!/^20\d{2}$/.test(String(year)))throw fail('年份无效');pddShop(s,shop);const today=beijing(),limit=String(year)===today.date.slice(0,4)?+today.month.slice(5):String(year)>today.date.slice(0,4)?0:12;
  const months=Array.from({length:limit},(_,i)=>`${year}-${String(limit-i).padStart(2,'0')}`).map(m=>{
    const rows=pddPeriodRows(s,shop,...bounds(m)),coverage=pddCoverage(s,shop,m),totals=aggregateMovements(rows),ref=s.get('SELECT * FROM platform_references WHERE shop_id=? AND month=?',shop,m),reference=ref?{...JSON.parse(ref.payload),id:ref.id}:null;
    const hasData=rows.length>0||coverage.status==='full',referenceTotals=reference?aggregateMovements(rows.filter(r=>(pddMeta(r).occurred_at||r.date+' 00:00:00')<=reference.cutoff)):null,comparison=!reference?'no_reference':coverage.gaps.some(g=>g.start<=reference.cutoff)?'range_difference':['income','expense','income_count','expense_count'].every(k=>reference[k]==null||referenceTotals[k]===reference[k])?'match':'amount_difference';
    return {month:m,...totals,income:hasData?totals.income:null,expense:hasData?totals.expense:null,net:hasData?totals.net:null,count:hasData?totals.count:null,status:hasData?'imported':'missing',coverage,comparison,reference,reference_totals:referenceTotals,opening_balance:reference?.opening_balance??null,closing_balance:reference?.closing_balance??null,balance_source:reference?'平台截图参考':null};
  });return {year:String(year),shop_id:shop,shop:s.shops().find(x=>x.id===shop).name,currency:'CNY',months};
}
export function movementRows(s,q){
  const unassigned=q.attribution==='unassigned';if(unassigned){if(!q.batch_id||!s.get("SELECT 1 FROM batch_attributions WHERE import_id=? AND status='unassigned'",q.batch_id))throw fail('请选择待归属批次');}else pddShop(s,q.shop_id);
  let from=q.from?date(q.from):q.month?bounds(month(q.month))[0]:'2000-01-01',to=q.to?date(q.to):q.month?bounds(month(q.month))[1]:'2099-12-31';if(from>to)throw fail('开始日期不能晚于结束日期');
  if(q.direction&&!['income','expense'].includes(q.direction))throw fail('收支方向无效');
  const source=unassigned?'ledger':'active_ledger';
  let rows=s.all(`SELECT l.*,i.filename,i.original_path FROM ${source} l LEFT JOIN imports i ON i.id=l.batch_id WHERE l.source=? AND l.date>=? AND l.date<=? AND ${unassigned?'l.batch_id=?':'l.shop_id=?'}`,PDD_SOURCE,from,to,unassigned?q.batch_id:q.shop_id).map(r=>{const meta=pddMeta(r);return {...r,occurred_at:meta.occurred_at||r.date+' 00:00:00',order_no:meta.order_ref&&meta.order_ref!=='-'?String(meta.order_ref):r.match_key||'',category_label:categoryLabel(r),business_code:(r.category||'').split('|')[0],original_note:meta.original_note||'',original_type:meta.original_type||'',source_row:meta.source_row??null};});
  const facets={categories:[...new Set(rows.map(x=>x.category_label))],batches:[...new Map(rows.filter(x=>x.batch_id).map(x=>[x.batch_id,{id:x.batch_id,filename:x.filename}])).values()]};
  if(q.batch_id)rows=rows.filter(x=>x.batch_id===q.batch_id);if(q.direction)rows=rows.filter(x=>q.direction==='income'?x.amount>0:x.amount<0);if(q.category)rows=rows.filter(x=>x.category_label===q.category);if(q.q){const term=String(q.q).trim();rows=rows.filter(x=>x.order_no.includes(term));}
  const sorts={occurred_at:r=>r.occurred_at,order_no:r=>r.order_no,amount:r=>r.amount,category:r=>r.category_label},sort=q.sort||'occurred_at';if(!sorts[sort]||q.sort_dir&&!['asc','desc'].includes(q.sort_dir))throw fail('排序条件无效');const sign=q.sort_dir==='asc'?1:-1;
  rows.sort((a,b)=>{const av=sorts[sort](a),bv=sorts[sort](b);return (av<bv?-1:av>bv?1:a.id.localeCompare(b.id))*sign;});return {rows,from,to,unassigned,facets};
}
export function movementsPage(s,q){const all=movementRows(s,q),size=Number(q.page_size||50),page=Number(q.page||1);if(![50,100].includes(size)||!Number.isSafeInteger(page)||page<1)throw fail('分页参数无效');const totals=aggregateMovements(all.rows);return {rows:all.rows.slice((page-1)*size,page*size),total:all.rows.length,page,page_size:size,totals,facets:all.facets,from:all.from,to:all.to,attribution:all.unassigned?'unassigned':'confirmed'};}
export function movementDetail(s,recordId,q){const all=movementRows(s,{shop_id:q.shop_id,attribution:q.attribution,batch_id:q.batch_id});const row=all.rows.find(x=>x.id===recordId);if(!row)throw fail('当前店铺或归属范围内没有这笔流水',404);return row;}
export function saveReference(s,input){pddShop(s,input.shop_id);month(input.month);const payload={};for(const key of ['income','expense','income_count','expense_count','opening_balance','closing_balance']){const n=input[key];if(n!=null&&!Number.isSafeInteger(n))throw fail('对照金额或笔数无效');payload[key]=n??null;}
  if(payload.income<0||payload.expense>0||payload.income_count<0||payload.expense_count<0)throw fail('对照收支方向或笔数无效');const cutoff=String(input.cutoff||'');if(!/^20\d{2}-\d{2}-\d{2} 23:59:59$/.test(cutoff)||!cutoff.startsWith(input.month))throw fail('请指定本月截至日期');date(cutoff);
  Object.assign(payload,{cutoff,evidence_path:input.evidence_path||null,evidence_name:input.evidence_name||'平台截图',note:input.note||'平台截图人工对照，未生成流水'});const old=s.get('SELECT id FROM platform_references WHERE shop_id=? AND month=?',input.shop_id,input.month),refId=old?.id||id();
  s.transaction(()=>{if(s.get('SELECT 1 FROM month_locks WHERE month=?',input.month))throw fail('月份已锁定',423);s.run('INSERT INTO platform_references VALUES(?,?,?,?,?) ON CONFLICT(shop_id,month) DO UPDATE SET payload=excluded.payload',refId,input.shop_id,input.month,JSON.stringify(payload),now());s.audit('pdd.reference',refId,{shop_id:input.shop_id,month:input.month,payload});});return {id:refId,...payload};
}
