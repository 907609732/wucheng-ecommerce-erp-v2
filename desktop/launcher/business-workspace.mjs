import {loadingMarkup} from '../shared/loading-screen.mjs';
import {createBusinessWorkspace} from './business-ui.mjs';

const api=window.launcher,$=id=>document.getElementById(id),array=value=>Array.isArray(value)?value:[];
const node=(tag,text='',className='')=>Object.assign(document.createElement(tag),{textContent:String(text??''),className});
const labels={overview:'经营',purchase:'采购',sales:'销售',warehouse:'云仓',exporter:'订单导出',system:'公共业务'};
const state={view:'business',navigationEpoch:0,busy:new Set(),connectionPlan:null,review:null,reviewEpoch:0,reviewBusy:false,connectionEpoch:0};
const display=value=>value==null?'—':typeof value==='object'?JSON.stringify(value,null,2):String(value);
const when=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{hour12:false});};
function errorMessage(error){return String(error?.message||error||'本次操作未完成').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}
function showError(error){$('error-message').textContent=errorMessage(error);$('error-banner').hidden=false;}
function notice(text){$('notice').textContent=text;$('notice').hidden=!text;}
function loading(target,status,variant='inline'){target.innerHTML=loadingMarkup({variant,status,logo:'../assets/lingtu-icon.png',brand:'五成 ERP'});}
function checked(result){if(result?.ok===false)throw Object.assign(Error(result.error||'本次请求未完成'),{code:result.code});return result;}
async function run(key,action,buttons=[]){if(state.busy.has(key))return;state.busy.add(key);buttons.forEach(button=>button.disabled=true);try{return await action();}catch(error){showError(error);}finally{state.busy.delete(key);buttons.forEach(button=>button.disabled=false);}}
const business=createBusinessWorkspace({launcher:api,loading,showError,notice,onNavigate:navigate});
async function navigate(view,{desk,focus=true}={}){
  if(!['business','settings'].includes(view))return;const mine=++state.navigationEpoch;
  if($('business-review-dialog').open)$('business-review-dialog').close();
  if(view!=='business')await business.leave();if(mine!==state.navigationEpoch)return;
  state.view=view;document.body.classList.toggle('business-mode',view==='business');
  for(const section of document.querySelectorAll('main>.view'))section.hidden=section.id!=='view-'+view;
  for(const button of document.querySelectorAll('.main-nav [data-view]')){if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  if(focus)$('main').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});
  if(view==='settings')await loadSettings();else await business.show(desk?{id:desk.id,route:desk.route}:{});
}
async function refreshStatus(){
  try{const value=checked(await api.businessStatus());$('actor').textContent=value.actor?.label||value.actor?.login||'身份已连接';$('environment').textContent=value.environment?.label||'账本信息待确认';$('connection').textContent=value.connection?.label||'正在确认连接';$('connection').dataset.state=['connected','local','server'].includes(value.connection?.state)?'connected':value.ready?'connected':'offline';return value;}
  catch(error){$('connection').textContent='连接未就绪';$('connection').dataset.state='offline';throw error;}
}
function connectionVisibility(){const mode=$('connection-mode').value;$('connection-url-label').hidden=mode!=='client';$('connection-provider-label').hidden=mode!=='client';$('connection-url').required=mode==='client';$('save-connection').textContent=mode==='server'?'查看连接变更':'保存连接';$('private-network-tools').hidden=mode!=='client'||$('connection-provider').value!=='embedded'||typeof api.networkLogin!=='function';}
function clearConnectionPlan(){state.connectionPlan=null;$('connection-review').hidden=true;}
function connectionInput(){const mode=$('connection-mode').value;return {mode,networkProvider:$('connection-provider').value,serverUrl:mode==='client'?$('connection-url').value.trim():''};}
function renderConnection(response){const value=response.connection||response;$('connection-mode').value=value.mode||'standalone';$('connection-provider').value=value.networkProvider||'embedded';$('connection-url').value=value.serverUrl||'';$('connection-detail').textContent=value.detail||value.label||(value.mode==='standalone'?'使用本机账本。':'连接公司主机，使用共享业务数据。');clearConnectionPlan();connectionVisibility();}
async function loadSettings(){
  const mine=++state.connectionEpoch;const results=await Promise.allSettled([api.connection(),api.integrationConfig(),refreshStatus()]);if(mine!==state.connectionEpoch)return;
  if(results[0].status==='fulfilled')renderConnection(checked(results[0].value));else showError(results[0].reason);
  if(results[1].status==='fulfilled'){const config=checked(results[1].value);$('integration-config').textContent=JSON.stringify(config,null,2);$('workbench-version').textContent=config.version?'工作台 '+config.version:'';}else{$('integration-config').textContent='接入配置暂未读取成功，请刷新重试。';showError(results[1].reason);}
  if(results[2].status==='rejected')showError(results[2].reason);
}
async function persistConnection(form){renderConnection(checked(await api.saveConnection(form)));notice('连接配置已保存。');await refreshStatus();}
async function prepareConnection(form){const proposal=checked(await api.networkPlan());if(JSON.stringify(form)!==JSON.stringify(connectionInput()))return;if(typeof proposal.token!=='string'||!proposal.difference)throw Error('公司主机未返回可核对的连接方案。');state.connectionPlan={token:proposal.token,form,createdAt:Date.now()};$('connection-difference').textContent=JSON.stringify(proposal.difference,null,2);$('connection-review-note').textContent='请核对本次变更及保留的现有入口。此操作仅启用公司私网连接。';$('connection-review').hidden=false;$('connection-review-title').focus();}
async function saveConnection(event){event.preventDefault();await run('connection',async()=>{const form=connectionInput();if(form.mode==='server')await prepareConnection(form);else{clearConnectionPlan();await persistConnection(form);}},[$('save-connection')]);}
async function confirmConnection(){await run('connection',async()=>{const plan=state.connectionPlan;if(!plan)return;if(JSON.stringify(plan.form)!==JSON.stringify(connectionInput()))throw Error('连接表单已变化，请重新查看变更。');if(Date.now()-plan.createdAt>=290000){await prepareConnection(plan.form);notice('原方案已过期，请重新核对连接变更。');return;}try{await persistConnection({...plan.form,networkToken:plan.token});}catch(error){clearConnectionPlan();throw error;}},[$('confirm-connection')]);}
async function networkAction(action){const method={login:'networkLogin',connect:'networkConnect',status:'networkStatus',logout:'networkLogout'}[action];await run('network',async()=>{const form=connectionInput();if(form.mode!=='client'||form.networkProvider!=='embedded')throw Error('请选择员工客户端和内置私网连接。');const result=checked(await api[method](...(['login','connect'].includes(action)?[form]:[])));$('private-network-state').textContent=result.loginOpened?'已打开官方登录页。验证完成后，请重新连接。':result.message||result.detail||(result.connected?'公司私网已连接':'私网状态：'+(result.state||'待确认'));if(['connect','logout'].includes(action))await refreshStatus();},[$('network-'+action)]);}
async function diagnosticAction(action){const method={read:'readLogs',copy:'copyLogs',export:'exportLogs'}[action];await run('diagnostics',async()=>{const result=checked(await api[method]());if(action==='read')$('diagnostic-output').textContent=array(result.entries).map(entry=>'['+(entry.source||'主机')+'] '+(entry.text||entry.message||'')).join('\n')||'本次未返回日志记录。';else if(action==='copy')notice('日志已复制。');else if(result.exported)notice('诊断报告已导出：'+(result.filename||''));},[$({read:'read-diagnostics',copy:'copy-diagnostics',export:'export-diagnostics'}[action])]);}

