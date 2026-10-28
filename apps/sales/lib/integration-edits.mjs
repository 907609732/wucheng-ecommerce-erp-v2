import {registerReviewedEdits} from './reviewed-edits.mjs';
import {editLedger,normalizeLedger,validateManualRelation} from './ledger.mjs';
import {makeBackup} from './backup.mjs';
import {fail} from './util.mjs';
export function installSalesEdits(integration,s){
 const fields=['date','amountCents','currency','match_key','order_ref','category','deducted','note'];
 const normalized=['shop_id','date','kind','amount','currency','external_id','match_key','order_ref','category','deducted','note','source'];
 const comparable=o=>Object.fromEntries(normalized.map(k=>[k,o[k]]));
 return registerReviewedEdits(integration,{db:s.db,transaction:s.transaction,backup:()=>makeBackup(s,'before-integration-edit'),types:{ledger:{
  fields,read:id=>s.get('SELECT * FROM ledger WHERE id=?',id),comparable,
  propose(before,patch){
   if(before.batch_id)throw fail('导入流水须按原流程撤销批次后重新导入');
   if(s.get('SELECT 1 FROM matches WHERE left_id=? OR right_id=?',before.id,before.id))throw fail('请先在销售台处理关联匹配');
   const cents=patch.amountCents??before.amount;if(!Number.isSafeInteger(cents))throw fail('金额必须使用整数分');
   const result=normalizeLedger({...before,...patch,amount:(cents/100).toFixed(2)}, {},s.shops());
   validateManualRelation(s,result,before.id);
   if([before.date,result.date].some(d=>s.get('SELECT 1 FROM month_locks WHERE month=?',d.slice(0,7))))throw fail('月份已锁定，请先按原流程解锁',423);
   return {...before,...result};
  },
  write:(id,_before,p)=>editLedger(s,id,{...p,amount:(p.amount/100).toFixed(2)})
 }}});
}
