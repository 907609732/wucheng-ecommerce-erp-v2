import path from 'node:path';
import {registerReviewedEdits} from './reviewed-edits.mjs';
import {validateOrder,backfillItemUnits} from './importer.mjs';
import {preserveShipments} from '../public/shipments.mjs';
export function installPurchaseEdits(integration,store){
 const fields=['date','paidAt','supplier','status','amountCents','refundCents','shippingCents','recipient','phone','address','logisticsCompany','trackingNo','note','items','classification','excludedFromSpend'];
 const comparable=o=>Object.fromEntries([...fields,'platform','account','orderNo','supplierContact','attachmentIds'].map(k=>[k,o[k]??null]));
 return registerReviewedEdits(integration,{db:store.db,transaction:store.transaction,backup:()=>store.backup(path.join(store.dir,'backups','before-edit-'+Date.now()+'.sqlite')),types:{order:{
  fields,read:id=>store.get(id),comparable,
  propose(before,patch){const proposed=validateOrder({...before,...patch,items:preserveShipments(backfillItemUnits(patch.items||before.items,{items:before.items}),before.items)});store.monthLocks.assertWritable([before,proposed]);return proposed;},
  write:(id,before,proposed)=>store.update(id,{...proposed,updatedAt:before.updatedAt})
 }}});
}
