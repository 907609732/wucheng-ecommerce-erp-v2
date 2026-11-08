export function parsePayrollAmount(value){
 const text=String(value??'').trim();
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))throw Error('工资金额须为非负数、最多两位小数的金额');
 const [whole,fraction='']=text.replaceAll(',','').split('.'),n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(!Number.isSafeInteger(n)||n<0||n>1e12)throw Error('工资金额不能为负数或超出范围');return n;
}
export function simplePayroll(b){const l=b.lines?.[0];return b.kind==='payroll'&&!b.voided&&b.lines?.length===1&&l.withheldCents===0&&l.employerCents===0&&l.grossCents===l.netCents&&l.amountCents===l.grossCents&&b.amountCents===l.grossCents;}
export const isEmptyPayrollDraft=r=>!r.billId&&['date','name','amount','note'].every(k=>!String(r[k]??'').trim());
export function payrollRows(bills,period){return bills.filter(b=>b.kind==='payroll'&&!b.voided&&(period.length===4?b.period.startsWith(period+'-'):b.period===period)).flatMap(b=>(b.lines||[]).map((l,i)=>({key:b.id+':'+i,billId:b.id,version:b.version,date:b.billDate,period:b.period,name:simplePayroll(b)?b.party:l.label||b.party,amount:(l.grossCents/100).toFixed(2),note:b.note||'',editable:simplePayroll(b),status:b.amountCents===0?'零金额':b.pendingCents===0?'已付清':b.paidCents?'部分付款':'待付款',complex:!simplePayroll(b),original:!!b.batchId})));}
export const emptyPayrollGridRow=()=>({key:crypto.randomUUID(),date:''});
export function emptyPayrollMonthRow(month){
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw Error('工资月份无效');
 const [y,m]=month.split('-').map(Number),day=new Date(Date.UTC(y,m,0)).getUTCDate();
 return {key:crypto.randomUUID(),month,date:month+'-'+String(day).padStart(2,'0')};
}
export function packPayrollGrid(flat,minimum=2,year=''){
 if(year&&!/^20\d{2}$/.test(year))throw Error('工资年度无效');
 const names=[...new Set(flat.map(r=>r.name))].sort((a,b)=>a.localeCompare(b,'zh-CN')),count=Math.max(2,minimum,names.length),rows=year?Array.from({length:12},(_,i)=>emptyPayrollMonthRow(year+'-'+String(i+1).padStart(2,'0'))):[];
 for(const person of flat){const slot=names.indexOf(person.name),prefix='p'+slot+'_';if(year&&!person.period?.startsWith(year+'-'))continue;let row=rows.find(r=>(year?r.month===person.period:r.date===person.date)&&!r[prefix+'meta']);if(!row){row=year?emptyPayrollMonthRow(person.period):{key:crypto.randomUUID(),date:person.date};rows.push(row);}row[prefix+'meta']={...person};for(const f of ['name','amount','note','status'])row[prefix+f]=person[f]??'';}
 if(year)rows.sort((a,b)=>a.month.localeCompare(b.month));
 return {count,rows:rows.length?rows:[emptyPayrollGridRow(),emptyPayrollGridRow(),emptyPayrollGridRow()]};
}
export function flattenPayrollGrid(rows,count){
 const result=[];
 for(const row of rows){let occupied=false;for(let slot=0;slot<count;slot++){const p='p'+slot+'_',meta=row[p+'meta']||{key:row.key+':person:'+slot,editable:true,status:'未保存'},values={name:row[p+'name']||'',amount:row[p+'amount']??'',note:row[p+'note']||''};if(meta.billId||Object.values(values).some(v=>String(v).trim())){occupied=true;result.push({...meta,...values,date:row.month&&meta.billId?meta.date:row.date||'',...(row.month?{period:row.month}:{}),gridKey:row.key,slot});}}
  if(!row.month&&!occupied&&String(row.date||'').trim())result.push({key:row.key+':person:0',date:row.date,name:'',amount:'',note:'',editable:true,status:'未保存',gridKey:row.key,slot:0});
 }
 return result;
}
export function payrollYearSummary(bills,year){
 if(!/^20\d{2}$/.test(year))throw Error('工资年度无效');
 const months=Array.from({length:12},(_,i)=>({period:year+'-'+String(i+1).padStart(2,'0'),label:(i+1)+'月',payableCents:null,paidCents:null,pendingCents:0,billCount:0}));
 let payableCents=0,paidCents=0,pendingCents=0,billCount=0;
 const parties=new Set();
 const add=(a,b)=>{const n=a+b;if(!Number.isSafeInteger(n))throw Error('人力费用合计超出范围');return n;};
 for(const b of bills){
  if(b.kind!=='payroll')continue;
  const payments=(b.payments||[]).filter(p=>!p.voided),net=payments.reduce((n,p)=>add(n,p.direction==='refund'?-p.amountCents:p.amountCents),0);
  const month=months.find(m=>m.period===b.period);
  if(month&&!b.voided){const pending=b.amountCents-net;month.payableCents=add(month.payableCents||0,b.amountCents);month.pendingCents=add(month.pendingCents,pending);month.billCount++;payableCents=add(payableCents,b.amountCents);pendingCents=add(pendingCents,pending);billCount++;parties.add(b.party);}
  for(const p of payments){const m=months.find(m=>m.period===p.date?.slice(0,7));if(!m)continue;const amount=p.direction==='refund'?-p.amountCents:p.amountCents;m.paidCents=add(m.paidCents||0,amount);paidCents=add(paidCents,amount);}
 }
 return {year,months,payableCents,paidCents,pendingCents,billCount,partyCount:parties.size,recordedMonths:months.filter(m=>m.billCount).length};
}
