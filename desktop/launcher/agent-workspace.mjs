import {loadingMarkup} from '../shared/loading-screen.mjs';
import {createAgentApi,taskStates,moduleLabels,scheduleCron,readableSchedule,reviewBinding,betaServerUrl} from './agent-api.mjs';
import {createResultTools} from './agent-result-tools.mjs';

const api = createAgentApi();
const $ = id => document.getElementById(id);
const make = (tag, text = '', className = '') => Object.assign(document.createElement(tag), {textContent:String(text ?? ''),className});
const array = value => Array.isArray(value) ? value : [];
const display = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const fieldLabels={id:'编号',name:'名称',filename:'文件名',fileId:'文件编号',artifactId:'结果文件编号',taskId:'任务编号',jobId:'处理任务编号',orderNo:'订单号',order_no:'订单号',platform:'平台',supplier:'供应商',date:'日期',month:'月份',period:'期间',status:'状态',state:'状态',amountCents:'金额（分）',refundCents:'退款（分）',amount:'金额（按来源单位）',moneyUnit:'金额单位',dateBasis:'日期口径',count:'数量',total:'总数',offset:'当前起始位置',nextOffset:'下一段起始位置',limit:'每段条数',message:'说明',summary:'摘要',issues:'待处理事项',operation:'操作',input:'业务参数',preview:'预演结果',action:'操作',revision:'数据修订',version:'版本',createdAt:'创建时间',updatedAt:'更新时间',sha256:'文件摘要',size:'字节数',bytes:'字节数',available:'可用',files:'文件',orders:'订单',entries:'记录',data:'明细',rows:'明细',result:'结果',sourceFingerprint:'来源摘要',attachments:'原件',before:'变更前',after:'变更后'};
const fieldLabel = key => fieldLabels[key] || key;
const when = value => {const date = new Date(value);return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN',{hour12:false});};
const pending = new Set(['waiting_input','waiting_review','unknown']);
const state = {view:'home',status:null,tasks:[],cursor:null,taskId:null,detail:null,resultSelection:null,events:[],attachments:[],inputAttachments:[],reviewKey:null,displayedBinding:null,resultRenderKey:null,eventRenderKey:null,taskEpoch:0,settingsEpoch:0,settings:null,policy:null,policyRevision:null,schedules:[],scheduleId:null,scheduleVersion:null,scheduleEnabled:true,connectionPlan:null,connectionCanConfigure:false,busy:new Set(),polling:false,connected:false};
const resultTools=createResultTools({api,getDetail:()=>state.detail,getStatus:()=>state.status,isHistorical:()=>!!state.resultSelection,makeTable:tableBlock,onRefresh:()=>pollTask(true),onDraftChange:syncActions,notice,showError,loading});

function errorMessage(error) {
  return String(error?.message || error || '本次操作未完成').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
}
function showError(error) {$('error-message').textContent=errorMessage(error);$('error-banner').hidden=false;}
function notice(text) {$('notice').textContent=text;$('notice').hidden=!text;}
function loading(target, text, variant = 'inline') {
  target.innerHTML=loadingMarkup({variant,status:text,logo:'../assets/lingtu-icon.png',brand:'五成 ERP'});
}
function readyForTasks() {return state.connected && state.status?.canCreateTasks !== false && state.status?.actor?.canCreateTasks !== false && state.status?.actor?.enabled !== false;}
function readyForSchedules() {return readyForTasks() && state.status?.actor?.role!=='viewer' && state.status?.actor?.canRunTasks===true;}
function canSupplement() {return readyForTasks() && state.taskId && !['queued','running','committing','unknown','cancelled'].includes(state.detail?.task?.status);}
function canManage() {const actor=state.status?.actor;return actor?.canManageSettings === true || actor?.role === 'admin';}
async function run(key, fn, buttons = []) {
  if(state.busy.has(key))return;
  state.busy.add(key);buttons.forEach(b=>b.disabled=true);
  try{return await fn();}catch(error){showError(error);return undefined;}
  finally{state.busy.delete(key);buttons.forEach(b=>b.disabled=false);syncActions();}
}
function syncActions() {
  $('submit-goal').disabled=!readyForTasks() || state.busy.has('create') || state.busy.has('upload');
  $('approve-result').disabled=!readyForTasks() || !$('review-check').checked || state.detail?.review?.canApprove !== true || !state.displayedBinding || state.busy.has('review') || resultTools.hasChanges();
  $('reject-result').disabled=!readyForTasks() || state.busy.has('review') || state.detail?.review?.canApprove !== true;
  $('submit-input').disabled=!canSupplement() || state.busy.has('input') || state.busy.has('upload');
}
function navigate(view, {focus=true}={}) {
  if(!['home','task','history','settings'].includes(view))return;
  if(state.view!==view&&!resultTools.leave())return;
  state.view=view;
  for(const section of document.querySelectorAll('main>.view'))section.hidden=section.id!=='view-'+view;
  for(const button of document.querySelectorAll('.main-nav [data-view]')){if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  if(focus)$('main').focus({preventScroll:true});
  window.scrollTo({top:0,behavior:'instant'});
  if(view==='home')void refreshTasks().catch(showError);
  if(view==='history')void refreshTasks().catch(showError);
  if(view==='settings')void loadSettings().catch(showError);
}
function showStatus(value) {
  state.status=value;state.connected=true;
  const actor=value.actor || {}, environment=value.environment || {};
  $('actor').textContent=actor.label || actor.name || actor.login || '身份已连接';
  $('actor').title=actor.role ? ({admin:'管理员',editor:'员工',viewer:'只读成员'}[actor.role] || actor.role) : '';
  $('environment').textContent=environment.label || (['test','beta'].includes(environment.mode) ? '测试账本' : '账本信息待确认');
  $('environment').dataset.mode=environment.mode || 'unknown';
  $('connection').textContent=value.connection?.label || '已连接公司主机';
  $('connection').dataset.state='connected';
  $('settings-access').textContent=canManage() ? '公司统一提供模型额度。密钥保存于主机，不向员工显示。' : '公司 AI 服务由管理员维护。你可以查看引擎状态和自己的定时任务。';
  syncActions();
}
async function refreshStatus() {
  try{showStatus(await api.request('status'));}
  catch(error){state.connected=false;$('connection').textContent='连接未就绪';$('connection').dataset.state='offline';syncActions();throw error;}
}

function taskRow(task) {
  const row=make('button','','task-row');row.type='button';row.dataset.taskId=task.id;
  const copy=make('span');copy.append(make('strong',task.goal || task.title || '未命名任务'),make('small',[when(task.updatedAt || task.createdAt),task.engine ? (task.engine==='hermes'?'Hermes':'Codex') : '',task.scope?.label || ''].filter(Boolean).join(' · ')));
  const badge=make('span',taskStates[task.status] || task.status || '状态待确认','state');badge.dataset.state=task.status;
  row.append(copy,badge);row.addEventListener('click',()=>void openTask(task.id));return row;
}
function fillTasks(target,tasks,empty) {target.replaceChildren(...tasks.map(taskRow));if(!tasks.length)target.append(make('p',empty,'empty'));}
function renderTasks() {
  const waiting=state.tasks.filter(task=>pending.has(task.status));
  $('pending-count').textContent=String(waiting.length);
  fillTasks($('pending-tasks'),waiting.slice(0,5),'暂时没有需要你处理的事项。');
  fillTasks($('recent-tasks'),state.tasks.slice(0,6),'还没有任务。描述目标，开始第一项工作。');
  const query=$('history-query').value.trim().toLocaleLowerCase(),filter=$('history-state').value;
  const tasks=state.tasks.filter(task=>(!query || String(task.goal || task.title || '').toLocaleLowerCase().includes(query))&&(!filter || task.status===filter));
  fillTasks($('history-tasks'),tasks,'没有找到符合条件的任务。');$('history-more').hidden=!state.cursor;
}
async function refreshTasks({more=false}={}) {
  const result=await api.request('tasks.list',{limit:100,...(more&&state.cursor?{cursor:state.cursor}:{})});
  const rows=array(result?.tasks);
  state.tasks=more ? [...new Map([...state.tasks,...rows].map(task=>[task.id,task])).values()] : rows;
  state.cursor=result?.nextCursor || null;renderTasks();
}
function fileData(file) {return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('无法读取附件：'+file.name));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});}
function renderAttachments(followup=false) {
  const field=followup?'inputAttachments':'attachments',target=followup?'input-attachments':'goal-attachments';
  $(target).replaceChildren(...state[field].map(file=>{const li=make('li');li.append(make('span',file.name || '附件'));const remove=make('button','×');remove.type='button';remove.setAttribute('aria-label','移除附件 '+file.name);remove.addEventListener('click',()=>{state[field]=state[field].filter(item=>item.id!==file.id);renderAttachments(followup);});li.append(remove);return li;}));
}
async function uploadFiles(files,followup=false) {
  const taskId=state.taskId,field=followup?'inputAttachments':'attachments',prefix=followup?'input':'goal';
  await run('upload',async()=>{
    if(state[field].length+files.length>20)throw new Error('每次最多添加 20 份资料，请分次补充。');
    for(const file of files){
      const limit=state.status?.limits?.attachmentBytes || 50*1024*1024;
      if(!file.size)throw new Error(file.name+' 是空文件，请检查后重新添加。');
      if(file.size>limit)throw new Error(file.name+' 超过当前附件大小上限 '+Math.round(limit/1024/1024)+' MB');
      loading($(prefix+'-upload-status'),'正在添加 '+file.name);
      const response=await api.request('attachments.upload',{name:file.name,type:file.type || 'application/octet-stream',bytes:await fileData(file)});
      const attachment=response.attachment || response;
      if(!attachment?.id)throw new Error('附件没有取得服务端凭据，请重新添加');
      if(followup&&taskId!==state.taskId)throw new Error('任务已切换，请在当前任务重新添加资料');
      state[field].push({...attachment,name:attachment.name || file.name});renderAttachments(followup);
    }
  });
  $(prefix+'-files').value='';$(prefix+'-upload-status').replaceChildren();
}
async function createTask(event) {
  event.preventDefault();const goal=$('goal').value.trim();if(!goal || !readyForTasks())return;
  await run('create',async()=>{
    const response=await api.request('tasks.create',{goal,attachmentIds:state.attachments.map(file=>file.id)});
    if(!response?.task?.id)throw new Error('主机未返回任务编号，请先检查任务历史，避免重复创建');
    $('goal').value='';state.attachments=[];renderAttachments();await openTask(response.task.id);void refreshTasks().catch(showError);
  },[$('submit-goal')]);
}
async function openTask(id) {
  if(!resultTools.leave())return;
  const epoch=++state.taskEpoch;state.taskId=id;state.detail=null;state.resultSelection=null;state.events=[];state.reviewKey=null;state.displayedBinding=null;state.resultRenderKey=null;state.eventRenderKey=null;state.inputAttachments=[];renderAttachments(true);$('result-history-label').hidden=true;$('historical-result-note').hidden=true;
  $('task-title').textContent='正在读取任务';$('task-scope').replaceChildren();$('task-events').replaceChildren();$('task-actions').replaceChildren();$('review-panel').hidden=true;$('task-input').value='';
  loading($('result-content'),'正在读取结果','content');loading($('task-loading'),'正在读取执行动态');navigate('task');
  try{const detail=await api.request('tasks.get',{taskId:id,afterSequence:0});if(epoch!==state.taskEpoch)return;renderDetail(detail,{replaceEvents:true});$('task-title').focus({preventScroll:true});}
  catch(error){if(epoch===state.taskEpoch){$('task-loading').replaceChildren();$('result-content').replaceChildren(make('p','暂时无法读取此任务。请刷新结果重试。','empty'));showError(error);}}
}
function eventNode(event) {
  const item=make('li');item.dataset.sequence=event.sequence ?? event.id ?? '';
  const data=event.data || event.payload || {};
  const title=event.title || data.title || ({created:'已接收目标','task.created':'已接收目标',started:'开始处理','task.running':'开始处理',progress:'执行进展','engine.message':'AI 工作记录',message:'工作记录',user_input:'补充要求','user.input':'补充要求','input.required':'需要补充信息','step.started':'正在处理业务','step.completed':'业务步骤已完成','result.updated':'结果已更新','review.required':'结果待复核','review.rejected':'结果已退回','review.invalidated':'需要重新复核','commit.verified':'提交回执已核对','commit.blocked':'提交需要处理',review:'结果待复核',completed:'处理结果','task.completed':'处理结果',paused:'已暂停','task.paused':'已暂停',failed:'执行中断','task.cancelled':'已停止任务'}[event.type] || '执行记录');
  item.append(make('strong',title));
  const message=event.message || event.text || event.question || event.goal || data.message || data.text || data.question || data.summary || (event.module ? (moduleLabels[event.module] || event.module) : '');
  if(message)item.append(make('p',message));
  const time=make('time',when(event.createdAt || event.timestamp || event.at));item.append(time);return item;
}
function renderDetail(detail,{replaceEvents=false}={}) {
  if(!detail?.task || detail.task.id!==state.taskId)return;
  state.detail=detail;
  const incoming=array(detail.events), seen=new Map((replaceEvents?[]:state.events).map(event=>[event.sequence ?? event.id,event]));
  for(const event of incoming)seen.set(event.sequence ?? event.id ?? JSON.stringify(event),event);
  state.events=[...seen.values()].sort((a,b)=>(a.sequence ?? 0)-(b.sequence ?? 0));
  const task=detail.task;$('task-title').textContent=task.goal || task.title || '任务';
  $('task-state').textContent=taskStates[task.status] || task.status;$('task-state').dataset.state=task.status;
  $('task-scope').replaceChildren(make('span',$('environment').textContent),make('span',task.engine==='hermes'?'Hermes':'Codex'));
  const scope=detail.result?.scope || task.scope;
  if(typeof scope==='string')$('task-scope').append(make('span',scope));
  else if(scope?.label)$('task-scope').append(make('span',scope.label));
  else if(scope?.modules)$('task-scope').append(make('span',array(scope.modules).map(id=>id==='system'?'公共事务':moduleLabels[id] || id).join(' · ')));
  if(scope?.period)$('task-scope').append(make('span',display(scope.period)));
  if(task.assigneeId)$('task-scope').append(make('span','当前负责人：'+(task.assigneeLabel || task.assigneeId)));
  $('task-reference').textContent='任务编号：'+task.id;
  const eventKey=JSON.stringify(state.events);
  if(eventKey!==state.eventRenderKey){$('task-events').replaceChildren(...state.events.map(eventNode));if(!state.events.length)$('task-events').append(make('li','任务记录尚未返回。'));state.eventRenderKey=eventKey;}
  $('task-loading').replaceChildren();
  if(['running','queued','committing'].includes(task.status)){
    loading($('task-loading'),task.progress?.message || taskStates[task.status]);
    const progress=$('task-loading').querySelector('progress');
    if(Number.isFinite(task.progress?.completed)&&task.progress.total>0){progress.max=task.progress.total;progress.value=Math.min(task.progress.total,task.progress.completed);}
  }
  const attention={waiting_input:'需要补充信息。填写下面的输入框后继续处理。',waiting_review:'结果已准备好，请在右侧核对差异和来源。',unknown:'提交结果暂未确定。系统需要先核对回执，避免重复提交。',paused:'任务已暂停，已有结果和执行记录保留。',cancelled:'任务已停止。已经提交的变更不会因此自动撤销。',failed:'任务尚未完成。查看执行记录，修正问题后再继续。'}[task.status];
  $('task-attention').textContent=task.attention?.message || task.question || (['paused','failed','unknown'].includes(task.status)?task.error:'') || attention || '';$('task-attention').hidden=!$('task-attention').textContent;
  $('task-input').placeholder=['running','queued'].includes(task.status)?'如需调整执行中的任务，请先暂停，再补充要求。':'补充缺失信息，或说明需要调整的地方。';
  renderTaskActions(task);renderResult(detail);syncActions();
}
function actionButton(label, handler, {primary=false,disabled=false}={}) {const button=make('button',label,primary?'primary':'');button.type='button';button.disabled=disabled;button.addEventListener('click',handler);return button;}
function renderTaskActions(task) {
  const target=$('task-actions');target.replaceChildren();
  target.append(actionButton('刷新结果',()=>void pollTask(true)));
  if(task.status==='unknown' && readyForTasks())target.append(actionButton('核对提交回执',()=>void controlTask('resume'),{disabled:state.busy.has('control')}));
  const allowed=task.allowedActions;
  const can=action=>Array.isArray(allowed)?allowed.includes(action):({pause:['running','queued'],resume:['paused','failed','waiting_input'],cancel:['running','queued','paused','waiting_input','waiting_review']}[action]||[]).includes(task.status);
  for(const [action,label] of [['pause','暂停'],['resume','继续处理'],['cancel','停止任务']])if(can(action)&&readyForTasks())target.append(actionButton(label,()=>void controlTask(action),{disabled:state.busy.has('control')}));
}
async function controlTask(action) {
  await run('control',async()=>{await api.request('tasks.control',{taskId:state.taskId,action});await pollTask(true);});
}
function tableBlock(block) {
  const wrap=make('div','','table-wrap');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',block.title || '结果明细');
  const table=make('table'),head=make('thead'),headRow=make('tr'),body=make('tbody');
  const rows=array(block.rows).map(row=>row&&typeof row==='object'&&!Array.isArray(row)?row:{value:row});
  const columns=array(block.columns).length?block.columns.map(column=>typeof column==='string'?{key:column,label:fieldLabel(column)}:column):[...new Set(rows.flatMap(row=>Object.keys(row)))].map(key=>({key,label:fieldLabel(key),wrap:true}));
  for(const column of columns){const th=make('th',column.label || column.key,column.type==='number'||column.type==='money'?'numeric':'');th.scope='col';headRow.append(th);}
  head.append(headRow);
  for(const row of rows){
    const tr=make('tr');for(const column of columns){const value=row?.[column.key];const td=make('td',display(value),column.type==='number'||column.type==='money'||typeof value==='number'?'numeric':column.wrap?'wrap':'');tr.append(td);}body.append(tr);
  }
  table.append(head,body);wrap.append(table);if(!rows.length)wrap.append(make('p','本次查询没有返回记录。','fine-print'));resultTools.enhanceTable(wrap,block,{rows,columns});return wrap;
}
function structuredValue(value,depth=0) {
  if(value==null || typeof value!=='object')return make('span',display(value));
  if(depth>6)return make('pre',JSON.stringify(value,null,2));
  if(Array.isArray(value)){
    if(value.every(row=>row&&typeof row==='object'&&!Array.isArray(row)))return tableBlock({rows:value});
    const list=make('ul');for(const item of value){const row=make('li');row.append(structuredValue(item,depth+1));list.append(row);}return list;
  }
  const list=make('dl','','structured-result');
  for(const [key,item]of Object.entries(value)){
    if(key==='downloadUrl')continue;
    const term=make('dt',fieldLabel(key)),description=make('dd');
    if(item&&typeof item==='object'){const details=make('details','','record-details');details.append(make('summary',Array.isArray(item)?`${item.length} 条记录`:'展开查看'),structuredValue(item,depth+1));description.append(details);}else description.append(make('span',display(item)));
    list.append(term,description);
  }
  if(value.artifactId){const description=make('dd');description.append(filesBlock([{...value,id:value.artifactId,name:value.name||value.filename}]));list.append(make('dt','结果文件'),description);}
  return list;
}
function filesBlock(files) {
  const list=make('ul','','file-list');
  for(const file of array(files)){const li=make('li'),copy=make('span',file.name || file.title || '结果文件');li.append(copy);const artifactId=file.artifactId || (file.taskId===state.taskId?file.id:null);if(artifactId)li.append(resultTools.fileActions(artifactId,file));else li.append(make('small','暂未生成可用文件'));list.append(li);}
  return list;
}
async function openArtifact(artifactId) {await run('artifact:'+artifactId,async()=>{const result=await api.request('artifacts.open',{taskId:state.taskId,id:artifactId});if(result?.message)notice(result.message);});}
function renderResultHistory(detail) {
  const select=$('result-history'),selection=state.resultSelection?JSON.stringify(state.resultSelection):'';
  const options=[Object.assign(make('option','当前结果'),{value:''}),...array(detail.resultVersions).map(result=>Object.assign(make('option',`版本 ${result.version} · ${when(result.createdAt)}${result.summary?' · '+result.summary:''}`),{value:JSON.stringify({resultId:result.id,resultVersion:result.version})}))];
  if(JSON.stringify([...select.options].map(option=>[option.value,option.textContent]))!==JSON.stringify(options.map(option=>[option.value,option.textContent])))select.replaceChildren(...options);
  select.value=selection;$('result-history-label').hidden=options.length<2;$('historical-result-note').hidden=!state.resultSelection;
}
function renderResult(detail) {
  renderResultHistory(detail);
  const target=$('result-content'),result=detail.result,key=JSON.stringify({result,status:detail.task?.status,completedStages:detail.task?.completedStages,selection:state.resultSelection,actor:{role:state.status?.actor?.role,canRunTasks:state.status?.actor?.canRunTasks,modules:state.status?.actor?.modules},capabilities:state.status?.capabilities});
  if(state.resultRenderKey===key){renderReview(detail);return;}
  resultTools.renderStart(detail);state.resultRenderKey=key;target.replaceChildren();$('result-version').textContent=result?.version!=null?'版本 '+result.version:'';
  if(!result){target.append(make('p','结果准备好后，会在这里展示明细、来源和变更。','empty'));renderReview(detail);return;}
  if(result.summary)target.append(make('p',result.summary,'result-summary'));
  for(const block of array(result.blocks)){
    const section=make('section','','result-block');if(block.title)section.append(make('h3',block.title));
    if(block.type==='table')section.append(tableBlock(block));
    else if(block.type==='chart')section.append(resultTools.chartBlock(block));
    else if(block.type==='metrics'){
      const metrics=make('div','','metrics');for(const metric of array(block.items || block.metrics)){const item=make('div','','metric');item.append(make('small',metric.label || metric.title),make('strong',display(metric.value)),make('small',metric.unit || metric.note || ''));metrics.append(item);}section.append(metrics);
    }else if(block.type==='files')section.append(filesBlock(block.files || block.items));
    else if(['file','download'].includes(block.type)){
      if(block.artifactId)section.append(filesBlock([{...block,id:block.artifactId,name:block.name||block.filename}]));
      else section.append(make('p',block.name || block.filename || '业务原件'),make('p','此文件尚未登记为可下载的任务结果，请补充要求让 AI 整理可下载原件。','fine-print'));
      if(block.sha256)section.append(make('p','文件摘要：'+block.sha256,'fine-print'));
    }else if(block.type==='json')section.append(structuredValue(block.data));
    else if(block.type==='job')section.append(structuredValue(Object.fromEntries(Object.entries(block).filter(([key])=>!['type','title'].includes(key)))));
    else if(['text',undefined].includes(block.type))section.append(make('p',block.text || block.content || block.message || '','result-text'));
    else section.append(structuredValue(block));
    target.append(section);
  }
  if(array(result.changes).length){const section=make('section','','result-block');section.append(make('h3','本次变更'));const compared=result.changes.filter(change=>change&&typeof change==='object'&&(Object.hasOwn(change,'before')||Object.hasOwn(change,'after'))),other=result.changes.filter(change=>!compared.includes(change));
    if(compared.length)section.append(tableBlock({title:'变更前后',columns:[{key:'label',label:'项目',wrap:true},{key:'before',label:'变更前',wrap:true},{key:'after',label:'变更后',wrap:true}],rows:compared.map(change=>({label:change.label || change.title || change.field || ({assignment:'任务负责人'+(change.taskId?' · '+change.taskId:''),schedule:'定时任务',permissions:'人员权限'}[change.kind]) || change.operation || '变更',before:change.before,after:change.after}))}));
    for(const change of other)section.append(structuredValue(change));target.append(section);}
  if(array(result.issues).length){const issues=make('section','','result-issues');issues.append(make('h3','异常与需要关注的事项'));const list=make('ul');for(const issue of result.issues){const resolved=issue?.resolved===true,item=make('li',(resolved?'已解决 · ':'')+(typeof issue==='string'?issue:issue.message || issue.summary || issue.code),resolved?'issue-resolved':'');list.append(item);}issues.append(list);target.append(issues);}
  if(array(result.evidence).length){const section=make('section','','result-block');section.append(make('h3','来源与原件'));const list=make('ul','','evidence-list');for(const source of result.evidence){const li=make('li'),copy=make('div');copy.append(make('span',source.label || source.title || source.name || source.filename || '业务来源'));if(source.note || source.period)copy.append(make('small',source.note || source.period));const details=make('details','','record-details');details.append(make('summary','查看来源、单位与范围'),structuredValue(source));copy.append(details);li.append(copy);if(source.artifactId)li.append(resultTools.fileActions(source.artifactId,source));list.append(li);}section.append(list);target.append(section);}
  if(result.receipt){const receipt=make('section','','receipt'),verified=result.receipt.verified===true||result.receipt.state==='verified';receipt.append(make('h3',verified?'提交结果已核对':result.receipt.state==='partial'?'部分提交已核对':'提交回执'));receipt.append(make('p',result.receipt.message || result.receipt.summary || '已保存业务回执。'));if(result.receipt.id)receipt.append(make('p','回执编号：'+result.receipt.id));if(result.receipt.verified===false||['unknown','partial'].includes(result.receipt.state))receipt.append(make('p','其余业务结果仍需核对，当前不能视为全部提交完成。'));if(array(result.receipt.receipts).length){const records=make('details','','record-details');records.append(make('summary','查看 '+result.receipt.receipts.length+' 项业务回执'),make('pre',JSON.stringify(result.receipt.receipts,null,2)));receipt.append(records);}target.append(receipt);}
  renderReview(detail);
}
function renderReview(detail) {
  const binding=state.resultSelection?null:reviewBinding(detail),key=binding?JSON.stringify(binding):null,changed=state.reviewKey && key && state.reviewKey!==key;
  if(key!==state.reviewKey)$('review-check').checked=false;
  if(changed)notice('结果或账本版本已变化，请重新核对当前结果。');
  state.reviewKey=key;state.displayedBinding=binding;
  $('review-panel').hidden=!detail.review || !binding || detail.task.status!=='waiting_review';
  $('review-description').textContent=detail.review?.canApprove===true ? (detail.review.description || `确认后，将按结果版本 ${detail.review.resultVersion} 提交列出的变更，并核对实际回执。`) : (detail.review?.reason || '此结果需要具备相应权限的人员复核。');
  $('review-check').disabled=!readyForTasks() || detail.review?.canApprove!==true;
  syncActions();
}
async function review(decision) {
  if(!readyForTasks() || !state.displayedBinding || state.detail?.review?.canApprove!==true || decision==='approve'&&(!$('review-check').checked||resultTools.hasChanges()))return;
  const binding={...state.displayedBinding};
  $('review-check').checked=false;
  await run('review',async()=>{try{await api.request('reviews.'+decision,binding);}catch(error){await pollTask(true);throw error;}$('review-check').checked=false;await pollTask(true);void refreshTasks().catch(showError);},[$('approve-result'),$('reject-result')]);
}
async function pollTask(force=false) {
  if(!state.taskId || state.polling || (!force && (state.view!=='task' || document.hidden)))return;
  state.polling=true;const id=state.taskId,epoch=state.taskEpoch;
  try{const sequence=state.events.reduce((max,event)=>Math.max(max,Number(event.sequence)||0),0);const detail=await api.request('tasks.get',{taskId:id,afterSequence:sequence,...state.resultSelection});if(id===state.taskId && epoch===state.taskEpoch)renderDetail(detail);}
  catch(error){showError(error);}finally{state.polling=false;}
}
async function supplement(event) {
  event.preventDefault();const text=$('task-input').value.trim() || (state.inputAttachments.length?'补充资料：'+state.inputAttachments.map(file=>file.name).join('、'):'');if(!text || !canSupplement())return;
  await run('input',async()=>{await api.request('tasks.input',{taskId:state.taskId,text,attachmentIds:state.inputAttachments.map(file=>file.id)});$('task-input').value='';state.inputAttachments=[];state.resultSelection=null;renderAttachments(true);await pollTask(true);},[$('submit-input')]);
}

