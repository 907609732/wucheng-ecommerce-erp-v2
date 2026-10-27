import {itemShipments} from './shipments.mjs';
export const auditActions={update:'编辑订单',attributes:'修改订单属性',classification:'修改采购分类',rollback:'撤销修改',create:'首次入账','supplement-source':'补充原始数据','backfill-account':'补回采购账号','initialize-classification':'初始化采购分类'};
export const auditFields={platform:'采购平台',account:'采购账号',orderNo:'订单编号',date:'下单日期',paidAt:'付款日期',supplier:'供应商',status:'订单状态',excludedFromSpend:'采购支出统计',amountCents:'实付金额',refundCents:'已记录退款',shippingCents:'其中运费',note:'订单备注',recipient:'收货人',phone:'联系手机',address:'收货地址',logisticsCompany:'物流公司',trackingNo:'运单号',supplierContact:'供应商联系地址',attachmentIds:'订单附件',items:'商品明细',classification:'采购分类'};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const sameValue=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export function auditValue(o,key){
 if(key==='attachmentIds')return o?.attachmentIds||[];
 if(key==='supplierContact')return o?.supplierContact||null;
 if(key==='items')return (o?.items||[]).map(i=>({...i,shipments:itemShipments(i)}));
 if(key==='excludedFromSpend')return !!o?.[key];
 if(key==='classification')return o?.[key]??{mode:'single',category:'goods',owner:'company'};
 return o?.[key]??(key==='items'?[]:key.endsWith('Cents')?0:'');
}
export const orderChanges=(before,after)=>before?Object.entries(auditFields).flatMap(([key,label])=>{const a=auditValue(before,key),b=auditValue(after,key);return sameValue(a,b)?[]:[{key,label,before:a,after:b}];}):[];
export function auditText(key,value){
 const money=v=>'¥'+(Number(v||0)/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
 if(key.endsWith('Cents'))return money(value);
 if(key==='excludedFromSpend')return value?'不计入采购支出':'按状态正常计入';
 if(key==='classification'){const labels={goods:'商品采购',fixed_asset:'固定资产采购',expense:'日常支出'};return value?.mode==='split'?(value.parts||[]).map(p=>`${labels[p.category]||p.category}：实付 ${money(p.amountCents)}，退款 ${money(p.refundCents)}`).join('\n'):labels[value?.category]||'商品采购';}
 if(key==='supplierContact')return value?[value.name,value.phone,value.address].filter(Boolean).join(' · '):'未填写';
 if(key==='attachmentIds')return value?.length?value.map(id=>'附件 '+id).join('\n'):'无附件';
 if(key==='items')return (value||[]).map((i,n)=>`${n+1}. ${i.title||''}${i.spec?' · '+i.spec:''}${i.sku?' · 编码 '+i.sku:''} × ${i.qty}${i.unit||''} · 单价 ${i.unitPriceCents==null?'未提供':money(i.unitPriceCents)}${itemShipments(i).map(p=>'\n  运单：'+(p.trackingNo||'未填写')+' · '+(p.logisticsCompany||'未填写')).join('')}`).join('\n')||'未填写';
 return String(value??'')||'未填写';
}
