import {mountSupplierManagement} from './supplier-management.js';
export function createDirectories({state,api,esc,money,goOrders,toast,platforms}){
 const field=(label,name,value='',extra='')=>`<label class="field">${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
 async function suppliers(){return mountSupplierManagement({state,api,esc,money,goOrders,toast,platforms});}
 async function addresses(){
  const root=document.querySelector('#page-content');
  if(!state.extendedEditingAvailable){root.innerHTML='<p><a href="#settings">← 返回设置</a></p><div class="notice">后台尚未更新，请重启灵兔采购台并刷新页面后使用。</div>';return;}
  root.innerHTML=`<p><a href="#settings">← 返回设置</a></p><section class="panel"><form id="address-filter" class="directory-toolbar">${field('搜索姓名、电话、地址或供应商','q')}<label class="field">标签<select name="tag"><option value="">全部标签</option></select></label><button class="btn primary">查询</button><button type="button" class="btn" id="address-new">添加地址</button></form><p class="privacy-note">收货地址和供应商地址共用一个地址库；编辑或删除库中地址不会改变已保存的订单。</p><div id="address-editor"></div><div id="address-rows"></div></section>`;
  let rows=[],revision=0;
  const editor=root.querySelector('#address-editor');
  function edit(a={}){
   const original=a;
   editor.innerHTML=`<form class="directory-editor"><h3>${a.id?'编辑':'添加'}地址</h3><div class="form-grid">${field('联系人 / 地址名称 *','name',a.name,'required maxlength="200"')}${field('联系电话','phone',a.phone,'maxlength="40"')}<label class="field wide">详细地址<textarea name="address" maxlength="4000">${esc(a.address)}</textarea></label>${field('标签（用逗号分隔）','tags',a.tags?.join('，'))}<div class="actions"><button type="button" class="btn" data-tag="收货地址">＋ 收货地址</button><button type="button" class="btn" data-tag="供应商地址">＋ 供应商地址</button></div><label class="field">关联供应商平台（可选）<select name="platform"><option value="">不关联</option>${platforms.map(p=>`<option ${p===a.platform?'selected':''}>${esc(p)}</option>`).join('')}</select></label>${field('关联供应商名称（可选）','supplier',a.supplier,'list="directory-suppliers"')}<datalist id="directory-suppliers">${[...new Set(state.orders.map(o=>o.supplier))].map(s=>`<option value="${esc(s)}">`).join('')}</datalist><label class="field wide">备注<textarea name="note" maxlength="2000">${esc(a.note)}</textarea></label></div><div class="actions"><button class="btn primary">保存地址</button><button type="button" class="btn" id="address-cancel">取消</button></div><p class="alert error" id="address-error" hidden></p></form>`;
   editor.querySelector('#address-cancel').onclick=()=>editor.replaceChildren();
   editor.querySelectorAll('[data-tag]').forEach(b=>b.onclick=()=>{const el=editor.querySelector('[name=tags]');el.value=[...new Set([...el.value.split(/[,，;；\s]+/).filter(Boolean),b.dataset.tag])].join('，');});
   editor.querySelector('form').onsubmit=async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector('.primary');button.disabled=true;
    try{const data={...Object.fromEntries(new FormData(form)),updatedAt:original.updatedAt};await api('/api/addresses'+(original.id?'/'+original.id:''),data,original.id?'PUT':'POST');editor.replaceChildren();await load();toast('地址已保存');}
    catch(error){const box=editor.querySelector('#address-error');if(box){box.hidden=false;box.textContent=error.message;}button.disabled=false;}
   };
  }
  const load=async()=>{
   const rev=++revision,box=root.querySelector('#address-rows');
   try{
    const all=await api('/api/addresses');if(!root.isConnected||rev!==revision)return;
    const filters=Object.fromEntries(new FormData(root.querySelector('#address-filter'))),select=root.querySelector('[name=tag]');
    const tags=[...new Set(['收货地址','供应商地址',...all.flatMap(a=>a.tags)])];select.innerHTML='<option value="">全部标签</option>'+tags.map(t=>`<option ${t===filters.tag?'selected':''}>${esc(t)}</option>`).join('');
    const q=(filters.q||'').trim().toLowerCase();rows=all.filter(a=>(!filters.tag||a.tags.includes(filters.tag))&&(!q||[a.name,a.phone,a.address,a.supplier,a.note,...a.tags].join(' ').toLowerCase().includes(q)));
    box.innerHTML=`<div class="table-wrap"><table class="data-table"><thead><tr><th>联系人 / 名称</th><th>电话</th><th>地址</th><th>标签</th><th>关联供应商</th><th>操作</th></tr></thead><tbody>${rows.map((a,i)=>`<tr><td>${esc(a.name)}</td><td>${esc(a.phone)}</td><td class="address-cell">${esc(a.address)}</td><td>${a.tags.map(esc).join('、')}</td><td>${a.supplier?esc(a.platform+' · '+a.supplier):'—'}</td><td><button class="text-button" data-address-edit="${i}">编辑</button> <button class="text-button" data-address-delete="${i}">删除</button></td></tr>`).join('')||'<tr><td colspan="6">尚无符合条件的地址，点击“添加地址”录入。</td></tr>'}</tbody></table></div>`;
    box.querySelectorAll('[data-address-edit]').forEach(b=>b.onclick=()=>edit(rows[Number(b.dataset.addressEdit)]));
    box.querySelectorAll('[data-address-delete]').forEach(b=>b.onclick=()=>{
     const a=rows[Number(b.dataset.addressDelete)];b.outerHTML=`<span class="delete-address-confirm">删除“${esc(a.name)}”？<button class="text-button" data-confirm-delete="${a.id}">确认删除</button> <button class="text-button" data-cancel-delete>取消</button></span>`;
     const confirm=box.querySelector(`[data-confirm-delete="${a.id}"]`);confirm.onclick=async()=>{confirm.disabled=true;try{await api('/api/addresses/'+a.id,{updatedAt:a.updatedAt},'DELETE');await load();}catch(e){toast(e.message);await load();}};
     confirm.parentElement.querySelector('[data-cancel-delete]').onclick=()=>void load();
    });
   }catch(e){if(root.isConnected)box.textContent='读取失败：'+e.message;}
  };
  root.querySelector('#address-new').onclick=()=>edit();root.querySelector('#address-filter').onsubmit=e=>{e.preventDefault();void load();};await load();
 }
 return {suppliers,addresses};
}
