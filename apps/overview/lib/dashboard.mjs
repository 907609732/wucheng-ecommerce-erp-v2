import {report,prepareReport} from './report.mjs';
import {month,lastMonth,hash,sum,fail} from './util.mjs';

const expenseKeys=['refund','platformFee','purchase','freight','payroll','other'];
const referenceKeys=['income',...expenseKeys];
const knownSum=values=>values.some(v=>v!=null)?sum(values.filter(v=>v!=null)):null;
const outflow=totals=>{const v=knownSum(expenseKeys.map(k=>totals[k]));return v==null?null:-v||0;};
const localToday=()=>new Date().toLocaleDateString('sv-SE');
const completeCoverage=r=>r.coverage.every(c=>['full','zero'].includes(c.status));

// Reuse one read-only source snapshot and one normalization for all twelve months.
// Annual cash movements add up; outstanding bills are a balance at December end.
export function dashboard(s,sources,{grain='month',period=lastMonth(),today=localToday()}={}){
 if(!['month','year'].includes(grain))throw fail('看板周期无效');
 if(grain==='year'&&!/^20\d{2}$/.test(period))throw fail('年份格式应为 YYYY');
 if(grain==='month')month(period);
 const prepared=prepareReport(s,sources);
 const months=grain==='month'?[period]:Array.from({length:12},(_,i)=>period+'-'+String(i+1).padStart(2,'0'));
 const reports=months.map(m=>report(s,sources,m,prepared));
 let result=reports[0];
 if(grain==='year'){
  const last=reports.at(-1),totals={};
  for(const k of Object.keys(last.totals))totals[k]=knownSum(reports.map(r=>r.totals[k]));
  const issues=reports.flatMap(r=>r.issues.filter(i=>!['refund_dates','source'].includes(i.type)).map(i=>({...i,title:r.month+' · '+i.title,month:r.month})));
  issues.push(...last.issues.filter(i=>['refund_dates','source'].includes(i.type)));
  result={...last,totals,difference:knownSum(reports.map(r=>r.difference)),rows:reports.flatMap(r=>r.rows).sort((a,b)=>b.date.localeCompare(a.date)||a.key.localeCompare(b.key)),issues,
   revision:hash(reports.map(r=>r.revision)),complete:reports.every(r=>r.complete),snapshots:[],
   coverage:last.coverage.map(c=>{const states=reports.map(r=>r.coverage.find(x=>x.category===c.category));const count=states.filter(x=>['full','zero'].includes(x.status)).length;return {category:c.category,status:count===12?'full':states.some(x=>x.status==='stale')?'stale':states.every(x=>x.status==='missing')?'missing':'partial',reason:count+' / 12 个月已确认；逐月核对与补录'};}),
   shops:last.shops.map(shop=>{const parts=reports.map(r=>r.shops.find(x=>x.id===shop.id));return {...shop,records:sum(parts.map(x=>x.records)),status:parts.every(x=>x.status==='full')?'full':parts.some(x=>x.records)?'partial':'missing'};})};
 }
 const trend=grain==='year'?reports.map(r=>({period:r.month,label:Number(r.month.slice(5))+'月',income:r.totals.income,outflow:outflow(r.totals),difference:r.difference,totals:r.totals,
  records:r.rows.length,confirmed:completeCoverage(r),future:r.month>today.slice(0,7),status:r.unavailable?'unavailable':completeCoverage(r)?'full':r.rows.length?'partial':r.month>today.slice(0,7)?'future':'missing'})):dailyTrend(result,today);
 const shopIncome=result.shops.map(shop=>{const rows=result.rows.filter(r=>r.source==='sales'&&r.owner===shop.id&&r.bucket==='income'&&r.currency==='CNY');return {id:shop.id,name:shop.name,platform:shop.platform,amountCents:result.unavailable?null:rows.length?sum(rows.map(r=>r.amountCents)):shop.status==='full'?0:null,records:rows.length};}).sort((a,b)=>(b.amountCents??-Infinity)-(a.amountCents??-Infinity));
 return {...result,grain,period,periodLabel:grain==='year'?period+' 年':period.replace('-',' 年 ')+' 月',balanceMonth:months.at(-1),trend,shopIncome,
  dataMonths:reports.filter(r=>r.rows.length).length,confirmedMonths:reports.filter(completeCoverage).length,
  expenseBreakdown:expenseKeys.map(key=>({key,amountCents:result.totals[key]==null?null:-result.totals[key]||0}))};
}

function dailyTrend(r,today){
 const days=new Date(Number(r.month.slice(0,4)),Number(r.month.slice(5)),0).getDate();
 const domainFull=k=>r.coverage.some(c=>c.category===k&&['full','zero'].includes(c.status));
 return Array.from({length:days},(_,i)=>{
  const period=r.month+'-'+String(i+1).padStart(2,'0'),rows=r.rows.filter(x=>x.date===period&&x.currency==='CNY'),totals={};
  for(const k of referenceKeys){const matches=rows.filter(x=>x.bucket===k);const domain=['income','refund','platformFee'].includes(k)?'sales':k;totals[k]=r.unavailable?null:matches.length?sum(matches.map(x=>x.amountCents)):period<=today&&domainFull(domain)?0:null;}
  return {period,label:String(i+1)+'日',income:totals.income,outflow:outflow(totals),difference:knownSum(Object.values(totals)),totals,records:rows.length,status:r.unavailable?'unavailable':period<=today&&completeCoverage(r)?'full':rows.length?'partial':period>today?'future':'missing'};
 });
}