function setFormEnabled(form, enabled) {for(const input of form.querySelectorAll('input,select,textarea,button'))input.disabled=!enabled;}
async function loadSettings() {
  const epoch=++state.settingsEpoch;
  const results=await Promise.allSettled([api.request('settings.get'),api.request('schedules.list'),api.request('permissions.get'),api.request('connection.get'),refreshStatus()]);
  if(epoch!==state.settingsEpoch)return;
  const [models,schedules,permissions,connection]=results;
  if(results[4].status==='rejected')showError(results[4].reason);
  if(models.status==='fulfilled')renderSettings(models.value.settings || models.value);else {$('settings-access').textContent=errorMessage(models.reason);setFormEnabled($('model-form'),false);}
  if(schedules.status==='fulfilled'){state.schedules=array(schedules.value.schedules);renderSchedules();}else $('schedule-list').replaceChildren(make('p',errorMessage(schedules.reason),'empty'));
  if(permissions.status==='fulfilled')renderPermissions(permissions.value);else {$('member-rows').replaceChildren(make('p',errorMessage(permissions.reason),'empty'));setFormEnabled($('permissions-form'),false);$('add-member').disabled=true;}
  if(connection.status==='fulfilled')renderConnection(connection.value);else {$('connection-detail').textContent=errorMessage(connection.reason);setFormEnabled($('connection-form'),false);}
}
function engineCatalog() {
  const source=state.status?.engines || {};
  return Array.isArray(source)?Object.fromEntries(source.map(engine=>[engine.id,engine])):source;
}
function renderModelChoice(value=$('company-model').value) {
  const engine=$('default-engine').value,models=engineCatalog()[engine]?.supportedModels;
  const restricted=engine==='codex' || Array.isArray(models),field=make(restricted?'select':'input');
  field.id='company-model';field.required=true;field.setAttribute('aria-describedby','company-model-hint');
  if(restricted){
    field.append(Object.assign(make('option','请选择公司服务提供的兼容模型'),{value:''}));
    for(const model of array(models))field.append(Object.assign(make('option',model),{value:model}));
    if(value && !array(models).includes(value))field.append(Object.assign(make('option',value+'（当前引擎不兼容）'),{value,disabled:true}));
    $('company-model-hint').textContent=!array(models).length?'尚未取得该引擎的兼容模型清单，请刷新设置后再保存。':value&&!models.includes(value)?'当前公司模型不兼容此引擎，请明确选择替代模型。已有配置不会自动更换。':'这里只列出当前引擎支持的模型；还需确认公司 API 已开通所选模型。';
  }else{field.autocomplete='off';field.maxLength=200;field.placeholder='公司 API 提供的模型名称';$('company-model-hint').textContent='Hermes 使用公司 API 提供的模型名称。此配置由两个引擎共用，切换到 Codex 时需要重新核对兼容清单。';}
  field.value=value;field.disabled=!canManage();$('company-model').replaceWith(field);
}
function validateEngineModel(engine,model) {
  const models=engineCatalog()[engine]?.supportedModels;
  if((engine==='codex' || Array.isArray(models)) && !array(models).includes(model))throw new Error('请选择该引擎兼容清单中的公司模型；如清单尚未载入，请刷新设置。');
}
function renderSettings(settings) {
  state.settings=settings;$('default-engine').value=settings.defaultEngine || 'codex';
  const company=settings.company || {};renderModelChoice(company.model || '');$('company-base-url').value=company.baseUrl || '';$('company-budget').value=company.budgetLimit ?? '';$('company-api-key').value='';$('company-budget-notice').textContent=settings.budgetNotice || '';
  $('company-key-state').textContent=company.hasKey?'公司密钥已配置。留空可保留现有密钥。':'尚未配置公司密钥。个人 AI 工具的登录资料不会自动复制到这里。';
  const engines=engineCatalog();
  $('engine-status').replaceChildren(...Object.entries(engines).map(([id,engine])=>{const configured=company.hasKey===true;const item=make('span',`${id==='hermes'?'Hermes':'Codex'} · ${engine.available?(configured?'已配置':'待配置公司服务'):'未就绪'}${engine.version?' · '+engine.version:''}`,'engine-item');item.dataset.ready=String(engine.available===true&&configured);return item;}));
  setFormEnabled($('model-form'),canManage());
}
async function saveModel(event) {
  event.preventDefault();if(!canManage())return;
  const company={baseUrl:$('company-base-url').value.trim(),model:$('company-model').value.trim(),budgetLimit:$('company-budget').value===''?0:Number($('company-budget').value)};
  const key=$('company-api-key').value.trim();if(key)company.apiKey=key;
  try{await run('settings',async()=>{validateEngineModel($('default-engine').value,company.model);const response=await api.request('settings.save',{defaultEngine:$('default-engine').value,company,...(state.settings?.version!=null?{version:state.settings.version}:{})});renderSettings(response.settings || response);notice('公司 AI 配置已保存。');},[$('save-model')]);}
  finally{$('company-api-key').value='';}
}
function memberRow(login='',member={role:'viewer',modules:[],enabled:true,canRunTasks:false}) {
  const row=make('article','','member-card'),main=make('div','','member-main');
  const loginLabel=make('label','员工登录身份'),input=make('input');input.value=login;input.placeholder='员工的 Tailscale 登录账号';input.autocomplete='off';input.maxLength=254;input.dataset.memberField='login';input.required=true;loginLabel.append(input);
  const roleLabel=make('label','职责'),role=make('select');role.dataset.memberField='role';for(const [value,label]of [['viewer','只读成员'],['editor','业务员工'],['admin','管理员']]){const option=make('option',label);option.value=value;role.append(option);}role.value=member.role;roleLabel.append(role);
  const enabledLabel=make('label','','check'),enabled=make('input');enabled.type='checkbox';enabled.checked=member.enabled===true;enabled.dataset.memberField='enabled';enabledLabel.append(enabled,make('span','启用成员'));main.append(loginLabel,roleLabel,enabledLabel);row.append(main);
  const modules=make('div','','member-modules');for(const [id,label]of Object.entries(moduleLabels)){const field=make('label','','check'),checkbox=make('input');checkbox.type='checkbox';checkbox.value=id;checkbox.checked=array(member.modules).includes(id);checkbox.dataset.memberField='module';field.append(checkbox,make('span',label));modules.append(field);}row.append(modules);
  const actions=make('div','','member-task actions'),taskLabel=make('label','','check'),tasks=make('input');tasks.type='checkbox';tasks.checked=member.canRunTasks===true;tasks.dataset.memberField='canRunTasks';taskLabel.append(tasks,make('span','允许执行业务操作（查询无需开启）'));actions.append(taskLabel);actions.append(actionButton('移除此成员',()=>row.remove()));actions.lastChild.className='member-remove';row.append(actions);return row;
}
function renderPermissions(response) {
  const policy=response.policy || response;state.policy=policy;state.policyRevision=response.revision ?? null;
  $('member-rows').replaceChildren(...Object.entries(policy.users || {}).map(([login,member])=>memberRow(login,member)));
  if(!Object.keys(policy.users || {}).length)$('member-rows').append(make('p','尚未配置员工。添加成员后设置可访问的业务范围。','empty'));
  setFormEnabled($('permissions-form'),canManage());$('add-member').disabled=!canManage();
}
async function savePermissions(event) {
  event.preventDefault();if(!canManage())return;
  await run('permissions',async()=>{
    const users=Object.create(null);
    for(const row of $('member-rows').querySelectorAll('.member-card')){const field=key=>row.querySelector(`[data-member-field="${key}"]`),login=field('login').value.trim().toLowerCase();if(!login || /\s|,/.test(login))throw new Error('请填写有效的员工登录身份');if(Object.hasOwn(users,login))throw new Error('员工登录身份重复：'+login);users[login]={role:field('role').value,enabled:field('enabled').checked,canRunTasks:field('canRunTasks').checked,modules:[...row.querySelectorAll('[data-member-field="module"]:checked')].map(input=>input.value)};}
    const response=await api.request('permissions.save',{policy:{schemaVersion:1,users},revision:state.policyRevision});renderPermissions(response.policy?response:{policy:{schemaVersion:1,users},revision:response.revision});notice('人员权限已保存。');
  },[$('save-members')]);
}
function renderConnection(response) {
  const connection=response.connection || response;$('connection-mode').value=connection.mode || 'standalone';$('connection-provider').value=connection.networkProvider || 'embedded';$('connection-url').value=connection.serverUrl || '';
  $('connection-detail').textContent=connection.detail || connection.label || '员工连接公司主机后，使用同一任务与权限服务。';
  state.connectionCanConfigure=canManage() || connection.canConfigure===true;clearConnectionPlan();connectionVisibility();syncConnectionControls();
}
function clearConnectionPlan() {state.connectionPlan=null;$('connection-review').hidden=true;}
function syncConnectionControls() {const enabled=state.connectionCanConfigure && !state.busy.has('connection');setFormEnabled($('connection-form'),enabled);$('confirm-connection').disabled=!enabled || !state.connectionPlan;}
function connectionVisibility() {const mode=$('connection-mode').value;$('connection-url').required=mode==='client';$('connection-url').closest('label').hidden=mode!=='client';$('connection-provider').closest('label').hidden=mode!=='client';$('save-connection').textContent=mode==='server'?'查看连接变更':'保存连接';$('private-network-tools').hidden=mode!=='client'||$('connection-provider').value!=='embedded'||typeof window.launcher?.networkLogin!=='function';}
function connectionInput() {const mode=$('connection-mode').value;return {mode,networkProvider:$('connection-provider').value,serverUrl:mode==='client'?betaServerUrl($('connection-url').value):''};}
async function connectionAction(action) {if(state.busy.has('connection'))return;$('error-banner').hidden=true;notice('');await run('connection',async()=>{syncConnectionControls();await action();});syncConnectionControls();}
async function prepareConnection(form, renewed=false) {
  clearConnectionPlan();const proposal=await api.request('connection.plan',form);
  if(JSON.stringify(form)!==JSON.stringify(connectionInput()))return;
  if(typeof proposal.token!=='string' || !proposal.token || !Array.isArray(proposal.difference?.add) || !Array.isArray(proposal.difference?.preserve) || proposal.difference.funnel!==false)throw new Error('无法核实本次连接变更，请检查公司主机后重试。');
  state.connectionPlan={token:proposal.token,form,createdAt:Date.now()};
  const difference=proposal.difference,body=$('connection-difference');body.replaceChildren();
  body.append(make('h3',difference.add.length?'将新增':'测试版入口'));
  if(difference.add.length){const list=make('ul');for(const entry of difference.add){const port=/^HTTPS\s+(\d+)\s*→\s*http:\/\/127\.0\.0\.1:\d+$/.exec(String(entry));list.append(make('li',port?'公司私网测试版入口：HTTPS '+port[1]:entry));}body.append(list);}
  else body.append(make('p','测试版入口已存在，本次将切换为公司主机模式。'));
  if(difference.preserve.length){body.append(make('h3','现有入口继续保留'));const list=make('ul');for(const entry of difference.preserve)list.append(make('li',entry));body.append(list);}
  body.append(make('p','访问范围：仅公司私网，不对公网开放。'));
  if(proposal.backup)body.append(make('p','变更前的连接配置已保存。','fine-print'));
  $('connection-review-note').textContent=renewed?'连接方案已更新，请重新核对后确认。':'请核对以下变更，确认后启用这台公司主机。';
  $('connection-review').hidden=false;$('connection-review-title').focus({preventScroll:true});$('connection-review').scrollIntoView({block:'nearest'});
}
async function persistConnection(form) {
  const response=await api.request('connection.save',form);renderConnection(response);
  notice('连接配置已保存。');await refreshStatus();
}
async function saveConnection(event) {
  event.preventDefault();await connectionAction(async()=>{const form=connectionInput();if(form.mode==='server')await prepareConnection(form);else{clearConnectionPlan();await persistConnection(form);}});
}
async function confirmConnection() {
  await connectionAction(async()=>{
    const proposal=state.connectionPlan;if(!proposal)return;
    if(Date.now()-proposal.createdAt>=290000){await prepareConnection(proposal.form,true);return;}
    try{await persistConnection({...proposal.form,networkToken:proposal.token});}
    catch(error){clearConnectionPlan();if(/请先审查本次私网配置差异|网络配置已变化，请重新审查/.test(errorMessage(error)) || ['NETWORK_PLAN_EXPIRED','NETWORK_PLAN_CHANGED'].includes(error.code)){await prepareConnection(proposal.form,true);return;}throw error;}
  });
}
function showNetworkStatus(result) {
  const labels={'needs-login':'需要登录私网','needs-approval':'设备正在等待管理员批准','logged-out':'已退出私网',starting:'正在连接私网',stopped:'私网已停止',running:'私网已运行',error:'连接未完成',unavailable:'私网组件尚未就绪'};
  $('private-network-state').textContent=result.loginOpened?'已打开官方登录页。完成验证后，点击“登录后重新连接”。':result.connected?'公司私网已连接':result.message || labels[result.state] || '暂未返回连接状态';
}
async function networkAction(action) {
  await connectionAction(async()=>{
    const method={login:'networkLogin',connect:'networkConnect',status:'networkStatus',logout:'networkLogout'}[action],invoke=window.launcher?.[method];
    if(typeof invoke!=='function')throw new Error('当前终端不支持此私网操作');
    const form=connectionInput();if(form.mode!=='client'||form.networkProvider!=='embedded')throw new Error('请选择员工客户端和内置私网连接');
    const result=await invoke(...(['login','connect'].includes(action)?[form]:[]));showNetworkStatus(result||{});
    if(action==='connect' || action==='logout')await refreshStatus().catch(showError);
  });
}
async function diagnosticAction(action) {
  const methods={read:'readLogs',copy:'copyLogs',export:'exportLogs'},button=$({read:'read-diagnostics',copy:'copy-diagnostics',export:'export-diagnostics'}[action]);
  await run('diagnostics',async()=>{const invoke=window.launcher?.[methods[action]];if(typeof invoke!=='function')throw new Error('当前终端不支持主机诊断');const result=await invoke();if(action==='read')$('diagnostic-output').textContent=array(result.entries).map(entry=>'['+(entry.source||'主机')+'] '+(entry.text||entry.message||'')).join('\n') || '本次未返回日志记录。';else if(action==='copy' && result.copied!=null)notice('已复制 '+result.copied+' 条日志。');else if(action==='export' && result.exported===true)notice('诊断报告已导出：'+(result.filename||''));},[button]);
}
function renderSchedules() {
  $('schedule-list').replaceChildren(...state.schedules.map(schedule=>{
    const row=make('article','','schedule-row');row.append(make('h3',schedule.goal || '定时任务'),make('p',`${schedule.enabled===false?'已暂停':'已启用'} · ${schedule.timezone || '时区待确认'} · ${readableSchedule(schedule.cron).label}`));
    if(schedule.nextRunAt)row.append(make('p','下次执行：'+when(schedule.nextRunAt)));
    if(schedule.blockedReason)row.append(make('p',({permission_revoked:'创建者权限已撤销，已保留计划',previous_run_pending:'上一次任务尚未结束，等待处理',run_failed:'运行未完成，请查看任务记录'}[schedule.blockedReason]||'计划暂未执行，请检查任务记录')));
    if(schedule.lastRun?.taskId || schedule.lastTaskId || schedule.runs?.[0]?.taskId)row.append(actionButton('查看最近结果',()=>void openTask(schedule.lastRun?.taskId || schedule.lastTaskId || schedule.runs[0].taskId)));
    if(array(schedule.runs).length){const history=make('details','','record-details');history.append(make('summary','运行记录（'+schedule.runs.length+'）'));for(const run of schedule.runs){const entry=make('p',when(run.occurrence)+' · '+(taskStates[run.state] || {skipped:'已跳过'}[run.state] || run.state));if(run.taskId)entry.append(actionButton('查看任务',()=>void openTask(run.taskId)));history.append(entry);}row.append(history);}
    const actions=make('div','','actions'),disabled=!readyForSchedules();actions.append(actionButton('修改',()=>editSchedule(schedule),{disabled}),actionButton(schedule.enabled===false?'启用':'暂停',()=>void updateSchedule(schedule),{disabled}),actionButton('删除',()=>void deleteSchedule(schedule),{disabled}));row.append(actions);return row;
  }));
  if(!state.schedules.length)$('schedule-list').append(make('p','还没有定时任务。每次执行都会保存记录和结果。','empty'));
  $('new-schedule').disabled=!readyForSchedules();
}
function editSchedule(schedule=null) {
  if(!readyForSchedules())return;
  state.scheduleId=schedule?.id || null;state.scheduleVersion=schedule?.version;state.scheduleEnabled=schedule?.enabled!==false;$('schedule-form').hidden=false;$('schedule-form-title').textContent=schedule?'修改定时任务':'新建定时任务';
  $('schedule-goal').value=schedule?.goal || '';$('schedule-engine').value=schedule?.engine || state.settings?.defaultEngine || 'codex';
  const timezone=schedule?.timezone || 'Asia/Shanghai';if(![...$('schedule-timezone').options].some(option=>option.value===timezone))$('schedule-timezone').append(Object.assign(make('option',timezone),{value:timezone}));$('schedule-timezone').value=timezone;
  const rule=readableSchedule(schedule?.cron || '0 9 * * *');$('schedule-frequency').value=rule.frequency;$('schedule-time').value=rule.time;$('schedule-cron').value=schedule?.cron || '';$('schedule-misfire').value=schedule?.misfirePolicy || 'once';scheduleVisibility();$('schedule-goal').focus();
}
function scheduleVisibility() {const custom=$('schedule-frequency').value==='custom';$('schedule-cron-label').hidden=!custom;$('schedule-time-label').hidden=custom;$('schedule-cron').required=custom;}
async function saveSchedule(event) {
  event.preventDefault();if(!readyForSchedules())return;await run('schedule',async()=>{
    const goal=$('schedule-goal').value.trim();if(!goal)throw new Error('请描述定时任务要完成的工作');
    validateEngineModel($('schedule-engine').value,state.settings?.company?.model);
    const payload={goal,engine:$('schedule-engine').value,timezone:$('schedule-timezone').value,cron:scheduleCron($('schedule-frequency').value,$('schedule-time').value,$('schedule-cron').value),misfirePolicy:$('schedule-misfire').value,noOverlap:true,enabled:state.scheduleEnabled,...(state.scheduleId?{id:state.scheduleId,version:state.scheduleVersion}:{})};
    await api.request(state.scheduleId?'schedules.update':'schedules.create',payload);$('schedule-form').hidden=true;state.scheduleId=null;state.schedules=array((await api.request('schedules.list')).schedules);renderSchedules();notice('定时任务已保存。');
  },[$('save-schedule')]);
}
async function updateSchedule(schedule) {if(!readyForSchedules())return;await run('schedule:'+schedule.id,async()=>{await api.request('schedules.update',{id:schedule.id,version:schedule.version,enabled:schedule.enabled===false});state.schedules=array((await api.request('schedules.list')).schedules);renderSchedules();});}
async function deleteSchedule(schedule) {
  if(!readyForSchedules() || !window.confirm('删除此定时计划？已有任务和结果仍会保留。\n\n'+schedule.goal))return;
  await run('schedule:'+schedule.id,async()=>{await api.request('schedules.delete',{id:schedule.id,version:schedule.version});state.schedules=array((await api.request('schedules.list')).schedules);renderSchedules();});
}

