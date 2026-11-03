import {carrierOptions,normalizeCarrier} from './address-parse.mjs';
import {allShipments,shipmentText} from './shipments.mjs';
import {hasCategory,classificationLabel} from './classification.mjs';
import {includedInSpend} from './order-attributes.mjs';
export const emptyOrderFilter=()=>({q:'',category:'',platform:'',status:'',spend:'',month:'',from:'',to:'',supplier:'',account:'',carrier:'',note:'',tracking:'',refund:'',minAmount:'',maxAmount:'',preset:'all'});
// 运单号 / 物流公司展示口径：订单级优先，为空时合并商品行（运单号按序 '；' 连接，公司去重）。
export const orderTracking=o=>[...new Set(allShipments(o).map(s=>s.trackingNo).filter(Boolean))].join('；');
export const orderCarrier=o=>[...new Set(allShipments(o).map(s=>s.logisticsCompany).filter(Boolean))].join('；');
export const hasTracking=o=>!!orderTracking(o);
export function orderUploadDate(value){if(!value||!Number.isFinite(Date.parse(value)))return '';return new Date(value).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false});}
export function orderSearchValues(o){
 const money=v=>(Number(v||0)/100).toFixed(2),items=o.items||[];
 return {source:o.sourceLabel,uploadedBy:o.uploadedBy,uploadedAt:orderUploadDate(o.createdAt),orderNo:o.orderNo,platform:o.platform,supplier:o.supplier,account:o.account,date:o.date,paidAt:o.paidAt,status:o.status,amount:money(o.amountCents),refund:money(o.refundCents),shipping:money(o.shippingCents),recipient:o.recipient,phone:o.phone,address:o.address,carrier:orderCarrier(o),tracking:orderTracking(o),note:o.note,classification:classificationLabel(o),spend:o.excludedFromSpend?'不计入采购支出':'正常计入采购支出',supplierContact:Object.values(o.supplierContact||{}).join(' '),product:items.map(i=>i.title).join(' '),spec:items.map(i=>i.spec).join(' '),sku:items.map(i=>i.sku).join(' '),unit:items.map(i=>i.unit).join(' '),qty:items.map(i=>i.qty).join(' '),price:items.map(i=>i.unitPriceCents==null?'':money(i.unitPriceCents)).join(' ')};
}
export function filterOrders(orders,f={},basis='paid'){
 const q=String(f.q||'').trim().toLocaleLowerCase();
 return orders.filter(o=>{
  if(!hasCategory(o,f.category))return false;
  const date=basis==='created'?o.date:(o.paidAt||o.date);
  if(f.platform&&o.platform!==f.platform||f.status&&o.status!==f.status||f.month&&!date.startsWith(f.month)||f.from&&date<f.from||f.to&&date>f.to)return false;
  if(f.supplier&&o.supplier!==f.supplier||f.account&&o.account!==f.account||f.carrier&&!allShipments(o).some(s=>(carrierOptions.includes(f.carrier)?normalizeCarrier(s.logisticsCompany)===f.carrier:s.logisticsCompany===f.carrier)))return false;
  if(f.note==='yes'&&!o.note?.trim()||f.note==='no'&&o.note?.trim()||f.tracking==='yes'&&!hasTracking(o)||f.tracking==='no'&&hasTracking(o))return false;
  if(f.refund==='yes'&&o.refundCents<=0||f.refund==='no'&&o.refundCents>0)return false;
  for(const [key,cmp] of [['minAmount',(a,b)=>a<b],['maxAmount',(a,b)=>a>b]])if(f[key]!==''&&f[key]!=null&&Number.isFinite(Number(f[key]))&&cmp(o.amountCents,Math.round(Number(f[key])*100)))return false;
  if(f.spend==='excluded'&&!o.excludedFromSpend||f.spend==='normal'&&o.excludedFromSpend||f.spend==='effective'&&!includedInSpend(o))return false;
  if(f.preset==='effective'&&!includedInSpend(o)||f.preset==='excluded'&&!o.excludedFromSpend||f.preset==='closed'&&o.status!=='已关闭'||f.preset==='review'&&o.status!=='待核对'||f.preset==='noted'&&!o.note?.trim()||f.preset==='refunded'&&o.refundCents<=0)return false;
  const values=orderSearchValues(o);
  return !q||(f.searchField?String(values[f.searchField]??''):Object.values(values).join(' ')).toLocaleLowerCase().includes(q);
 });
}
export function sortOrders(orders,sorters=[],basis='paid'){
 const allowed=new Set(['orderNo','supplier','platform','account','purchaseDate','createdAt','date','paidAt','amountCents','refundCents','status','excludedFromSpend','recipient','phone','address','logisticsCompany','trackingNo','trackingText','carrierText','note','productText','classificationValue']);
 const value=(o,key)=>key==='classificationValue'?classificationLabel(o):key==='purchaseDate'?(basis==='created'?o.date:o.paidAt||o.date):key==='productText'?o.items.map(i=>i.title).join('；'):key==='trackingText'?orderTracking(o):key==='carrierText'?orderCarrier(o):o[key]??'';
 return [...orders].sort((a,b)=>{
  for(const {field,dir} of sorters){if(!allowed.has(field))continue;const x=value(a,field),y=value(b,field);const n=typeof x==='number'&&typeof y==='number'?x-y:String(x).toLowerCase().localeCompare(String(y).toLowerCase(),'zh-CN');if(n)return dir==='desc'?-n:n;}
  return 0;
 });
}
