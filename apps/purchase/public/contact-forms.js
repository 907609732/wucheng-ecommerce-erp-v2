import {parseAddress} from './address-parse.mjs';
export function contactForm(role,value,esc){
 const supplier=role==='supplier',label=supplier?'供应商联系地址':'收货信息',prefix=supplier?'supplierContact-':'';
 const fields=supplier?{name:'name',phone:'phone',address:'address'}:{name:'recipient',phone:'phone',address:'address'};
 return `<section class="contact-form" data-contact="${role}"><h3>${label}（可选）</h3><div class="form-grid"><label class="field wide">${supplier?'供应商地址':'收货地址'}<textarea name="${prefix+fields.address}" data-address-text rows="2" maxlength="4000" placeholder="粘贴姓名、手机和详细地址，按回车自动填好">${esc(value?.address)}</textarea></label><label class="field">${supplier?'联系人 / 名称':'收货人姓名'}<input name="${prefix+fields.name}" value="${esc(value?.name)}" maxlength="200"></label><label class="field">联系电话<input name="${prefix+fields.phone}" value="${esc(value?.phone)}" maxlength="40"></label></div><div data-address-preview class="privacy-note" aria-live="polite" hidden></div><details class="contact-address-tools"><summary>地址库</summary><div class="actions"><button type="button" class="text-button" data-pick-address>选择已有地址</button><button type="button" class="text-button" data-save-address>保存当前地址</button><a href="#addresses" target="_blank" rel="noopener">管理地址库 ↗</a></div><div data-address-picker hidden></div></details></section>`;
}
export function wireContactForms(root,{api,esc,toast}){
 for(const section of root.querySelectorAll('[data-contact]')){
  const supplier=section.dataset.contact==='supplier',prefix=supplier?'supplierContact-':'',nameKey=supplier?'name':'recipient';
  const read=()=>({name:section.querySelector(`[name="${prefix+nameKey}"]`).value,phone:section.querySelector(`[name="${prefix}phone"]`).value,address:section.querySelector(`[name="${prefix}address"]`).value});
  const apply=a=>{section.querySelector(`[name="${prefix+nameKey}"]`).value=a.name||a.recipient||'';section.querySelector(`[name="${prefix}phone"]`).value=a.phone||'';section.querySelector(`[name="${prefix}address"]`).value=a.address||'';};
  section.querySelector('[data-address-text]').onkeydown=e=>{
   if(e.key!=='Enter'||e.shiftKey||e.isComposing||e.keyCode===229)return;
   e.preventDefault();e.stopPropagation();const original=e.target.value.trim();if(!original)return;
   const box=section.querySelector('[data-address-preview]');box.hidden=false;
   try{const parsed=parseAddress(original),prior=read();e.target.dataset.originalAddress=original;apply({name:parsed.recipient||prior.name,phone:parsed.phone||prior.phone,address:parsed.address||original});box.textContent=`${parsed.recipient?'已填写姓名；':''}${parsed.phone?'已填写电话；':''}请核对地址${!parsed.recipient&&!parsed.phone?'。未识别姓名和电话，已有填写已保留':''}`;}catch(error){box.textContent=error.message;}
  };
  section.querySelector('[data-save-address]').onclick=async e=>{
   const b=e.currentTarget;b.disabled=true;
   try{const data={...read(),tags:[supplier?'供应商地址':'收货地址'],...(supplier?{platform:root.querySelector('[name=platform]').value,supplier:root.querySelector('[name=supplier]').value.trim()}:{})};if(!data.supplier)delete data.platform;
    await api('/api/addresses',data);toast('已保存到地址库');}catch(e){toast(e.message);}finally{b.disabled=false;}
  };
  section.querySelector('[data-pick-address]').onclick=async()=>{
   const box=section.querySelector('[data-address-picker]');if(!box.hidden){box.hidden=true;return;}box.hidden=false;box.textContent='正在读取地址库…';
   try{
    const rows=await api('/api/addresses');if(!box.isConnected)return;
    box.innerHTML=`<div class="directory-toolbar"><input data-picker-q placeholder="搜索姓名、电话、地址" aria-label="搜索地址库"><select data-picker-tag aria-label="地址标签"><option value="">全部标签</option>${[...new Set(['收货地址','供应商地址',...rows.flatMap(a=>a.tags)])].map(t=>`<option>${esc(t)}</option>`).join('')}</select></div><div data-picker-list></div>`;
    const draw=()=>{
     const q=box.querySelector('[data-picker-q]').value.toLowerCase(),tag=box.querySelector('[data-picker-tag]').value;
     box.querySelector('[data-picker-list]').innerHTML=rows.map((a,i)=>({a,i})).filter(({a})=>(!tag||a.tags.includes(tag))&&[a.name,a.phone,a.address,a.supplier].join(' ').toLowerCase().includes(q)).map(({a,i})=>`<button type="button" class="address-choice" data-use-address="${i}"><b>${esc(a.name)} · ${esc(a.phone)}</b><span>${esc(a.address)}</span><small>${a.tags.map(esc).join('、')}${a.supplier?' · '+esc(a.platform+' '+a.supplier):''}</small></button>`).join('')||'<p class="privacy-note">没有符合条件的地址。</p>';
     box.querySelectorAll('[data-use-address]').forEach(b=>b.onclick=()=>{apply(rows[Number(b.dataset.useAddress)]);box.hidden=true;});
    };box.querySelector('[data-picker-q]').oninput=draw;box.querySelector('[data-picker-tag]').onchange=draw;draw();
   }catch(e){if(box.isConnected)box.textContent='读取失败：'+e.message;}
  };
 }
}
