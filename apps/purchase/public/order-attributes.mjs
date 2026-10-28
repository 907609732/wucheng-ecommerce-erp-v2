export const orderStatuses=['已完成','待发货','待收货','待付款','已关闭','待核对'];
export function normalizeExcluded(value=false){
 if(typeof value!=='boolean')throw Error('计入采购支出选项无效');
 return value;
}
export const includedInSpend=o=>!o.excludedFromSpend&&['已完成','待收货','待发货'].includes(o.status);
export const spendSettingLabel=o=>o.excludedFromSpend?'不计入':'按状态正常计入';
export function attributePatch(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('请选择要修改的属性');
 const keys=Object.keys(input);
 if(!keys.length||keys.some(k=>!['status','excludedFromSpend','supplier','account'].includes(k)))throw Error('只允许批量修改订单状态、计入采购支出、供应商和采购账号');
 const patch={};
 if(Object.hasOwn(input,'status')){
  if(!orderStatuses.includes(input.status))throw Error('请选择有效订单状态');
  patch.status=input.status;
 }
 if(Object.hasOwn(input,'excludedFromSpend'))patch.excludedFromSpend=normalizeExcluded(input.excludedFromSpend);
 if(Object.hasOwn(input,'supplier')){
  const supplier=String(input.supplier??'').trim();
  if(!supplier)throw Error('供应商 / 店铺不能为空');
  if(supplier.length>200)throw Error('供应商 / 店铺最多 200 字');
  patch.supplier=supplier;
 }
 if(Object.hasOwn(input,'account')){
  const account=String(input.account??'').trim();
  if(!account)throw Error('采购账号不能为空');
  if(account.length>200)throw Error('采购账号最多 200 字');
  patch.account=account;
 }
 return patch;
}
