const storageKey='purchase-order-form-fields-v2';
const fields=[
 ['platform','采购平台',true],['supplier','供应商',true],['orderNo','订单编号',true],['account','采购账号',false,false],
 ['date','下单日期',true],['paidAt','付款日期',false,false],['status','订单状态',false,false],['amountCents','实付金额',true],
 ['excludedFromSpend','采购支出统计',false,false],['refundCents','已记录退款',false,false],['shippingCents','其中运费',false,false],
 ['classification','采购类别',false,false],['contacts','收货与供应商地址'],['note','备注'],
];
function preferences(key=storageKey,hiddenDefaults=[]){
 let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{}
 return Object.fromEntries(fields.map(([key,,required,visible=true])=>[key,required||typeof saved[key]!=='boolean'?required||(visible&&!hiddenDefaults.includes(key)):saved[key]]));
}
export function wireOrderFormView(root,esc,{key=storageKey,hiddenDefaults=[],requiredFields=[],label='显示字段'}={}){
 root.classList.add('compact-order-form');
 for(const label of root.querySelectorAll('label.field')){
  const control=label.querySelector(':scope > input,:scope > select,:scope > textarea');if(!control)continue;
  const title=document.createElement('span');title.className='form-field-title';
  while(label.firstChild&&label.firstChild!==control)title.append(label.firstChild);
  if(control.required&&!title.querySelector('.required')){
   const marker=document.createElement('span');marker.className='required';marker.textContent='*';marker.setAttribute('aria-label','必填');title.append(marker);
  }
  label.prepend(title);
 }
 const sections=new Map();
 for(const [key] of fields){
  const section=key==='supplier'?root.querySelector('.supplier-picker'):key==='classification'?root.querySelector('.classification-form'):key==='contacts'?root.querySelector('.delivery-form'):root.querySelector(`[name="${key}"]`)?.closest('label.field');
  if(section){section.dataset.formField=key;sections.set(key,section);}
 }
 const requiredKeys=new Set(fields.filter(([, ,required])=>required).map(([key])=>key).concat(requiredFields));
 const view=preferences(key,hiddenDefaults);for(const key of requiredFields)view[key]=true;
 const toolbar=document.createElement('div');toolbar.className='form-view-toolbar';
 toolbar.innerHTML=`<h3>采购信息</h3><details class="form-field-picker"><summary>${esc(label)}</summary><div class="form-field-options"><p>勾选需要填写的字段。隐藏只收起显示，已有数据照常保留。</p>${fields.filter(([key])=>sections.has(key)).map(([key,label,required])=>`<label><input type="checkbox" data-form-toggle="${key}" ${view[key]?'checked':''} ${requiredKeys.has(key)?'disabled':''}>${esc(label)}${requiredKeys.has(key)?'（必填）':''}</label>`).join('')}<button type="button" class="text-button" data-default-fields>恢复默认</button><span class="muted" data-field-save-status role="status"></span></div></details>`;
 root.prepend(toolbar);
 const apply=()=>{for(const [key,section] of sections)section.hidden=!view[key];};
 const save=()=>{apply();const status=toolbar.querySelector('[data-field-save-status]');try{localStorage.setItem(key,JSON.stringify(view));status.textContent='已保存';}catch{status.textContent='本次生效，浏览器未允许保存';}};
 toolbar.querySelectorAll('[data-form-toggle]').forEach(input=>input.onchange=()=>{view[input.dataset.formToggle]=input.checked;save();});
 toolbar.querySelector('[data-default-fields]').onclick=()=>{for(const [key,,required,visible=true] of fields)view[key]=requiredKeys.has(key)||(visible&&!hiddenDefaults.includes(key));toolbar.querySelectorAll('[data-form-toggle]').forEach(input=>input.checked=view[input.dataset.formToggle]);save();};
 apply();
}
