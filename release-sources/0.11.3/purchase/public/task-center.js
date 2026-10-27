import {importGuides} from './import-guides.mjs';

const statusLabels={pending:'待处理',done:'已核对',no_activity:'无采购',stale:'需复核',locked:'已锁定'};
const reviewSteps={
 'review:refunds':['逐个账号对照平台订单，检查完成、关闭、退款中等真实状态。','以付款和退款凭证核对实付、运费及已退款金额；实付已含运费时不重复相加。','不要按状态推算退款；未取得退款金额时，在备注说明并继续补充。'],
 'review:dates-accounts':['核对每个平台的全部采购账号；当前已入账账号仅作参考。','补齐真实付款日期；确实缺少付款日期时，说明按下单月份归属。','确认跨月付款的订单已归入正确月份，避免只按导入日期整理。'],
 'review:items-amounts':['核对每笔订单的全部商品、规格、数量、单位和单价。','核对整单实付；同一订单多行商品不能重复计算整单金额。','回查导入记录中的冲突、无效及未勾选订单，处理后重新导入或补录。'],
 'review:classification':['逐单检查商品采购、固定资产采购、日常支出的归类。','混合采购按实际用途拆分金额，并核对退款分类。','非公司采购设为“不计入采购支出”，保留真实交易状态和原始记录。'],
 'review:attachments-logistics':['补齐需要留存的订单截图、付款凭证、送货单或采购附件。','检查供应商、商品和必要的收货联系方式；已有快递的订单补充物流。','没有附件或物流的订单按实际情况在任务备注说明，不编造凭证。']
};

