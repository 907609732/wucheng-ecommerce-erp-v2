import {itemShipments} from './shipments.mjs';
export function requireDelivery(order){
 for(const [key,label] of [['recipient','收货人'],['phone','联系电话'],['address','收货地址']])if(!String(order[key]||'').trim())throw Error('请填写'+label);
 for(const [index,item] of (order.items||[]).entries()){
  const shipments=itemShipments(item);
  if(!shipments.length||shipments.some(s=>!String(s.trackingNo||'').trim()||!String(s.logisticsCompany||'').trim()))throw Error(`请填写第 ${index+1} 项商品的运单号和物流公司`);
 }
}
