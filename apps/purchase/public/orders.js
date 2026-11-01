import {carrierOptions} from './address-parse.mjs';
import {allShipments,shipmentText} from './shipments.mjs';
import {includedInSpend} from './order-attributes.mjs';
import {createOrderImagePreview} from './order-image-preview.js';
import {orderConfirmation} from './month-locks.js';
import {categories,classificationLabel,contribution,unallocatedRefund} from './classification.mjs';
import {categoryOptions} from './classification-ui.js';
import {emptyOrderFilter,filterOrders,orderTracking,orderCarrier,orderUploadDate} from './order-query.mjs';
import {mountChineseMonthPickers} from './month-picker.js';

let grid=null,ctx=null,resize=null,prefs={},ready=false,imagePreview=null;
const expandedItems=new Set();
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const defaults={pageSize:100,sorters:[{field:'purchaseDate',dir:'desc'}],columns:{},showImages:false,sidebarCollapsed:true};
function readPrefs(){try{return {...defaults,...JSON.parse(localStorage.getItem('purchase-order-view')||'{}')};}catch{return {...defaults};}}
function savePrefs(){try{localStorage.setItem('purchase-order-view',JSON.stringify(prefs));}catch{}}
const plainTooltip=(e,cell)=>{const el=document.createElement('div');el.className='order-tooltip';el.textContent=String(cell.getValue()??'');return el;};
const editableOrder=o=>!orderConfirmation(o,ctx.state);
const rows=()=>filterOrders(ctx.state.orders,ctx.state.filter,ctx.state.basis).map(o=>({...o,purchaseDate:ctx.state.basis==='created'?o.date:o.paidAt||o.date,productText:o.items.map(i=>i.title).join('；'),itemCount:o.items.length,trackingText:orderTracking(o),carrierText:orderCarrier(o),classificationValue:o.classification?.mode==='split'?'split':o.classification?.category||'goods'}));
export function destroyOrders(){imagePreview?.dispose();imagePreview=null;if(resize)window.removeEventListener('resize',resize);resize=null;ready=false;if(grid){grid.destroy();grid=null;}}
function adjustHeight(){if(grid&&$('#order-grid'))grid.setHeight(Math.max(320,window.innerHeight-$('#order-grid').getBoundingClientRect().top-24));}
function exportLink(){if(!$('#export-link'))return;const sorters=grid&&ready?grid.getSorters().map(s=>({field:s.field,dir:s.dir})):prefs.sorters;const query=new URLSearchParams({...ctx.state.filter,basis:ctx.state.basis,sorters:JSON.stringify(sorters)});$('#export-link').href='/api/export?'+query;$('#classification-export-link').href='/api/classification-export?'+query;}
function summary(){const list=rows();$('#order-summary').innerHTML=`<b>${list.length}</b> 笔订单 <span>实付合计 <strong>${ctx.money(list.reduce((s,o)=>s+contribution(o,ctx.state.filter.category).amountCents,0))}</strong></span><span>已记录退款 ${ctx.money(list.reduce((s,o)=>s+contribution(o,ctx.state.filter.category).refundCents,0))}</span><span>计入支出 <strong>${ctx.money(list.filter(includedInSpend).reduce((s,o)=>s+contribution(o,ctx.state.filter.category).netCents,0))}</strong></span><small>${ctx.state.filter.category?'仅所选类别分配金额 · ':''}实付合计含全部状态及不计入订单</small>`;for(const b of $$('[data-order-preset]'))b.querySelector('span').textContent=filterOrders(ctx.state.orders,{preset:b.dataset.orderPreset},ctx.state.basis).length;exportLink();}
export async function refreshOrderRows({resetPage=false}={}){
 if(!grid||!ready)return;
 const selected=resetPage?[]:grid.getSelectedData().map(o=>o.id);grid.deselectRow();
 const currentPage=resetPage?1:grid.getPage();
 const data=rows();await grid.replaceData(data);grid.selectRow(selected.filter(id=>data.some(o=>o.id===id&&editableOrder(o))));
 if(prefs.pageSize===0)await grid.setPageSize(Math.max(ctx.state.orders.length,1));
 await grid.setPage(Math.min(currentPage,Math.max(grid.getPageMax(),1)));
 summary();selectionSummary();
}
function selectionSummary(){
 if(!grid||!ready||!$('#selected-orders-count'))return;
 const selected=grid.getSelectedData().filter(editableOrder),editable=rows().filter(editableOrder);$('#batch-category').hidden=$('#batch-classify').hidden=!editable.length;$('#selected-orders-count').textContent='已选 '+selected.length+' 笔';$('.order-batch-menu>summary').textContent=selected.length?'批量操作 · 已选 '+selected.length+' 笔':'批量操作';$('#batch-classify').disabled=!selected.length;$('#batch-attributes').hidden=!editable.length;$('#batch-attributes').disabled=!ctx.state.attributeEditingAvailable||!selected.length;$('#batch-attributes').title=ctx.state.attributeEditingAvailable?'':'请重启灵兔采购台后台并刷新页面后使用';$('#batch-supplier').hidden=$('#batch-account').hidden=!editable.length;$('#batch-supplier').disabled=$('#batch-account').disabled=!ctx.state.attributeEditingAvailable||!selected.length;$('#batch-supplier').title=$('#batch-account').title=ctx.state.attributeEditingAvailable?'':'请重启灵兔采购台后台并刷新页面后使用';
 $('#select-filtered-orders').textContent=(editable.length===rows().length?'选择全部筛选结果，共 ':'选择筛选结果中的可编辑订单，共 ')+editable.length+' 笔';
 const page=grid.getRows('display').filter(r=>editableOrder(r.getData())),count=page.filter(r=>r.isSelected()).length,box=$('.class-page-check');
 if(box){box.disabled=!page.length;box.checked=page.length>0&&count===page.length;box.indeterminate=count>0&&count<page.length;}
}
function pageCheckbox(){
 const box=document.createElement('input');box.type='checkbox';box.className='class-page-check';box.setAttribute('aria-label','选择当前页订单');box.title='仅选择当前页';
 box.addEventListener('click',e=>e.stopPropagation());box.addEventListener('change',()=>{const ids=grid.getRows('display').filter(r=>editableOrder(r.getData())).map(r=>r.getData().id);box.checked?grid.selectRow(ids):grid.deselectRow(ids);selectionSummary();});return box;
}
function classificationMenu(e,row){
 if(!editableOrder(row.getData()))return [{label:'已锁定：请先到月度确认取消确认',disabled:true}];
 const selected=row.isSelected(),orders=selected?grid.getSelectedData():[row.getData()],scope=document.createElement('span');scope.className='class-menu-scope';scope.textContent=selected?'作用范围：已选 '+orders.length+' 笔订单':'作用范围：仅此订单 '+row.getData().orderNo;
 return [{label:scope,disabled:true},{label:'修改属性（状态 / 计入支出）',disabled:!ctx.state.attributeEditingAvailable,action:()=>ctx.changeAttributes(orders)},{label:'批量修改供应商',disabled:!ctx.state.attributeEditingAvailable,action:()=>ctx.changeAttributes(orders,{},'supplier')},{label:'批量修改采购账号',disabled:!ctx.state.attributeEditingAvailable,action:()=>ctx.changeAttributes(orders,{},'account')},{label:'设为不计入采购支出',disabled:!ctx.state.attributeEditingAvailable,action:()=>ctx.changeAttributes(orders,{excludedFromSpend:true})},{label:'恢复正常计入',disabled:!ctx.state.attributeEditingAvailable,action:()=>ctx.changeAttributes(orders,{excludedFromSpend:false})},{separator:true},...Object.entries(categories).map(([key,label])=>({label:'设为'+label,action:()=>ctx.changeClassification(orders,key,{confirm:true})})),{separator:true},{label:orders.length===1?'拆分分类金额':'拆分分类金额（请只选一笔）',disabled:orders.length!==1,action:()=>ctx.splitClassification(orders[0].id)}];
}
export function mountOrders(context){
 destroyOrders();ctx=context;prefs=readPrefs();document.querySelector('.shell').classList.toggle('sidebar-compact',prefs.sidebarCollapsed);
 const {state,esc,icon,options}=ctx;
 imagePreview=createOrderImagePreview({api:ctx.api,esc,openDetail:ctx.detailModal});imagePreview.setEnabled(!!prefs.showImages);
 const select=(key,label,values)=>`<label>${label}<select data-order-filter="${key}" aria-label="${label}">${options(values,state.filter[key],'全部')}</select></label>`;
 const uniq=key=>[...new Set(state.orders.map(o=>o[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 $('#page-content').innerHTML=`<section class="panel orders-panel"><div class="order-presets">${[['all','全部订单'],['effective','有效采购'],['closed','已关闭'],['excluded','不计入'],['review','待核对'],['refunded','有退款'],['noted','有备注']].map(([key,label])=>`<button data-order-preset="${key}" class="${(state.filter.preset||'all')===key?'active':''}">${label}<span>${filterOrders(state.orders,{preset:key},state.basis).length}</span></button>`).join('')}<div class="order-display-actions"><button id="image-toggle" class="btn ghost" aria-pressed="${!!prefs.showImages}">${prefs.showImages?'隐藏图片':'显示图片'}</button><details class="column-picker"><summary>显示列</summary><div id="column-options"></div></details></div><button class="sidebar-toggle" id="toggle-sidebar">${icon('dashboard')}<span>收起导航</span></button></div>
 <div class="order-main-filters"><div class="search">${icon('search')}<input id="order-search" aria-label="搜索全部订单" placeholder="订单号 / 商品 / 收货人 / 手机 / 地址 / 运单 / 备注" value="${esc(state.filter.q)}"></div><select data-order-filter="platform" aria-label="订单平台">${options(ctx.platforms,state.filter.platform,'全部平台')}</select><select data-order-filter="status" aria-label="订单状态筛选">${options(ctx.statuses,state.filter.status,'全部状态')}</select><input type="text" data-month-picker data-order-filter="month" aria-label="订单月份" placeholder="选择年月" value="${esc(state.filter.month)}"><select id="order-basis" aria-label="日期口径"><option value="paid" ${state.basis==='paid'?'selected':''}>按付款日期</option><option value="created" ${state.basis==='created'?'selected':''}>按下单日期</option></select><select id="order-sort-mode" aria-label="订单排序方式"><option value="custom">按表头排序</option><option value="createdAt-desc">上传日期：最新在前</option><option value="createdAt-asc">上传日期：最早在前</option><option value="purchaseDate-desc">采购日期：最新在前</option><option value="purchaseDate-asc">采购日期：最早在前</option></select><button class="btn" id="toggle-filters" aria-expanded="false">更多筛选</button><button class="btn ghost" id="reset-orders">重置</button></div>
 <div id="order-advanced" hidden><div class="order-advanced-grid"><label>采购类别<select data-order-filter="category" aria-label="采购类别筛选">${categoryOptions(state.filter.category,'全部采购类别')}</select></label>${select('supplier','供应商',uniq('supplier'))}${select('account','采购账号',uniq('account'))}${select('carrier','物流公司',carrierOptions)}<label>支出统计<select data-order-filter="spend" aria-label="支出统计筛选">${[['','全部'],['excluded','手动不计入'],['normal','按状态正常计入'],['effective','实际计入支出']].map(([value,label])=>`<option value="${value}" ${state.filter.spend===value?'selected':''}>${label}</option>`).join('')}</select></label><label>备注<select data-order-filter="note" aria-label="备注筛选"><option value="">全部</option><option value="yes" ${state.filter.note==='yes'?'selected':''}>有备注</option><option value="no" ${state.filter.note==='no'?'selected':''}>无备注</option></select></label><label>运单信息<select data-order-filter="tracking" aria-label="运单信息筛选"><option value="">全部</option><option value="yes" ${state.filter.tracking==='yes'?'selected':''}>有运单号</option><option value="no" ${state.filter.tracking==='no'?'selected':''}>无运单号</option></select></label><label>开始日期<input type="date" data-order-filter="from" aria-label="开始日期" value="${esc(state.filter.from)}"></label><label>结束日期<input type="date" data-order-filter="to" aria-label="结束日期" value="${esc(state.filter.to)}"></label><label>最低实付（元）<input type="number" step="0.01" min="0" data-order-filter="minAmount" aria-label="最低实付金额" value="${esc(state.filter.minAmount)}" placeholder="不限"></label><label>最高实付（元）<input type="number" step="0.01" min="0" data-order-filter="maxAmount" aria-label="最高实付金额" value="${esc(state.filter.maxAmount)}" placeholder="不限"></label></div></div>
 <div class="order-grid-tools"><div id="order-summary" aria-live="polite"></div><details class="order-batch-menu"><summary>批量操作</summary><div class="order-selection-bar"><strong id="selected-orders-count">已选 0 笔</strong><button class="text-button" id="select-filtered-orders">选择全部筛选结果</button><button class="text-button" id="clear-order-selection">清空选择</button><button class="btn" id="batch-attributes" disabled>批量修改属性</button><button class="btn" id="batch-supplier" disabled>批量改供应商</button><button class="btn" id="batch-account" disabled>批量改账号</button><select id="batch-category" aria-label="批量目标类别">${categoryOptions('goods')}</select><button class="btn" id="batch-classify" disabled>批量修改类别</button></div></details></div><div id="order-page-size-holder" hidden><label class="page-size-label">每页<select id="order-page-size" aria-label="每页订单数">${[[50,'50 笔'],[100,'100 笔'],[200,'200 笔'],[0,'全部']].map(([n,label])=>`<option value="${n}" ${prefs.pageSize===n?'selected':''}>${label}</option>`).join('')}</select></label></div><div id="order-grid" aria-label="采购订单明细表"></div></section>`;
 const toolbar=document.createElement('div');toolbar.className='order-toolbar';
 const panel=$('.orders-panel'),presets=$('.order-presets'),filters=$('.order-main-filters'),display=$('.order-display-actions'),sidebar=$('#toggle-sidebar');
 panel.prepend(toolbar);toolbar.append(presets,filters,display,sidebar);
 mountChineseMonthPickers($('#page-content'));
 const textCol=(title,field,width,extra={})=>({title,field,width,minWidth:60,sorter:'string',formatter:'plaintext',tooltip:plainTooltip,...extra});
 const itemText=(i,key)=>key==='unitPriceCents'?(i.unitPriceCents==null?'未提供':(i.unitPriceCents/100).toFixed(2)):key==='productText'?i.title+(i.spec?' · '+i.spec:''):String(i[key]??'')||'—';
 const itemTooltip=(e,cell)=>{const el=document.createElement('div');el.className='order-tooltip';el.textContent=cell.getData().items.map((i,n)=>`${n+1}. ${itemText(i,'productText')}\n单价：${itemText(i,'unitPriceCents')} 元 · 数量：${i.qty} · 单位：${i.unit||'未提供'}${shipmentText(i,'trackingNo')?`\n运单号：${shipmentText(i,'trackingNo')} · ${shipmentText(i,'logisticsCompany')}`:''}`).join('\n\n');return el;};
 const lockNotice=o=>{const confirmation=orderConfirmation(o,state);return confirmation?`${confirmation.month} 已确认 · 只读。需要修改时，请先到月度确认取消确认。`:'';};
 const itemFormatter=key=>cell=>{
  const o=cell.getData(),open=expandedItems.has(o.id),items=open?o.items:o.items.slice(0,1);
  const footer=key==='productText'?(o.items.length>1?`<button class="item-expand" data-expand-items="${esc(o.id)}" aria-expanded="${open}">${open?'收起':'展开其余 '+(o.items.length-1)+' 项'} · 共 ${o.items.length} 项</button>`:'<span class="item-single">1 项商品</span>'):(o.items.length>1&&!open?'<span class="item-first">首项</span>':'<span class="item-single">&nbsp;</span>');
  return `<div class="order-item-lines" style="min-height:32px">${items.map((i,n)=>`<div class="order-item-line" title="${esc(itemText(i,key))}">${key==='productText'&&open?`<span class="item-number">${n+1}.</span> `:''}${esc(itemText(i,key))}</div>`).join('')}${footer}</div>`;
 };
 const columns=[
  {title:'选择',formatter:'rowSelection',cssClass:'order-selection-cell',titleFormatter:pageCheckbox,width:42,minWidth:42,hozAlign:'center',headerSort:false,frozen:true},
  {title:'#',formatter:'rownum',width:38,minWidth:38,hozAlign:'center',headerSort:false,frozen:true},
  {title:'供应商 / 订单号',field:'supplier',width:210,minWidth:140,frozen:true,sorter:'string',tooltip:(e,cell)=>{const el=document.createElement('div');el.className='order-tooltip';el.textContent=[cell.getData().supplier,cell.getData().orderNo,lockNotice(cell.getData())].filter(Boolean).join('\n');return el;},formatter:cell=>{const notice=lockNotice(cell.getData());return `<div class="grid-lines"><div class="grid-supplier-heading"><span class="grid-primary">${esc(cell.getValue())}</span>${notice?`<span class="grid-lock-icon" role="img" tabindex="0" aria-label="${esc(notice)}" title="${esc(notice)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></span>`:''}</div><div class="grid-secondary">${esc(cell.getData().orderNo)}</div></div>`;}},
  {title:'图片',field:'orderImages',width:134,minWidth:100,headerSort:false,visible:!!prefs.showImages,formatter:imagePreview.formatter,variableHeight:true,cssClass:'order-preview-cell'},
  {title:'采购类别',field:'classificationValue',width:150,minWidth:130,cssClass:'classification-cell',sorter:(a,b)=>(categories[a]||'混合').localeCompare(categories[b]||'混合','zh-CN'),editor:'list',editable:cell=>editableOrder(cell.getData()),editorParams:{values:categories},formatter:cell=>{const o=cell.getData(),code=o.classification?.mode==='split'?'split':o.classification?.category||'goods',p=contribution(o,state.filter.category);return `<div class="class-cell"><span class="class-badge ${code}">${classificationLabel(o)}</span>${state.filter.category?`<small class="class-caption">此类实付 ${ctx.money(p.amountCents)} · 行内为整单</small>`:''}${unallocatedRefund(o)?`<small>待分配退款 ${ctx.money(unallocatedRefund(o))}</small>`:''}</div>`;},cellEdited:cell=>{const target=cell.getValue(),row=cell.getRow(),o=row.getData();row.update({classificationValue:o.classification?.mode==='split'?'split':o.classification?.category||'goods'});ctx.changeClassification([o],target);}},
  {title:'实付金额',field:'amountCents',width:116,minWidth:110,sorter:'number',hozAlign:'right',formatter:c=>`<b class="grid-money">${ctx.money(c.getValue())}</b>`},
  {title:'支出统计',field:'excludedFromSpend',width:116,minWidth:110,sorter:(a,b)=>Number(a)-Number(b),tooltip:(e,c)=>c.getValue()?'手动设为不计入采购支出；订单和真实状态仍保留':includedInSpend(c.getData())?'按订单状态正常计入采购支出':'当前订单状态不计入采购支出',formatter:c=>`<span class="spend-badge ${c.getValue()?'excluded':''}">${c.getValue()?'不计入':includedInSpend(c.getData())?'计入':'未计入'}</span>`},
  textCol('采购账号','account',125),
  {title:'商品 / 规格',field:'productText',width:210,minWidth:150,sorter:'string',tooltip:itemTooltip,formatter:itemFormatter('productText'),variableHeight:true},
  {title:'单价(元)',field:'itemPrices',width:86,minWidth:80,headerSort:false,hozAlign:'right',tooltip:itemTooltip,formatter:itemFormatter('unitPriceCents'),variableHeight:true},
  {title:'数量',field:'itemQuantities',width:66,minWidth:60,headerSort:false,hozAlign:'right',tooltip:itemTooltip,formatter:itemFormatter('qty'),variableHeight:true},
  {title:'单位',field:'itemUnits',width:60,minWidth:55,headerSort:false,tooltip:itemTooltip,formatter:itemFormatter('unit'),variableHeight:true},
  {title:'平台',field:'platform',width:65,minWidth:60,sorter:'string',formatter:c=>ctx.tag(c.getValue())},
  textCol('采购日期','purchaseDate',98),
  textCol('数据来源','sourceLabel',240),textCol('录入人','uploadedBy',110),
  textCol('上传日期','createdAt',210,{headerTooltip:'首次录入系统的时间（北京时间），后续编辑不会改变',formatter:cell=>orderUploadDate(cell.getValue()),tooltip:(e,cell)=>orderUploadDate(cell.getValue())}),
  {title:'状态',field:'status',width:80,minWidth:70,sorter:'string',formatter:c=>ctx.statusTag(c.getValue())},
  textCol('收货人','recipient',80),textCol('联系手机','phone',127),textCol('收货地址','address',undefined,{minWidth:160,widthGrow:2}),textCol('物流公司','carrierText',95),textCol('运单号','trackingText',145,{cssClass:'tracking-cell'}),
  {title:'订单备注',field:'note',width:145,minWidth:105,sorter:'string',tooltip:plainTooltip,formatter:c=>!editableOrder(c.getData())?`<span class="grid-note-readonly">${esc(c.getValue()||'—')}</span>`: `<button class="grid-note ${c.getValue()?'has-note':''}" data-note="${esc(c.getData().id)}" title="编辑此订单备注">${c.getValue()?esc(c.getValue()):'＋ 添加备注'}</button>`},
  textCol('订单编号','orderNo',190,{visible:false}),textCol('下单日期','date',100,{visible:false}),textCol('付款日期','paidAt',100,{visible:false}),
  {title:'已记录退款',field:'refundCents',width:100,sorter:'number',visible:false,formatter:c=>ctx.money(c.getValue()),hozAlign:'right'},
  {title:'操作',field:'actions',width:132,minWidth:132,headerSort:false,frozen:true,formatter:c=>`<button class="grid-action" data-detail="${esc(c.getData().id)}">详情</button>${editableOrder(c.getData())?`<button class="grid-action" data-note="${esc(c.getData().id)}">备注</button><button class="grid-action" data-edit="${esc(c.getData().id)}">编辑</button>`:''}`}
 ];
 columns.forEach(c=>{if(c.field&&c.field!=='orderImages'&&Object.hasOwn(prefs.columns,c.field)&&!c.frozen)c.visible=prefs.columns[c.field];});
 grid=new Tabulator('#order-grid',{
  data:rows(),index:'id',selectableRows:'highlight',selectableRowsCheck:row=>editableOrder(row.getData()),rowContextMenu:classificationMenu,layout:'fitColumns',height:Math.max(320,window.innerHeight-310),sortOrderReverse:true,
  rowFormatter:row=>{const locked=!editableOrder(row.getData()),el=row.getElement();el.classList.toggle('month-readonly',locked);const box=el.querySelector('.order-selection-cell input');if(box){box.disabled=locked;box.title=locked?'已锁定，请先到月度确认取消确认':'选择订单';}},
  columnDefaults:{resizable:true,vertAlign:'middle',headerSortTristate:true,sorterParams:{locale:'zh-CN'}},placeholder:'没有找到符合条件的采购订单',
  pagination:true,paginationMode:'local',paginationSize:prefs.pageSize||Math.max(state.orders.length,1),paginationButtonCount:5,
  paginationCounter:(size,start,page,total)=>`共 ${total} 笔 · 当前显示 ${total?start:0}–${Math.min(start+size-1,total)} 笔`,
  initialSort:prefs.sorters.map(s=>({column:s.field,dir:s.dir})),locale:'zh-cn',langs:{'zh-cn':{pagination:{first:'首页',first_title:'首页',last:'末页',last_title:'末页',prev:'上一页',prev_title:'上一页',next:'下一页',next_title:'下一页',page_title:'第'}}},columns
 });
 grid.on('tableBuilt',()=>{ready=true;const holder=$('#order-page-size-holder');$('#order-grid .tabulator-footer-contents').prepend(holder.firstElementChild);holder.remove();adjustHeight();summary();selectionSummary();});
 grid.on('rowSelectionChanged',selectionSummary);grid.on('pageLoaded',selectionSummary);
 $('#select-filtered-orders').addEventListener('click',()=>grid.selectRow(rows().filter(editableOrder).map(o=>o.id)));
 $('#clear-order-selection').addEventListener('click',()=>grid.deselectRow());
 $('#batch-attributes').addEventListener('click',()=>ctx.changeAttributes(grid.getSelectedData()));
 $('#batch-supplier').addEventListener('click',()=>ctx.changeAttributes(grid.getSelectedData(),{},'supplier'));
 $('#batch-account').addEventListener('click',()=>ctx.changeAttributes(grid.getSelectedData(),{},'account'));
 $('#batch-classify').addEventListener('click',()=>ctx.changeClassification(grid.getSelectedData(),$('#batch-category').value,{confirm:true}));
 grid.on('rowDblClick',(e,row)=>{if(!e.target.closest('button,input,select,.classification-cell'))ctx.detailModal(row.getData().id);});
 $('#order-grid').addEventListener('click',e=>{const button=e.target.closest('[data-expand-items]');if(!button)return;const id=button.dataset.expandItems;expandedItems.has(id)?expandedItems.delete(id):expandedItems.add(id);const row=grid.getRow(id);row.reformat();row.normalizeHeight();});
 const syncSortMode=()=>{const sort=prefs.sorters[0],value=prefs.sorters.length===1&&sort?sort.field+'-'+sort.dir:'custom';$('#order-sort-mode').value=['createdAt-desc','createdAt-asc','purchaseDate-desc','purchaseDate-asc'].includes(value)?value:'custom';};
 syncSortMode();$('#order-sort-mode').onchange=e=>{if(e.target.value==='custom')return;const [field,dir]=e.target.value.split('-');grid.setSort(field,dir);};
 grid.on('dataSorted',sorters=>{prefs.sorters=sorters.map(s=>({field:s.field,dir:s.dir}));syncSortMode();savePrefs();if(ready){exportLink();selectionSummary();}});
 $('#column-options').innerHTML=columns.filter(c=>c.field&&c.field!=='orderImages'&&!c.frozen).map(c=>`<label><input type="checkbox" data-order-column="${c.field}" ${c.visible===false?'':'checked'}>${esc(c.title)}</label>`).join('');
 $('#column-options').addEventListener('change',e=>{const field=e.target.dataset.orderColumn;if(!field)return;grid.getColumn(field).toggle();prefs.columns[field]=e.target.checked;savePrefs();});
 $('#order-page-size').addEventListener('change',async e=>{prefs.pageSize=Number(e.target.value);savePrefs();await grid.setPageSize(prefs.pageSize||Math.max(state.orders.length,1));});

 $('#toggle-sidebar span').textContent=prefs.sidebarCollapsed?'展开导航':'收起导航';
 $('#toggle-sidebar').addEventListener('click',()=>{prefs.sidebarCollapsed=!prefs.sidebarCollapsed;savePrefs();document.querySelector('.shell').classList.toggle('sidebar-compact',prefs.sidebarCollapsed);$('#toggle-sidebar span').textContent=prefs.sidebarCollapsed?'展开导航':'收起导航';grid.redraw(true);adjustHeight();});
 $('#toggle-filters').addEventListener('click',()=>{const p=$('#order-advanced');p.hidden=!p.hidden;$('#toggle-filters').setAttribute('aria-expanded',String(!p.hidden));adjustHeight();});
 $('#image-toggle').addEventListener('click',()=>{prefs.showImages=!prefs.showImages;savePrefs();imagePreview.setEnabled(prefs.showImages);const column=grid.getColumn('orderImages');prefs.showImages?column.show():column.hide();$('#image-toggle').textContent=prefs.showImages?'隐藏图片':'显示图片';$('#image-toggle').setAttribute('aria-pressed',String(prefs.showImages));grid.getRows('visible').forEach(row=>row.normalizeHeight());grid.redraw(true);});
 $('#reset-orders').addEventListener('click',()=>{state.filter=emptyOrderFilter();mountOrders(ctx);});
 $('#order-basis').addEventListener('change',e=>{state.basis=e.target.value;refreshOrderRows({resetPage:true}).catch(e=>ctx.toast(e.message));});
 for(const el of $$('[data-order-filter]'))el.addEventListener('change',()=>{state.filter[el.dataset.orderFilter]=el.value;refreshOrderRows({resetPage:true}).catch(e=>ctx.toast(e.message));});
 let timer;$('#order-search').addEventListener('input',e=>{state.filter.q=e.target.value;grid.deselectRow();clearTimeout(timer);timer=setTimeout(()=>refreshOrderRows({resetPage:true}).catch(e=>ctx.toast(e.message)),150);});
 for(const el of $$('[data-order-preset]'))el.addEventListener('click',()=>{state.filter.preset=el.dataset.orderPreset;$$('[data-order-preset]').forEach(b=>b.classList.toggle('active',b===el));refreshOrderRows({resetPage:true}).catch(e=>ctx.toast(e.message));});
 resize=adjustHeight;window.addEventListener('resize',resize);
}
