import {supplierChoices} from './supplier-picker.js';
import {orderConfirmation} from './month-locks.js';
import {orderStatuses,includedInSpend,attributePatch} from './order-attributes.mjs';
const $=s=>document.querySelector(s);
export function createAttributeActions(ctx){
 const {state,modal,closeModal,setKind,api,esc,money,toast,refreshRows}=ctx;
 function open(selected,preset={},focus=null){
  if(!selected.length)return;
  if(!state.attributeEditingAvailable){toast('请重启灵兔采购台后台并刷新页面后使用批量修改属性');return;}
  const snapshot=selected.map(o=>structuredClone(state.orders.find(s=>s.id===o.id)||o));
  if(snapshot.some(o=>orderConfirmation(o,state))){toast('所选订单中有已锁定数据，请先到月度确认取消确认');return;}
  let suppliers=supplierChoices(state.orders);
  const supplierOptions=()=>'<option value="">保持不变</option>'+suppliers.map((s,i)=>`<option value="${i}">${esc(s.label||s.supplier)} · ${esc(s.platform||'未指定平台')}</option>`).join('')+'<option value="new">＋ 手动填写供应商</option>';
  const accounts=[...new Set(state.orders.map(o=>o.account).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 setKind('attributes');
 modal(focus==='supplier'?'批量修改供应商':focus==='account'?'批量修改采购账号':'批量修改属性',`本次作用于 ${snapshot.length} 笔订单`,
   `<div class="form-grid"><label class="field">订单状态<select id="attribute-status" aria-label="批量订单状态"><option value="">保持不变</option>${orderStatuses.map(s=>`<option value="${s}" ${preset.status===s?'selected':''}>${s}</option>`).join('')}</select></label><label class="field">采购支出统计<select id="attribute-spend" aria-label="批量采购支出统计"><option value="">保持不变</option><option value="exclude" ${preset.excludedFromSpend===true?'selected':''}>不计入采购支出</option><option value="normal" ${preset.excludedFromSpend===false?'selected':''}>恢复正常计入（按订单状态）</option></select></label><label class="field">供应商 / 店铺<select id="attribute-supplier-choice" aria-label="批量供应商 / 店铺">${supplierOptions()}</select></label><label class="field" id="attribute-supplier-manual" hidden style="display:none">手动填写供应商<input id="attribute-supplier" value="${esc(preset.supplier||'')}" placeholder="输入供应商名称" maxlength="200" autocomplete="off"></label><label class="field">采购账号<input id="attribute-account" list="attribute-account-list" value="${esc(preset.account||'')}" placeholder="保持不变，可输入新账号" autocomplete="off"><datalist id="attribute-account-list">${accounts.map(a=>`<option value="${esc(a)}">`).join('')}</datalist></label></div><p class="privacy-note">不属于公司的订单可选“不计入采购支出”，保留真实交易状态和原始记录；之后可恢复正常计入。已关闭、待付款、待核对的订单仍不计入支出。修改采购账号时，若新账号下已存在相同订单号，整批不会保存，并列出冲突订单。</p><div id="attribute-preview" class="notice" aria-live="polite"></div><details><summary>查看本次 ${snapshot.length} 笔订单</summary><div class="class-overwrite-list">${snapshot.map(o=>`<article><b>${esc(o.orderNo)}</b> · ${esc(o.supplier)} · ${esc(o.account)} · ${money(o.amountCents)}</article>`).join('')}</div></details><div id="attribute-error" class="alert error" hidden></div>`,
   `<button class="btn" data-action="close">取消</button><button class="btn primary" id="save-attributes" disabled>确认修改 ${snapshot.length} 笔</button>`,true);
 // focus 模式（批量改供应商 / 账号）打开后聚焦对应输入，晚于 modal 自身的首元素聚焦。
 if(focus)setTimeout(()=>{const el=$(focus==='supplier'?'#attribute-supplier-choice':'#attribute-'+focus);el?.focus();el?.scrollIntoView({block:'nearest'});},60);
  const draft=()=>{
   const patch={},status=$('#attribute-status').value,spend=$('#attribute-spend').value,supplier=$('#attribute-supplier').value.trim(),account=$('#attribute-account').value.trim();
   if(status)patch.status=status;if(spend)patch.excludedFromSpend=spend==='exclude';
   if(supplier)patch.supplier=supplier;if(account)patch.account=account;return patch;
  };
  const preview=()=>{
   const patch=draft(),after=snapshot.map(o=>({...o,...patch}));
   const net=rows=>rows.filter(includedInSpend).reduce((s,o)=>s+o.amountCents-o.refundCents,0);
   const changes=[];if(patch.status)changes.push(`订单状态 → ${patch.status}`);
   if(Object.hasOwn(patch,'excludedFromSpend'))changes.push(`采购支出统计 → ${patch.excludedFromSpend?'不计入':'恢复正常计入'}`);
   if(patch.supplier)changes.push(`供应商 → ${patch.supplier}`);
   if(patch.account)changes.push(`采购账号 → ${patch.account}`);
   const changed=snapshot.filter((o,i)=>['status','excludedFromSpend','supplier','account'].some(k=>Object.hasOwn(patch,k)&&(o[k]!==after[i][k]))).length;
   $('#attribute-preview').textContent=(changes.length?changes.join('；'):'请选择需要修改的属性')+`。\n所选 ${snapshot.length} 笔，实付合计 ${money(snapshot.reduce((s,o)=>s+o.amountCents,0))}；计入采购净支出 ${money(net(snapshot))} → ${money(net(after))}。\n实际改变 ${changed} 笔；确认后一次保存并保留修改记录。`;
   $('#save-attributes').disabled=!changed;
  };
  $('#attribute-status').addEventListener('change',preview);$('#attribute-spend').addEventListener('change',preview);
  const supplierSelect=$('#attribute-supplier-choice'),supplierInput=$('#attribute-supplier'),manual=$('#attribute-supplier-manual');
  const renderSuppliers=()=>{const value=supplierInput.value,wasManual=supplierSelect.value==='new',index=suppliers.findIndex(s=>s.supplier===value);supplierSelect.innerHTML=supplierOptions();supplierSelect.value=wasManual?'new':index>=0?String(index):value?'new':'';manual.hidden=supplierSelect.value!=='new';manual.style.display=manual.hidden?'none':'';};
  supplierSelect.onchange=()=>{manual.hidden=supplierSelect.value!=='new';manual.style.display=manual.hidden?'none':'';supplierInput.value=supplierSelect.value==='new'?'':suppliers[Number(supplierSelect.value)]?.supplier||'';if(supplierSelect.value==='')supplierInput.value='';if(!manual.hidden)supplierInput.focus();preview();};
  supplierInput.addEventListener('input',preview);$('#attribute-account').addEventListener('input',preview);renderSuppliers();preview();
  api('/api/supplier-management/choices').then(profiles=>{if(!supplierSelect.isConnected)return;suppliers=supplierChoices(state.orders,[],profiles);renderSuppliers();}).catch(()=>{});
  $('#save-attributes').addEventListener('click',async e=>{
   const button=e.currentTarget;button.disabled=true;
   try{
    const patch=attributePatch(draft()),result=await api('/api/orders/attributes/batch',{patch,orders:snapshot.map(o=>({id:o.id,updatedAt:o.updatedAt}))});
    const byId=new Map(result.orders.map(o=>[o.id,o]));state.orders=state.orders.map(o=>byId.get(o.id)||o);
    closeModal();await refreshRows();toast(result.skipped?.length?`已更新 ${result.changed} 笔，跳过 ${result.skipped.length} 笔（账号冲突）`:`已更新 ${result.changed} 笔订单，修改记录已保存`);
   }catch(error){const box=$('#attribute-error');box.hidden=false;box.textContent=error.message+(error.conflicts?.length?'\n'+error.conflicts.map(c=>`${c.platform} · ${c.orderNo} · ${c.account}：${c.reason}`).join('\n'):'');button.disabled=false;}
  });
 }
 return {open};
}
