export function supplierChoices(orders,addresses=[],profiles=[]){
 const map=new Map(),get=(platform,supplier)=>{
  const key=JSON.stringify([platform,supplier]);
  if(!map.has(key))map.set(key,{key,platform,supplier,account:'',contact:null,maintained:false});
  return map.get(key);
 };
 const newest=(a,b)=>String(b.updatedAt||b.updated_at||b.date||'').localeCompare(String(a.updatedAt||a.updated_at||a.date||''));
 for(const order of [...orders].sort(newest)){
  if(!order.supplier?.trim())continue;
  const choice=get(order.platform,order.supplier);
  if(!choice.account)choice.account=order.account||'';
  if(!choice.contact&&order.supplierContact&&Object.values(order.supplierContact).some(Boolean))choice.contact=order.supplierContact;
 }
 for(const address of [...addresses].sort(newest)){
  if(!address.supplier&&!address.tags?.includes('供应商地址'))continue;
  const choice=get(address.platform||'',address.supplier||address.name);
  if(choice.maintained)continue;
  choice.maintained=true;choice.contact={name:address.name||'',phone:address.phone||'',address:address.address||''};
 }
 for(const profile of profiles){
  const platforms=[...new Set(profile.shops.map(shop=>shop.platform))];
  for(const platform of platforms){
   const shops=profile.shops.filter(shop=>shop.platform===platform);
   const primary=shops.find(shop=>shop.name===profile.name)||shops[0];
   const choice=get(platform,primary.name);
   choice.aliases=shops.map(shop=>shop.name);choice.label=profile.name;
   for(const shop of shops){
    const alias=map.get(JSON.stringify([platform,shop.name]));
    if(alias&&alias!==choice){if(!choice.account)choice.account=alias.account;if(!choice.contact)choice.contact=alias.contact;map.delete(alias.key);}
   }
   choice.maintained=true;choice.profileName=profile.name;
   choice.addresses=(profile.addresses||[]).map(address=>({...address,name:address.name||profile.contact||'',phone:address.phone||profile.phone||''}));
   choice.account=primary.account||choice.account;
   if(choice.addresses.length)choice.contact=choice.addresses[0];
   else if(profile.contact||profile.phone)choice.contact={name:profile.contact||choice.contact?.name||'',phone:profile.phone||choice.contact?.phone||'',address:choice.contact?.address||''};
  }
 }
 return [...map.values()].sort((a,b)=>Number(b.maintained)-Number(a.maintained)||a.supplier.localeCompare(b.supplier,'zh-CN')||a.platform.localeCompare(b.platform,'zh-CN'));
}
export function supplierPicker(o,esc){
 return `<div class="field wide supplier-picker"><label for="order-supplier-choice">供应商 / 店铺 <span class="required">*</span></label><select id="order-supplier-choice" disabled><option>正在读取供应商…</option></select><label class="field" data-new-supplier ${o.supplier?'':'hidden'}>供应商名称<input name="supplier" value="${esc(o.supplier)}" placeholder="填写新供应商名称" maxlength="200"></label><label class="field" data-supplier-address hidden>供应商联系地址<select data-supplier-address-choice></select></label><small class="muted" data-supplier-status aria-live="polite"></small></div>`;
}
export async function wireSupplierPicker(root,{orders,api,esc}){
 const select=root.querySelector('#order-supplier-choice');if(!select)return;
 let addresses=[],profiles=[],failed=false;
 try{addresses=await api('/api/addresses');}catch{failed=true;}
 try{profiles=await api('/api/supplier-management/choices');}catch{}
 if(!root.isConnected)return;
 let choices=supplierChoices(orders,addresses,profiles);const field=name=>root.querySelector(`[name="${name}"]`);
 const addressLabel=root.querySelector('[data-supplier-address]'),addressSelect=root.querySelector('[data-supplier-address-choice]');
 const contact=address=>{for(const name of ['name','phone','address'])field('supplierContact-'+name).value=address?.[name]||'';};
 const showAddresses=()=>{const choice=choices.find(c=>c.key===select.value),values=choice?.addresses||[];addressLabel.hidden=values.length<2;addressSelect.innerHTML=values.map((a,i)=>`<option value="${i}">${esc([a.label||'联系地址 '+(i+1),a.name,a.phone,a.address].filter(Boolean).join(' · '))}</option>`).join('');addressSelect.value=String(values.findIndex(a=>['name','phone','address'].every(k=>(a[k]||'')===field('supplierContact-'+k).value)));};
 addressSelect.onchange=()=>{const choice=choices.find(c=>c.key===select.value);contact(choice?.addresses?.[Number(addressSelect.value)]);};
 const manual=root.querySelector('[data-new-supplier]'),status=root.querySelector('[data-supplier-status]');
 const render=()=>{
  const platform=field('platform').value;
  const current=choices.find(c=>c.platform===platform&&(c.supplier===field('supplier').value||c.aliases?.includes(field('supplier').value)));
  select.innerHTML='<option value="">请选择已有供应商</option>'+[true,false].map(maintained=>{
   const rows=choices.filter(c=>c.platform===platform&&c.maintained===maintained);return rows.length?`<optgroup label="${maintained?'已维护供应商':'历史订单供应商'}">${rows.map(c=>`<option value="${esc(c.key)}">${esc(c.label||c.supplier)}</option>`).join('')}</optgroup>`:'';
  }).join('')+'<option value="new">＋ 新供应商 / 手动填写</option>';
  select.value=current?.key||(field('supplier').value?'new':'');select.disabled=!platform;manual.hidden=select.value!=='new';showAddresses();
 };
 render();if(failed)status.textContent='地址库读取失败，暂显示历史供应商；可手动填写。';
 select.onchange=()=>{
  addressLabel.hidden=true;
  manual.hidden=select.value!=='new';
  if(select.value==='new'){field('supplier').value='';for(const name of ['name','phone','address'])field('supplierContact-'+name).value='';field('supplier').focus();status.textContent='';return;}
  const choice=choices.find(c=>c.key===select.value&&c.platform===field('platform').value);if(!choice){field('supplier').value='';for(const name of ['name','phone','address'])field('supplierContact-'+name).value='';status.textContent='';return;}
  field('supplier').value=choice.supplier;
  if(choice.account){field('account').value=choice.account;field('account').dataset.supplierAccount=choice.account;}
  for(const name of ['name','phone','address'])field('supplierContact-'+name).value=choice.contact?.[name]||'';
  showAddresses();
  status.textContent=choice.contact?'已带出供应商联系信息，请核对。':'已选供应商，尚无联系地址，可在下方补充。';
 };
 field('platform').addEventListener('change',()=>{
  field('supplier').value='';for(const name of ['name','phone','address'])field('supplierContact-'+name).value='';
  const account=field('account');if(account.dataset.supplierAccount===account.value)account.value='默认账号';delete account.dataset.supplierAccount;
  render();status.textContent='请重新选择此平台的供应商。';
 });
 return {refresh:render,update(orders,addresses,profiles=[]){choices=supplierChoices(orders,addresses,profiles);render();}};
}