for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>navigate(button.dataset.view));
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();navigate('home');});
for(const button of document.querySelectorAll('[data-example]'))button.addEventListener('click',()=>{$('goal').value=button.dataset.example;$('goal').focus();});
$('dismiss-error').addEventListener('click',()=>{$('error-banner').hidden=true;});
$('goal-form').addEventListener('submit',createTask);$('goal-files').addEventListener('change',()=>void uploadFiles([...$('goal-files').files]));
$('input-files').addEventListener('change',()=>void uploadFiles([...$('input-files').files],true));
for(const [input,form] of [['goal','goal-form'],['task-input','input-form']])$(input).addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$(form).requestSubmit();}});
$('task-back').addEventListener('click',()=>navigate('history'));$('input-form').addEventListener('submit',supplement);
$('result-history').addEventListener('change',()=>{if(!resultTools.leave()){$('result-history').value=state.resultSelection?JSON.stringify(state.resultSelection):'';return;}state.resultSelection=$('result-history').value?JSON.parse($('result-history').value):null;state.taskEpoch++;state.displayedBinding=null;state.resultRenderKey=null;$('review-check').checked=false;$('review-panel').hidden=true;syncActions();void pollTask(true);});
$('review-check').addEventListener('change',syncActions);$('approve-result').addEventListener('click',()=>void review('approve'));$('reject-result').addEventListener('click',()=>void review('reject'));
$('history-query').addEventListener('input',renderTasks);$('history-state').addEventListener('change',renderTasks);$('refresh-history').addEventListener('click',()=>void run('history',()=>refreshTasks(),[$('refresh-history')]));$('history-more').addEventListener('click',()=>void run('history',()=>refreshTasks({more:true}),[$('history-more')]));
$('refresh-settings').addEventListener('click',()=>void run('refresh-settings',()=>loadSettings(),[$('refresh-settings')]));$('model-form').addEventListener('submit',saveModel);
$('default-engine').addEventListener('change',()=>renderModelChoice());
$('permissions-form').addEventListener('submit',savePermissions);$('add-member').addEventListener('click',()=>{$('member-rows').querySelector('.empty')?.remove();const row=memberRow();$('member-rows').append(row);row.querySelector('input').focus();});
for(const id of ['connection-mode','connection-provider','connection-url'])$(id).addEventListener('input',()=>{clearConnectionPlan();connectionVisibility();});
$('connection-mode').addEventListener('change',()=>{clearConnectionPlan();connectionVisibility();});$('connection-form').addEventListener('submit',saveConnection);$('confirm-connection').addEventListener('click',()=>void confirmConnection());$('cancel-connection').addEventListener('click',()=>{clearConnectionPlan();$('save-connection').focus();});$('check-connection').addEventListener('click',()=>void run('connection-check',async()=>{const result=await api.request('connection.check');$('connection-detail').textContent=result.detail || result.message || result.label || '连接检查已完成';await refreshStatus();},[$('check-connection')]));
for(const action of ['login','connect','status','logout'])$('network-'+action).addEventListener('click',()=>void networkAction(action));
$('local-diagnostics').hidden=typeof window.launcher?.readLogs!=='function';for(const action of ['read','copy','export'])$({read:'read-diagnostics',copy:'copy-diagnostics',export:'export-diagnostics'}[action]).addEventListener('click',()=>void diagnosticAction(action));
$('new-schedule').addEventListener('click',()=>editSchedule());$('cancel-schedule').addEventListener('click',()=>{$('schedule-form').hidden=true;state.scheduleId=null;});$('schedule-frequency').addEventListener('change',scheduleVisibility);$('schedule-form').addEventListener('submit',saveSchedule);
window.addEventListener('unhandledrejection',event=>showError(event.reason));
const taskPoll=setInterval(()=>void pollTask(),2000);
const listPoll=setInterval(()=>{if(!document.hidden && ['home','history'].includes(state.view))void refreshTasks().catch(showError);},15000);
window.addEventListener('beforeunload',event=>{if(resultTools.hasChanges()){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{clearInterval(taskPoll);clearInterval(listPoll);resultTools.dispose();});
await run('initialize',async()=>{await refreshStatus();await refreshTasks();});
await window.launcher?.ready?.().catch(showError);
