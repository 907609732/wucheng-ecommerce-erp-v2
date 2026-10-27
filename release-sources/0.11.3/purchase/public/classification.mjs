export const categories=Object.freeze({goods:'商品采购',fixed_asset:'固定资产采购',expense:'日常支出'});
export const defaultClassification=()=>({mode:'single',category:'goods',owner:'company'});
export function normalizeClassification(value,amountCents,refundCents){
 const c=value===undefined?defaultClassification():value;
 if(!c||typeof c!=='object'||!['single','split'].includes(c.mode))throw Error('采购分类模式无效');
 if(c.owner!==undefined&&c.owner!=='company')throw Error('第一期支出归属仅支持公司共用');
 if(c.mode==='single'){
  if(!Object.hasOwn(categories,c.category))throw Error('请选择有效的采购类别');
  return {mode:'single',category:c.category,owner:'company'};
 }
 if(!Array.isArray(c.parts)||c.parts.length<2||c.parts.length>3)throw Error('混合订单请分配到两种或三种采购类别');
 const seen=new Set();let paid=0,refund=0;
 const parts=c.parts.map(p=>{
  if(!p||!Object.hasOwn(categories,p.category)||seen.has(p.category))throw Error('拆分类别无效或重复，每种类别最多一行');
  seen.add(p.category);
  if(!Number.isSafeInteger(p.amountCents)||p.amountCents<=0||p.amountCents>1e12||!Number.isSafeInteger(p.refundCents)||p.refundCents<0)throw Error('分类实付须大于零，退款须为非负整数分');
  if(p.refundCents>p.amountCents)throw Error('分类退款不能超过该类别实付金额');
  paid+=p.amountCents;refund+=p.refundCents;
  return {category:p.category,amountCents:p.amountCents,refundCents:p.refundCents};
 }).sort((a,b)=>Object.keys(categories).indexOf(a.category)-Object.keys(categories).indexOf(b.category));
 if(paid!==amountCents)throw Error('分类实付合计必须等于整单实付金额，请重新核对拆分');
 if(refund>refundCents)throw Error('分类退款合计不能超过整单退款，请重新核对拆分');
 return {mode:'split',parts,owner:'company'};
}
export function allocations(o){
 const c=o.classification||defaultClassification();
 return c.mode==='split'?c.parts.map(p=>({...p})):[{category:c.category,amountCents:o.amountCents,refundCents:o.refundCents}];
}
export const classificationLabel=o=>o.classification?.mode==='split'?'混合':categories[o.classification?.category||'goods'];
export const hasCategory=(o,category)=>!category||allocations(o).some(p=>p.category===category);
export const unallocatedRefund=o=>o.refundCents-allocations(o).reduce((s,p)=>s+p.refundCents,0);
export function contribution(o,category=''){
 if(!category)return {amountCents:o.amountCents,refundCents:o.refundCents,netCents:o.amountCents-o.refundCents};
 const p=allocations(o).find(p=>p.category===category)||{amountCents:0,refundCents:0};
 return {amountCents:p.amountCents,refundCents:p.refundCents,netCents:p.amountCents-p.refundCents};
}
export function classificationTotals(orders,category=''){
 const totals=Object.entries(categories).map(([category,label])=>({category,label,amountCents:0,refundCents:0,netCents:0,count:0}));
 for(const o of orders)for(const p of allocations(o).filter(p=>!category||p.category===category)){const t=totals.find(t=>t.category===p.category);t.amountCents+=p.amountCents;t.refundCents+=p.refundCents;t.netCents+=p.amountCents-p.refundCents;t.count++;}
 return {categories:totals,unallocatedRefundCents:orders.reduce((s,o)=>s+unallocatedRefund(o),0)};
}
export const classificationDescription=o=>allocations(o).map(p=>`${categories[p.category]}：实付 ${(p.amountCents/100).toFixed(2)}，退款 ${(p.refundCents/100).toFixed(2)}`).join('；')+(unallocatedRefund(o)?`；待分配退款 ${(unallocatedRefund(o)/100).toFixed(2)}`:'');