async function reviewRequest(operation,payload={}){if(typeof api.businessReview!=='function')throw Error('当前版本的业务复核接口尚未就绪，请更新完整桌面版。');return checked(await api.businessReview({operation,...payload}));}
function reviewId(value){return value?.id||value?.reviewId;}
function reviewTitle(value){return value.title||value.summary||((labels[value.module]||'业务')+'变更');}
// Keep large previews inspectable without creating thousands of table nodes at once.
function pagedRows(section,table,body,rows,renderRow){
  const size=100,pages=Math.max(1,Math.ceil(rows.length/size));let page=0;
  const controls=node('nav','','review-pagination'),previous=node('button','上一页'),next=node('button','下一页'),label=node('span');
  previous.type=next.type='button';controls.setAttribute('aria-label','明细分页');label.setAttribute('aria-live','polite');controls.append(previous,label,next);
  const draw=()=>{const fragment=document.createDocumentFragment();for(const row of rows.slice(page*size,(page+1)*size))fragment.append(renderRow(row));body.replaceChildren(fragment);previous.disabled=page===0;next.disabled=page+1>=pages;label.textContent='第 '+(page+1)+' / '+pages+' 页 · 共 '+rows.length+' 条';};
  previous.addEventListener('click',()=>{if(page){page--;draw();table.scrollIntoView({block:'nearest'});}});next.addEventListener('click',()=>{if(page+1<pages){page++;draw();table.scrollIntoView({block:'nearest'});}});
  draw();if(rows.length>size)section.append(controls);
}
function reviewSection(target,title,value){
  if(value===undefined||value===null)return;const section=node('section','','review-section');const sectionId={'处理范围':'scope','变更前后':'diff','来源与证据':'evidence','异常与需要注意的事项':'issues'}[title];if(sectionId)section.id='business-review-'+sectionId;section.append(node('h3',title));
  const fields={module:'业务',period:'期间',month:'月份',date:'日期',count:'条数',total:'合计',amountCents:'金额（分）',amount:'金额（来源单位）',currency:'币种',source:'来源',sourceId:'来源编号',recordId:'记录编号',operation:'操作',summary:'说明',message:'说明',status:'状态'};
  const rows=Array.isArray(value)?value:null;
  if(rows?.length&&rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&('before'in row||'after'in row))){
    const table=node('table'),head=node('tr');for(const label of ['项目','变更前','变更后'])head.append(node('th',label));const thead=node('thead');thead.append(head);table.append(thead);const body=node('tbody');
    table.append(body);section.append(table);pagedRows(section,table,body,rows,row=>{const tr=node('tr');tr.append(node('td',row.label||fields[row.field]||row.field||row.name||row.id||'记录'),node('td',display(row.before)),node('td',display(row.after)));return tr;});
  }else if(value&&typeof value==='object'&&!rows){
    const table=node('table'),body=node('tbody');for(const [key,item]of Object.entries(value)){const row=node('tr');row.append(node('th',fields[key]||key),node('td',display(item)));body.append(row);}table.append(body);section.append(table);
  }else section.append(node('pre',display(value)));target.append(section);
}
function renderPreviewBlocks(target,blocks){
  for(const block of array(blocks)){
    if(!block||typeof block!=='object')continue;
    if(block.type==='table'&&Array.isArray(block.rows)){
      const section=node('section','','review-section');section.append(node('h3',block.title||'业务预览'));
      const columns=Array.isArray(block.columns)?block.columns.map(column=>typeof column==='string'?{key:column,label:column}:{key:column.key||column.id||column.field,label:column.label||column.title||column.key||column.field}):[...new Set(block.rows.flatMap(row=>row&&typeof row==='object'?Object.keys(row):[]))].map(key=>({key,label:key}));
      const table=node('table'),head=node('tr');for(const column of columns)head.append(node('th',column.label));const thead=node('thead');thead.append(head);table.append(thead);const body=node('tbody');
      table.append(body);section.append(table);pagedRows(section,table,body,block.rows,row=>{const tr=node('tr');for(const column of columns)tr.append(node('td',display(row?.[column.key])));return tr;});if(!block.rows.length)section.append(node('p','本次预览没有明细记录。','fine-print'));target.append(section);
    }else if(block.type==='text')reviewSection(target,block.title||'预览说明',block.text??block.content??block.value);
    else reviewSection(target,block.title||'业务预览',block);
  }
}
function renderReview(review){
  state.review=review;const target=$('business-review-detail');target.replaceChildren();if(!review){target.append(node('p','选择一项，查看变更内容。','empty'));return;}
  const states={awaiting_review:'待复核',committing:'正在提交',completed:'已完成',rejected:'已退回',unknown:'提交状态待核对',stale:'数据已变化，需重新预览'};target.append(node('h3',reviewTitle(review)),node('p',[labels[review.module]||review.module,states[review.state]||review.state,when(review.createdAt),reviewId(review)].filter(Boolean).join(' · '),'review-metadata'));
  if(review.summary&&review.summary!==reviewTitle(review))target.append(node('p',review.summary));
  reviewSection(target,'处理范围',review.scope);renderPreviewBlocks(target,review.blocks);reviewSection(target,'变更前后',review.changes??review.diff??review.preview);reviewSection(target,'来源与证据',review.evidence??review.sources);reviewSection(target,'异常与需要注意的事项',review.issues??review.exceptions);
  target.append(node('p','数据版本：'+display(review.revision),'review-metadata'));const versions=node('details','','review-section');versions.id='business-review-revision';versions.append(node('summary','版本核对信息'),node('pre',display({version:review.version,revision:review.revision,digest:review.digest})));target.append(versions);
  if(review.error)target.append(node('p',review.error.message||display(review.error),'review-attention'));
  if(review.receipt){const receipt=node('section','','review-receipt');receipt.append(node('h3','实际业务回执'),node('pre',display(review.receipt)));target.append(receipt);}
  const allowed=review.canApprove===true&&review.state==='awaiting_review'&&Number.isSafeInteger(review.version)&&review.version>0&&typeof review.digest==='string'&&/^[a-f0-9]{64}$/i.test(review.digest)&&review.revision!==undefined&&review.revision!==null&&!!reviewId(review);
  if(!allowed){target.append(node('p',review.message||review.reason||(review.receipt?'此操作已返回回执。':'此版本目前不能确认；数据有变化时请让外部 AI 重新准备预览。'),'review-attention'));return;}
  const check=node('label','','review-check'),checkbox=node('input');checkbox.type='checkbox';checkbox.id='business-review-check';check.append(checkbox,node('span','我已核对本次处理范围、差异、来源和异常。'));target.append(check);
  const actions=node('div','','actions'),confirm=node('button','确认并提交','primary'),reject=node('button','退回重新准备');confirm.id='business-review-confirm';reject.id='business-review-reject';confirm.type=reject.type='button';confirm.disabled=true;checkbox.addEventListener('change',()=>{confirm.disabled=state.reviewBusy||!checkbox.checked;});confirm.addEventListener('click',()=>void submitReview('approve',review));reject.addEventListener('click',()=>void submitReview('reject',review));actions.append(confirm,reject);target.append(actions,node('p','确认仅绑定上方结果与数据版本；数据变化后需要重新核对。','fine-print'));
}
let nextReviewCursor=null;
async function refreshReviewList({keepSelection=true,append=false}={}){
  if(append&&!nextReviewCursor)return;
  const mine=++state.reviewEpoch,filter=$('business-review-filter').value;
  loading($('business-review-loading'),'正在读取业务操作');$('business-review-more').disabled=true;
  try{
    const response=await reviewRequest('list',{limit:50,...(filter==='pending'?{state:'awaiting_review'}:{}),...(append?{cursor:nextReviewCursor}:{})});
    if(mine!==state.reviewEpoch||filter!==$('business-review-filter').value)return;
    const reviews=array(response.reviews??response.items);nextReviewCursor=response.nextCursor??null;
    $('business-review-count').textContent=String(response.pendingCount??reviews.filter(review=>review.state==='awaiting_review').length);
    if(!append)$('business-review-list').replaceChildren();
    const seen=new Set([...$('business-review-list').querySelectorAll('[data-review-id]')].map(button=>button.dataset.reviewId));
    for(const review of reviews){
      if(seen.has(reviewId(review)))continue;const button=node('button','','review-row');button.type='button';button.dataset.reviewId=reviewId(review);
      const status={awaiting_review:'待确认',committing:'提交中',completed:'已完成',rejected:'已退回',unknown:'待核对',stale:'已过期'}[review.state]||review.state;
      button.append(node('strong',reviewTitle(review)),node('small',[labels[review.module]||review.module,status,when(review.createdAt)].filter(Boolean).join(' · ')));
      button.setAttribute('aria-current',String(reviewId(state.review)===reviewId(review)));button.addEventListener('click',()=>void selectReview(reviewId(review)).catch(showError));$('business-review-list').append(button);
    }
    if(!append&&!reviews.length)$('business-review-list').append(node('p',filter==='all'?'暂时没有业务操作记录。':'暂时没有待确认操作。','empty'));
    $('business-review-more').hidden=nextReviewCursor===null;
    if(!keepSelection||!state.review)renderReview(null);
  }catch(error){$('business-review-count').textContent='—';$('business-review-status').textContent=errorMessage(error);throw error;}
  finally{if(mine===state.reviewEpoch){$('business-review-loading').replaceChildren();$('business-review-more').disabled=false;}}
}
let countRefresh=null;
async function refreshReviewCount(){if(document.hidden)return;if(countRefresh)return countRefresh;countRefresh=(async()=>{try{const response=await reviewRequest('list',{summary:true});$('business-review-count').textContent=String(response.pendingCount??array(response.reviews??response.items).filter(review=>review.state==='awaiting_review').length);}catch{$('business-review-count').textContent='—';}finally{countRefresh=null;}})();return countRefresh;}
async function selectReview(id){if(state.reviewBusy)return;const mine=++state.reviewEpoch;loading($('business-review-loading'),'正在核对操作版本');$('business-review-status').textContent='';try{const response=await reviewRequest('get',{id});if(mine!==state.reviewEpoch)return;const review=response.review||response;if(reviewId(review)!==id)throw Error('返回的操作编号不一致，未显示其他操作。');renderReview(review);for(const button of document.querySelectorAll('.review-row'))button.setAttribute('aria-current',String(button.dataset.reviewId===id));}finally{if(mine===state.reviewEpoch)$('business-review-loading').replaceChildren();}}
async function submitReview(operation,review){
  if(state.reviewBusy||reviewId(state.review)!==reviewId(review))return;if(operation==='approve'&&!$('business-review-check')?.checked)return;
  state.reviewBusy=true;for(const button of $('business-review-detail').querySelectorAll('button,input'))button.disabled=true;loading($('business-review-loading'),operation==='approve'?'正在提交并核对业务回执':'正在退回本次操作');$('business-review-status').textContent='';
  try{const binding={id:reviewId(review),version:review.version,revision:review.revision,digest:review.digest},result=await reviewRequest(operation,binding);state.reviewEpoch++;
    if(result.review)renderReview(result.review);else if(result.receipt)renderReview({...review,canApprove:false,receipt:result.receipt});else renderReview({...review,canApprove:false,message:operation==='reject'?'已退回，请让外部 AI 重新准备预览。':'提交已受理；实际回执尚未返回，请刷新查询，勿重复提交。'});
    $('business-review-status').textContent=operation==='reject'?'本次操作已退回。':result.receipt||result.review?.receipt?'已返回实际业务回执，请核对。':'请查询实际提交状态。';await refreshReviewList();
  }catch(error){renderReview({...review,canApprove:false,message:'操作未完成或状态尚待核对，请刷新读取实际状态；不会自动重复提交。'});$('business-review-status').textContent=errorMessage(error);showError(error);}finally{state.reviewBusy=false;$('business-review-loading').replaceChildren();}
}
async function openReviews(){await business.suspend();$('business-review-dialog').showModal();$('business-review-status').textContent='';try{await refreshReviewList();}catch(error){showError(error);}}
function setSidebarHidden(hidden){document.body.classList.toggle('sidebar-hidden',hidden);$('main-sidebar').hidden=hidden;const toggle=$('toggle-sidebar');toggle.setAttribute('aria-expanded',String(!hidden));toggle.setAttribute('aria-label',hidden?'展开侧栏':'收起侧栏');toggle.title=hidden?'展开侧栏':'收起侧栏';toggle.textContent=hidden?'☰':'‹';void business.measure().catch(showError);}
try{setSidebarHidden(localStorage.getItem('wucheng.sidebar.hidden')==='true');}catch{}
$('toggle-sidebar').addEventListener('click',()=>{const hidden=!document.body.classList.contains('sidebar-hidden');setSidebarHidden(hidden);try{localStorage.setItem('wucheng.sidebar.hidden',String(hidden));}catch{}});
for(const button of document.querySelectorAll('[data-backup-desk]'))button.addEventListener('click',()=>void run('backup-'+button.dataset.backupDesk,async()=>{const result=checked(await api.backup(button.dataset.backupDesk));notice(labels[result.id]+'账本与原件已备份：'+result.directory);},[button]));
for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>void navigate(button.dataset.view).catch(showError));
$('nav-warehouse').addEventListener('click',()=>void navigate('business',{desk:{id:'warehouse'}}).catch(showError));
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();void navigate('business').catch(showError);});
$('dismiss-error').addEventListener('click',()=>{$('error-banner').hidden=true;});$('refresh-settings').addEventListener('click',()=>void run('settings',loadSettings,[$('refresh-settings')]));
for(const [id,kind]of [['copy-mcp','mcp'],['copy-cli','cli']])$(id).addEventListener('click',()=>void run('copy-integration',async()=>{checked(await api.copyIntegration(kind));notice((kind==='mcp'?'MCP 配置':'CLI 命令')+'已复制。');},[$(id)]));
for(const id of ['connection-mode','connection-provider','connection-url'])$(id).addEventListener('input',()=>{clearConnectionPlan();connectionVisibility();});$('connection-mode').addEventListener('change',connectionVisibility);$('connection-form').addEventListener('submit',event=>void saveConnection(event));$('confirm-connection').addEventListener('click',()=>void confirmConnection());$('cancel-connection').addEventListener('click',()=>{clearConnectionPlan();$('save-connection').focus();});
$('check-connection').addEventListener('click',()=>void run('connection-check',async()=>{const result=checked(await api.checkConnection());$('connection-detail').textContent=result.detail||result.message||result.label||'连接检查已完成。';await refreshStatus();},[$('check-connection')]));for(const action of ['login','connect','status','logout'])$('network-'+action).addEventListener('click',()=>void networkAction(action));
for(const action of ['read','copy','export'])$({read:'read-diagnostics',copy:'copy-diagnostics',export:'export-diagnostics'}[action]).addEventListener('click',()=>void diagnosticAction(action));
$('business-review-more').addEventListener('click',()=>void refreshReviewList({append:true}).catch(showError));
$('business-review-filter').addEventListener('change',()=>void refreshReviewList({keepSelection:false}).catch(showError));
$('business-review-open').addEventListener('click',()=>void openReviews().catch(showError));$('business-review-close').addEventListener('click',()=>{$('business-review-dialog').close();});$('business-review-refresh').addEventListener('click',()=>void refreshReviewList().catch(showError));
$('business-review-dialog').addEventListener('close',()=>{state.reviewEpoch++;if(state.view==='business')void business.resume().catch(showError);});$('business-review-dialog').addEventListener('cancel',()=>{ /* Escape closes only; it never approves or retries. */ });
const stopMessages=api?.onMessage?.(value=>notice(typeof value==='string'?value:value?.message||''));
const reviewTimer=setInterval(()=>{if(!document.hidden&&!$('business-review-dialog').open)void refreshReviewCount();},30000);
const reviewVisibility=()=>{if(!document.hidden)void refreshReviewCount();};document.addEventListener('visibilitychange',reviewVisibility);
window.addEventListener('beforeunload',()=>{clearInterval(reviewTimer);document.removeEventListener('visibilitychange',reviewVisibility);stopMessages?.();business.dispose();});
void (async()=>{if(!api)throw Error('请在完整桌面版中打开工作台。');await api.ready();await refreshStatus();await navigate('business',{focus:false});void refreshReviewCount();})().catch(showError);
