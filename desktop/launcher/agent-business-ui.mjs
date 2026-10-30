const labels={overview:'经营',purchase:'采购',sales:'销售',warehouse:'云仓',exporter:'订单导出'};
const primary=['overview','purchase','sales'];
const live=new Set(['queued','running','committing']);
const states={queued:'等待执行',running:'执行中',waiting_input:'需要补充',waiting_review:'待复核',committing:'正在提交',unknown:'核对提交状态',paused:'已暂停',completed:'已完成',failed:'未完成',cancelled:'已停止'};

/** The surface is only a measured native-view slot. It never embeds an untrusted URL. */
export function createBusinessWorkspace({launcher=window.launcher,api,ready=()=>false,loading,showError,notice,onNavigate,openTask,getSkillSelection=()=>({})}){
  const $=id=>document.getElementById(id),tabs=[...document.querySelectorAll('.business-tabs [data-desk]')];
  let active='overview',visible=false,nativeVisible=false,assistantOpen=false,opening=false,failed=false,startingTask=false,syncingTask=false,epoch=0,measureEpoch=0,lastBounds='',currentTask=null,taskTimer=null,disposed=false;
  const surface=$('business-surface'),layout=$('business-layout'),assistant=$('business-assistant');
  const taskProgress=document.createElement('div');taskProgress.className='business-task-progress';$('business-task-state').after(taskProgress);
  const moduleName=id=>labels[id]||(id==='system'?'公共事务':id);
  const taskModules=selected=>[...new Set([active,'system',...(selected||[])])];
  try{const last=window.localStorage.getItem('wucheng.workbench.lastPrimary');if(primary.includes(last))active=last;}catch{}
  const drafts=new Map();
  function changeActive(id){if(id===active)return;drafts.set(active,{goal:$('business-goal').value,range:$('business-range').value});active=id;const saved=drafts.get(id);$('business-goal').value=saved?.goal||'';$('business-range').value=saved?.range||'';if(primary.includes(id))try{window.localStorage.setItem('wucheng.workbench.lastPrimary',id);}catch{}}
  function isNarrow(){return window.innerWidth<1360||layout.getBoundingClientRect().width-376<760;}
  function updateLabels(){
    for(const tab of tabs){const selected=tab.dataset.desk===active;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
    if(primary.includes(active)){surface.setAttribute('aria-labelledby','desk-tab-'+active);surface.removeAttribute('aria-label');}else{surface.removeAttribute('aria-labelledby');surface.setAttribute('aria-label',labels[active]);}
    const range=$('business-range').value.trim(),scope=taskModules(getSkillSelection.modules?.()).map(moduleName).join(' / ');
    $('business-context').textContent=scope+' · '+(range?'用户补充范围：'+range:'未读取页面筛选；仅按用户目标中的范围执行。');
    $('business-ai-toggle').setAttribute('aria-expanded',String(assistantOpen));assistant.hidden=!assistantOpen;layout.classList.toggle('has-assistant',assistantOpen);layout.classList.toggle('assistant-full',assistantOpen&&isNarrow());
    surface.hidden=assistantOpen&&isNarrow();$('business-ai-close').textContent='返回'+labels[active];
  }
  async function hideNative(){lastBounds='';if(nativeVisible||opening){const operation=epoch;await launcher?.hide?.();if(operation===epoch)nativeVisible=false;}}
  async function measure(){
    if(disposed||!visible||opening||failed)return;
    const measurement=++measureEpoch,operation=epoch;
    updateLabels();const rect=surface.getBoundingClientRect(),covered=surface.hidden||document.hidden||$('business-more').open||rect.width<=0||rect.height<=0;
    if(covered){await hideNative();return;}
    const header=document.querySelector('.app-header')?.getBoundingClientRect(),footer=document.querySelector('.development-preview')?.getBoundingClientRect();
    document.documentElement.style.setProperty('--app-header-height',(header?.height||76)+'px');document.documentElement.style.setProperty('--preview-footer-height',(footer?.height||0)+'px');
    const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height},key=JSON.stringify(bounds);
    if(key!==lastBounds){await launcher?.bounds?.(bounds);if(measurement!==measureEpoch||operation!==epoch||!visible||opening)return;lastBounds=key;}
    if(measurement!==measureEpoch||operation!==epoch||!visible||opening)return;
    if(!nativeVisible&&typeof launcher?.open==='function'){
      const mine=epoch,result=await launcher.open(active);if(mine!==epoch||!visible||surface.hidden)return;if(result?.cancelled)return;nativeVisible=true;
    }
  }
  async function openDesk(id,route){
    if(!Object.hasOwn(labels,id))return;
    if(!primary.includes(id)){
      const mine=++epoch;opening=true;$('business-more').open=false;
      try{await hideNative();if(mine!==epoch||!visible)return;if(typeof launcher?.open!=='function')throw Error('当前窗口没有桌面业务入口，请使用完整桌面版');const result=await launcher.open(id,route);if(mine!==epoch||!visible||result?.cancelled)return;if(result?.id===id){changeActive(id);nativeVisible=true;updateLabels();}else notice('已请求打开'+labels[id]+'，沿用其现有桌面业务窗口。');}catch(error){if(mine===epoch)showError(error);}finally{if(mine===epoch){opening=false;void measure().catch(showError);}}return;
    }
    if(route&&active===id&&nativeVisible&&!window.confirm('即将定位到新的'+labels[id]+'页面。请先确认当前表单已经保存，再继续。'))return;
    const mine=++epoch;opening=true;failed=false;
    try{
      await hideNative();if(mine!==epoch||!visible)return;changeActive(id);updateLabels();$('business-more').open=false;$('business-failure').hidden=true;loading($('business-loading'),'正在打开'+labels[id]+'工作台','content');
      if(typeof launcher?.open!=='function'||typeof launcher?.bounds!=='function')throw Error('当前窗口没有业务内嵌能力，请使用完整桌面测试版。');
      const rect=surface.getBoundingClientRect();if(rect.width>0&&rect.height>0)await launcher.bounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
      if(mine!==epoch||!visible)return;
      if(surface.hidden||document.hidden||rect.width<=0||rect.height<=0)return;
      const result=await launcher.open(id,route);if(mine!==epoch||!visible)return;if(result?.cancelled){$('business-loading').replaceChildren();return;}
      nativeVisible=true;$('business-loading').replaceChildren();
    }catch(error){if(mine===epoch){failed=true;$('business-loading').replaceChildren();$('business-failure-message').textContent=String(error.message||error);$('business-failure').hidden=false;showError(error);}}
    finally{if(mine===epoch){opening=false;void measure().catch(showError);}}
  }
  async function show({id=active,route}={}){visible=true;if(route)assistantOpen=false;updateLabels();await openDesk(id,route);if(visible)startTaskPolling();}
  async function leave(){visible=false;const mine=++epoch;opening=false;clearInterval(taskTimer);taskTimer=null;await launcher?.hide?.();if(mine===epoch){nativeVisible=false;lastBounds='';}}
  async function toggleAssistant(value){const mine=epoch;assistantOpen=value;updateLabels();if(value&&isNarrow())await hideNative();else await measure();if(value&&visible&&mine===epoch&&assistantOpen)$('business-goal').focus();}
  function summary(detail){
    const previous=currentTask?.task?.id===detail?.task?.id?currentTask.lastSequence||0:0;currentTask={...detail,lastSequence:Math.max(previous,...(detail?.events||[]).map(event=>Number(event.sequence)||0))};$('business-task-summary').hidden=!detail?.task;taskProgress.replaceChildren();
    if(!detail?.task)return;$('business-task-state').textContent=[detail.task.scope?.label,states[detail.task.status]||detail.task.status].filter(Boolean).join(' · ');$('business-task-result').textContent=detail.result?.summary||detail.task.question||detail.task.error||'实际结果尚未返回。';
    if(live.has(detail.task.status)){loading(taskProgress,detail.task.progress?.message||states[detail.task.status]);const progress=taskProgress.querySelector('progress');if(progress&&Number.isFinite(detail.task.progress?.completed)&&detail.task.progress.total>0){progress.max=detail.task.progress.total;progress.value=Math.min(detail.task.progress.completed,detail.task.progress.total);}}
    $('business-open-task').textContent=detail.task.status==='waiting_review'?'展开任务空间并复核':detail.task.status==='waiting_input'?'展开任务并补充信息':'展开任务空间';
    if(detail.task.status==='completed'&&detail.result?.receipt?.state==='verified')$('business-task-result').textContent+=' 已核对提交回执；请在确认没有未保存表单后刷新业务看板。';
  }
  async function syncTask(){
    if(syncingTask||!visible||!currentTask?.task?.id||['completed','cancelled','failed'].includes(currentTask.task.status))return;
    syncingTask=true;
    try{const detail=await api.request('tasks.get',{taskId:currentTask.task.id,afterSequence:currentTask.lastSequence||0});if(currentTask?.task.id===detail.task?.id)summary({...detail,lastSequence:Math.max(currentTask.lastSequence||0,...(detail.events||[]).map(event=>Number(event.sequence)||0))});}catch(error){if(visible)showError(error);}finally{syncingTask=false;}
  }
  function startTaskPolling(){clearInterval(taskTimer);taskTimer=setInterval(()=>void syncTask(),5000);}
  async function startTask(event){
    event.preventDefault();if(!ready()||startingTask)return;const goal=$('business-goal').value.trim(),range=$('business-range').value.trim();if(!goal)return;
    const button=$('business-start-task');startingTask=true;button.disabled=true;
    try{const selected=getSkillSelection(),modules=taskModules(selected.scope?.modules),contextLabel=modules.map(moduleName).join(' / ')+' · '+(range||'按目标中的范围执行；页面筛选未读取');
      $('business-context').textContent=contextLabel;
      const scopeNote=range?'\n\n用户补充的业务范围：'+range:'\n\n未读取页面筛选；仅按用户目标中的范围执行。缺少必要日期、对象或范围时请先询问，不得默认整个账本。';
      const result=await api.request('tasks.create',{goal:goal+scopeNote+'\n本任务没有自动读取页面筛选、选中记录或未保存草稿。',...selected,scope:{...selected.scope,modules,label:contextLabel}});
      if(!result.task?.id)throw Error('主机未返回真实任务编号，请先查看任务历史，避免重复创建。');summary(result);$('task-business-back').hidden=false;if(visible){startTaskPolling();void syncTask();}
    }catch(error){showError(error);}finally{startingTask=false;button.disabled=!ready();}
  }
  for(const tab of document.querySelectorAll('[data-desk]'))tab.addEventListener('click',()=>void openDesk(tab.dataset.desk));
  tabs.forEach((tab,index)=>tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();void openDesk(tabs[next].dataset.desk);}));
  $('business-ai-toggle').addEventListener('click',()=>void toggleAssistant(!assistantOpen).catch(showError));$('business-ai-close').addEventListener('click',()=>void toggleAssistant(false).catch(showError));$('business-retry').addEventListener('click',()=>void openDesk(active));$('business-ai-form').addEventListener('submit',startTask);$('business-open-task').addEventListener('click',()=>currentTask?.task?.id&&void openTask(currentTask.task.id));
  $('business-range').addEventListener('input',updateLabels);$('business-skill-choice').addEventListener('skill-scope-change',updateLabels);$('business-skill-choice').addEventListener('change',updateLabels);
  $('business-more').addEventListener('toggle',()=>{if($('business-more').open)void hideNative().catch(showError);else if(visible&&!opening)void measure().catch(showError);});
  $('task-business-back').addEventListener('click',()=>void onNavigate('business'));$('business-source-back').addEventListener('click',()=>currentTask?.task?.id&&void openTask(currentTask.task.id));
  const unsubscribe=launcher?.onNavigate?.(value=>{if(!value?.id)return;if(Object.hasOwn(labels,value.id))void onNavigate('business',{desk:value});else if(value.id==='home')void onNavigate('business',{desk:{id:'overview'}});else if(['settings','logs'].includes(value.id))void onNavigate('settings');});
  const observer=new ResizeObserver(()=>void measure().catch(showError));observer.observe(layout);observer.observe(document.querySelector('.app-header'));document.addEventListener('visibilitychange',()=>{if(visible)void measure().catch(showError);});
  return {show,leave,measure,suspend:hideNative,hasReturn:()=>!!currentTask?.task,acceptTask(detail){if(detail?.task?.id===currentTask?.task?.id)summary(detail);},dispose(){disposed=true;observer.disconnect();clearInterval(taskTimer);unsubscribe?.();}};
}
