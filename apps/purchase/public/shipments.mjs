// One parcel can serve several products; arrays preserve each product's association.
export function itemShipments(item={}) {
 return Array.isArray(item.shipments)?item.shipments:
  (item.trackingNo||item.logisticsCompany?[{trackingNo:item.trackingNo||'',logisticsCompany:item.logisticsCompany||''}]:[]);
}
export function normalizeShipments(item) {
 if(Object.hasOwn(item,'shipments')&&!Array.isArray(item.shipments))throw Error('商品运单列表无效');
 const rows=itemShipments(item);
 if(rows.length>50)throw Error('每条商品最多 50 个运单');
 const seen=new Set();
 return rows.map(row=>{
  if(!row||typeof row!=='object')throw Error('商品运单信息无效');
  const trackingNo=String(row.trackingNo??'').trim(),logisticsCompany=String(row.logisticsCompany??'').trim();
  if(trackingNo.length>100)throw Error('商品运单号最多 100 字');
  if(logisticsCompany.length>200)throw Error('商品物流公司最多 200 字');
  return {trackingNo,logisticsCompany};
 }).filter(row=>{
  const key=JSON.stringify(row);if((!row.trackingNo&&!row.logisticsCompany)||seen.has(key))return false;seen.add(key);return true;
 });
}
export const shipmentText=(item,key)=>itemShipments(item).map(s=>s[key]||'').filter(Boolean).join('；');
export const allShipments=order=>[{trackingNo:order.trackingNo||'',logisticsCompany:order.logisticsCompany||''},...(order.items||[]).flatMap(itemShipments)];
export function normalizeContact(value) {
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value))throw Error('供应商联系地址无效');
 const result={};
 for(const [key,max] of [['name',200],['phone',40],['address',4000]]){
  result[key]=String(value[key]??'').trim();if(result[key].length>max)throw Error('供应商联系信息过长');
 }
 return Object.values(result).some(Boolean)?result:null;
}
// Old clients omit shipments. Match only unambiguous product identities rather than row position.
export function preserveShipments(items,before) {
 const key=i=>JSON.stringify([i.title,i.spec||'',i.sku||'']);
 if(items.some(i=>!Object.hasOwn(i,'shipments'))&&before.some(p=>itemShipments(p).length&&!items.some(i=>key(i)===key(p))))throw Error('商品明细已改变，请刷新页面并核对原有运单');
 return items.map(i=>{
  if(Object.hasOwn(i,'shipments'))return i;
  const matches=before.filter(p=>key(p)===key(i));
  if(matches.length!==1){
   if(matches.some(p=>itemShipments(p).length))throw Error('商品明细无法对应原运单，请刷新页面后编辑');
   return i;
  }
  const prior=matches[0],changed=['trackingNo','logisticsCompany'].some(k=>Object.hasOwn(i,k)&&String(i[k]||'')!==String(prior[k]||''));
  if(changed){if(itemShipments(prior).length>1)throw Error('此商品有多个运单，请刷新页面后编辑');return i;}
  return {...i,shipments:itemShipments(prior)};
 });
}
