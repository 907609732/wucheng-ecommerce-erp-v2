import {orderConfirmation} from './month-locks.js';
import {categories,defaultClassification,normalizeClassification,allocations,classificationDescription,unallocatedRefund} from './classification.mjs';
const $=s=>document.querySelector(s);
const yuan=c=>(c/100).toFixed(2);
export const categoryOptions=(selected='',all='')=>(all?`<option value="">${all}</option>`:'')+Object.entries(categories).map(([key,label])=>`<option value="${key}" ${key===selected?'selected':''}>${label}</option>`).join('');
export function classificationForm(o,{split=false}={}){
 const c=o.classification||defaultClassification(),mode=split||c.mode==='split'?'split':c.category;
 const parts=c.mode==='split'?c.parts:[{category:c.category,amountCents:o.amountCents||0,refundCents:0}];
 return `<section class="classification-form"><label class="field">采购类别<select name="classificationMode" aria-label="采购类别">${categoryOptions(mode)}<option value="split" ${mode==='split'?'selected':''}>混合（拆分分类金额）</option></select></label><div class="classification-parts" ${mode!=='split'?'hidden':''}><p class="privacy-note">每种类别一行；填写两类或三类实付，未使用的类别留空或填 0。运费已包含在实付中。</p><div class="class-part-head"><span>采购类别</span><span>实付分配（元）</span><span>退款分配（元）</span></div>${Object.entries(categories).map(([key,label])=>{const p=parts.find(p=>p.category===key);return `<div class="class-part-row" data-class-part="${key}"><strong>${label}</strong><input type="number" min="0" step="0.01" data-class-amount aria-label="${label}实付分配" value="${p?yuan(p.amountCents):''}" placeholder="0.00"><input type="number" min="0" step="0.01" data-class-refund aria-label="${label}退款分配" value="${p?.refundCents?yuan(p.refundCents):''}" placeholder="暂不分配"></div>`;}).join('')}<div class="classification-balance" aria-live="polite"></div></div><p class="privacy-note class-single-hint" ${mode==='split'?'hidden':''}>整单退款自动归入此类别。耗材、软件、外包、员工福利等选日常支出，用途写备注。</p></section>`;
}
function cents(value){
 if(!/^\d+(\.\d{1,2})?$/.test(value||'0'))throw Error('分类金额须为非负数字，最多两位小数');
 const [a,b='']=(value||'0').split('.');return Number(a)*100+Number(b.padEnd(2,'0'));
}
export function classificationDraft(root=document){
 const mode=root.querySelector('[name="classificationMode"]')?.value||'goods';
 if(mode!=='split')return {mode:'single',category:mode,owner:'company'};
 return {mode:'split',owner:'company',parts:[...root.querySelectorAll('[data-class-part]')].map(row=>({category:row.dataset.classPart,amountCents:cents(row.querySelector('[data-class-amount]').value),refundCents:cents(row.querySelector('[data-class-refund]').value)})).filter(p=>p.amountCents||p.refundCents)};
}
export function readClassification(o,root=document){return normalizeClassification(classificationDraft(root),o.amountCents,o.refundCents);}
export function wireClassification(o){
 const form=$('.classification-form');if(!form)return;
 const update=()=>{
  const mixed=form.querySelector('select').value==='split';form.querySelector('.classification-parts').hidden=!mixed;form.querySelector('.class-single-hint').hidden=mixed;
  if(!mixed)return;
  const balance=form.querySelector('.classification-balance');
  try{
   const paid=$('[name="amountCents"]')?cents($('[name="amountCents"]').value):o.amountCents||0,refund=$('[name="refundCents"]')?cents($('[name="refundCents"]').value):o.refundCents||0,c=classificationDraft(form);
   const allocated=c.parts.reduce((s,p)=>s+p.amountCents,0),assigned=c.parts.reduce((s,p)=>s+p.refundCents,0);
   balance.textContent=`整单实付 ¥${yuan(paid)} · 已分配 ¥${yuan(allocated)} · 差额 ¥${yuan(paid-allocated)}；整单退款 ¥${yuan(refund)} · 待分配退款 ¥${yuan(refund-assigned)}`;
   balance.classList.toggle('invalid',allocated!==paid||assigned>refund||c.parts.some(p=>p.refundCents>p.amountCents));
  }catch(e){balance.textContent=e.message;balance.classList.add('invalid');}
 };
 form.addEventListener('input',update);form.addEventListener('change',update);
 for(const key of ['amountCents','refundCents'])$(`[name="${key}"]`)?.addEventListener('input',update);
 update();
}
export function classificationDetails(o,esc,money,{readOnly=false}={}){
 return `<section class="classification-details"><h3>采购分类</h3>${allocations(o).map(p=>`<div><strong>${categories[p.category]}</strong><span>实付 ${money(p.amountCents)}</span><span>退款 ${money(p.refundCents)}</span><b>净支出 ${money(p.amountCents-p.refundCents)}</b></div>`).join('')}${unallocatedRefund(o)?`<p class="class-warning">待分配退款 ${money(unallocatedRefund(o))}，已扣减总支出；请拆分退款类别后核对各类净额。</p>`:''}${readOnly?'':`<button class="text-button" data-class-split="${esc(o.id)}">拆分分类金额 / 分配退款</button>`}</section>`;
}
export function createClassificationActions(ctx){
 const {modal,closeModal,api,esc,money,state,toast,refreshRows,setKind}=ctx;
 async function apply(saved){
  const byId=new Map(saved.map(o=>[o.id,o]));state.orders=state.orders.map(o=>byId.get(o.id)||o);await refreshRows();
 }
 function error(e){const box=$('#classification-error');if(box){box.hidden=false;box.textContent=e.message;}else toast(e.message);}
 async function change(orders,category,{confirm=false}={}){
  if(!orders.length)return;if(orders.some(o=>orderConfirmation(o,state))){toast('所选订单中有已锁定数据，请先到月度确认取消确认');return;}
  const snapshot=orders.map(o=>structuredClone(state.orders.find(s=>s.id===o.id)||o)),mixed=snapshot.filter(o=>o.classification?.mode==='split');
  if(confirm||snapshot.length>1||mixed.length){
   setKind('classification');
   modal('确认修改采购类别',`本次作用于 ${snapshot.length} 笔订单 → ${categories[category]}`,`<p>将这 ${snapshot.length} 笔订单整单归入<strong> ${categories[category]}</strong>，退款同时归入该类别。</p>${mixed.length?`<div class="alert warning">以下 ${mixed.length} 笔混合订单的实付、退款拆分将被整单分类替换。</div><div class="class-overwrite-list">${mixed.map(o=>`<article><b>${esc(o.orderNo)} · ${esc(o.supplier)}</b><p>${esc(classificationDescription(o))}</p></article>`).join('')}</div>`:''}<p class="privacy-note">确认后一次保存，任一订单版本变化则整批不保存。修改历史保留原拆分。</p><div id="classification-error" class="alert error" hidden></div>`,`<button class="btn" data-action="close">取消</button><button id="confirm-classification" class="btn primary">确认修改 ${snapshot.length} 笔</button>`,true);
   $('#confirm-classification').addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try{const r=await api('/api/orders/classification/batch',{category,orders:snapshot.map(o=>({id:o.id,updatedAt:o.updatedAt}))});closeModal();await apply(r.orders);toast(`已将 ${r.orders.length} 笔订单改为${categories[category]}`);}catch(e){error(e);button.disabled=false;}});
   return;
  }
  try{const o=snapshot[0],saved=await api('/api/orders/'+o.id+'/classification',{updatedAt:o.updatedAt,classification:{mode:'single',category,owner:'company'}},'PATCH');await apply([saved]);toast('采购类别已保存');}catch(e){error(e);}
 }
 function split(id){
  const original=state.orders.find(o=>o.id===id);if(!original)return;if(orderConfirmation(original,state)){toast('此订单已锁定，请先到月度确认取消确认');return;}const o=structuredClone(original);setKind('classification');
  modal('拆分分类金额',`${esc(o.orderNo)} · ${esc(o.supplier)}`,`<div class="class-order-totals"><span>整单实付 <b>${money(o.amountCents)}</b></span><span>整单退款 <b>${money(o.refundCents)}</b></span></div>${classificationForm(o,{split:true})}<p class="privacy-note">退款暂时无法判断时，可保留部分或全部待分配；总支出仍扣除整单退款。</p><div id="classification-error" class="alert error" hidden></div>`,`<button class="btn" data-action="close">取消</button><button id="save-classification" class="btn primary">保存分类分配</button>`,true);
  wireClassification(o);
  $('#save-classification').addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try{const classification=readClassification(o),saved=await api('/api/orders/'+o.id+'/classification',{updatedAt:o.updatedAt,classification},'PATCH');closeModal();await apply([saved]);toast('分类分配已保存');}catch(e){error(e);button.disabled=false;}});
 }
 return {change,split};
}
