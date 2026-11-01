let selectedOwner='all',allPeriods=false,search='';
const expanded=new Set();
export function renderFreight({month,shops,bills,esc,money,onBill,onNew,onImport,onExport,onMonth,onDownload}){
 const $=s=>document.querySelector(s);
 const owners=[...shops.map(s=>({id:s.id,name:s.name,platform:s.platform})),{id:'company',name:'公司共用',platform:'未归属店铺的运费'}];
 if(!owners.some(s=>s.id===selectedOwner))selectedOwner='all';
 const active=bills.filter(b=>!b.voided), ownerName=id=>owners.find(s=>s.id===id)?.name||id;
 const filtered=()=>active.filter(b=>(allPeriods||b.period===month)&&(selectedOwner==='all'||b.owner===selectedOwner)&&[b.billNo,b.party,b.title,ownerName(b.owner)].join(' ').toLowerCase().includes(search.toLowerCase()));
 $('#content').innerHTML=`<div class="freight-page">
  <div class="page-head freight-heading"><div><h1>运费账单</h1><p class="lead">每月按店铺填写，也可用 Excel 批量维护。</p></div>
   <div class="actions"><button id="freight-cloud">下载云仓账单</button><button id="freight-import">导入 Excel</button><details class="freight-export-menu"><summary class="button primary">导出 Excel <span aria-hidden="true">⌄</span></summary><div class="freight-menu-panel"><button id="freight-export"><b>导出已有账单</b><small>按当前筛选导出，修改后可回导</small></button><button id="freight-template"><b>下载空白填写表</b><small>预填所选月份与店铺</small></button></div></details></div>
  </div>
  <section class="card freight-ledger">
   <div class="freight-controls"><div class="freight-month"><button id="freight-prev" aria-label="上个月">‹</button><input id="freight-month" type="month" min="2000-01" max="2099-12" value="${esc(month)}" aria-label="运费月份"><button id="freight-next" aria-label="下个月">›</button><span id="freight-scope" class="muted"></span></div><details id="freight-filter" class="freight-filter" ${selectedOwner!=='all'||search||allPeriods?'open':''}><summary>筛选<span id="freight-filter-count"></span></summary><div class="freight-filter-fields"><select id="freight-owner" aria-label="筛选店铺"><option value="all">全部店铺及公司共用</option>${owners.map(s=>`<option value="${esc(s.id)}" ${s.id===selectedOwner?'selected':''}>${esc(s.name+' · '+s.platform)}</option>`).join('')}</select><input id="freight-search" type="search" value="${esc(search)}" placeholder="店铺、物流公司或账单号" aria-label="搜索运费账单"><label class="checkbox"><input id="freight-all" type="checkbox" ${allPeriods?'checked':''}>所有月份</label><button id="freight-reset" type="button">清除筛选</button></div></details></div>
   <div id="freight-totals" class="freight-summary" aria-live="polite"></div>
   <div class="table-wrap"><table class="simple freight-store-table"><thead><tr><th>店铺</th><th>登记情况</th><th class="number">运费金额（元）</th><th class="number">已付（元）</th><th class="number">待付（元）</th><th class="freight-action-cell">操作</th></tr></thead><tbody id="freight-shops"></tbody></table></div>
   <div class="table-note">“待填写”表示尚未录入；付款在账单详情中单独登记。</div>
  </section>
  <details class="freight-help"><summary>填写与表格维护说明</summary><p>直接填写：找到店铺，点“填写”，输入物流公司和金额即可。同一店铺可以添加多张账单。</p><p>Excel 维护：下载空白填写表录入新账单，或导出已有账单修改，再用“导入 Excel”预览确认。更正已有账单须保留记录 ID、版本，并填写更正原因。</p><p>此处金额按账单所属月份汇总，已付包含该账单所有日期的净付款；经营看板按实际付款日期统计。登记过账单不等于已录全，完整性仍在“待补数据”中确认。</p></details>
 </div>`;
 const render=()=>{
  const rows=filtered(),sum=k=>rows.reduce((n,b)=>n+b[k],0),value=k=>rows.length?'¥ '+money(sum(k)):'—';
  const visibleOwners=owners.filter(s=>(selectedOwner==='all'||s.id===selectedOwner)&&(!search||s.name.toLowerCase().includes(search.toLowerCase())||rows.some(b=>b.owner===s.id)));
  $('#freight-scope').textContent=allPeriods?'正在查看所有月份':'';
  $('#freight-filter-count').textContent=[selectedOwner!=='all',!!search,allPeriods].filter(Boolean).length?' · 已筛选':'';
  $('#freight-totals').innerHTML=`<span>已登记 <b>${rows.length}</b> 张账单</span><span>运费合计 <strong>${value('amountCents')}</strong></span><span>待付 <strong>${value('pendingCents')}</strong></span>`;
  $('#freight-export').disabled=!rows.length;
  $('#freight-shops').innerHTML=visibleOwners.map(shop=>{
   const subset=rows.filter(b=>b.owner===shop.id),amount=k=>subset.length?money(subset.reduce((n,b)=>n+b[k],0)):'<span class="freight-dash">—</span>',isOpen=expanded.has(shop.id)&&subset.length;
   const row=`<tr class="freight-shop-row ${isOpen?'is-open':''}"><td><strong>${esc(shop.name)}</strong><small>${esc(shop.platform)}</small></td><td>${subset.length?`<span class="pill good">${subset.length} 张账单</span>`:'<span class="freight-unrecorded">待填写</span>'}</td><td class="number freight-amount">${amount('amountCents')}</td><td class="number">${amount('paidCents')}</td><td class="number">${amount('pendingCents')}</td><td class="freight-action-cell">${subset.length?`<button class="freight-row-action" data-expand="${esc(shop.id)}" aria-label="${esc((isOpen?'收起':'查看')+shop.name+'账单')}" aria-expanded="${!!isOpen}">${isOpen?'收起':'查看账单'} <span aria-hidden="true">${isOpen?'⌃':'⌄'}</span></button>`:`<button class="freight-row-action" data-create="${esc(shop.id)}" aria-label="填写${esc(shop.name)}运费">＋ 填写</button>`}</td></tr>`;
   if(!isOpen)return row;
   return row+`<tr class="freight-expanded"><td colspan="6"><div class="freight-bill-list">${subset.map(b=>`<button class="freight-bill" data-bill="${esc(b.id)}"><span><b>${esc(b.party)}</b><small>${esc(b.period+' · '+b.billNo)}${b.linkedSource?' · 已关联来源':''}</small></span><span class="freight-bill-amount"><b>¥ ${money(b.amountCents)}</b><small>${b.pendingCents===0?'已付清':b.paidCents?'部分付款 · 待付 '+money(b.pendingCents):'待付款'} · 查看详情 ›</small></span></button>`).join('')}<button class="freight-add-another" data-create="${esc(shop.id)}">＋ 再添加一张</button></div></td></tr>`;
  }).join('')||'<tr><td colspan="6"><div class="empty">没有符合筛选条件的店铺或账单。</div></td></tr>';
 };
 render();
 $('#freight-owner').onchange=e=>{selectedOwner=e.target.value;render();};
 $('#freight-search').oninput=e=>{search=e.target.value.trim();render();};
 $('#freight-all').onchange=e=>{allPeriods=e.target.checked;render();};
 $('#freight-reset').onclick=()=>{selectedOwner='all';search='';allPeriods=false;$('#freight-owner').value='all';$('#freight-search').value='';$('#freight-all').checked=false;render();};
 $('#freight-shops').onclick=e=>{
  const create=e.target.closest('[data-create]'),expand=e.target.closest('[data-expand]'),bill=e.target.closest('[data-bill]');
  if(create){expanded.add(create.dataset.create);onNew(create.dataset.create);}
  if(expand){expanded.has(expand.dataset.expand)?expanded.delete(expand.dataset.expand):expanded.add(expand.dataset.expand);render();$('#freight-shops').querySelector(`[data-expand="${CSS.escape(expand.dataset.expand)}"]`)?.focus();}
  if(bill)onBill(bill.dataset.bill);
 };
 const changeMonth=value=>{if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)){allPeriods=false;onMonth(value);}};
 $('#freight-month').onchange=e=>changeMonth(e.target.value);
 const shiftMonth=delta=>{const d=new Date(month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+delta);changeMonth(d.toISOString().slice(0,7));};
 $('#freight-prev').onclick=()=>shiftMonth(-1);$('#freight-next').onclick=()=>shiftMonth(1);
 $('#freight-import').onclick=()=>onImport();
 $('#freight-cloud').onclick=()=>onDownload();
 const query=()=>({period:month,owner:selectedOwner,q:search,allPeriods:allPeriods?'1':'0'});
 $('#freight-export').onclick=()=>{onExport(query());$('.freight-export-menu').open=false;};
 $('#freight-template').onclick=()=>{onExport({...query(),template:'1',allPeriods:'0',q:''});$('.freight-export-menu').open=false;};
 const dismiss=e=>{if(!e.target.closest('.freight-export-menu'))$('.freight-export-menu').open=false;};
 document.addEventListener('click',dismiss);
 return {destroy:()=>document.removeEventListener('click',dismiss)};
}
