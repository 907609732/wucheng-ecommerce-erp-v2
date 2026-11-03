import {month,date,required,hash,id,now,fail} from './util.mjs';
import {parsePayrollAmount,simplePayroll} from '../public/payroll-model.mjs';
export function savePayrollSheet(s,sources,input){
 if(!input||Object.keys(input).some(k=>!['requestId','month','year','rows','reason'].includes(k)))throw fail('工资表提交字段无效');
 const annual=Object.hasOwn(input,'year');
 if(annual&&(Object.hasOwn(input,'month')||!/^20\d{2}$/.test(input.year)))throw fail('年度期间无效，不能同时指定月份');
 const scope=annual?input.year:month(input.month),requestId=required(input.requestId,'请求标识',80);
 if(!/^[a-f0-9-]{36}$/i.test(requestId))throw fail('请求标识无效');
 if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>500)throw fail('每次提交1至500行');
 s.db.exec('CREATE TABLE IF NOT EXISTS payroll_sheet_requests(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)');
 const digest=hash(input);
 return s.tx(()=>{
  const prior=s.get('SELECT * FROM payroll_sheet_requests WHERE request_id=?',requestId);
  if(prior){if(prior.digest!==digest)throw fail('同一请求标识不能提交不同内容',409);return JSON.parse(prior.result);}
  const seen=new Set(),saved=[];
  for(const [index,row] of input.rows.entries())try{
   if(!row||Object.keys(row).some(k=>!['key','billId','version','date','name','amount','note',...(annual?['period']:[])].includes(k)))throw fail('工资行字段无效');
   const m=annual?month(row.period):scope;
   if(annual&&!m.startsWith(scope+'-'))throw fail('工资账期必须属于所选年度');
   const key=required(row.key,'行标识',150),unique=row.billId||key;if(seen.has(unique))throw fail('工资行重复');seen.add(unique);
   if(!/^20\d{2}-\d{2}-\d{2}$/.test(row.date||''))throw fail('日期须为 YYYY-MM-DD');
   const billDate=date(row.date),party=required(row.name,'姓名',200),amountCents=parsePayrollAmount(row.amount),note=String(row.note||'');if(note.length>2000)throw fail('备注不能超过2000字');
   if(annual&&!row.billId&&billDate.slice(0,7)!==m)throw fail('新增工资日期须属于对应月份');
   let before;if(row.billId){before=s.bill(row.billId);if(before.period!==m)throw fail('不能更改其他账期的工资',409);if(!simplePayroll(before))throw fail('含工资明细的记录请通过原明细更正');if(row.version!==before.version)throw fail('工资已被其他人修改，请保留草稿并刷新核对',409);}
   const line={...(before?.lines[0]||{lineNo:'1',sourceRow:null}),label:party,grossCents:amountCents,withheldCents:0,netCents:amountCents,employerCents:0,amountCents};
   const bill={...(before||{kind:'payroll',billNo:'GZ-'+m.replace('-','')+'-'+id(),category:'salary',owner:'company',linkedSource:'',title:'工资'}),party,billDate,period:m,amountCents,note,lines:[line]};
   const result=before?s.updateBill(before.id,{...bill,version:row.version,reason:required(input.reason,'更正原因',500)},sources):s.createBill(bill,sources);
   saved.push({key,id:result.id,version:result.version});
  }catch(error){error.row=index+1;error.status||=400;error.message='第 '+(index+1)+' 行：'+error.message;throw error;}
  const result={ok:true,saved};s.run('INSERT INTO payroll_sheet_requests VALUES(?,?,?,?)',requestId,digest,JSON.stringify(result),now());return result;
 });
}
