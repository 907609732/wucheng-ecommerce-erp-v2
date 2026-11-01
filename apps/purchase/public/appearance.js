const key='purchase-font-scale';
const sizes=[{value:1,label:'标准 · 100%'},{value:1.2,label:'较大 · 120%'},{value:1.4,label:'大号 · 140%'},{value:1.6,label:'特大 · 160%'}];
export function fontScale(){
 return Number(document.documentElement.style.getPropertyValue('--font-scale'))||1;
}
function apply(value){
 const scale=sizes.some(s=>s.value===Number(value))?Number(value):1;
 document.documentElement.style.setProperty('--font-scale',String(scale));
 document.documentElement.dataset.largeType=String(scale>=1.4);
 window.dispatchEvent(new Event('resize'));
 return scale;
}
try{apply(localStorage.getItem(key));}catch{apply(1);}
window.addEventListener('storage',event=>{if(event.key===key)apply(event.newValue);});
export function appearancePanel(){
 return `<section class="panel appearance-panel"><div class="panel-head"><h2>字号大小</h2></div><div class="panel-body"><label class="field">界面字号<select id="font-size-setting">${sizes.map(size=>`<option value="${size.value}" ${size.value===fontScale()?'selected':''}>${size.label}</option>`).join('')}</select></label><p class="privacy-note">调整菜单、订单表格、筛选条件和弹窗的文字大小，立即生效并保存在当前浏览器。</p><div class="font-size-preview"><strong>文字预览：采购订单</strong><p>供应商、商品名称与订单备注</p><small>采购金额 ¥1,234.56 · 已完成</small></div><div class="actions"><button class="btn" id="reset-font-size">恢复标准字号</button><span class="muted small" id="font-size-status" role="status" aria-live="polite"></span></div></div></section>`;
}
export function wireAppearance(){
 const select=document.querySelector('#font-size-setting');
 const update=value=>{
  const scale=apply(value);select.value=String(scale);
  const status=document.querySelector('#font-size-status');
  try{localStorage.setItem(key,String(scale));status.textContent=`已保存 · ${Math.round(scale*100)}%`;}catch{status.textContent='已生效，但浏览器不允许保存设置';}
 };
 select.addEventListener('change',()=>update(select.value));
 document.querySelector('#reset-font-size').addEventListener('click',()=>update(1));
}
