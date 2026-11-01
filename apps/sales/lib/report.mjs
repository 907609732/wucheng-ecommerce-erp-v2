import { SHOPS, DATASETS, DEFINITIONS, EXCLUSIONS } from './config.mjs';
import { bounds, shiftMonth, safeSum, fxConvert, month, hash, fail } from './util.mjs';

const moneyFields=['sales','refunds','ad_spend','ad_sales'];
const additive=[...moneyFields,'orders'];
function sumNullable(rows,key) {return rows.some(r=>r[key]!=null)?safeSum(rows.map(r=>r[key])):null;}
export function monthData(s,m,{live=false}={}) {
  const lock=s.get('SELECT * FROM month_locks WHERE month=?',month(m));
  if(lock&&!live)return {...JSON.parse(lock.snapshot),locked:true,locked_at:lock.locked_at};
  const [start,end]=bounds(m);
  return {month:m,locked:false,shops:s.shops(),operations:s.all('SELECT * FROM active_operations WHERE start<=? AND end>=? ORDER BY start,end',end,start),ledger:s.all('SELECT * FROM active_ledger WHERE date<=? ORDER BY date,id',end),matches:s.all('SELECT * FROM matches WHERE left_id IN (SELECT id FROM active_ledger) AND right_id IN (SELECT id FROM active_ledger)'),coverage:s.all('SELECT * FROM coverage WHERE month=?',m),rates:s.all('SELECT * FROM rates WHERE date<=?',end),freight:s.all('SELECT * FROM freight_records WHERE month=? ORDER BY id',m),freight_attachments:s.all('SELECT a.* FROM freight_attachments a JOIN freight_records f ON f.id=a.record_id WHERE f.month=? ORDER BY a.id',m)};
}
function coverage(data,shop,dataset) {return data.coverage.find(r=>r.shop_id===shop&&r.dataset===dataset)?.status||'missing';}
function rateAt(data,currency,date) {return currency==='CNY'?100000000:data.rates.find(r=>r.currency===currency&&r.date===date)?.rate??null;}
function chooseOperations(rows,start,end) {
  const exact=rows.find(r=>r.start===start&&r.end===end); if(exact)return {rows:[exact],exact:true};
  const candidates=rows.filter(r=>r.start>=start&&r.end<=end).sort((a,b)=>a.start.localeCompare(b.start)||b.end.localeCompare(a.end));
  const chosen=[];let last='';for(const r of candidates)if(r.start>last){chosen.push(r);last=r.end;}
  return {rows:chosen,exact:false};
}
function rangeComplete(rows,start,end) {
  let current=start; for(const r of rows){if(r.start!==current)return false;current=new Date(Date.parse(r.end+'T00:00:00Z')+86400000).toISOString().slice(0,10);}return current>end;
}
export function summarizeMonth(data,shopId='all',day=null) {
  const [ms,me]=bounds(data.month),start=day||ms,end=day||me;
  const shops=(data.shops||SHOPS).filter(s=>shopId==='all'||s.id===shopId);
  const operationRows=[],reconRows=[];
  for(const shop of shops) {
    const ledger=data.ledger.filter(r=>r.shop_id===shop.id),period=ledger.filter(r=>r.date>=start&&r.date<=end);
    const ops=data.operations.filter(r=>r.shop_id===shop.id);
    const currencies=[...new Set([...ops.map(r=>r.currency),...period.map(r=>r.currency)])];if(!currencies.length)currencies.push(shop.id==='ozon'?'RUB':'CNY');
    for(const currency of currencies) {
      const p=period.filter(r=>r.currency===currency),all=ledger.filter(r=>r.currency===currency&&r.date<=end);
      const scoped=ops.filter(r=>r.currency===currency),c=chooseOperations(scoped,start,end),rows=c.rows;
      const op={shop_id:shop.id,shop:shop.name,platform:shop.platform,currency,coverage:coverage(data,shop.id,'operations'),source_complete:rangeComplete(rows,start,end),definition:[...new Set(rows.map(r=>r.definition))].join(' / ')};
      const selected={};for(const k of additive){selected[k]=chooseOperations(scoped.filter(r=>r[k]!=null),start,end).rows;op[k]=sumNullable(selected[k],k);}
      op.source_complete=rangeComplete(selected.sales,start,end);
      // Period UV and buyers are not additive, including across stores.
      op.visitors=c.exact?rows[0].visitors:null;op.buyers=c.exact?rows[0].buyers:null;
      op.conversion=c.exact&&rows[0].compatible&&op.visitors>0&&op.buyers!=null?op.buyers/op.visitors:null;
      op.roas=rows.length&&rows.every(r=>r.compatible&&r.ad_sales!=null&&r.ad_spend!=null)&&new Set(rows.map(r=>r.definition)).size===1&&op.ad_spend>0?op.ad_sales/op.ad_spend:null;
      if(shop.manual) {
        for(const [key,kind]of [['sales','sale'],['refunds','refund']])op[key]=p.some(r=>r.kind===kind)?safeSum(p.filter(r=>r.kind===kind).map(r=>r.amount)):op.coverage==='full'?0:null;
        op.orders=p.filter(r=>r.kind==='sale').length|| (op.coverage==='full'?0:null);op.definition='销售登记金额（含客户支付运费）；退款按发生日';op.source_complete=op.coverage==='full';
      }
      op.net_sales=op.sales!=null&&op.refunds!=null?op.sales-op.refunds:null;op.aov=op.orders>0&&op.sales!=null?op.sales/op.orders:null;
      op.rmb={};op.fx_missing=false;
      for(const k of moneyFields) {
        const amounts=shop.manual?(k==='sales'||k==='refunds'?p.filter(r=>r.kind===(k==='sales'?'sale':'refund')).map(r=>fxConvert(r.amount,rateAt(data,r.currency,r.date))):[]):selected[k].map(r=>fxConvert(r[k],rateAt(data,r.currency,r.end)));
        op.rmb[k]=op[k]===null?null:amounts.some(a=>a===null)?null:safeSum(amounts);
        if(op[k]!=null&&op.rmb[k]===null)op.fx_missing=true;
      }
      operationRows.push(op);
      const recon={shop_id:shop.id,shop:shop.name,platform:shop.platform,currency,settlement_status:coverage(data,shop.id,'settlement'),receipt_status:coverage(data,shop.id,'receipt'),expense_status:coverage(data,shop.id,'expense')};
      const total=(kind,status)=>p.some(r=>r.kind===kind)?safeSum(p.filter(r=>r.kind===kind).map(r=>r.amount)):status==='full'?0:null;
      recon.settlement=shop.manual?null:total('settlement',recon.settlement_status);
      recon.receipt=total('receipt',recon.receipt_status);
      const costs=p.filter(r=>r.kind==='expense'&&!r.deducted);
      recon.expense=costs.length?safeSum(costs.map(r=>r.amount)):recon.expense_status==='full'?0:null;
      const deducted=p.filter(r=>r.kind==='expense'&&r.deducted);
      recon.already_deducted=deducted.length?safeSum(deducted.map(r=>r.amount)):recon.expense_status==='full'?0:null;
      recon.net_income=shop.manual?(op.net_sales!=null&&recon.expense!=null?op.net_sales-recon.expense:null):(recon.settlement!=null&&recon.expense!=null?recon.settlement-recon.expense:null);
      const settlements=all.filter(r=>r.kind==='settlement'),receipts=all.filter(r=>r.kind==='receipt');
      const eligibleMatches=data.matches.filter(m=>data.ledger.some(r=>r.id===m.left_id&&r.date<=end)&&data.ledger.some(r=>r.id===m.right_id&&r.date<=end));
      recon.unmatched_settlement=settlements.length?safeSum(settlements.map(r=>r.amount-safeSum(eligibleMatches.filter(m=>m.left_id===r.id).map(m=>m.left_amount)))):null;
      recon.unmatched_receipt=receipts.length?safeSum(receipts.map(r=>r.amount-safeSum(eligibleMatches.filter(m=>m.right_id===r.id).map(m=>m.right_amount)))):null;
      recon.cash_gap=recon.settlement!=null&&recon.receipt!=null?recon.settlement-recon.receipt:null;
      recon.receivable=shop.manual&&all.some(r=>r.kind==='sale')?safeSum(all.filter(r=>['sale','refund','receipt'].includes(r.kind)).map(r=>r.kind==='sale'?r.amount:-r.amount)):null;
      reconRows.push(recon);
    }
  }
  const knownSales=operationRows.filter(r=>r.rmb.sales!=null);
  const aggregate=key=>operationRows.some(r=>r.rmb[key]!=null)?safeSum(operationRows.map(r=>r.rmb[key])):null;
  const fullyCovered=operationRows.length>0&&operationRows.every(r=>r.coverage==='full'&&r.source_complete&&!r.fx_missing&&r.sales!=null);
  return {month:data.month,start,end,locked:data.locked,locked_at:data.locked_at||null,shops:shops.length,operations:operationRows,reconciliation:reconRows,totals:{sales:aggregate('sales'),refunds:aggregate('refunds'),ad_spend:aggregate('ad_spend'),orders:sumNullable(operationRows,'orders'),covered_shops:new Set(knownSales.map(r=>r.shop_id)).size,complete:fullyCovered},definitions:DEFINITIONS,exclusions:EXCLUSIONS};
}
const compare=(a,b)=>a!=null&&b!=null&&b!==0?(a-b)/Math.abs(b):null;
export function report(s,{period,grain='month',shop='all',empty_trend}={}) {
  if(!['day','month','year'].includes(grain))throw fail('时间粒度无效');
  if(shop!=='all'&&!s.shops().some(x=>x.id===shop))throw fail('店铺无效');
  if(grain==='year') {
    if(!/^20\d{2}$/.test(period))throw fail('年份无效');
    const months=Array.from({length:12},(_,i)=>period+'-'+String(i+1).padStart(2,'0'));
    const reports=months.map(m=>summarizeMonth(monthData(s,m),shop));
    const combine=(key,fields)=>{
      const map=new Map();for(const rep of reports)for(const r of rep[key]){
        const k=r.shop_id+'|'+r.currency; if(!map.has(k))map.set(k,{...r,_months:[]});map.get(k)._months.push(r);
      }
      return [...map.values()].map(r=>{const a=r._months;delete r._months;for(const f of fields)r[f]=sumNullable(a,f);r.coverage=a.every(x=>x.coverage==='full')?'full':'partial';
        if(key==='operations') {r.rmb=Object.fromEntries(moneyFields.map(f=>[f,sumNullable(a.map(x=>x.rmb),f)]));r.visitors=null;r.buyers=null;r.conversion=null;r.roas=null;r.aov=r.orders>0&&r.sales!=null?r.sales/r.orders:null;r.fx_missing=a.some(x=>x.fx_missing);}
        else {for(const f of ['receivable','unmatched_settlement','unmatched_receipt'])r[f]=a.at(-1)[f];for(const f of ['settlement_status','receipt_status','expense_status'])r[f]=a.every(x=>x[f]==='full')?'full':'partial';}
        return r;});
    };
    return {period,grain,shop,locked:reports.every(r=>r.locked),operations:combine('operations',[...additive,'net_sales']),reconciliation:combine('reconciliation',['settlement','receipt','expense','net_income','already_deducted','cash_gap']),totals:{sales:sumNullable(reports.map(r=>r.totals),'sales'),refunds:sumNullable(reports.map(r=>r.totals),'refunds'),ad_spend:sumNullable(reports.map(r=>r.totals),'ad_spend'),orders:sumNullable(reports.map(r=>r.totals),'orders'),complete:reports.every(r=>r.totals.complete)},trend:reports.map(r=>({label:r.month,...r.totals})),comparison:{mom:null,yoy:null},exclusions:EXCLUSIONS,definitions:DEFINITIONS};
  }
  const m=month(String(period).slice(0,7));
  let day=null;if(grain==='day') {const d=new Date(period+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==period)throw fail('日期无效');day=period;}
  const data=monthData(s,m),r=summarizeMonth(data,shop,day);
  if(empty_trend==='skip'&&r.totals.sales==null)return {...r,period,grain,shop,trend:[],comparison:{mom:null,yoy:null}};
  const previous=summarizeMonth(monthData(s,shiftMonth(m,-1)),shop),lastYear=summarizeMonth(monthData(s,shiftMonth(m,-12)),shop);
  const trend=grain==='day'?Array.from({length:+bounds(m)[1].slice(8)},(_,i)=>{const d=m+'-'+String(i+1).padStart(2,'0');return {label:d,...summarizeMonth(data,shop,d).totals};}):Array.from({length:12},(_,i)=>{const n=shiftMonth(m,i-11);return {label:n,...summarizeMonth(monthData(s,n),shop).totals};});
  return {...r,period,grain,shop,trend,comparison:{mom:grain==='month'&&r.totals.complete&&previous.totals.complete?compare(r.totals.sales,previous.totals.sales):null,yoy:grain==='month'&&r.totals.complete&&lastYear.totals.complete?compare(r.totals.sales,lastYear.totals.sales):null}};
}
export function revision(s,m) {const data=monthData(s,m,{live:true});return {data,revision:hash(data)};}
export function reconciliationDetail(s,m,shop='all') {
  const data=monthData(s,m),end=bounds(m)[1];
  const rows=data.ledger.filter(r=>(shop==='all'||r.shop_id===shop)&&r.date<=end&&['settlement','receipt'].includes(r.kind));
  const matches=data.matches.filter(m=>rows.some(r=>r.id===m.left_id)&&rows.some(r=>r.id===m.right_id));
  const remaining=r=>r.amount-safeSum(matches.filter(m=>m[r.kind==='settlement'?'left_id':'right_id']===r.id).map(m=>m[r.kind==='settlement'?'left_amount':'right_amount']));
  const details=rows.map(r=>({...r,remaining:remaining(r)}));
  const candidates=[];for(const left of details.filter(r=>r.kind==='settlement'&&r.remaining!==0&&r.match_key)){
    const found=details.filter(r=>r.kind==='receipt'&&r.remaining!==0&&r.shop_id===left.shop_id&&r.currency===left.currency&&r.match_key===left.match_key&&r.remaining===left.remaining);
    if(found.length===1&&details.filter(r=>r.kind==='settlement'&&r.remaining===found[0].remaining&&r.shop_id===left.shop_id&&r.currency===left.currency&&r.match_key===left.match_key).length===1)candidates.push({left_id:left.id,right_id:found[0].id,amount:left.remaining,match_key:left.match_key});
  }
  return {rows:details,matches,candidates,locked:data.locked};
}
