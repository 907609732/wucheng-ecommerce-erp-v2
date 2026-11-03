export const importMonth=o=>String(o.paidAt||o.date||'').slice(0,7);

export function reviewImportOrders(orders,store){
 const locks=new Map(store.monthLocks.confirmations().map(c=>[c.platform+'|'+c.month,c]));
 return orders.map((o,index)=>{
  const old=store.find(o),existing=old?(old.fingerprint===o.fingerprint?'duplicate':'conflict'):null;
  const confirmation=locks.get(o.platform+'|'+importMonth(o));
  const locked=confirmation?{month:confirmation.month,platform:confirmation.platform}:null;
  const importStatus=o.errors.length?'invalid':existing||(locked?'locked':'ready');
  const notImportedReason=importStatus==='invalid'?o.errors.join('；'):importStatus==='duplicate'?'订单已存在，重复数据未导入':importStatus==='conflict'?'订单已存在且内容不同，未覆盖原订单':importStatus==='locked'?`${locked.month} · ${locked.platform} 已确认锁定，未导入；补录须先到月度确认取消确认`:'';
  return {...o,index,existing,existingId:old?.id,locked,importStatus,notImportedReason};
 });
}

export function notImportedOrder(o,reason=o.notImportedReason,status=o.importStatus){
 return {index:o.index,orderNo:o.orderNo,platform:o.platform,account:o.account,date:o.date,paidAt:o.paidAt||'',month:importMonth(o),sourceRows:o.sourceRows||[],reason,status};
}

export function importReportDraft(filename,orders,issues,indices,{aborted=false}={}){
 const selected=new Set(indices);
 return {filename,totalOrders:orders.length,imported:0,aborted,notImported:orders.filter(o=>aborted||!selected.has(o.index)).map(o=>notImportedOrder(o,o.notImportedReason||(selected.has(o.index)?'本批次未保存，请重新核对后导入':'未勾选，本次未导入'),o.importStatus==='ready'?(selected.has(o.index)?'batch_aborted':'unselected'):o.importStatus)),issues:issues.map(i=>({row:i.row,message:i.message}))};
}
