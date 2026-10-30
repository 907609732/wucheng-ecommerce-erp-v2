import {loadingMarkup} from './loading-screen.mjs';
import {createTaskCards as createTaskCenter} from './task-cards.js';
import {newOrderNumber} from './order-number.mjs';
import {validateUploadLimits} from './upload-limits.mjs';
import {wireOrderFormView} from './order-form-view.js';
import {supplierPicker,wireSupplierPicker} from './supplier-picker.js';
import {appearancePanel,wireAppearance,fontScale} from './appearance.js';
import {createDirectories} from './directories.js';
import {contactForm,wireContactForms} from './contact-forms.js';
import {itemShipments,shipmentText} from './shipments.mjs';
import {orderChanges,auditText} from './audit-values.mjs';
import {createAuditUI} from './audit-log.js';
import {parseAddress,detectCarrier,carrierOptions,normalizeCarrier} from './address-parse.mjs';
import {includedInSpend,orderStatuses} from './order-attributes.mjs';
import {createAttributeActions} from './order-attributes-ui.js';
import {createOrderImageUI} from './order-images.js';
import {importReportHtml} from './import-results.js';
import {createMonthUI,orderConfirmation} from './month-locks.js';
import {categories,classificationDescription,classificationTotals,hasCategory} from './classification.mjs';
import {categoryOptions,classificationForm,classificationDraft,readClassification,wireClassification,classificationDetails,createClassificationActions} from './classification-ui.js';
import {supplementDetails} from './source-details.js';
import {importGuides} from './import-guides.mjs';
import {importRules} from './import-rules.mjs';
import {emptyOrderFilter,orderUploadDate} from './order-query.mjs';
import {mountOrders,destroyOrders,refreshOrderRows} from './orders.js';
import {clipboardImages} from './ocr-files.mjs';
import {refreshTailscaleIndicator} from './tailscale-indicator.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const paths={phone:'M7 2h10v20H7z M10 5h4 M11 19h2',bag:'M5 7h14v14H5z M9 7V5a3 3 0 0 1 6 0v2',dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',orders:'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',import:'M12 3v12 m-4-4 4 4 4-4 M4 16v5h16v-5',spark:'m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z',settings:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2 2 M16.4 16.4l2 2 M18.4 5.6l-2 2 M7.6 16.4l-2 2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',plus:'M12 5v14 M5 12h14',arrow:'M5 12h14 m-5-5 5 5-5 5',down:'M12 3v12 m-4-4 4 4 4-4 M5 18v3h14v-3',calendar:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16',chart:'M4 20V4 M4 20h16 M8 16v-4 M13 16V8 M18 16V5',wallet:'M3 6h18v14H3z M3 6V4h14 M16 11h5v5h-5z',supplier:'M4 21V7l8-4 8 4v14 M2 21h20 M9 21v-5h6v5 M8 9h1 M15 9h1 M8 12h1 M15 12h1',search:'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14 M15 15l6 6',close:'M6 6l12 12 M6 18 18 6',check:'m5 12 4 4L19 6',info:'M12 8v1 M12 11v6 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',file:'M6 2h8l4 4v16H6z M14 2v5h5 M9 11h6 M9 15h6',shield:'M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6z m-5 10 3 3 5-6',clock:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 6v6l4 2',edit:'m4 16 12-12 4 4L8 20H4z M13 7l4 4',chevron:'m9 5 7 7-7 7'};
const icon=n=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n]||paths.file}"/></svg>`;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const orderImageUI=createOrderImageUI({api,esc});
const money=c=>'¥'+(Number(c||0)/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const plainMoney=c=>c==null?'':(c/100).toFixed(2);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const platforms=Object.keys(importRules);const statuses=orderStatuses;
const colors=['#168374','#eca65c','#d4aa38','#d98190','#25a565','#8fac9e','#bdc7b6'];
const state={page:'dashboard',dashboardMonth:'',year:today().slice(0,4),basis:'paid',platform:'全部',category:'',orders:[],imports:[],token:'',chart:null,donut:null,filter:emptyOrderFilter(),pageNo:1};
const monthUI=createMonthUI({state,api,esc,money,modal,closeModal,toast,refresh,render,emptyOrderFilter,setKind:kind=>{modalKind=kind;}});
const taskCenter=createTaskCenter({state,api,esc,money,toast,modal,closeModal,refresh,render,today,historyHtml:importHistoryHtml,openImport:importModal,openOcr:ocrModal,openConfirmation:(month,platform)=>monthUI.open(month,platform),setKind:kind=>{modalKind=kind;},openOrders:async(month,platform)=>{state.basis='paid';state.filter={...emptyOrderFilter(),month,platform:platform||''};state.pageNo=1;state.page='orders';await render();}});
const classificationActions=createClassificationActions({modal,closeModal,api,esc,money,state,toast,refreshRows:async()=>{if(state.page==='orders')await refreshOrderRows();else await render();},setKind:kind=>{modalKind=kind;}});
const auditUI=createAuditUI({state,api,esc,modal,closeModal,toast,refresh,render,setKind:kind=>{modalKind=kind;},getKind:()=>modalKind});
const attributeActions=createAttributeActions({modal,closeModal,api,esc,money,state,toast,refreshRows:async()=>{if(state.page==='orders')await refreshOrderRows();else await render();},setKind:kind=>{modalKind=kind;}});
const directories=createDirectories({state,api,esc,money,toast,platforms,goOrders:async filter=>{state.filter={...emptyOrderFilter(),...filter};state.pageNo=1;state.page='orders';await render();}});
let attachmentEpoch=0,attachmentBusy=false,saveBusy=false;
let importRevision=0,importDirty=false,ocrRevision=0,ocrBusy=false;
let preview=null,formOrder=null,ocrJobId=null,ocrPoll=null,modalKind='',ocrFiles=[],noteDraft=null,formAttachments=[],formExistingAttachments=[];
function options(values,selected,all){return (all?`<option value="">${all}</option>`:'')+values.map(v=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(v)}</option>`).join('');}
const tag=p=>`<span class="tag ${p==='1688'?'p-1688':p==='淘宝'?'p-taobao':p==='拼多多'?'p-pdd':p==='闲鱼'?'p-xianyu':p==='微信'?'p-wechat':''}">${esc(p)}</span>`;
const statusTag=s=>`<span class="tag status-${esc(s)}">${esc(s)}</span>`;
async function api(url,body,method){
 const res=await fetch(url,body===undefined&&!method?{}:{method:method||'POST',headers:{...(state.token?{'X-Purchase-Token':state.token}:{}),'Idempotency-Key':crypto.randomUUID(),...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});
 const data=await res.json();if(!res.ok)throw Object.assign(Error(data.error||'操作失败'),{code:data.code,conflicts:data.conflicts,locks:data.locks,report:data.report,preview:data.preview});return data;
}
let modalReturnFocus=null;
let toastTimer;function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
async function refresh(){const [b,health]=await Promise.all([api('/api/bootstrap'),api('/api/health')]);Object.assign(state,{uploadLimitsAvailable:health.features?.includes('upload-limits-v2')===true,auditAvailable:health.features?.includes('order-audit-rollback')===true,attributeEditingAvailable:health.features?.includes('atomic-order-attributes')===true,extendedEditingAvailable:['item-shipments','contact-snapshots','atomic-attachments','address-book','supplier-view'].every(f=>health.features?.includes(f)),serverVersion:health.version,personnel:b.personnel,pendingEditsCount:Number(b.pendingEditsCount)||0,orders:b.orders,imports:b.imports,token:b.token,ocrReady:b.ocrReady,adminConfigured:b.adminConfigured,agentManaged:b.agentManaged,localDesktop:b.localDesktop,confirmationMode:b.confirmationMode,monthConfirmations:b.monthConfirmations||[]});}
function nav(){return [['dashboard','dashboard','采购支出看板'],['orders','orders','全部订单'],['imports','orders','任务中心']].map(([id,n,label])=>`<button data-nav="${id}" class="${state.page===id?'active':''}" title="${label}">${icon(n)}<span>${label}</span>${id==='orders'?`<span class="count">${state.orders.length}</span>`:''}</button>`).join('');}
function pendingEditsNav(){return state.pendingEditsCount>0?`<div class="nav-label" style="margin-top:32px">待处理</div><nav class="nav"><a href="/integration-edits.html" title="待确认修改">${icon('edit')}<span>待确认修改</span><span class="count">${state.pendingEditsCount}</span></a></nav>`:'';}
let pendingEditsRefresh=null;
function refreshPendingEdits(){
 if(pendingEditsRefresh||document.hidden)return;
 pendingEditsRefresh=api('/api/bootstrap').then(b=>{state.pendingEditsCount=Number(b.pendingEditsCount)||0;const slot=$('#pending-edits-nav');if(slot){slot.hidden=state.pendingEditsCount===0;slot.innerHTML=pendingEditsNav();}}).catch(()=>{}).finally(()=>{pendingEditsRefresh=null;});
}
window.addEventListener('focus',refreshPendingEdits);
window.addEventListener('pageshow',event=>{if(event.persisted)refreshPendingEdits();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshPendingEdits();});
const titles={suppliers:['供应商管理','维护供应商产品、多个地址与各平台店铺，关联采购记录。'],addresses:['地址库','统一管理收货和供应商地址，按标签查找。'],logs:['订单日志','查询每次修改，核对前后差异并撤销误操作。'],months:['月度确认','采购核对完成后，按月份和平台锁定数据。'],dashboard:['采购支出看板','每个月花了多少，向谁采购，一目了然。'],orders:['全部采购订单','把不同平台的采购，记在同一本账里。'],imports:['任务中心','按月逐项收集、补齐并核对采购数据，照着流程完成本月任务。'],about:['设置','常用管理、显示偏好、数据安全与使用帮助。']};
async function render(){
 syncRoute();
 destroyOrders();
 state.chart?.destroy();state.donut?.destroy();state.chart=null;state.donut=null;
 const [title,subtitle]=titles[state.page]||titles.dashboard;
 $('#app').innerHTML=`<div class="shell ${state.page==='orders'?'orders-mode':''}"><aside class="sidebar"><div class="brand"><div class="brand-mark">${icon('bag')}</div><div><strong>灵兔采购台</strong><small>LINGTU<br>PURCHASE DESK</small></div></div><div class="nav-label">采购工作空间</div><nav class="nav">${nav()}</nav><div id="pending-edits-nav" ${state.pendingEditsCount?'':'hidden'}>${pendingEditsNav()}</div><div class="sidebar-bottom"><div class="local-card"><p><i class="dot"></i>本地运行 · 数据已保存</p><small>采购数据仅保存在本机</small><small><a id="tailscale-indicator" href="/phone">正在检测手机连接…</a></small></div><div class="user"><div class="avatar">采</div><div><b>我的采购工作台</b><small>PERSONAL WORKSPACE</small></div></div><nav class="nav sidebar-settings"><button data-nav="about" title="设置" class="settings-nav ${['about','logs','suppliers','addresses','months'].includes(state.page)?'active':''}">${icon('settings')}<span>设置</span></button></nav></div></aside><main class="main"><header class="topbar"><div class="crumb">工作空间 ${icon('chevron')} <b>${title}</b></div><div class="top-date">${icon('calendar')}${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date())}<span>本机版 ${esc(state.serverVersion||'1.3.2')}</span></div></header><div class="content"><div class="page-heading"><div><h1>${title}</h1><p>${esc(subtitle)}</p></div></div><div id="page-content"></div><footer class="page-footer"><span>灵兔采购台 · 每一笔采购，都有记录。</span><span>本地存储 / 人民币 CNY</span></footer></div></main></div>`;
 void refreshTailscaleIndicator({managed:state.agentManaged});
 if(state.page==='dashboard')await dashboard();else if(state.page==='orders')ordersPage();else if(state.page==='imports')await importsPage();else if(state.page==='months')await monthUI.page();else if(state.page==='logs')await auditUI.page();else if(state.page==='suppliers')await directories.suppliers();else if(state.page==='addresses')await directories.addresses();else await aboutPage();
}
 const effective=includedInSpend;
const orderDate=o=>state.basis==='paid'?(o.paidAt||o.date):o.date;
function stat(label,value,bottom,n,featured=false){return `<div class="stat ${featured?'featured':''}"><div class="stat-label">${label}<span class="stat-icon">${icon(n)}</span></div><div class="stat-value">${value}</div><div class="stat-bottom">${bottom}</div></div>`;}
let dashboardRevision=0;
async function dashboard(){
 const revision=++dashboardRevision;
 const years=[...new Set([today().slice(0,4),...state.orders.map(o=>o.date.slice(0,4)),...state.orders.map(o=>(o.paidAt||o.date).slice(0,4))])].sort().reverse();
 const query=new URLSearchParams({year:state.year,basis:state.basis,platform:state.platform,category:state.category});
 const [s,annual]=await Promise.all([api(`/api/dashboard?${query}&month=${state.dashboardMonth}`),state.dashboardMonth?api(`/api/dashboard?${query}`):Promise.resolve(null)]);if(state.page!=='dashboard'||revision!==dashboardRevision)return;
 const chartMonths=(annual||s).months,period=state.dashboardMonth?`${state.year} 年 ${Number(state.dashboardMonth)} 月`:state.year;

 if(!s.categories)Object.assign(s,classificationTotals(state.orders.filter(o=>effective(o)&&orderDate(o).startsWith(state.dashboardMonth?`${state.year}-${state.dashboardMonth}`:state.year)&&(state.platform==='全部'||o.platform===state.platform)),state.category));
 const active=s.months.filter(m=>m.count),latest=active.at(-1);const recent=state.orders.filter(o=>orderDate(o).startsWith(state.dashboardMonth?`${state.year}-${state.dashboardMonth}`:state.year)&&(state.platform==='全部'||o.platform===state.platform)&&hasCategory(o,state.category)).sort((a,b)=>orderDate(b).localeCompare(orderDate(a))).slice(0,5);
 $('#page-content').innerHTML=`<div class="filterbar"><div class="actions"><select id="year-filter" aria-label="统计年份">${years.map(y=>`<option value="${y}" ${y===state.year?'selected':''}>${y} 年</option>`).join('')}</select><select id="global-platform" aria-label="平台筛选">${options(['全部',...platforms],state.platform)}</select><select id="global-category" aria-label="采购类别筛选">${categoryOptions(state.category,'全部采购类别')}</select><span class="label-muted">采购支出 · 含运费</span></div><div class="segmented"><button data-basis="paid" class="${state.basis==='paid'?'active':''}">按付款月份</button><button data-basis="created" class="${state.basis==='created'?'active':''}">按下单月份</button></div></div><nav class="dashboard-months" aria-label="快捷统计月份">${['',...Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0'))].map(month=>`<button type="button" data-dashboard-month="${month}" class="${state.dashboardMonth===month?'active':''}" aria-pressed="${state.dashboardMonth===month}">${month?`${Number(month)}月`:'全年'}</button>`).join('')}</nav><div class="stats">${stat(state.dashboardMonth?`${Number(state.dashboardMonth)}月采购净支出`:'年度采购净支出',money(s.netCents),`实付 ${money(s.amountCents)} · ${state.category?'已分配退款':'已记录退款'} ${money(s.refundCents)}`,'wallet',true)}${stat('有效采购订单',`${s.orderCount}<span class="unit">笔</span>`,`共 ${s.allOrderCount} 笔 · ${s.excludedCount} 笔未纳入统计`,'orders')}${stat('合作供应商',`${s.supplierCount}<span class="unit">家</span>`,`覆盖 ${s.platforms.filter(p=>p.count).length} 个采购渠道`,'supplier')}${stat('平均每单采购',money(s.orderCount?Math.round(s.netCents/s.orderCount):0),`${active.length} 个有采购记录的月份`,'chart')}</div><div class="classification-cards">${s.categories.filter(c=>!state.category||c.category===state.category).map(c=>`<article class="classification-card"><h3>${c.label}</h3><strong>${money(c.netCents)}</strong><p>实付 ${money(c.amountCents)}<br>已分配退款 ${money(c.refundCents)} · ${c.count} 笔</p></article>`).join('')}</div><div class="classification-reconcile"><b>待分配退款 ${money(s.unallocatedRefundCents)}</b><br>${state.category?'当前仅统计所选类别的分配金额，相关混合订单的待分配退款尚未归入该类别；订单详情仍显示整单金额。':`分类净支出合计 ${money(s.categories.reduce((n,c)=>n+c.netCents,0))} − 待分配退款 ${money(s.unallocatedRefundCents)} = 总采购净支出 ${money(s.netCents)}`}<br>实付包含运费，不重复加计。</div><div class="charts"><section class="panel"><div class="panel-head"><div><h2>月度采购支出</h2><p>${state.year} 年 1–12 月 · 点击月份查看订单</p></div><div class="legend"><i class="dot"></i>采购净支出</div></div><div class="panel-body"><div class="chart-wrap"><canvas id="monthly-chart" role="img" aria-label="月度采购金额柱状图"></canvas></div></div></section><section class="panel"><div class="panel-head"><div><h2>采购平台分布</h2><p>有效采购金额占比</p></div><span class="label-muted">${period}</span></div><div class="panel-body"><div class="donut-wrap"><canvas id="platform-chart" role="img" aria-label="采购平台金额分布"></canvas><div class="donut-center"><strong>${s.platforms.filter(p=>p.count).length}</strong><small>采购渠道</small></div></div><div class="platform-list">${s.platforms.map((p,i)=>`<div class="platform-row"><span class="swatch" style="background:${colors[i]}"></span><span class="platform-name">${p.name}</span><span class="platform-num">${money(p.amountCents)}</span><span class="platform-pct">${s.netCents?Math.round(p.amountCents/s.netCents*100):0}%</span></div>`).join('')}</div></div></section></div><div class="lower-grid"><section class="panel"><div class="panel-head" style="padding-bottom:19px"><div><h2>最近采购</h2><p>${latest?`最近有采购记录：${state.year} 年 ${latest.month} 月`:state.dashboardMonth?'本月暂无采购记录':'导入第一份订单，开始记录采购'}</p></div><button class="text-button" data-nav="orders">查看全部</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>供应商 / 商品</th><th>平台</th><th>采购日期</th><th>实付金额</th><th>状态</th></tr></thead><tbody>${recent.map(o=>`<tr class="clickable" data-detail="${o.id}"><td class="supplier-cell" title="${esc(o.supplier)}">${esc(o.supplier)}<div class="order-id">${esc(o.items[0]?.title.slice(0,22))}${o.items.length>1?` · 等 ${o.items.length} 项`:''}</div></td><td>${tag(o.platform)}</td><td class="muted">${orderDate(o)}</td><td class="amount">${money(o.amountCents)}</td><td>${statusTag(o.status)}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂时没有采购记录</td></tr>'}</tbody></table></div></section><section class="panel"><div class="panel-head"><div><h2>主要供应商</h2><p>按有效采购净金额排序</p></div><span class="label-muted small">TOP 5</span></div><div class="panel-body supplier-list">${s.suppliers.slice(0,5).map((v,i)=>`<div class="supplier-line"><span class="rank ${i<3?'top':''}">0${i+1}</span><div class="supplier-data"><div><span class="supplier-name" title="${esc(v.name)}">${esc(v.name)}</span><strong>${money(v.amountCents)}</strong></div><div class="track"><span style="width:${Math.max(2,v.amountCents/(s.suppliers[0]?.amountCents||1)*100)}%"></span></div></div></div>`).join('')||'<div class="empty">暂无供应商数据</div>'}</div></section></div><div class="footnote">${icon('info')}<span>统计口径：未设为“不计入”的已完成、待发货和待收货订单计入有效采购，净采购 = 实付 − 已记录退款。关闭、待付款、待核对及手动不计入的订单 ${s.excludedCount} 笔（${money(s.excludedCents)}）单列保留。${state.basis==='paid'?`缺少付款日期时按下单日期归月（有效订单 ${s.missingPaidCount} 笔）。`:''} 未提供退款金额的源表，不据订单状态推算退款。</span></div><details><summary>每月金额明细</summary><div class="table-wrap"><table class="data-table"><thead><tr><th>月份</th><th>有效订单</th><th>实付金额</th><th>已记录退款</th><th>采购净支出</th></tr></thead><tbody>${chartMonths.map(m=>`<tr class="clickable" data-month="${state.year}-${String(m.month).padStart(2,'0')}"><td>${m.month} 月</td><td>${m.count} 笔</td><td>${money(m.amountCents)}</td><td>${money(m.refundCents)}</td><td>${money(m.netCents)}</td></tr>`).join('')}</tbody></table></div></details>`;
 Chart.defaults.font.size=14*fontScale();Chart.defaults.font.family='"Segoe UI","Microsoft YaHei",sans-serif';Chart.defaults.color='#91a097';Chart.defaults.animation=false;
 state.chart=new Chart($('#monthly-chart'),{type:'bar',data:{labels:chartMonths.map(m=>`${m.month}月`),datasets:[{label:'采购净支出',data:chartMonths.map(m=>m.netCents/100),backgroundColor:chartMonths.map(m=>m.month===(state.dashboardMonth?Number(state.dashboardMonth):latest?.month)?'#168374':'#a9cec0'),hoverBackgroundColor:'#117b6e',borderRadius:4,maxBarThickness:28}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#183e33',padding:12,callbacks:{label:c=>` ${money(c.parsed.y*100)} · ${chartMonths[c.dataIndex].count} 笔`}}},scales:{x:{grid:{display:false},border:{display:false},ticks:{font:{size:12*fontScale()}}},y:{beginAtZero:true,border:{display:false},grid:{color:'#edf2ec',drawTicks:false},ticks:{font:{size:12*fontScale()},padding:12,callback:v=>'¥'+v.toLocaleString()}}},onClick:(e,elements)=>{if(elements.length)showMonth(`${state.year}-${String(elements[0].index+1).padStart(2,'0')}`);}}});
 const platformData=s.platforms.map(p=>p.amountCents/100);state.donut=new Chart($('#platform-chart'),{type:'doughnut',data:{labels:s.netCents?platforms:['暂无采购'],datasets:[{data:s.netCents?platformData:[1],backgroundColor:s.netCents?colors:['#eef2eb'],borderWidth:s.platforms.filter(p=>p.amountCents).length>1?3:0,hoverOffset:4}]},options:{responsive:true,maintainAspectRatio:false,cutout:'80%',plugins:{legend:{display:false},tooltip:{enabled:!!s.netCents,callbacks:{label:c=>`${c.label} ${money(c.parsed*100)}`}}}}});
}
function ordersPage(){mountOrders({api,state,esc,money,icon,options,platforms,statuses,tag,statusTag,detailModal,toast,changeClassification:classificationActions.change,splitClassification:classificationActions.split,changeAttributes:attributeActions.open});}
async function importsPage(){await taskCenter.page();}
function importHistoryHtml(){return `<section class="panel"><div class="panel-head" style="padding-bottom:20px"><div><h2>全部导入记录</h2><p>包含全部月份的导入批次；上传时间不代表采购月份</p></div><a class="btn" href="/api/template">${icon('down')}下载通用模板</a></div><div class="table-wrap"><table class="data-table"><thead><tr><th>原始文件</th><th>导入时间</th><th>源文件行数</th><th>处理结果</th><th>未导入订单</th><th>原始文件</th></tr></thead><tbody>${state.imports.map(i=>`<tr><td>${esc(i.filename)}</td><td class="muted">${new Date(i.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</td><td>${i.line_count}</td><td>${i.metadata?.method==='supplement-taobao'?`补充 ${i.metadata.summary.updated} 笔`:`入库 ${i.imported} 笔`}</td><td class="muted">${i.metadata?.importReport?`${i.metadata.importReport.notImported.length} 笔 <button class="text-button" data-action="import-report" data-import-id="${i.id}">查看清单</button>`:`${i.skipped} 笔`}</td><td><a href="/api/source/${i.id}">下载原文件</a></td></tr>`).join('')||'<tr><td colspan="6" class="empty">还没有导入记录</td></tr>'}</tbody></table></div></section><div class="footnote">${icon('info')}<span>同一平台 + 账号 + 订单号只保存一笔。重复文件不会重复入账；金额或状态变化会标为冲突，需打开现有订单核对。淘宝、闲鱼、拼多多支持常见字段及手动映射，首次使用新导出格式时请核对预览。</span></div>`;}

async function aboutPage(){
 $('#page-content').innerHTML=loadingMarkup({brand:'五成电子商务工作台',subtitle:'采购台',status:'正在读取设置…',logo:'./loading-logo.png'});
 let info;
 try{info=await api('/api/app-info');}catch(e){$('#page-content').innerHTML=`<div class="alert error">读取设置失败：${esc(e.message)}</div>`;return;}
 const u=info.upgrade||{},usage=info.usage||{};
 let exportSorters=[];try{exportSorters=JSON.parse(localStorage.getItem('purchase-order-view')||'{}').sorters||[];}catch{}
 const filteredExport=new URLSearchParams({...state.filter,basis:state.basis,sorters:JSON.stringify(exportSorters)});
 const monthlyExport=new URLSearchParams({year:state.year,basis:state.basis,platform:state.platform,category:state.category});
 const exportPanel=`<section class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>导出任务</h2>${icon('down')}</div><div class="panel-body"><p>当前筛选导出沿用「全部订单」中的筛选条件和排序；需调整范围时，先返回订单列表筛选。</p><div class="actions settings-export-actions"><a class="btn" href="/api/export">导出全部订单</a><a class="btn" href="/api/export?${filteredExport}">导出当前筛选订单</a><a class="btn" href="/api/classification-export">导出全部分类明细</a><a class="btn" href="/api/classification-export?${filteredExport}">导出当前筛选分类明细</a><a class="btn" href="/api/monthly-export?${monthlyExport}">导出 ${esc(state.year)} 年月度报表</a></div><p class="privacy-note">月度报表沿用看板的年份、平台、类别与日期口径；全部导出包含已关闭和不计入订单。</p></div></section>`;

 const website=info.website?`<a href="${esc(info.website)}" target="_blank" rel="noopener noreferrer">${esc(info.website)}</a>`:'官网链接预留中';
 const upgradeLine={idle:'尚未检查',checking:'正在检查更新…',unconfigured:'尚未配置更新源，暂时无法判断是否有新版',ok:u.hasUpdate?`发现新版本 <strong>v${esc(u.latest)}</strong>`:`已是最新版本 v${esc(info.version)}`,error:`检查失败：${esc(u.error)}`}[u.state]||u.state;
 $('#page-content').innerHTML=`${monthUI.passwordCard()}<section class="panel"><div class="panel-body actions"><a class="btn" href="#suppliers">供应商管理</a><a class="btn" href="#addresses">地址库</a><a class="btn" href="#months">月度确认</a>${state.agentManaged?'<a class="btn" href="/mobile.html">手机录入</a>':'<a class="btn" href="/phone">手机管理</a>'}</div></section><div class="settings-grid">${appearancePanel()}  <section class="panel"><div class="panel-head"><h2>检查更新</h2>${icon('down')}</div><div class="panel-body"><p>当前版本 <strong>v${esc(info.version)}</strong> · ${upgradeLine}</p>${u.hasUpdate?`<p>${esc(u.name||'')} ${u.url?`<a href="${esc(u.url)}" target="_blank" rel="noopener noreferrer">前往下载 </a>`:''}</p>`:''}<button class="btn primary" data-action="check-update" ${u.state==='checking'?'disabled':''}>${icon('search')}检查更新</button><p class="privacy-note">升级检查在每次启动时后台自动进行，不打断使用。新版安装包上传到 GitHub 仓库的 Releases 后，此处会提示可更新版本。</p></div></section>${exportPanel}
  <section class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>数据备份</h2>${icon('shield')}</div><div class="panel-body"><p>备份包含采购数据库、原始表格与采购单附件、已缓存图片、修改记录。建议每次大批量导入后保留一份。</p><div class="checklist"><span>${icon('check')} ${state.orders.length} 笔采购订单</span><span>${icon('check')} ${state.orders.reduce((s,o)=>s+o.items.length,0)} 条商品明细</span><span>${icon('check')} ${state.imports.length} 批原始文件</span></div><button class="btn primary" data-action="backup">${icon('down')}创建完整备份</button><p class="privacy-note">备份先保存到本机备份目录，并提供 ZIP 下载。恢复时先关闭系统，保留现有 data 文件夹副本，再将备份中的 purchases.sqlite、originals、attachments 和 images（如有）放入 data 文件夹。</p></div></section>
  <details class="panel settings-disclosure"><summary>执行日志 / 订单日志</summary><div class="panel-body"><p>统一查看每一笔订单的首次入账、修改与撤销记录，核对前后差异，并可撤销误操作。</p><div class="checklist"><span>${icon('check')} 按订单号、供应商、批次与日期查询</span><span>${icon('check')} 撤销只恢复选定字段，保留后续修改</span><span>${icon('check')} 日志随完整备份一并保存</span></div><button class="btn primary" data-action="open-logs">${icon('arrow')}打开订单日志</button>${state.auditAvailable?'':'<p class="privacy-note">日志与撤销需要新版后台支持，请重启灵兔采购台并刷新页面。</p>'}</div></details>
  <section class="panel"><div class="panel-head"><h2>识别与数据规则</h2>${icon('spark')}</div><div class="panel-body"><p>本地 OCR 模型：<strong>${state.ocrReady?'已就绪，可离线使用':'未就绪，请运行安装识别模型.cmd'}</strong></p><p>图片、PDF 和采购数据不上传到外部服务。</p><div class="checklist"><span>${icon('check')} 支持印刷体中文、英文与数字</span><span>${icon('check')} 识别完成后可逐项修改，再确认入账</span><span>${icon('check')} 原始附件保留，修改订单有历史记录</span></div><p>本地识别擅长清晰文字单据。复杂表格、多订单长截图和手写单请分单上传，并人工补齐商品明细。未知内容保持为空。</p></div></section>

  <section class="panel"><div class="panel-head"><h2>使用统计</h2>${icon('chart')}</div><div class="panel-body"><div class="checklist"><span>${icon('check')} 累计打开 <strong>${usage.totalOpens||0}</strong> 次</span><span>${icon('check')} 活跃 <strong>${usage.activeDays||0}</strong> 天</span><span>${icon('check')} 今日打开 <strong>${usage.todayOpens||0}</strong> 次</span></div>${usage.firstUsedAt?`<p class="privacy-note">首次使用：${new Date(usage.firstUsedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>`:''}<p class="privacy-note">统计仅记录打开次数与活跃天数，保存在本机；日活与使用次数可上报到 Cloudflare（预留端点，未配置则不发送）。</p></div></section>
  <section class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>统计口径</h2></div><div class="panel-body small muted" style="line-height:2">有效采购：未设为“不计入”的已完成、待发货、待收货订单。采购净支出 = 订单实付金额 − 已记录退款。运费是实付款的组成部分，不重复加计。待付款、已关闭、待核对及手动设为不计入的订单保留在订单列表中，默认不计入看板。付款月份缺失时使用下单月份。原表没有退款字段时，退款金额暂记为 0，仅表示尚无退款金额记录。</div></section>
  <section class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>软件介绍</h2>${icon('info')}</div><div class="panel-body"><p><strong>灵兔采购台</strong> 是一款本地采购管理工具，帮你把 1688、淘宝、闲鱼、拼多多、微信以及线下采购，统一记进同一本账。</p><p>把各平台导出的订单表格一键导入，自动匹配字段、去重并核对金额；也可以上传采购单截图，由本地 AI 识别后填写入账。看板按月汇总花了多少钱、向谁采购、各平台占比，支持商品采购、固定资产、日常支出的分类核算，以及按月份锁定已核对的数据防止误改。</p><div class="checklist"><span>${icon('check')} 多平台订单统一入账，自动去重、冲突保留</span><span>${icon('check')} 采购单图片 / PDF / 文字本地识别，无需联网</span><span>${icon('check')} 月度采购看板，供应商与平台占比一目了然</span><span>${icon('check')} 采购分类、月度确认、订单日志与撤销</span><span>${icon('check')} 数据全部保存在本机，不上传外部服务</span></div></div></section>
  <section class="panel"><div class="panel-head"><h2>使用教程</h2>${icon('spark')}</div><div class="panel-body"><p class="privacy-note">${state.agentManaged?'请从工作台的采购入口打开本页，切换业务台会保留当前页面；不要使用旧正式端口。':'双击「启动灵兔采购台.cmd」，浏览器打开本机采购页即可使用；关闭网页数据不丢。'}日常按下面四步走：</p><ol style="padding-left:22px;line-height:1.9;margin:12px 0"><li><strong>录入采购</strong>：进入「任务中心」→ 表格导入（1688 / 淘宝 / 闲鱼 / 拼多多 / 微信订单表），或「采购单识别」上传单据截图、PDF、粘贴文字；线下散单用「直接填写」。</li><li><strong>核对入账</strong>：导入时预览订单数、金额与去重结果，确认字段映射后入库；识别结果逐项核对日期、金额、商品后再保存。</li><li><strong>看板与分析</strong>：在「采购支出看板」按年份、平台、采购类别查看月度金额与占比，点柱状图月份可下钻到对应订单。</li><li><strong>管理订单</strong>：在「全部订单」筛选、排序、编辑备注与收货物流；点击表头排序，按住 Shift 可多列排序，双击订单查看详情。勾选后打开「批量操作」修改属性；右键可修改分类或拆分金额。误改可在「设置 → 执行日志 / 订单日志」展开后撤销。</li></ol><p class="privacy-note">每月核对完成后，到「月度确认」按平台锁定当月数据防止误改；${state.agentManaged?'定期在工作台设置中备份测试账本。':'定期在本页创建完整 ZIP 备份。'}所有数据、原始文件与图片都保存在本机。</p></div></section>
  <details class="panel settings-disclosure" style="grid-column:1/-1"><summary>各平台订单导入教程</summary><div class="panel-body">${Object.keys(importGuides).map(importGuide).join('')}</div></details><section class="panel"><div class="panel-head"><h2>关于</h2>${icon('bag')}</div><div class="panel-body"><p><strong>灵兔采购台</strong> · 把每一笔采购看清楚</p><div class="checklist"><span>${icon('check')} 署名：<strong>${esc(info.brand)}</strong></span><span>${icon('check')} 当前版本 <strong>v${esc(info.version)}</strong></span><span>${icon('check')} 官网：${website}</span></div></div></section>
 </div>`;
 wireAppearance();
 if(state.agentManaged){for(const action of ['backup','check-update']){const button=document.querySelector(`[data-action="${action}"]`);if(button){button.hidden=true;const panel=button.closest('section'),notes=panel?.querySelectorAll('.privacy-note');if(notes?.length)notes[notes.length-1].textContent=action==='backup'?'备份与恢复由工作台设置统一处理，此处不覆盖测试账本。':'组件更新由工作台统一处理，不从采购页替换程序。';}}}
 monthUI.wirePassword();
}
function modal(title,subtitle,body,foot,narrow=false){if(!document.querySelector('#overlay .modal'))modalReturnFocus=document.activeElement;attachmentEpoch++;attachmentBusy=false;saveBusy=false;orderImageUI.dispose();$('#overlay').innerHTML=`<div class="modal-backdrop ${modalKind==='ocr'?'ocr-backdrop':''}"><section class="modal ${narrow?'narrow':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-head"><div><h2 id="modal-title">${title}</h2><p>${subtitle}</p></div><button class="close" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="modal-body">${body}</div><footer class="modal-foot">${foot}</footer></section></div>`;document.body.style.overflow='hidden';if(formOrder)wireClassification(formOrder);setTimeout(()=>$('.modal input:not([type=file]),.modal button')?.focus(),30);}
function closeModal(){if(saveBusy)return;attachmentEpoch++;attachmentBusy=false;orderImageUI.dispose();importRevision++;ocrRevision++;ocrBusy=false;if(ocrPoll)clearTimeout(ocrPoll);ocrPoll=null;$('#overlay').innerHTML='';document.body.style.overflow='';const previousFocus=modalReturnFocus;modalReturnFocus=null;if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});modalKind='';ocrFiles.forEach(f=>f.url&&URL.revokeObjectURL(f.url));ocrFiles=[];ocrJobId=null;const pending=formAttachments;formAttachments=[];formExistingAttachments=[];for(const a of pending)api('/api/attachments/'+a.id,undefined,'DELETE').catch(()=>{});}
function importModal(platform=''){modalKind='import';preview=null;importRevision++;modal('导入采购订单','① 选择平台 → ② 上传对应表格 → ③ 核对并入库',`<label class="field">第一步：选择采购平台<select id="import-platform">${options(platforms,platform,'请选择订单来自哪个平台')}</select></label><p class="privacy-note">选择平台后显示上传入口，并使用该平台的导入规则。</p><div id="import-upload"></div><div id="import-status" class="privacy-note" role="status"></div><div id="preview-body"></div>`,`<span class="small muted" id="import-footnote">请先选择采购平台</span><div class="actions"><button class="btn" data-action="close">取消</button><button class="btn primary" id="commit-import" data-action="commit-import" disabled>确认入库</button></div>`);if(platforms.includes(platform))selectImportPlatform();}

function importGuide(platform){const g=importGuides[platform];if(!g)return '';return `<section class="import-guide" aria-label="${esc(platform)}导入教程"><div class="import-guide-head"><h3>如何准备${esc(platform)}订单表</h3>${g.link?`<a class="btn" href="${esc(g.link)}" target="_blank" rel="noopener noreferrer">${esc(g.label)} </a>`:''}</div><ol>${g.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol><p class="privacy-note">${esc(g.note)}</p></section>`;}
function selectImportPlatform(){
 importRevision++;preview=null;$('#preview-body').innerHTML='';$('#import-status').textContent='';$('#commit-import').disabled=true;
 const platform=$('#import-platform').value,rule=importRules[platform];
 $('#import-footnote').textContent=rule?'预览不会写入采购账本':'请先选择采购平台';
 $('#import-upload').innerHTML=rule?`<section class="panel" style="padding:18px;margin-top:18px"><h3>上传${esc(rule.title)}</h3><p class="privacy-note">${esc(rule.description)}</p><div class="form-grid"><label class="field">缺少账号时使用<input id="import-account" value="${esc(rule.account)}" placeholder="表内账号优先，此处仅作补充"></label><label class="field">通用模板（自行整理时使用）<a class="btn" href="/api/template">${icon('down')}下载 CSV 模板</a></label></div><label class="dropzone" id="import-drop" style="margin-top:18px"><input type="file" id="import-file" accept=".xlsx,.csv" hidden><div>${icon('import')}<strong>选择${esc(platform)}表格，或拖到这里</strong><p>支持 .xlsx / .csv，单文件不超过 25 MB</p></div></label></section>`:'';
 if(rule)wireDrop('#import-drop',file=>loadImport(file));
}
async function remapImport(body){const revision=++importRevision,id=preview.id;importDirty=true;$('#commit-import').disabled=true;try{const next=await api('/api/import/'+id+'/remap',body);if(revision!==importRevision||modalKind!=='import')return;preview=next;renderPreview();}catch(e){if(revision===importRevision){preview=null;$('#preview-body').innerHTML='';$('#import-status').textContent='预览失败：'+e.message;}throw e;}}

function wireDrop(selector,fn){const el=$(selector);el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('drag');});el.addEventListener('dragleave',()=>el.classList.remove('drag'));el.addEventListener('drop',e=>{e.preventDefault();el.classList.remove('drag');if(e.dataTransfer.files.length)fn(e.dataTransfer.files[0]);});}
// 多文件拖放（采购单附件区）。
function wireDropMulti(selector,fn){const el=$(selector);if(!el)return;el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('drag');});el.addEventListener('dragleave',()=>el.classList.remove('drag'));el.addEventListener('drop',e=>{e.preventDefault();el.classList.remove('drag');if(e.dataTransfer.files.length)fn(e.dataTransfer.files);});}
const attachmentSize=bytes=>bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':bytes>=1024?Math.round(bytes/1024)+' KB':bytes+' B';
function attachmentCard(a){const saved=!!a.createdAt||formExistingAttachments.some(x=>x.id===a.id);return `<div class="attachment-card">${a.thumbUrl?`<a href="${esc((a.downloadUrl||'/api/attachments/'+a.id)+'?preview=1')}" target="_blank" rel="noopener noreferrer"><img src="${esc(a.thumbUrl)}" alt="${esc(a.filename)}"></a>`:icon('file')}<div class="attachment-meta"><span class="attachment-name" title="${esc(a.filename)}">${esc(a.filename)}</span><span class="muted small">${attachmentSize(a.bytes)}${a.createdAt?' · '+new Date(a.createdAt).toLocaleDateString('zh-CN'):''}${saved?' · 已保存':''}</span><div class="attachment-links"><a class="text-button" href="${esc(a.downloadUrl||'/api/attachments/'+a.id)}" download="${esc(a.filename)}">下载</a>${formAttachments.some(x=>x.id===a.id)?`<button class="text-button" data-attachment-remove="${esc(a.id)}">移除</button>`:''}</div></div></div>`;}
function showUploadLimit(message){
 const previous=document.querySelector('.upload-limit-dialog');if(previous){previous.querySelector('p').textContent=message;return;}
 const dialog=document.createElement('dialog');dialog.className='upload-limit-dialog';dialog.setAttribute('aria-labelledby','upload-limit-title');dialog.setAttribute('role','alertdialog');
 dialog.innerHTML=`<h3 id="upload-limit-title">附件超出限制</h3><p>${esc(message)}</p><button type="button" class="btn primary">知道了</button>`;
 dialog.querySelector('button').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());$('#overlay').append(dialog);dialog.showModal();
}
const isUploadLimit=e=>e.code==='UPLOAD_LIMIT'||String(e.code||'').startsWith('LIMIT_');
function updateSaveState(){const button=$('[data-action="save-order"]');if(button)button.disabled=attachmentBusy||saveBusy||!state.extendedEditingAvailable||(modalKind==='ocr'&&ocrBusy);}
function wireAttachmentZone(){
 wireDropMulti('#order-attachment-drop',files=>uploadAttachments(files));renderAttachments();
 const root=$('#order-form');if(root){wireOrderFormView(root,esc);wireContactForms(root,{api,esc,toast});void wireSupplierPicker(root,{orders:state.orders,api,esc});}
 if(!state.extendedEditingAvailable){const box=$('#form-error');if(box){box.hidden=false;box.textContent='后台尚未更新，请重启灵兔采购台并刷新页面后保存。';}}
 updateSaveState();
}
async function uploadAttachments(files){
 if(!state.extendedEditingAvailable)return toast('请重启灵兔采购台并刷新页面后使用附件功能');
 if(attachmentBusy||saveBusy)return toast('正在处理附件，请稍候');
 if(!state.uploadLimitsAvailable)return toast('请重启灵兔采购台后台并刷新页面，以启用新的上传限制');
 try{validateUploadLimits([...formExistingAttachments,...formAttachments,...files]);}catch(e){showUploadLimit(e.message);return;}
 const epoch=attachmentEpoch,form=new FormData();for(const f of files)form.append('files',f);
 attachmentBusy=true;updateSaveState();renderAttachments();
 try{
  const saved=await api('/api/attachments',form);
  if(epoch!==attachmentEpoch){await Promise.allSettled(saved.map(a=>api('/api/attachments/'+a.id,{},'DELETE')));return;}
  formAttachments=[...formAttachments,...saved];toast(`已添加 ${saved.length} 个附件，保存订单后绑定`);return saved;
 }catch(e){if(epoch===attachmentEpoch){if(isUploadLimit(e))showUploadLimit(e.message);else toast('附件上传失败：'+e.message);}}
 finally{if(epoch===attachmentEpoch){attachmentBusy=false;updateSaveState();renderAttachments();}}
}
function renderAttachments(){
 const box=$('#order-attachments');if(!box)return;
 const list=[...formExistingAttachments,...formAttachments];
 box.innerHTML=(list.map(attachmentCard).join('')||'<span class="muted small">尚未添加附件</span>')+(attachmentBusy?'<span role="status">正在上传附件，请稍候…</span>':'');
}
async function loadImport(file){
 const platform=$('#import-platform')?.value;if(!importRules[platform])return;
 const revision=++importRevision;preview=null;$('#preview-body').innerHTML='';$('#import-footnote').textContent='预览不会写入采购账本';$('#import-status').textContent='正在按'+platform+'规则解析表格，请稍候…';$('#commit-import').disabled=true;
 const form=new FormData();form.append('file',file);form.append('platform',platform);form.append('account',$('#import-account').value||importRules[platform].account);
 try{const next=await api('/api/import/preview',form);if(revision!==importRevision||modalKind!=='import')return;preview=next;renderPreview();$('#import-status').textContent=platform+' · '+file.name;}catch(e){if(revision===importRevision&&modalKind==='import')$('#import-status').textContent='解析失败：'+e.message;}
}
function renderPreview(){importDirty=false;const p=preview;const valid=p.orders.filter(o=>!o.errors.length&&!o.existing&&!o.locked);$('#preview-body').innerHTML=`<div class="preview-summary"><span><b>${p.lineCount}</b>条原始明细</span><span><b>${p.summary.orders}</b>笔订单</span><span><b>${p.summary.valid}</b>笔可导入</span><span><b>${p.summary.duplicates}</b>笔重复</span><span><b>${p.summary.locked||0}</b>笔因月份锁定不导入</span><span><b>${p.summary.conflicts+p.summary.invalid+p.issues.length}</b>项待处理</span></div><div id="commit-import-error"></div>${p.summary.locked?`<div class="alert">${p.summary.locked} 笔订单属于已确认的平台月份，已排除勾选，不会导入。订单号、月份和原因见下表。其他可导入订单仍需点击「确认入库」。</div>`:''}${accountPreview(p)}${p.summary.conflicts||p.summary.invalid||p.issues.length?`<div class="alert">冲突和异常不会入库。${p.issues.slice(0,5).map(i=>`第 ${i.row} 行：${esc(i.message)}`).join('；')}${p.issues.length>5?'；更多问题请核对源文件':''}</div>`:''}<details><summary>字段对应与工作表（新平台格式可在这里调整）</summary><div class="form-grid"><label class="field">工作表<select id="mapping-sheet">${options(p.sheets,p.sheet)}</select></label><label class="field">金额含义<select id="amount-mode"><option value="order" ${p.options.amountMode==='order'?'selected':''}>整单实付金额（同订单只计一次）</option><option value="line" ${p.options.amountMode==='line'?'selected':''}>逐行金额（同订单逐行相加）</option></select></label></div><div class="form-grid">${Object.entries(p.fields).filter(([key])=>key!=='platform').map(([key,f])=>`<label class="field">${f.label}<select data-mapping="${key}"><option value="">不导入此字段</option>${p.headers.map((h,i)=>`<option value="${i}" ${String(p.mapping[key])===String(i)?'selected':''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}</div><button class="btn" data-action="remap">重新预览</button></details><div class="preview-table" style="margin-top:16px"><table class="data-table"><thead><tr><th><input type="checkbox" id="select-all-preview" aria-label="全选可导入订单" ${valid.length?'checked':'disabled'}></th><th>订单编号 / 日期</th><th>采购账号</th><th>供应商</th><th>实付金额</th><th>商品</th><th>核对结果</th></tr></thead><tbody>${p.orders.map(o=>`<tr><td><input type="checkbox" data-import-index="${o.index}" aria-label="选择订单 ${esc(o.orderNo)}" ${!o.errors.length&&!o.existing&&!o.locked?'checked':'disabled'}></td><td>${esc(o.orderNo)}<div class="order-id">归属 ${esc((o.paidAt||o.date).slice(0,7))} · ${o.paidAt?'付款月':'下单月'}</div></td><td>${esc(o.account)}</td><td class="supplier-cell" title="${esc(o.supplier)}">${esc(o.supplier||'缺少供应商')}</td><td class="amount">${o.amountCents==null?'缺失':money(o.amountCents)}</td><td>${o.items.length} 项</td><td style="max-width:310px;white-space:normal;line-height:1.8">${o.errors.length?`<span style="color:#b95b58">${esc(o.errors.join('；'))}</span>`:o.existing==='duplicate'?'<span class="muted">已存在，跳过</span>':o.existing==='conflict'?`<a href="#" data-detail="${o.existingId}">内容有变化，查看现有订单</a>`:o.locked?`<span style="color:#b95b58">${esc(o.notImportedReason)}</span>`:o.warnings.length?`<span style="color:#a58246">${esc(o.warnings.join('；'))}</span>`:'<span style="color:#31866a">可导入</span>'}</td></tr>`).join('')}</tbody></table></div>`;$('#commit-import').disabled=!valid.length;updateImportTotal();}
function showImportReport(report){modalKind='import-report';modal('导入结果',esc(report.filename),importReportHtml(report,esc),'<span class="small muted">此清单已保存在任务中心的导入记录中，可随时回查</span><button class="btn primary" data-action="close">完成</button>');}
function updateImportTotal(){if(!preview)return;const selected=$$('[data-import-index]:checked').map(el=>preview.orders[Number(el.dataset.importIndex)]);$('#import-footnote').textContent=`已选 ${selected.length} 笔，实付合计 ${money(selected.reduce((s,o)=>s+(o.amountCents||0),0))}`;$('#commit-import').disabled=importDirty||!selected.length;}

function deliveryForm(o){return `<details class="delivery-form" ${modalKind==='edit'?'open':''}><summary>收货与供应商地址</summary>${contactForm('recipient',{name:o.recipient,phone:o.phone,address:o.address},esc)}${contactForm('supplier',o.supplierContact,esc)}</details>`;}
function deliveryDetails(o){return `<section class="delivery-details"><h3>收货与物流</h3><div class="details-grid">${[['recipient','收货人姓名'],['phone','联系手机'],['logisticsCompany','物流公司'],['trackingNo','运单号']].map(([k,label])=>`<div><label>${label}</label>${esc(o[k]||'未提供')}</div>`).join('')}<div class="full-address"><label>收货地址</label>${esc(o.address||'未提供')}</div>${o.supplierContact?`<div class="full-address"><label>供应商联系地址</label>${esc([o.supplierContact.name,o.supplierContact.phone,o.supplierContact.address].filter(Boolean).join(' · '))}</div>`:''}</div></section>`;}
function historyChanges(before,after){return orderChanges(before,after).map(c=>`${esc(c.label)}：${esc(auditText(c.key,c.before))} → ${esc(auditText(c.key,c.after))}`).join('<br>')||'订单信息已更新';}
function noteModal(id){const order=state.orders.find(o=>o.id===id);if(!order)return;if(orderConfirmation(order,state)){toast('此订单已锁定，请先到月度确认取消确认');return;}modalKind='note';noteDraft=structuredClone(order);modal('订单备注','保存后立即显示在订单表中，并保留修改记录',`<div class="note-order-info">${esc(order.supplier)} · ${tag(order.platform)}<br><small>订单号：${esc(order.orderNo)}</small></div><div class="note-editor"><label class="field">备注内容<textarea id="quick-note" maxlength="10000" placeholder="例如：已联系补发、等待发票、下次采购注意事项">${esc(order.note)}</textarea></label><p class="privacy-note">只保存本机备注，不会向卖家发送消息。</p><div id="note-error" class="alert error" hidden></div></div>`,`<span class="small muted">支持多行文字，最多 10,000 字</span><div class="actions"><button class="btn" data-action="close">取消</button><button class="btn primary" data-action="save-note">保存备注</button></div>`,true);}

function blankOrder(){return {platform:'微信',account:'默认账号',orderNo:newOrderNumber('微信',today()),date:today(),paidAt:today(),supplier:'',amountCents:null,refundCents:0,shippingCents:0,status:'已完成',items:[{title:'',spec:'',sku:'',qty:1,unit:'个',unitPriceCents:0}],note:''};}
function formHtml(o){return `<div id="order-form"><datalist id="carrier-options">${carrierOptions.map(c=>`<option value="${esc(c)}">`).join('')}</datalist><div class="form-grid"><label class="field">采购平台<select name="platform">${options(platforms,o.platform)}</select></label>${supplierPicker(o,esc)}<label class="field">订单编号 <span class="required">*</span><input name="orderNo" value="${esc(o.orderNo)}" placeholder="原订单号或自定编号" required></label><label class="field">采购账号<input name="account" value="${esc(o.account||'默认账号')}"></label><label class="field">下单日期 <span class="required">*</span><input name="date" type="date" value="${esc(o.date)}" required></label><label class="field">付款日期<input name="paidAt" type="date" value="${esc(o.paidAt)}"></label><label class="field">订单状态<select name="status">${options(statuses,o.status)}</select></label><label class="field">采购支出统计<select name="excludedFromSpend" aria-label="采购支出统计" ${state.attributeEditingAvailable?'':'disabled title="请重启灵兔采购台后台并刷新页面后使用"'}><option value="false" ${!o.excludedFromSpend?'selected':''}>正常计入（按订单状态）</option><option value="true" ${o.excludedFromSpend?'selected':''}>不计入采购支出</option></select></label><label class="field">实付金额（含运费） <span class="required">*</span><input name="amountCents" type="number" step="0.01" min="0" value="${plainMoney(o.amountCents)}" placeholder="0.00" required></label><label class="field">已记录退款<input name="refundCents" type="number" step="0.01" min="0" value="${plainMoney(o.refundCents)}"></label><label class="field">其中运费<input name="shippingCents" type="number" step="0.01" min="0" value="${plainMoney(o.shippingCents)}"></label></div>${classificationForm(o)}${deliveryForm(o)}<div class="form-section"><h3>商品明细</h3><button class="text-button" data-action="add-item">＋ 添加商品</button></div><div class="item-table-scroll"><div class="item-grid item-labels"><span>商品名称 *</span><span>规格</span><span>数量</span><span>单位</span><span>单价(元)</span><span>运单号 / 物流公司</span><span></span></div><div id="item-rows">${o.items.map((i,index)=>itemHtml(i,index)).join('')}</div></div><label class="field wide" style="margin-top:16px">备注<textarea name="note" rows="2">${esc(o.note)}</textarea></label>${modalKind==='ocr'?'':`<div class="form-section"><h3>采购单附件</h3><span class="small muted">图片 / PDF / 文档</span></div><label class="dropzone attachment-drop" id="order-attachment-drop"><input type="file" id="order-attachment-input" multiple hidden aria-label="选择采购单附件"><div>${icon('file')}<strong>选择附件，或拖到这里</strong><p>图片自动生成缩略图；已保存到订单的附件不可删除</p></div></label><div id="order-attachments" class="attachment-list" aria-live="polite"></div>`}<div id="form-error" class="alert error" hidden></div></div>`;}
function shipmentHtml(shipment={}){return `<div class="shipment-row"><input aria-label="商品运单号" data-shipment-key="trackingNo" value="${esc(shipment.trackingNo)}" placeholder="运单号"><select aria-label="商品物流公司" data-shipment-key="logisticsCompany"><option value="">请选择物流公司</option>${carrierOptions.map(c=>`<option value="${esc(c)}" ${normalizeCarrier(shipment.logisticsCompany)===c?'selected':''}>${esc(c)}</option>`).join('')}</select><button type="button" class="text-button" data-action="remove-shipment" aria-label="移除运单" title="移除此运单">×</button></div>`;}
function itemHtml(i,index){return `<div class="item-grid" data-item="${index}"><input aria-label="商品名称 ${index+1}" data-key="title" value="${esc(i.title)}" placeholder="商品名称"><input aria-label="商品规格 ${index+1}" data-key="spec" value="${esc(i.spec)}" placeholder="规格"><input aria-label="商品数量 ${index+1}" data-key="qty" type="number" min="0.001" step="any" value="${esc(i.qty)}"><input aria-label="商品单位 ${index+1}" data-key="unit" value="${esc(i.unit)}" maxlength="100" placeholder="如：个"><input aria-label="商品单价 ${index+1}" data-key="unitPriceCents" type="number" min="0" step="0.01" value="${plainMoney(i.unitPriceCents)}"><button class="close" data-remove-item="${index}" aria-label="移除商品 ${index+1}" title="移除商品">${icon('close')}</button><input data-key="sku" type="hidden" value="${esc(i.sku)}"><div class="item-shipments"><div class="shipment-rows">${(itemShipments(i).length?itemShipments(i):[{}]).map(shipmentHtml).join('')}</div><button type="button" class="text-button" data-action="add-shipment" title="添加运单；同一商品可有多个运单，不同商品可共用同一运单">＋ 运单</button></div></div>`;}
function collectForm(){const o={...formOrder};for(const key of ['platform','orderNo','account','date','paidAt','status','supplier','note','recipient','phone','address','logisticsCompany','trackingNo'])o[key]=$(`[name="${key}"]`)?.value??o[key]??'';const cents=v=>{if(!/^\d+(\.\d{1,2})?$/.test(v))throw Error('金额须为非负数字，最多两位小数');const [a,b='']=v.split('.');return Number(a)*100+Number(b.padEnd(2,'0'));};for(const key of ['amountCents','refundCents','shippingCents'])o[key]=cents($(`[name="${key}"]`).value||(key==='amountCents'?'':'0'));o.items=$$('[data-item]').map(row=>{const i={};row.querySelectorAll('[data-key]').forEach(el=>i[el.dataset.key]=el.value);i.shipments=[...row.querySelectorAll('.shipment-row')].map(s=>Object.fromEntries([...s.querySelectorAll('[data-shipment-key]')].map(el=>[el.dataset.shipmentKey,el.value]))).filter(s=>s.trackingNo.trim()||s.logisticsCompany.trim());i.qty=Number(i.qty);i.unitPriceCents=i.unitPriceCents===''?null:cents(i.unitPriceCents);return i;});o.excludedFromSpend=$('[name="excludedFromSpend"]').value==='true';o.supplierContact=Object.fromEntries(['name','phone','address'].map(k=>[k,$('[name="supplierContact-'+k+'"]').value]));o.classification=readClassification(o);return o;}
async function editOrderModal(id){const order=state.orders.find(o=>o.id===id);if(!order)return;if(orderConfirmation(order,state)){toast('此订单已锁定，请先到月度确认取消确认');return;}modalKind='edit';ocrJobId=null;formOrder=structuredClone(state.orders.find(o=>o.id===id));formAttachments=[];formExistingAttachments=state.extendedEditingAvailable?await api('/api/orders/'+id+'/attachments'):[];modal('编辑采购订单','保存后更新看板，同时保留修改记录',formHtml(formOrder),`<span class="small muted">金额以元填写 · 运费已包含在实付中</span><div class="actions"><button class="btn" data-action="close">取消</button><button class="btn primary" data-action="save-order">保存订单</button></div>`,true);wireAttachmentZone();}
function ocrModal(platform=''){
 ocrFiles.forEach(f=>f.url&&URL.revokeObjectURL(f.url));ocrFiles=[];
 modalKind='ocr';ocrJobId=null;ocrBusy=false;ocrRevision++;
 formOrder={...blankOrder(),...(platforms.includes(platform)?{platform}:{}),paidAt:'',status:'待核对'};formAttachments=[];formExistingAttachments=[];
 modal('采购单识别','上传单据、粘贴文字或直接填写，核对后统一入账',`
  <div class="entry-methods segmented" role="group" aria-label="采购单录入方式"><button class="active" data-action="entry-mode" data-mode="recognize" aria-pressed="true">上传 / 粘贴识别</button><button data-action="entry-mode" data-mode="direct" aria-pressed="false">直接填写</button></div>
  <div class="ocr-layout"><div class="ocr-input"><button type="button" class="dropzone" id="ocr-drop" data-action="choose-ocr"><span>${icon('spark')}<strong>添加图片 / 附件，或粘贴图片</strong><span class="ocr-drop-hint">先 Ctrl + C 复制图片，再在此窗口粘贴<br>支持图片、PDF、文档；图片 / PDF 可识别</span></span></button><input id="ocr-file" type="file" multiple hidden aria-label="选择采购单图片或附件"><div id="order-attachments" class="attachment-list" aria-live="polite"></div><div class="ocr-batch-actions"><span id="ocr-file-count" class="small muted" role="status">尚未添加图片</span><button class="text-button" data-action="clear-ocr" disabled>清空</button><button class="btn primary" data-action="start-ocr" disabled>开始识别</button></div><div id="ocr-progress" class="progress" role="status" aria-live="polite"></div><textarea id="ocr-text" rows="14" placeholder="识别结果会填入右侧，请逐项核对、补齐。确认入账后保留全部原件，多份附件可打包下载。&#10;&#10;也可以粘贴微信聊天或采购单文字，例如：&#10;供应商：五金配件店&#10;日期：2026-10-13&#10;商品：门锁配件&#10;数量：2&#10;实付金额：128.50" aria-label="采购单原文"></textarea></div><div id="ocr-form">${formHtml(formOrder)}</div></div>
 `,`<div class="ocr-footer-actions"><button class="btn" data-action="parse-text">从文字提取字段</button><span class="small muted">核对后确认入账</span></div><div class="actions"><button class="btn" data-action="close">取消</button><button class="btn primary" data-action="save-order">确认入账</button></div>`);
 const drop=$('#ocr-drop');
 drop.addEventListener('dragover',e=>{e.preventDefault();if(!ocrBusy)drop.classList.add('drag');});
 drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
 drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('drag');addOcrFiles(e.dataTransfer.files);});
 wireAttachmentZone();
}
function setEntryMode(mode){
 if(ocrBusy)return;
 const direct=mode==='direct';
 $('.ocr-layout').classList.toggle('direct-entry',direct);$('.ocr-input').classList.toggle('attachments-only',direct);
 $$('[data-action="entry-mode"]').forEach(button=>{const active=button.dataset.mode===mode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});

}
function setOcrBusy(busy){
 ocrBusy=busy;$('#ocr-form').inert=busy;$('#ocr-file').disabled=busy;$('#ocr-text').disabled=busy;
 $$('[data-action="entry-mode"],[data-action="parse-text"],[data-action="choose-ocr"],[data-action="remove-ocr"]').forEach(button=>button.disabled=busy);
 $('[data-action="start-ocr"]').disabled=busy||!ocrFiles.length;
 $('[data-action="clear-ocr"]').disabled=busy||attachmentBusy||!formAttachments.length;
 updateSaveState();
}
function renderOcrFiles(){
 renderAttachments();
 $('#ocr-file-count').textContent=`已添加 ${formAttachments.length} 个附件，${ocrFiles.length} 个可识别`;
 $('[data-action="start-ocr"]').textContent=ocrFiles.length?`识别 ${ocrFiles.length} 个文件`:'开始识别';
 setOcrBusy(ocrBusy);
 $('[data-action="clear-ocr"]').disabled=ocrBusy||attachmentBusy||!formAttachments.length;
}
async function addOcrFiles(incoming){
 if(ocrBusy||attachmentBusy||saveBusy){toast('正在处理，请稍候');return;}
 const files=Array.from(incoming||[]);if(!files.length)return;
 const epoch=attachmentEpoch,saved=await uploadAttachments(files);
 if(!saved||epoch!==attachmentEpoch||modalKind!=='ocr')return;
 let added=0;
 files.forEach((file,i)=>{
  if(!/\.(png|jpe?g|webp|pdf)$/i.test(file.name)||!file.size)return;
  ocrFiles.push({file,attachmentId:saved[i].id,url:null});added++;
 });
 if(added){ocrJobId=null;ocrRevision++;}
 renderOcrFiles();$('#ocr-progress').textContent='附件已保留，可识别图片 / PDF，也可直接填写入账。'+(added<files.length?' 文档仅作为附件保存。':'');
}
async function removePendingAttachments(ids){
 if((modalKind==='ocr'&&ocrBusy)||attachmentBusy||saveBusy)return;
 const epoch=attachmentEpoch;attachmentBusy=true;updateSaveState();
 try{
  for(const id of ids){
   await api('/api/attachments/'+id,undefined,'DELETE');
   if(epoch!==attachmentEpoch)return;
   formAttachments=formAttachments.filter(a=>a.id!==id);
   const removed=ocrFiles.filter(f=>f.attachmentId===id);
   if(removed.length){removed.forEach(f=>f.url&&URL.revokeObjectURL(f.url));ocrFiles=ocrFiles.filter(f=>f.attachmentId!==id);ocrJobId=null;ocrRevision++;}
  }
 }catch(e){if(epoch===attachmentEpoch)toast('移除附件失败：'+e.message);}
 finally{if(epoch===attachmentEpoch){attachmentBusy=false;if(modalKind==='ocr')renderOcrFiles();else renderAttachments();updateSaveState();}}
}
function removeOcrFile(index){
 const ids=index==null?formAttachments.map(a=>a.id):[ocrFiles[index]?.attachmentId].filter(Boolean);
 void removePendingAttachments(ids);
}
async function startOcr(){
 if(ocrBusy||attachmentBusy||saveBusy||!ocrFiles.length)return;
 const revision=++ocrRevision;setOcrBusy(true);$('#ocr-progress').textContent='正在准备本地识别…';ocrJobId=null;
 try{const form=new FormData();ocrFiles.forEach(({file})=>form.append('file',file));const job=await api('/api/ocr',form);if(modalKind!=='ocr'||revision!==ocrRevision)return;pollOcr(job.id,revision);}
 catch(e){if(modalKind==='ocr'&&revision===ocrRevision){if(isUploadLimit(e))showUploadLimit(e.message);$('#ocr-progress').textContent=e.message;setOcrBusy(false);}}
}
async function pollOcr(id,revision){
 if(modalKind!=='ocr'||revision!==ocrRevision)return;
 try{
  const job=await api('/api/ocr/'+id);if(modalKind!=='ocr'||revision!==ocrRevision)return;
  if(job.status==='failed')throw Object.assign(Error(job.error),{code:job.code});
  if(job.status==='done'){ocrJobId=id;$('#ocr-progress').textContent=`已识别 ${job.fileCount} 个文件，请核对右侧订单信息。`+(job.result.warnings||[]).join(' ');$('#ocr-text').value=job.result.text;formOrder={...job.result.order,excludedFromSpend:$('[name="excludedFromSpend"]').value==='true',classification:classificationDraft(),platform:$('[name="platform"]').value,account:$('[name="account"]').value};$('#ocr-form').innerHTML=formHtml(formOrder);wireClassification(formOrder);wireAttachmentZone();setOcrBusy(false);return;}
  $('#ocr-progress').innerHTML=`正在合并识别 ${job.fileCount} 个文件 · ${job.progress}%<progress max="100" value="${job.progress}"></progress>`;ocrPoll=setTimeout(()=>pollOcr(id,revision),800);
 }catch(e){if(modalKind==='ocr'&&revision===ocrRevision){ocrJobId=null;if(isUploadLimit(e))showUploadLimit(e.message);$('#ocr-progress').textContent='识别未完成：'+e.message+(isUploadLimit(e)?'':'；附件已保留，可重试识别或直接填写入账。');setOcrBusy(false);}}
}
async function parseOrderText(){
 if(ocrBusy)return;
 const revision=++ocrRevision;setOcrBusy(true);
 try{const r=await api('/api/ocr/text',{text:$('#ocr-text').value,platform:$('[name="platform"]').value});if(modalKind!=='ocr'||revision!==ocrRevision)return;formOrder={...r.order,excludedFromSpend:$('[name="excludedFromSpend"]').value==='true',classification:classificationDraft()};$('#ocr-form').innerHTML=formHtml(formOrder);wireClassification(formOrder);wireAttachmentZone();$('#ocr-progress').textContent='字段已提取，未识别的信息请手工补齐。';}
 finally{if(modalKind==='ocr'&&revision===ocrRevision)setOcrBusy(false);}
}
async function detailModal(id){const o=state.orders.find(o=>o.id===id);if(!o)return;modalKind='detail';const [history,supplements,orderAttachments]=await Promise.all([api('/api/orders/'+id+'/history'),api('/api/orders/'+id+'/supplements'),state.extendedEditingAvailable?api('/api/orders/'+id+'/attachments'):Promise.resolve([])]);modal('采购订单详情',`${o.platform} · ${o.orderNo}`,`${orderConfirmation(o,state)?`<div class="notice month-lock-banner">${orderConfirmation(o,state).month} · ${esc(o.platform)} 已确认，当前只读。需要修改时，请先到月度确认取消确认。</div>`:''}<div class="detail-money">${money(o.amountCents)}</div><div class="details-grid"><div><label>供应商</label>${esc(o.supplier)}</div><div><label>状态</label>${statusTag(o.status)}</div><div><label>采购账号</label>${esc(o.account)}</div><div><label>下单日期</label>${o.date}</div><div><label>付款日期</label>${o.paidAt||'未提供'}</div><div><label>上传日期</label>${esc(orderUploadDate(o.createdAt)||'未记录')}</div><div><label>已记录退款</label>${money(o.refundCents)}</div><div><label>其中运费</label>${money(o.shippingCents)}</div><div><label>计入看板</label>${o.excludedFromSpend?'手动设置：不计入采购支出':effective(o)?money(o.amountCents-o.refundCents):'当前状态不纳入统计'}</div><div><label>数据来源</label>${esc(o.sourceLabel||'未记录')}${o.sourceId?` · <a href="/api/source/${o.sourceId}">下载原始文件</a>`:''}</div><div><label>录入人</label>${esc(o.uploadedBy||'历史记录未设置')}</div></div>${classificationDetails(o,esc,money,{readOnly:!!orderConfirmation(o,state)})}${deliveryDetails(o)}${orderAttachments.length?`<section class="delivery-details" id="order-attachments-details"><h3>采购单附件 · ${orderAttachments.length}</h3><div class="attachment-grid">${orderAttachments.map(attachmentCard).join('')}</div></section>`:''}<section id="order-images" aria-label="订单图片"></section><div class="form-section"><h3>商品明细 · ${o.items.length} 项</h3></div><div class="table-wrap"><table class="data-table"><thead><tr><th>商品</th><th>规格</th><th>单价(元)</th><th>数量</th><th>单位</th><th>运单号</th><th>物流公司</th></tr></thead><tbody>${o.items.map(i=>`<tr><td style="white-space:normal;min-width:220px">${esc(i.title)}</td><td style="white-space:normal;min-width:80px">${esc(i.spec||'—')}</td><td>${i.unitPriceCents==null?'未提供':plainMoney(i.unitPriceCents)}</td><td>${i.qty}</td><td>${esc(i.unit||'未提供')}</td><td>${esc(shipmentText(i,'trackingNo')||'—')}</td><td>${esc(shipmentText(i,'logisticsCompany')||'—')}</td></tr>`).join('')}</tbody></table></div>${o.note?`<div class="notice" style="margin-top:16px">备注：${esc(o.note)}</div>`:''}${supplementDetails(supplements,esc)}<details><summary>修改记录（${history.length}）</summary>${state.auditAvailable?`<button class="btn" data-order-logs="${id}">查看此订单日志与撤销</button>`:''}${history.map(h=>{const after=JSON.parse(h.after_json),before=h.before_json?JSON.parse(h.before_json):null;return `<div class="history-entry"><b>${h.action==='rollback'?'撤销修改':h.action==='attributes'?'修改订单属性':h.action==='classification'?'修改采购分类':h.action==='initialize-classification'?'初始化商品采购分类':h.action==='create'?'首次入账':h.action==='backfill-account'?'从原表补回采购账号':h.action==='supplement-source'?'补充原始数据':'修改订单'}</b> · ${new Date(h.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}<br>${before?historyChanges(before,after):'保留原始数据与来源'}${h.batch_id?`<br><small>批次 ${esc(h.batch_id)}</small>`:''}</div>`;}).join('')}</details>`,`<span class="small muted">原始文件和首次导入数据不会被编辑覆盖</span>${orderConfirmation(o,state)?'<button class="btn" data-action="close">关闭</button>':`<button class="btn primary" data-edit="${id}">${icon('edit')}编辑订单</button>`}`,true);void orderImageUI.mount(id);}
async function showMonth(month){state.filter={...emptyOrderFilter(),platform:state.platform==='全部'?'':state.platform,category:state.category,month};state.pageNo=1;state.page='orders';await render();}
document.addEventListener('click',async e=>{
 const el=e.target.closest('button,a,tr[data-detail],tr[data-month]');if(!el||el.disabled)return;
 try{
 const monthButton=e.target.closest('[data-dashboard-month]');if(monthButton){state.dashboardMonth=monthButton.dataset.dashboardMonth;await render();return;}

 if(el.dataset.nav){if(el.dataset.nav==='ocr'){ocrModal();return;}state.page=el.dataset.nav;await refresh();await render();return;}
 if(el.dataset.orderLogs){await auditUI.forOrder(el.dataset.orderLogs);return;}
 if(el.dataset.detail){e.preventDefault();await detailModal(el.dataset.detail);return;}
 if(el.dataset.classSplit){classificationActions.split(el.dataset.classSplit);return;}
 if(el.dataset.edit){await editOrderModal(el.dataset.edit);return;}
 if(el.dataset.note){noteModal(el.dataset.note);return;}
 if(el.dataset.month){await showMonth(el.dataset.month);return;}
  if(el.dataset.basis){state.basis=el.dataset.basis;await render();return;}
 if(el.dataset.removeItem){el.closest('[data-item]').remove();return;}
 const action=el.dataset.action;
 if(action==='add-shipment'){const rows=el.closest('[data-item]').querySelector('.shipment-rows');if(rows.children.length>=50)return toast('每条商品最多 50 个运单');rows.insertAdjacentHTML('beforeend',shipmentHtml());return;}
 if(action==='remove-shipment'){el.closest('.shipment-row').remove();return;}
 if(action==='close'){closeModal();return;}
 if(action==='import'){importModal();return;}
 if(action==='ocr'){ocrModal();return;}
 if(action==='entry-mode'){setEntryMode(el.dataset.mode);return;}
 if(action==='choose-ocr'){$('#ocr-file').click();return;}
 if(action==='start-ocr'){await startOcr();return;}
 if(action==='remove-ocr'){removeOcrFile(Number(el.dataset.index));return;}
 if(action==='clear-ocr'){removeOcrFile();return;}
  if(action==='add-item'){$('#item-rows').insertAdjacentHTML('beforeend',itemHtml({title:'',spec:'',qty:1,unit:'个',unitPriceCents:0},Date.now()));return;}
 if(el.dataset.attachmentRemove){void removePendingAttachments([el.dataset.attachmentRemove]);return;}
 if(action==='remap'){el.disabled=true;try{const mapping={};$$('[data-mapping]').forEach(s=>mapping[s.dataset.mapping]=s.value);await remapImport({mapping,sheet:$('#mapping-sheet').value,amountMode:$('#amount-mode').value,account:$('#import-account').value});}finally{el.disabled=false;}return;}
 if(action==='import-report'){const report=state.imports.find(i=>i.id===el.dataset.importId)?.metadata?.importReport;if(report)showImportReport(report);return;}
 if(action==='commit-import'){
  el.disabled=true;
  try{
   const indices=$$('[data-import-index]:checked').map(el=>Number(el.dataset.importIndex));
   const r=await api('/api/import/'+preview.id+'/commit',{indices});closeModal();await refresh();await render();
   if(r.report)showImportReport(r.report);else toast(`已入库 ${r.imported} 笔采购订单${r.skipped?`，跳过 ${r.skipped} 笔重复订单`:''}`);
  }catch(e){
   if(e.preview&&e.report&&modalKind==='import'){preview=e.preview;renderPreview();$('#commit-import-error').innerHTML=importReportHtml(e.report,esc);$('#import-status').textContent=e.message;$('#commit-import-error').scrollIntoView({block:'start'});}
   else el.disabled=false;
   throw e;
  }
  return;
 }
 if(action==='save-note'){el.disabled=true;try{const saved=await api('/api/orders/'+noteDraft.id+'/note',{note:$('#quick-note').value,updatedAt:noteDraft.updatedAt},'PATCH');state.orders=state.orders.map(o=>o.id===saved.id?saved:o);closeModal();await refreshOrderRows();toast('备注已保存，修改记录已保留');}catch(e){$('#note-error').hidden=false;$('#note-error').textContent=e.message;el.disabled=false;}return;}
 if(action==='save-order'){
  if(attachmentBusy||saveBusy||!state.extendedEditingAvailable)return toast('请等待上传完成，并确认后台已更新');
  saveBusy=true;updateSaveState();
  try{const o=collectForm(),ids=formAttachments.map(a=>a.id);await api(o.id?'/api/orders/'+o.id:'/api/orders',{...o,...(ocrJobId?{ocrJobId}:{}),attachmentIds:ids},o.id?'PUT':'POST');formAttachments=[];saveBusy=false;closeModal();await refresh();await render();toast(o.id?'订单已更新，修改记录已保留':'采购订单已保存');}
  catch(e){if(isUploadLimit(e))showUploadLimit(e.message);const box=$('#form-error');if(box){box.hidden=false;box.textContent=e.message;}saveBusy=false;updateSaveState();}return;
 }
 if(action==='parse-text'){await parseOrderText();return;}
 if(action==='backup'){el.disabled=true;el.textContent='正在生成完整备份…';try{const b=await api('/api/backup',{});const a=document.createElement('a');a.href=b.url;a.download=b.filename;a.click();toast('完整备份已创建并开始下载');}finally{el.disabled=false;el.innerHTML=icon('down')+'创建完整备份';}return;}
if(action==='open-logs'){state.page='logs';await refresh();await render();return;}
if(action==='check-update'){el.disabled=true;el.textContent='正在检查更新…';try{const r=await api('/api/upgrade/check',{});await aboutPage();toast(r.state==='unconfigured'?'尚未配置更新源，无法检查新版':r.state==='error'?'检查更新失败：'+(r.error||'请稍后重试'):r.state==='ok'?(r.hasUpdate?`发现新版本 v${r.latest}`:'已是最新版本'):'正在检查更新');}catch(e){toast(e.message);}finally{el.disabled=false;}return;}
 }catch(error){toast(error.message);}
});
document.addEventListener('change',async e=>{try{const el=e.target;
 if(el.name==='platform'&&$('#order-suppliers'))$('#order-suppliers').innerHTML=[...new Set(state.orders.filter(o=>o.platform===el.value).map(o=>o.supplier))].map(n=>`<option value="${esc(n)}">`).join('');
 if(el.id==='year-filter'){state.year=el.value;await render();}
 if(el.id==='global-category'){state.category=el.value;await render();}
 if(el.id==='global-platform'){state.platform=el.value;await render();}
  if(el.id==='import-file'&&el.files.length)await loadImport(el.files[0]);
 if(el.id==='ocr-file'&&el.files.length){addOcrFiles(el.files);el.value='';}
 if(el.id==='order-attachment-input'&&el.files.length){uploadAttachments(el.files);el.value='';}
 if(el.id==='import-platform')selectImportPlatform();
 if(el.id==='import-account'&&preview)await remapImport({account:el.value||importRules[$('#import-platform').value].account});
 if(el.dataset.mapping!==undefined||['mapping-sheet','amount-mode'].includes(el.id)){importDirty=true;$('#commit-import').disabled=true;$('#import-footnote').textContent='字段已调整，请点击重新预览';}
 if(el.id==='select-all-preview'){$$('[data-import-index]:not(:disabled)').forEach(c=>c.checked=el.checked);updateImportTotal();}
 if(el.dataset.importIndex!==undefined)updateImportTotal();
 }catch(e){toast(e.message);}});
// Auto-detected carriers can follow a changed number; manually entered carriers stay intact.
document.addEventListener('input',e=>{
 const el=e.target;if(!(el instanceof HTMLInputElement))return;
 if(el.name==='logisticsCompany'||el.dataset.shipmentKey==='logisticsCompany'){el.dataset.manual='true';delete el.dataset.auto;return;}
 const autoFill=(tracking,company)=>{if(!company||company.dataset.manual==='true'||company.value&&!company.dataset.auto)return;company.value=detectCarrier(tracking.value);company.dataset.auto='true';};
 if(el.name==='trackingNo')autoFill(el,$('[name="logisticsCompany"]'));
 if(el.dataset.shipmentKey==='trackingNo')autoFill(el,el.closest('.shipment-row').querySelector('[data-shipment-key="logisticsCompany"]'));
});

document.addEventListener('paste',e=>{
 if(modalKind!=='ocr'||$('.ocr-input')?.hidden)return;
 const images=clipboardImages(e.clipboardData);if(!images.length)return;
 e.preventDefault();addOcrFiles(images);
});
document.addEventListener('keydown',e=>{if(document.querySelector('.upload-limit-dialog[open]'))return;if(orderImageUI.lightboxOpen())return;if(e.key==='Escape'&&modalKind&&!$('#cancel-month-submit')?.disabled)closeModal();if(e.key==='Tab'&&modalKind){const focus=$$('.modal button:not(:disabled),.modal input:not([hidden]):not([type=hidden]),.modal select,.modal textarea,.modal a').filter(x=>x.offsetParent!==null);if(!focus.length)return;if(e.shiftKey&&document.activeElement===focus[0]){e.preventDefault();focus.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===focus.at(-1)){e.preventDefault();focus[0].focus();}}});
(async()=>{try{readRoute();await refresh();if(state.orders.length&&!state.orders.some(o=>o.date.startsWith(state.year)))state.year=state.orders[0].date.slice(0,4);await render();}catch(e){$('#app').innerHTML=`<div class="startup-error"><div>灵兔采购台未能启动：${esc(e.message)}<p style="margin-top:16px">请运行“启动灵兔采购台.cmd”后刷新页面。</p></div></div>`;}})();

function accountPreview(p){const col=p.mapping.account,source=col!=null&&col!==""?p.headers[Number(col)]:"";return `<div class="privacy-note">${source?`采购账号自动读取表格「${esc(source)}」，空白时使用备用账号。`:`表内未匹配到采购账号，使用上方备用账号。`} 当前预览共 ${new Set(p.orders.map(o=>o.account)).size} 个账号，可在下表逐单核对。</div>`;}

function readRoute(){
 const [page,query='']=location.hash.slice(1).split('?');
 const aliases={tasks:'imports',settings:'about',backup:'about','data-backup':'about','order-logs':'logs'};
 if(page==='tasks'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(new URLSearchParams(query).get('month')||''))state.taskMonth=new URLSearchParams(query).get('month');
 state.page=aliases[page]||(['orders','months','logs','about','suppliers','addresses','imports'].includes(page)?page:'dashboard');
 if(state.page==='orders'){const params=new URLSearchParams(query),filter=emptyOrderFilter();for(const key of Object.keys(filter))if(params.has(key))filter[key]=params.get(key);state.filter=filter;state.pageNo=1;if(['paid','created'].includes(params.get('basis')))state.basis=params.get('basis');}
}
function syncRoute(){
 let next='#'+(state.page==='imports'?'tasks':state.page==='about'?'settings':state.page);
 if(state.page==='imports'&&state.taskMonth)next+='?'+new URLSearchParams({month:state.taskMonth});
 if(state.page==='orders'){const blank=emptyOrderFilter(),params=new URLSearchParams();for(const [k,v] of Object.entries(state.filter))if(v!==blank[k]&&v!==''&&v!=null)params.set(k,v);params.set('basis',state.basis);next+='?'+params;}
 if(location.hash!==next)history.pushState(null,'',next);
}
window.addEventListener('hashchange',()=>{if(saveBusy)return;closeModal();readRoute();void refresh().then(render).catch(e=>toast(e.message));});

document.addEventListener('change',e=>{if(e.target instanceof HTMLSelectElement&&e.target.dataset.shipmentKey==='logisticsCompany'){e.target.dataset.manual='true';delete e.target.dataset.auto;}});
