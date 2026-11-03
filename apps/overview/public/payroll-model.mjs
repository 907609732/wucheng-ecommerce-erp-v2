export function parsePayrollAmount(value){
 const text=String(value??'').trim();
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))throw Error('工资金额须为大于零、最多两位小数的金额');
 const [whole,fraction='']=text.replaceAll(',','').split('.'),n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(!Number.isSafeInteger(n)||n<=0||n>1e12)throw Error('工资金额须大于零且不能超出范围');return n;
}
export function simplePayroll(b){const l=b.lines?.[0];return b.kind==='payroll'&&!b.voided&&b.lines?.length===1&&l.withheldCents===0&&l.employerCents===0&&l.grossCents===l.netCents&&l.amountCents===l.grossCents&&b.amountCents===l.grossCents;}
export const isEmptyPayrollDraft=r=>!r.billId&&['date','name','amount','note'].every(k=>!String(r[k]??'').trim());
export function payrollRows(bills,period){return bills.filter(b=>b.kind==='payroll'&&!b.voided&&b.period===period).flatMap(b=>(b.lines||[]).map((l,i)=>({key:b.id+':'+i,billId:b.id,version:b.version,date:b.billDate,name:simplePayroll(b)?b.party:l.label||b.party,amount:(l.grossCents/100).toFixed(2),note:b.note||'',editable:simplePayroll(b),status:b.pendingCents===0?'已付清':b.paidCents?'部分付款':'待付款',complex:!simplePayroll(b),original:!!b.batchId})));}
