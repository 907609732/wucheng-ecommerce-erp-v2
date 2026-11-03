export const dashboardExpenseKeys=['refund','platformFee','purchase','freight','payroll','other'];
const referenceKeys=['income',...dashboardExpenseKeys];
const add=(a,b)=>{const value=a+b;if(!Number.isSafeInteger(value))throw Error('看板合计超出范围');return value;};
const sum=values=>values.reduce(add,0);
export const defaultDashboardPeriod=(today=new Date().toLocaleDateString('sv-SE'))=>({grain:'year',period:today.slice(0,4)});

// Presentation derives exclusively from the selected API result, never another ledger read.
export function dashboardVisuals(data){
 const running={income:0,outflow:0,difference:0};
 const cumulative=data.trend.map(point=>{
  const result={period:point.period,label:point.label};
  for(const key of Object.keys(running)){
   const amount=data.unavailable?null:point[key];
   result[key]=amount==null?null:(running[key]=add(running[key],amount));
  }
  return result;
 });
 const expenseSeries=dashboardExpenseKeys.map(key=>({key,values:data.trend.map(point=>data.unavailable||point.totals[key]==null?null:-point.totals[key]||0)}));
 const rows=data.rows.filter(row=>row.currency==='CNY'&&referenceKeys.includes(row.bucket));
 const names=new Map(data.shops.map(shop=>[shop.id,shop.name]));
 for(const row of rows)if(!names.has(row.owner))names.set(row.owner,row.owner==='company'?'公司共用':'未归属店铺');
 const owners=[...names].map(([id,name])=>{
  const selected=rows.filter(row=>row.owner===id),income=selected.filter(row=>row.bucket==='income'),expenses=selected.filter(row=>dashboardExpenseKeys.includes(row.bucket));
  return {id,name,records:selected.length,income:data.unavailable||!income.length?null:sum(income.map(row=>row.amountCents)),outflow:data.unavailable||!expenses.length?null:-sum(expenses.map(row=>row.amountCents))||0,difference:data.unavailable||!selected.length?null:sum(selected.map(row=>row.amountCents))};
 }).sort((a,b)=>(b.income??-Infinity)-(a.income??-Infinity)||Math.abs(b.difference||0)-Math.abs(a.difference||0));
 return {cumulative,expenseSeries,owners};
}
