import {includedInSpend} from '../public/order-attributes.mjs';
export function supplierSummary(orders,{q='',platform=''}={}) {
 const groups=new Map(),keyword=String(q).trim().toLocaleLowerCase();
 for(const o of orders){
  if(platform&&o.platform!==platform||keyword&&!o.supplier.toLocaleLowerCase().includes(keyword))continue;
  const key=JSON.stringify([o.platform,o.supplier]);
  if(!groups.has(key))groups.set(key,{platform:o.platform,supplier:o.supplier,orderCount:0,accounts:new Set(),lastPurchaseDate:'',amountCents:0,refundCents:0,netCents:0});
  const s=groups.get(key);s.orderCount++;s.accounts.add(o.account);s.lastPurchaseDate=[s.lastPurchaseDate,o.paidAt||o.date].sort().at(-1);
  s.amountCents+=o.amountCents;s.refundCents+=o.refundCents;if(includedInSpend(o))s.netCents+=o.amountCents-o.refundCents;
 }
 return [...groups.values()].map(s=>({...s,accounts:[...s.accounts].sort()})).sort((a,b)=>b.netCents-a.netCents||a.supplier.localeCompare(b.supplier,'zh-CN'));
}
