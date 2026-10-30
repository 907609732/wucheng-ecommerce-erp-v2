import {importGuides} from './import-guides.mjs';

const flowLabels={assigned:'待开始',in_progress:'处理中',submitted:'待验收',accepted:'已验收',returned:'已退回',stale:'需重新核对'};
const roles={boss:'老板',employee:'员工'};
const validMonth=value=>/^\d{4}-(0[1-9]|1[0-2])$/.test(value);

export function createTaskCards(ctx){
 const {state,api,esc,money,toast,modal,closeModal,refresh,render,today,historyHtml,openImport,openOcr,openConfirmation,openOrders,setKind}=ctx;
 const $=selector=>document.querySelector(selector);
 let board=null,session=null,staff=[],epoch=0,tab='all',filter='open',choosing=false;
 const monthValue=()=>{if(validMonth(state.taskMonth))return state.taskMonth;const [y,m]=today().split('-').map(Number);return new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7);};
 const monthText=value=>`${value.slice(0,4)} 年 ${Number(value.slice(5))} 月`;
 const stamp=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
 const shared=()=>session?.source==='workbench';
 const isBoss=()=>!shared()&&session?.selected&&session.role==='boss';
 const locked=task=>task.status==='locked'||!!task.confirmation;
 const taskDone=task=>locked(task)||task.assignment?.state==='accepted';
 const taskById=id=>board?.tasks.find(task=>task.id===id);
 const people=()=>shared()?staff:staff.filter(person=>person.active!==false);
 const actionButton=(label,op,id='',primary=false,extra='')=>`<button type="button" class="btn ${primary?'primary':''}" data-pc-op="${op}" ${id?`data-pc-id="${esc(id)}"`:''} ${extra}>${esc(label)}</button>`;
 const textButton=(label,op,id='')=>`<button type="button" class="text-button" data-pc-op="${op}" ${id?`data-pc-id="${esc(id)}"`:''}>${esc(label)}</button>`;

 async function getSession(){session=await api('/api/personnel/session');return session;}
 async function getStaff(){const result=await api('/api/personnel');staff=Array.isArray(result.staff)?result.staff:[];return staff;}
 const identityLabel=()=>shared()?(session.actor?.label||session.actor?.login||session.actor?.id||'已登录人员'):(session?.staff?.name||'当前经办人');
 function identityBar(){if(shared())return `<div class="pc-identity"><span>当前登录：${esc(identityLabel())}</span>${session.staff?`<small>历史经办关联：${esc(session.staff.name)}</small>`:''}</div>`;return `<div class="pc-identity"><span>${esc(identityLabel())}</span>${session?.readOnly?'<span class="pc-state">只读</span>':''}${textButton('切换本机工作身份','identity')}</div>`;}
 function tabs(){return `<div class="pc-tabs" role="group" aria-label="任务工作区">${shared()?actionButton('全部任务','tab-all','',false,`aria-pressed="${tab==='all'}"`):''}${actionButton('我的经办','tab-mine','',false,`aria-pressed="${tab==='mine'}"`)}${session?.canAssign?actionButton('任务安排','tab-assign','',false,`aria-pressed="${tab==='assign'}"`):''}</div>`;}

 function chooser(){
  const employees=people().filter(person=>person.role==='employee');
  const local=session?.source!=='workbench';
  return `<div class="pc-center"><header class="pc-page-head"><div><h2>选择本次工作身份</h2><p>${local?'本机按工作分工选择，不作为账号登录；远程身份由工作台授权。':'当前身份由工作台账号授权。请使用已绑定的员工账号。'}</p></div></header><div class="pc-identity-grid">${local?`<section class="pc-identity-card"><span class="pc-kind">负责人</span><h3>老板工作台</h3><p>分配任务、验收资料，并完成月度确认。</p>${actionButton('进入老板工作台','choose-boss','',true)}</section>`:''}<section class="pc-identity-card"><span class="pc-kind">执行人员</span><h3>员工任务</h3><p>查看分配给自己的任务，补齐采购资料后提交验收。</p>${employees.length?`<label class="field">选择员工<select id="pc-staff-choice" aria-label="选择员工">${employees.map(person=>`<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('')}</select></label>${actionButton('进入我的任务','choose-employee','',true)}`:`<div class="pc-empty-inline">还没有可用员工，请由老板先在主页添加人员，再分配任务。</div>`}</section></div></div>`;
 }

 function stageLabel(task){return task.kind==='collect'?'收集与导入':task.kind==='review'?'数据复核':'月度确认';}
 function taskStatus(task){if(locked(task))return '已锁定';if(task.kind==='confirm')return board.canConfirm?'待确认':`${board.availableOn} 起可确认`;return flowLabels[task.assignment?.state]||'未分配';}
 function dueLabel(task){const due=task.assignment?.dueOn;if(!due)return '<span>未设置截止日</span>';const overdue=due<today()&&!taskDone(task)&&task.assignment?.state!=='submitted';return `<span class="${overdue?'pc-overdue':''}">${overdue?'已逾期 · ':''}截止 ${esc(due)}</span>`;}
 function nextStep(task){
  if(locked(task))return '本任务范围已被月度确认锁定。任务验收记录单独保留，补录前需由管理员取消月度确认。';
  if(task.kind==='confirm')return locked(task)?'本平台本月已锁定。需要补录时，先由管理员取消月度确认。':'验收采购资料后，到月度确认检查订单数、实付和退款，再执行真实锁定。';
  const a=task.assignment;
  if(!a)return '先明确负责人、截止日期和处理要求，再开始本月工作。';
  if(a.state==='submitted')return isBoss()?'查看提交说明和原始依据，对照当前采购数据验收或退回。':'资料已提交，请等待人工验收。';
  if(a.state==='accepted')return '本次提交已验收，验收与月度锁定分别记录。';
  if(a.state==='returned')return '老板已退回，请按退回说明补齐资料后重新提交。';
  if(a.state==='stale')return '提交后采购数据有变化，请重新核对本任务范围，再次提交验收。';
  return task.kind==='collect'?`核查${task.platform||'本平台'}全部采购账号，取得原件并导入，逐单核对后提交。`:'按照操作步骤检查本月数据，处理问题并记录依据后提交验收。';
 }
 function steps(task){if(task.kind==='confirm')return ['核查已验收资料','核对本月金额与订单','执行月度确认'];if(task.kind==='collect')return ['取得全部账号原件','导入并补齐信息','核查后提交验收'];return ['查看本月订单','逐项复核并补充','记录依据并提交'];}
 function instructions(task){return task.kind==='collect'?(importGuides[task.platform]?.steps||['取得本平台全部采购账号的采购记录。','核对原件、商品和整单实付，再导入或直接填写。','检查本月范围，补齐缺失信息后提交验收。']):task.kind==='confirm'?['按原有月度确认规则处理。','各月从次月15日零点（北京时间）起可确认。','已锁订单不能直接补录；取消确认仍需管理员验证。']:[task.description||'按任务要求核对本月数据。','订单金额、退款、分类和原件应能对应。','已导入或已存在订单不代表已完成整月核对。'];}
 function cardActions(task){
  const a=task.assignment,p=task.permissions||{};
  if(locked(task))return isBoss()?actionButton('查看月度确认','confirm',task.id):'';
  if(task.kind==='confirm')return isBoss()?actionButton(locked(task)?'查看月度确认':'前往月度确认','confirm',task.id,!locked(task)):'';
  let main='',mainOp='';
  if(p.canReview&&a?.state==='submitted')main=actionButton('验收这项任务','review',task.id,true);
  else if(p.canStart||p.canSubmit&&!['submitted','accepted'].includes(a?.state))main=actionButton(a?.state==='assigned'?'开始处理':a?.state==='returned'||a?.state==='stale'?'重新处理':'继续处理','start',task.id,true);
  else if(a?.state==='submitted')main='';
  else if(p.canAssign){main=actionButton(a?'调整任务安排':'分配任务','assign',task.id,!a);mainOp='assign';}
  else main='';
  return main+(p.canSubmit&&!['submitted','accepted'].includes(a?.state)?textButton('提交验收','submit',task.id):'')+(p.canAssign&&a&&mainOp!=='assign'?textButton('调整分配','assign',task.id):'');
 }
 function card(task,{featured=false}={}){
  const ev=task.evidence||{},a=task.assignment,stateName=locked(task)?'locked':task.kind==='confirm'?'pending':a?.state||'unassigned';
  return `<article class="pc-card ${featured?'pc-featured':''}" data-pc-task="${esc(task.id)}"><div class="pc-card-top"><span class="pc-kind">${esc(stageLabel(task))}${task.platform?` · ${esc(task.platform)}`:''}</span><span class="pc-state ${esc(stateName)}">${esc(taskStatus(task))}</span></div><h3>${esc(task.title)}</h3><p class="pc-next-copy">${esc(nextStep(task))}</p><div class="pc-card-meta"><span>负责人：${esc(a?.assigneeName||(task.kind==='confirm'?'月度核对':'未分配'))}</span>${dueLabel(task)}</div>${a?.instructions?`<p class="pc-assignment-note">要求：${esc(a.instructions)}</p>`:''}<div class="pc-evidence"><div><strong>${Number(ev.count)||0}</strong><span>本月已入账</span></div><div><strong>${money(Number(ev.amountCents)||0)}</strong><span>整单实付</span></div><div><strong>${Number(ev.reviewCount)||0}</strong><span>待核对订单</span></div></div>${featured?`<ol class="pc-mini-steps">${steps(task).map((step,index)=>`<li><span>${index+1}</span>${esc(step)}</li>`).join('')}</ol>`:''}${a?.state==='returned'&&a.reviewNote?`<div class="pc-review-note">退回说明：${esc(a.reviewNote)}</div>`:''}${task.mark&&!a?'<p class="pc-legacy">存在历史核对记录，尚未记录任务验收。</p>':''}<footer class="pc-card-actions">${cardActions(task)}${textButton('详情与依据','details',task.id)}</footer></article>`;
 }

 function visibleTasks(){
  const all=board.tasks||[];
  let list=shared()?(tab==='mine'?all.filter(task=>session.staff?.id&&task.assignment?.assigneeId===session.staff.id):tab==='assign'?all.filter(task=>task.kind!=='confirm'):all):(session.readOnly?all:tab==='assign'?all.filter(task=>task.kind!=='confirm'):isBoss()?all.filter(task=>task.kind==='confirm'||task.assignment?.state==='submitted'&&task.permissions?.canReview||session.staff?.id&&task.assignment?.assigneeId===session.staff.id||session.canAssign&&task.kind!=='confirm'&&!task.assignment&&!locked(task)):all.filter(task=>session.staff?.id&&task.assignment?.assigneeId===session.staff.id));
  if(filter==='open')list=list.filter(task=>!taskDone(task));
  if(filter==='submitted')list=list.filter(task=>task.assignment?.state==='submitted');
  if(filter==='accepted')list=list.filter(task=>taskDone(task));
  return list;
 }
 function ordered(tasks){const rank={returned:1,stale:2,submitted:isBoss()?0:6,in_progress:3,assigned:4,accepted:8};const priority=task=>locked(task)?100:task.kind==='confirm'?99:!task.assignment?1:rank[task.assignment.state]??5;return [...tasks].sort((a,b)=>priority(a)-priority(b)||String(a.assignment?.dueOn||'9999').localeCompare(String(b.assignment?.dueOn||'9999')));}
 function summaryMarkup(){const tasks=board.tasks.filter(task=>task.kind!=='confirm'),accepted=tasks.filter(task=>task.assignment?.state==='accepted').length,submitted=tasks.filter(task=>task.assignment?.state==='submitted').length,unassigned=board.workflowSummary?.unassigned??tasks.filter(task=>!task.assignment&&!locked(task)).length;return `<div class="pc-summary"><span>资料已验收 <b>${accepted} / ${tasks.length}</b></span><span>待验收 <b>${submitted}</b></span>${session.canAssign?`<span>未分配 <b>${unassigned}</b></span>`:''}<span>平台已锁定 <b>${Number(board.summary?.lockedPlatforms)||0} / 7</b></span></div>`;}

 async function page({keepScroll=false}={}){
  const token=++epoch,scroll=window.scrollY,root=$('#page-content');if(!root)return;root.onclick=handleClick;
  try{
   await getSession();if(token!==epoch)return;
   if(!session.selected||choosing){await getStaff();if(token!==epoch)return;root.innerHTML=chooser();root.onclick=handleClick;return;}
   state.taskMonth=monthValue();const result=await api('/api/task-board?'+new URLSearchParams({month:state.taskMonth}));if(token!==epoch||state.page!=='imports')return;board=result;if(result.personnel)session=result.personnel;if(Array.isArray(result.staff))staff=result.staff;
   if(!shared()&&tab==='all')tab='mine';if(tab==='assign'&&!session.canAssign)tab='mine';
   const currentYear=Number(board.month.slice(0,4)),years=[...new Set([Number(today().slice(0,4)),currentYear,...state.orders.map(order=>Number((order.paidAt||order.date).slice(0,4)))])].filter(Number.isFinite).sort((a,b)=>b-a);
   const rows=ordered(visibleTasks()),focus=filter!=='accepted'?rows.find(task=>!taskDone(task)):null,rest=rows.filter(task=>task!==focus);
   root.innerHTML=`<div class="pc-center"><header class="pc-page-head"><div><h2>${esc(monthText(board.month))}</h2><p>${shared()?'安排、处理和验收本月任务；实际登录操作人与业务经办分别记录。':tab==='assign'?'明确负责人和截止日期，跟进提交与验收。':isBoss()?'验收员工提交，跟进本月采购和最终确认。':'按任务补齐采购资料，完成后提交给人工验收。'}</p></div>${identityBar()}</header><div class="pc-top-tools">${tabs()}<div class="actions"><label class="pc-year">年份 <select id="pc-year" aria-label="任务年份">${years.map(year=>`<option ${year===currentYear?'selected':''}>${year}</option>`).join('')}</select></label>${textButton('回到本月','current')}${textButton('刷新','refresh')}</div></div><nav class="pc-months" aria-label="任务月份">${Array.from({length:12},(_,i)=>{const month=currentYear+'-'+String(i+1).padStart(2,'0');return `<button type="button" data-pc-op="month" data-pc-month="${month}" aria-pressed="${month===board.month}">${i+1}月</button>`;}).join('')}</nav>${summaryMarkup()}<div class="pc-filterbar"><div role="group" aria-label="任务状态筛选">${[['open','当前待办'],['submitted','待验收'],['accepted','已处理'],['all','全部任务']].map(([value,label])=>`<button type="button" data-pc-op="filter" data-pc-filter="${value}" aria-pressed="${filter===value}">${label}</button>`).join('')}</div><span>${rows.length} 项${session.readOnly?' · 只读查看':tab==='mine'&&!isBoss()?' · 当前选择我的经办范围':''}</span></div>${focus?`<section class="pc-focus"><div class="pc-section-heading"><h3>${tab==='assign'&&!focus.assignment?'先安排这项任务':'当前要做'}</h3><span>提交、验收与锁定分别记录</span></div>${card(focus,{featured:true})}</section>`:''}${rest.length?`<section class="pc-other"><div class="pc-section-heading"><h3>${focus?'其他事项':'任务清单'}</h3></div><div class="pc-grid">${rest.map(task=>card(task)).join('')}</div></section>`:''}${!rows.length?`<section class="pc-empty"><h3>${filter==='accepted'?'还没有已验收的任务':tab==='mine'&&!isBoss()?'暂时没有分配给你的任务':'当前筛选下没有待办'}</h3><p>${shared()&&!session.staff&&tab==='mine'?'当前账号未关联历史经办记录，可查看并处理全部任务；需要归属时请明确选择历史人员ID。':tab==='mine'&&!isBoss()&&!session.readOnly?'当前经办暂无分派任务；可切换全部任务或明确安排负责人。':'可切换任务状态或月份继续查看。'}</p>${session.canAssign?actionButton('查看分配管理','tab-assign','',true):''}</section>`:''}<details class="pc-tools"><summary>常用工具与处理规则</summary><div class="pc-tools-actions">${textButton('通用表格导入','tool-import')}${textButton('单据识别 / 直接填写','tool-ocr')}<a href="/integration-review.html?launch=1" target="_blank" rel="noopener">历史订单采集 / 导入</a><a href="/api/template">下载通用模板</a></div><p>按付款月份整理；缺少付款日期时按下单月份。经办人提交后进行人工验收，验收不会锁定订单。月度确认仍按原有规则执行。</p></details><details class="pc-history"><summary>导入记录与未导入清单 <span>${state.imports.length} 批 · 全部月份</span></summary>${historyHtml()}</details></div>`;
   root.onclick=handleClick;$('#pc-year').onchange=event=>changeMonth(`${event.target.value}-${board.month.slice(5)}`).catch(error=>toast(error.message));if(keepScroll)window.scrollTo({top:scroll});
  }catch(error){if(token===epoch){root.innerHTML=`<div class="alert error" role="alert">任务中心暂时无法读取。<p>${esc(error.message)}</p>${actionButton('重试','refresh')}</div>`;root.onclick=handleClick;}}
 }
 async function changeMonth(month){if(!validMonth(month))return;state.taskMonth=month;filter='open';await render();}
 async function perform(task,action,extra={}){const result=await api('/api/task-board/action',{month:board.month,taskId:task.id,action,revision:board.revision,...extra});if(result.tasks)board=result;else if(result.board?.tasks)board=result.board;return result;}
 async function handleClick(event){const el=event.target.closest('[data-pc-op]');if(!el||el.disabled)return;event.stopPropagation();const op=el.dataset.pcOp,task=taskById(el.dataset.pcId);try{
  if(op==='identity'){choosing=true;await page();return;}
  if(op==='choose-boss'||op==='choose-employee'){const input=op==='choose-boss'?{role:'boss'}:{role:'employee',staffId:$('#pc-staff-choice')?.value};if(input.role==='employee'&&!input.staffId)throw Error('请选择员工');el.disabled=true;await api('/api/personnel/session',input);choosing=false;tab='mine';await refresh();state.page='imports';await render();return;}
  if(op==='refresh'){await refresh();await page({keepScroll:true});return;}
  if(op==='month'){await changeMonth(el.dataset.pcMonth);return;}
  if(op==='current'){await changeMonth(today().slice(0,7));return;}
  if(op==='filter'){filter=el.dataset.pcFilter;await page({keepScroll:true});return;}
  if(op==='tab-all'||op==='tab-mine'||op==='tab-assign'){tab=op==='tab-all'?'all':op==='tab-assign'?'assign':'mine';state.page='imports';await render();return;}
  if(op==='tool-import'){openImport();return;}if(op==='tool-ocr'){openOcr();return;}
  if(!task)return;
  if(op==='confirm'){await openConfirmation(board.month,task.platform);return;}
  if(op==='start'){el.disabled=true;if(['assigned','returned','stale'].includes(task.assignment?.state))await perform(task,'start');await page({keepScroll:true});if(task.kind==='review')await openOrders(board.month);else if(['微信','其他'].includes(task.platform))openOcr(task.platform);else openImport(task.platform);return;}
  if(op==='assign'){await getStaff();assignModal(task);return;}
  if(op==='submit'){submitModal(task);return;}
  if(op==='review'){reviewModal(task);return;}
  if(op==='details')detailModal(task);
 }catch(error){toast(error.message);el.disabled=false;}}

 function openForm(title,task,body,buttonLabel,handler){setKind('task-card');modal(title,`${esc(monthText(board.month))} · ${esc(task.title)}`,`<form id="pc-action-form">${body}<div id="pc-form-error" class="alert error" role="alert" hidden></div></form>`,`${actionButton('取消','modal-close')}<button class="btn primary" type="submit" form="pc-action-form">${esc(buttonLabel)}</button>`,true);const form=$('#pc-action-form');form.onsubmit=async event=>{event.preventDefault();const button=document.querySelector('[form="pc-action-form"]'),error=$('#pc-form-error');button.disabled=true;error.hidden=true;try{await handler(form);closeModal();await page({keepScroll:true});}catch(err){error.hidden=false;error.textContent=err.message;button.disabled=false;}};document.querySelector('[data-pc-op="modal-close"]').onclick=closeModal;return form;}
 function assignModal(task){const a=task.assignment||{},choices=shared()?people():people().filter(person=>person.role==='employee'||person.id===session.staff?.id);openForm('安排任务',task,`<div class="form-grid"><label class="field">负责人 <span class="required">*</span><select name="assigneeId" required><option value="">请选择已登记人员</option>${choices.map(person=>`<option value="${esc(person.id)}" ${a.assigneeId===person.id?'selected':''}>${esc(person.name)} · ${esc(person.workbenchActorId||person.id)}</option>`).join('')}</select></label><label class="field">截止日期 <span class="required">*</span><input name="dueOn" type="date" value="${esc(a.dueOn||'')}" required></label></div><label class="field">任务要求<textarea name="instructions" rows="4" maxlength="2000" placeholder="写明需覆盖的采购账号、原件位置和特殊要求">${esc(a.instructions||'')}</textarea></label>${!choices.length?'<p class="alert">还没有可分配人员，请先到主页添加。</p>':''}<p class="privacy-note">负责人、截止日和要求会保存到本月任务。变更安排不会替代员工提交或人工验收。</p>`,'保存安排',async form=>{await perform(task,'assign',{assigneeId:form.elements.assigneeId.value,dueOn:form.elements.dueOn.value,instructions:form.elements.instructions.value.trim()});toast('任务安排已保存');});}
 function submitModal(task){const noActivity=task.kind==='collect'&&(task.evidence?.count||0)===0;const form=openForm('提交人工验收',task,`<p class="pc-form-note">提交表示本任务资料已准备好，之后由人工验收；本操作不会确认或锁定月份。</p><label class="field">提交结果<select name="result"><option value="done">已核对，资料已备齐</option>${noActivity?'<option value="no_activity">已核查，本月无采购</option>':''}</select></label><label class="field">提交说明 <span class="required">*</span><textarea name="note" rows="4" required maxlength="2000" placeholder="记录核查过的账号、处理结果、依据位置与需验收时注意的问题">${esc(task.assignment?.submissionNote||'')}</textarea></label><label class="pc-ack"><input type="checkbox" name="ack" required><span>我已按步骤核查任务范围和全部相关账号，说明与原始记录一致。</span></label>`,'提交验收',async form=>{await perform(task,'submit',{result:form.elements.result.value,note:form.elements.note.value.trim(),ack:form.elements.ack.checked});toast('已提交，等待人工验收');});form.elements.result.onchange=()=>{form.elements.note.placeholder=form.elements.result.value==='no_activity'?'请写明已核查的全部账号和无采购依据':'记录核查过的账号、处理结果、依据位置与需验收时注意的问题';};}
 function reviewModal(task){const a=task.assignment||{};const form=openForm('验收任务',task,`<div class="pc-form-note"><b>经办：${esc(a.assigneeName||'未记录')} · ${esc(stamp(a.submittedAt))}<br>提交操作人：${esc(a.submittedBy||'历史记录未提供')}</b><p>${esc(a.submissionNote||'未填写提交说明')}</p></div><div class="pc-form-links">${textButton('核对本月订单','review-orders',task.id)}</div><label class="field">验收结果<select name="decision"><option value="accept">验收通过</option><option value="return">退回补充</option></select></label><label class="field">验收说明<textarea name="note" rows="4" maxlength="2000" placeholder="退回时请明确指出缺少什么、如何补充"></textarea></label><label class="pc-ack"><input type="checkbox" name="ack" required><span>我已核查提交说明、依据和当前采购数据。验收通过不代表月度已锁定。</span></label>`,'保存验收结果',async form=>{const action=form.elements.decision.value;if(action==='return'&&!form.elements.note.value.trim())throw Error('请填写退回原因');await perform(task,action,{note:form.elements.note.value.trim(),ack:form.elements.ack.checked});toast(action==='accept'?'本次任务已验收':'已退回给负责人补充');});form.elements.decision.onchange=()=>{form.elements.note.required=form.elements.decision.value==='return';};document.querySelector('[data-pc-op="review-orders"]').onclick=async()=>{closeModal();await openOrders(board.month,task.platform);};}
 function detailModal(task){const a=task.assignment;setKind('task-card');modal('任务详情',`${esc(monthText(board.month))} · ${esc(task.title)}`,`<div class="pc-detail-meta"><span>工作状态：${esc(taskStatus(task))}</span><span>负责人：${esc(a?.assigneeName||'未分配')}</span><span>截止日期：${esc(a?.dueOn||'未设置')}</span></div><p class="pc-detail-description">${esc(task.description)}</p>${a?.instructions?`<section class="pc-detail-section"><h3>任务要求</h3><p>${esc(a.instructions)}</p></section>`:''}<section class="pc-detail-section"><h3>操作步骤</h3><ol>${instructions(task).map(step=>`<li>${esc(step)}</li>`).join('')}</ol></section>${a?.submittedAt?`<section class="pc-detail-section"><h3>最近提交 · ${esc(stamp(a.submittedAt))}</h3><p>${esc(a.submissionNote||'未填写说明')}</p></section>`:''}${a?.reviewedBy?`<section class="pc-detail-section"><h3>验收操作人</h3><p>${esc(a.reviewedBy)}</p></section>`:''}${a?.reviewNote?`<section class="pc-detail-section"><h3>验收意见</h3><p>${esc(a.reviewNote)}</p></section>`:''}${task.mark?`<section class="pc-detail-section"><h3>历史核对记录</h3><p>${esc(task.mark.operator)} · ${esc(stamp(task.mark.updatedAt))}</p><p>${esc(task.mark.note||'未填写备注')}</p><small>历史核对记录不等同于人工验收。</small></section>`:''}`,`<button class="btn" data-action="close">关闭</button>`,true);}

 return {page};
}