export function createTaskCenter(ctx){
 const {state,api,esc,money,toast,modal,closeModal,refresh,render,today,historyHtml,openImport,openOcr,openConfirmation,openOrders,setKind}=ctx;
 let data=null,epoch=0,filter='all',operatorName='';
 const $=s=>document.querySelector(s);
 const monthLabel=month=>`${month.slice(0,4)} 年 ${Number(month.slice(5))} 月`;
 const previousMonth=()=>{const [y,m]=today().split('-').map(Number);return new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7);};
 const selectedMonth=()=>state.taskMonth||previousMonth();
 const taskById=id=>data?.tasks.find(task=>task.id===id);
 const complete=task=>task.completed===true;
 const activeTask=()=>data?.tasks.find(task=>!complete(task)&&task.kind!=='confirm')||data?.tasks.find(task=>!complete(task));
 const timestamp=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';

 function instructions(task){
  if(task.kind==='confirm')return ['先完成本平台全部账号的采集、补录和核对。','到可确认日期后，进入月度确认，检查订单数、实付与退款。','按现有确认流程锁定；以后补录需由管理员取消确认。'];
  if(task.kind==='review')return reviewSteps[task.id]||['查看所选月份的全部订单。','按要求补齐信息后，返回这里记录核对结果。'];
  return importGuides[task.platform]?.steps||['使用实际购买账号取得订单记录，或整理通用模板。','上传后核对账号、月份、商品及整单实付，再确认入库。','核查全部采购账号；无采购也需逐个账号检查后记录。'];
 }

 function taskRow(task,index){
  const ev=task.evidence||{},locked=task.status==='locked',label=statusLabels[task.status]||'待处理';
  const mainLabel=task.kind==='confirm'?(locked?'查看确认':'前往月度确认'):task.kind==='review'?'核对订单':['微信','其他'].includes(task.platform)?'识别 / 录入':'导入表格';
  const evidence=task.kind==='confirm'?`${ev.count||0} 笔订单 · 实付 ${money(ev.amountCents||0)} · 退款 ${money(ev.refundCents||0)}`:task.kind==='collect'?`本月已入账 ${ev.count||0} 笔${ev.accounts?.length?` · 已出现账号：${ev.accounts.map(account=>esc(typeof account==='string'?account:account.account||account.name||'')).join('、')}`:' · 请核查全部采购账号'}`:`本月 ${ev.count||0} 笔订单${ev.reviewCount?` · ${ev.reviewCount} 笔待核对`:''}${ev.missingPaidCount?` · ${ev.missingPaidCount} 笔缺付款日期`:''}`;
  return `<li class="tc-task ${complete(task)?'is-complete':''} ${task.status==='stale'?'is-stale':''}" data-tc-row="${esc(task.id)}" tabindex="-1">
   <div class="tc-number" aria-hidden="true">${complete(task)?'✓':String(index+1).padStart(2,'0')}</div>
   <div class="tc-task-content"><div class="tc-task-heading"><h3>${esc(task.title)}</h3><span class="tc-status ${esc(task.status)}">${label}</span></div>
    <p class="tc-evidence">${evidence}</p>
    <details class="tc-instructions"><summary>操作步骤</summary><p class="tc-description">${esc(task.description)}</p>${task.status==='stale'?'<p class="tc-stale-note">采购数据已变化，请重新核对。</p>':''}${task.mark?`<p class="tc-mark">上次记录：${esc(task.mark.operator)} · ${esc(timestamp(task.mark.updatedAt))}${task.mark.note?` · ${esc(task.mark.note)}`:''}</p>`:''}<ol>${instructions(task).map(step=>`<li>${esc(step)}</li>`).join('')}</ol>${task.kind==='collect'?'<p>覆盖本平台全部采购账号，包括还没有入账记录的账号。上传表格可以包含多个月份，入账日期仍以原始订单为准。</p>':''}${locked?'<p>此平台已锁定。补录或修改前，请在月度确认中由管理员取消确认。</p>':''}</details>
   </div>
   <div class="tc-task-actions"><button class="btn ${!complete(task)?'primary':''}" data-tc-op="start" data-tc-id="${esc(task.id)}" ${locked&&task.kind==='collect'?'disabled':''}>${mainLabel}</button>
    ${task.kind==='collect'?`<details class="tc-extra-actions"><summary>其他操作</summary><div class="tc-secondary"><button class="text-button" data-tc-op="orders" data-tc-id="${esc(task.id)}">查看订单</button>${!['微信','其他'].includes(task.platform)?`<button class="text-button" data-tc-op="ocr" data-tc-id="${esc(task.id)}" ${locked?'disabled':''}>单据补录</button>`:`<button class="text-button" data-tc-op="import" data-tc-id="${esc(task.id)}" ${locked?'disabled':''}>表格导入</button>`}</div></details>`:''}
    ${task.canMark?`<button class="text-button tc-record" data-tc-op="record" data-tc-id="${esc(task.id)}">${complete(task)?'修改记录':'标记已核对'}</button>`:task.kind==='confirm'?`<span class="tc-unlock-tip">${locked?'全部账号已锁定':data.canConfirm?'核对完成后确认锁定':`${esc(data.availableOn)} 起可确认`}</span>`:'<span class="tc-unlock-tip">已锁定，需管理员取消确认后处理</span>'}
   </div></li>`;
 }

 async function page({keepScroll=false}={}){
  const revision=++epoch,scroll=window.scrollY;state.taskMonth=selectedMonth();
  const root=$('#page-content');if(!root)return;
  if(!data||data.month!==state.taskMonth)root.innerHTML='<div class="loading" role="status">正在读取本月采购任务…</div>';
  try{const result=await api('/api/tasks?'+new URLSearchParams({month:state.taskMonth}));if(revision!==epoch||state.page!=='imports')return;data=result;}
  catch(error){if(revision===epoch&&state.page==='imports')root.innerHTML=`<div class="alert error">任务清单暂时无法读取。请确认采购台后台已更新并重启，再刷新页面。<p>${esc(error.message)}</p><button class="btn" data-tc-op="refresh">重试</button></div>`;root.onclick=handleClick;return;}
  const {summary}=data,currentYear=Number(data.month.slice(0,4)),yearOptions=[...new Set([Number(today().slice(0,4)),currentYear,...state.orders.map(order=>Number((order.paidAt||order.date).slice(0,4)))])].filter(Number.isFinite).sort((a,b)=>b-a);
  const next=activeTask();
  root.innerHTML=`<div class="tc-center">
   <div class="tc-toolbar"><div class="tc-month-title"><label class="tc-year">年份 <select id="tc-year" aria-label="任务年份">${yearOptions.map(year=>`<option ${year===currentYear?'selected':''}>${year}</option>`).join('')}</select></label></div><div class="actions"><button class="btn" data-tc-op="current-month">回到本月</button><button class="text-button" data-tc-op="refresh">刷新</button></div></div>
   <nav class="tc-months" aria-label="任务月份">${Array.from({length:12},(_,index)=>{const month=String(index+1).padStart(2,'0');return `<button type="button" data-tc-op="month" data-tc-month="${currentYear}-${month}" aria-pressed="${data.month.endsWith('-'+month)}" class="${data.month.endsWith('-'+month)?'active':''}">${index+1}月</button>`;}).join('')}</nav>
   <section class="tc-overview" aria-label="本月任务进度"><div class="tc-progress-main"><div class="tc-progress-value"><span>已处理</span><strong>${summary.completed}</strong><span>/ ${summary.total}</span></div><progress max="${summary.total||1}" value="${summary.completed}" aria-label="本月任务完成进度"></progress></div><div class="tc-overview-stats"><div><strong>${summary.pending}</strong><span>待处理</span></div><div><strong>${summary.orderCount}</strong><span>本月入账</span></div><div><strong>${summary.lockedPlatforms} / 7</strong><span>已锁定</span></div></div><div class="tc-next"><span>下一项</span><strong>${next?esc(next.title):'全部已处理'}</strong><button class="btn" data-tc-op="continue" ${!next?'disabled':''}>${next?'定位下一项':'全部已处理'}</button></div></section>
   <details class="tc-scope"><summary>任务范围与核对规则</summary><p>按付款月份整理；缺少付款日期时按下单月份。需核查各平台全部采购账号；无采购也须逐个账号检查后记录。已核对、无采购和已锁定分别记录。</p></details>
   <div class="tc-utilities"><span>常用工具</span><button class="text-button" data-action="import">通用表格导入</button><button class="text-button" data-action="ocr">识别 / 直接填写</button><a href="/integration-review.html?launch=1" target="_blank" rel="noopener">历史订单采集 / 导入</a><a href="/api/template">下载通用模板</a></div>
   <div class="tc-list-toolbar"><div class="segmented" role="group" aria-label="任务状态筛选"><button data-tc-op="filter" data-tc-filter="all" class="${filter==='all'?'active':''}" aria-pressed="${filter==='all'}">全部任务</button><button data-tc-op="filter" data-tc-filter="pending" class="${filter==='pending'?'active':''}" aria-pressed="${filter==='pending'}">待处理 ${summary.pending}</button><button data-tc-op="filter" data-tc-filter="completed" class="${filter==='completed'?'active':''}" aria-pressed="${filter==='completed'}">已处理 ${summary.completed}</button></div><span>${summary.stale?`${summary.stale} 项需复核`:''}</span></div>
   <div class="tc-groups">${data.groups.map((group,index)=>{const all=data.tasks.filter(task=>task.group===group.id),rows=all.filter(task=>filter==='all'||(filter==='completed'?complete(task):!complete(task)));return `<section class="panel tc-group" aria-labelledby="tc-group-${esc(group.id)}"><header class="tc-group-head"><span class="tc-stage">${String(index+1).padStart(2,'0')}</span><div><h2 id="tc-group-${esc(group.id)}">${esc(group.title)}</h2><p>${esc(group.description)}</p></div><span class="tc-group-count">${all.filter(complete).length} / ${all.length} 已处理</span></header><ol class="tc-tasks">${rows.map(task=>taskRow(task,data.tasks.indexOf(task))).join('')||'<li class="tc-empty">当前筛选下没有任务</li>'}</ol></section>`;}).join('')}</div>
   <details class="tc-history"><summary>导入记录与未导入清单 <span>${state.imports.length} 批 · 全部月份</span></summary>${historyHtml()}</details>
  </div>`;
  root.onclick=handleClick;
  $('#tc-year').onchange=event=>changeMonth(`${event.target.value}-${data.month.slice(5)}`).catch(error=>toast(error.message));
  if(keepScroll)window.scrollTo({top:scroll});
 }

 async function changeMonth(month){state.taskMonth=month;filter='all';await render();}
 async function handleClick(event){
  const button=event.target.closest('[data-tc-op]');if(!button||button.disabled)return;event.stopPropagation();
  const op=button.dataset.tcOp,task=taskById(button.dataset.tcId);
  try{
   if(op==='refresh'){await refresh();await page({keepScroll:true});return;}
   if(op==='filter'){filter=button.dataset.tcFilter;await page({keepScroll:true});return;}
   if(op==='month'){await changeMonth(button.dataset.tcMonth);return;}
   if(op==='last-month'||op==='current-month'){await changeMonth(op==='last-month'?previousMonth():today().slice(0,7));return;}
   if(op==='previous'||op==='next'){const [year,month]=data.month.split('-').map(Number);await changeMonth(new Date(Date.UTC(year,month-1+(op==='next'?1:-1),1)).toISOString().slice(0,7));return;}
   if(op==='continue'){filter='all';await page();const next=activeTask(),row=next&&document.querySelector(`[data-tc-row="${CSS.escape(next.id)}"]`);row?.scrollIntoView({behavior:'smooth',block:'center'});row?.focus({preventScroll:true});if(row)row.querySelector('details').open=true;return;}
   if(!task)return;
   if(op==='orders'){await openOrders(data.month,task.platform);return;}
   if(op==='import'){openImport(task.platform);return;}
   if(op==='ocr'){openOcr(task.platform);return;}
   if(op==='start'){if(task.kind==='confirm')await openConfirmation(data.month,task.platform);else if(task.kind==='review')await openOrders(data.month);else if(['微信','其他'].includes(task.platform))openOcr(task.platform);else openImport(task.platform);return;}
   if(op==='record')recordModal(task);
  }catch(error){toast(error.message);}
 }

 function recordModal(task){
  const month=data.month,revision=data.revision;
  setKind('monthly-task');
  modal('记录核对结果',`${monthLabel(month)} · ${esc(task.title)}`,
   `<form id="tc-record-form"><p class="tc-record-notice">记录表示你已按步骤完成核查。月度锁定仍需单独在“月度确认”完成。</p><div class="form-grid"><label class="field">经办人 <span class="required">*</span><input name="operator" required maxlength="80" value="${esc(task.mark?.operator||operatorName)}" placeholder="填写实际经办人姓名"></label><label class="field">处理结果<select name="status"><option value="done">已核对</option>${task.kind==='collect'&&(task.evidence?.count||0)===0?'<option value="no_activity">已核查，无采购</option>':''}<option value="pending">恢复待处理</option></select></label></div><label class="field">处理备注<textarea name="note" maxlength="2000" rows="3" placeholder="记录已核查账号、原始资料位置、处理说明；无采购时必填">${esc(task.mark?.note||'')}</textarea></label><label class="tc-ack"><input type="checkbox" name="ack" required><span>我已按操作步骤核对；平台采集包含全部采购账号，所填结果与原始记录一致。</span></label><p class="privacy-note">之后补入或修改本月数据，相关任务会提示重新核对。</p><div class="alert error" id="tc-record-error" role="alert" hidden></div></form>`,
   '<button class="btn" data-action="close">取消</button><button class="btn primary" type="submit" form="tc-record-form">保存处理结果</button>',true);
  const form=$('#tc-record-form');
  if([...form.elements.status.options].some(option=>option.value===task.mark?.status))form.elements.status.value=task.mark.status;
  const updateRequirements=()=>{form.elements.note.required=form.elements.status.value==='no_activity';form.elements.ack.required=form.elements.status.value!=='pending';};
  form.elements.status.onchange=updateRequirements;updateRequirements();
  form.onsubmit=async event=>{event.preventDefault();const button=document.querySelector('[form="tc-record-form"]'),error=$('#tc-record-error');button.disabled=true;error.hidden=true;
   try{await api('/api/tasks',{month,revision,taskId:task.id,status:form.elements.status.value,operator:form.elements.operator.value.trim(),note:form.elements.note.value.trim(),ack:form.elements.ack.checked});operatorName=form.elements.operator.value.trim();closeModal();await refresh();await page({keepScroll:true});toast('本月任务进度已保存');}
   catch(err){error.hidden=false;error.textContent=err.message;button.disabled=false;}
  };
 }
 return {page};
}
