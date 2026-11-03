import {registerReviewedEdits} from './reviewed-edits.mjs';
import {makeBackup} from './files.mjs';
export function installOverviewEdits(integration,s,sources){
 const fields=['party','period','billDate','category','owner','title','linkedSource','note','lines','amountCents'];
 const comparable=o=>Object.fromEntries(['kind','billNo',...fields].map(k=>[k,o[k]]));
 return registerReviewedEdits(integration,{db:s.db,transaction:s.tx,backup:()=>makeBackup(s),types:{bill:{
  fields,read:id=>s.bill(id),comparable,
  propose:(before,patch,reason)=>({...before,...s.validateUpdate(before,{...before,...patch,reason},sources())}),
  write:(id,before,p,reason)=>s.updateBill(id,{...p,version:before.version,reason},sources())
 }}});
}
