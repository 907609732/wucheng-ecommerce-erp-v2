const api = window.launcher, $ = id => document.getElementById(id);
const names = {warehouse:'菜鸟云仓同步',purchase:'采购台',sales:'销售台',overview:'经营收支总览',exporter:'历史订单导出台','node-runtime':'共享运行环境','browser-runtime':'浏览器组件'};
const descriptions = {overview:'汇总销售、采购及各项费用，查看整体收支与待补数据。',warehouse:'同步云仓库存，查看库存与销售变化。',purchase:'采购记账、历史订单导入与支出核对。',sales:'销售账单、运营数据与运费费用。'};
let rows = [], chosen, offlineToken, chosenOffline, offlineIds=new Set(), currentPanel = 'home', activeDesk = '', openingId = '', openingTimer;
let connectionState={mode:'standalone'};
let privateNetworkBusy=false,privateNetworkPolling=false,networkLastVerification=0;
let lastLoggedConnectionState='';
let connectionHealthPolls=0,connectionHealthSequence=0,messageTimer,lastDeskBounds='';
const isClient=()=>connectionState.mode==='client';
const healthConfiguration=()=>JSON.stringify([connectionState.mode,connectionState.serverUrl,connectionState.configurationId,connectionState.networkProvider,!!connectionState.networkSuspended]);
function renderConnectionHealth(status){
  if(status.state&&status.state!=='checking'&&status.state!==lastLoggedConnectionState){lastLoggedConnectionState=status.state;Promise.resolve(api.reportDiagnostic?.({source:'network',level:['ready','connected'].includes(status.state)?'info':'warning',text:(status.label||status.state)+' · '+(status.detail||'')})).catch(()=>{});}
  const prefix=connectionState.mode==='server'?'主服务器':isClient()?'客户端':'单机';
  const label=status.label||'正在检查连接…';
  const checked=status.checkedAt?'最近检查 '+new Date(status.checkedAt).toLocaleTimeString():'';
  const elapsed=Number.isFinite(status.latencyMs)?'检查耗时 '+status.latencyMs+' 毫秒':'';
  const detail=[status.detail,checked,elapsed].filter(Boolean).join(' · ');
  $('connectionIndicator').textContent=label.startsWith(prefix)?label:prefix+' · '+label;
  $('connectionIndicator').dataset.state=status.state;
  $('connectionIndicator').title=detail;
  $('connectionStatus').textContent=label;
  $('connectionStatus').dataset.state=status.state;
  $('connectionDetails').textContent=detail;
}
async function pollConnectionStatus({force=false}={}){
  if(!api.connectionStatus||privateNetworkBusy||connectionHealthPolls&&!force)return;
  const configuration=healthConfiguration(),sequence=++connectionHealthSequence;
  connectionHealthPolls++;
  try{
    const status=await api.connectionStatus();
    if(sequence!==connectionHealthSequence||configuration!==healthConfiguration()||status.mode!==connectionState.mode||status.configurationId!==connectionState.configurationId)return;
    renderConnectionHealth(status);
    if(isClient()){
      const wasConnected=connectionState.connected;
      connectionState.connected=status.state==='connected';
      if(['identity-error','unauthorized'].includes(status.state))clearDisplayedCache();
      if(!connectionState.connected){rows=rows.map(row=>({...row,status:'unavailable',authorized:false}));render();}
      else if(!wasConnected)await load();
    }
  }catch(error){
    if(sequence===connectionHealthSequence&&configuration===healthConfiguration()){
      if(isClient())connectionState.connected=false;
      renderConnectionHealth({state:'offline',label:'连接检查未完成',detail:'暂时无法获取最新连接状态，请点击检查连接。',checkedAt:new Date().toISOString()});
    }
  }finally{connectionHealthPolls--;}
}
const node = (tag, text, className) => Object.assign(document.createElement(tag), {textContent:text, ...(className ? {className} : {})});
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
const identityFailure = error => ['DATASET_CHANGED','CONNECTION_CHANGED','SERVER_IDENTITY_MISSING','MODULE_IDENTITY_MISSING'].includes(error?.code)||/连接设置已更改|连接设置正在更新|服务器、账本或成员身份发生变化|正式账本已更换|未返回完整身份|未返回模块账本身份/.test(error?.message||'');
function clearDisplayedCache(){
  $('cacheData').textContent='';$('cacheStatus').textContent='';
  if(currentPanel==='cache')void panel('home').catch(()=>{});
}
const message = error => {
  if(identityFailure(error))clearDisplayedCache();
  clearTimeout(messageTimer);
  const text=String(error?.message||error||'').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
  const isError=!!error&&typeof error==='object'||/失败|异常|错误|无法|未就绪|请先|尚未完成|已阻止/.test(text);
  $('toast').dataset.kind=isError?'error':'info';
  if(isError)Promise.resolve(api.reportDiagnostic?.({level:'error',text:String(error?.stack||text).slice(0,6000)})).catch(()=>{});
  $('message').textContent=text;
  // Errors remain until dismissed. A later direct message from the migration
  // UI must not be cleared by an earlier success timer.
  if(text&&!isError)messageTimer=setTimeout(()=>{if($('message').textContent===text)$('message').textContent='';},5000);
};
const busy = row => row.progress && !['installed','error','cancelled'].includes(row.progress.phase);
const phases = {queued:'等待安装',downloading:'正在下载',verifying:'正在校验',activating:'正在检查服务','component-installed':'组件已安装'};
const button = (label, action, primary = false) => {const b=node('button',label,primary?'primary':'');b.onclick=()=>Promise.resolve().then(action).catch(message);return b;};
function moreMenu(label){
  const details=node('details','','moduleMore'),summary=node('summary','更多'),actions=node('div','','moreActions');
  summary.setAttribute('aria-label',label+'的更多操作');details.append(summary,actions);return {details,actions};
}
async function syncDeskBounds(force=false){
  if(currentPanel!=='desk')return;
  const rect=$('extensionFrame').getBoundingClientRect();
  if(rect.width<=0||rect.height<=0)return;
  const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height},key=JSON.stringify(bounds);
  if(!force&&key===lastDeskBounds)return;
  lastDeskBounds=key;
  try{await api.bounds(bounds);}catch(error){lastDeskBounds='';throw error;}
}
function beginOpening(id) {
  openingId=id;
  message('');
  $('openingTitle').textContent='正在启动'+names[id]+'…';
  $('openingSeconds').textContent='已等待 0 秒';
  $('openingStatus').hidden=false;
  const started=Date.now();
  openingTimer=setInterval(()=>$('openingSeconds').textContent='已等待 '+Math.floor((Date.now()-started)/1000)+' 秒',1000);
  render();
}
function endOpening() {
  clearInterval(openingTimer);openingTimer=undefined;openingId='';
  $('openingStatus').hidden=true;
  render();
}
async function panel(name) {
  currentPanel = name;
  await api.hide();
  for (const p of ['home','settings','desk','cache','logs']) $(p+'Panel').hidden = p !== name;
  for(const id of ['home','settings','logs']){if(id===name)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}
}
async function load() {
  try{rows=await api.list();if(isClient())connectionState.connected=true;render();}
  catch(error){
    if(isClient()){
      connectionState.connected=false;
      rows=['warehouse','purchase','sales','overview','exporter'].map(id=>({id,remote:true,status:'unavailable',authorized:false,error:error.message}));
      connectionHealthSequence++;
      renderConnectionHealth({state:'offline',label:'主服务器连接中断',detail:'当前无法读取主服务器模块，请检查网络、主机和登录状态。',checkedAt:new Date().toISOString()});render();
    }
    throw error;
  }
}
function networkSelection(){return {mode:'client',serverUrl:$('serverUrl').value,networkProvider:'embedded'};}
function networkVisibility(){
  const client=$('connectionMode').value==='client';
  $('networkProviderLabel').hidden=!client;
  $('privateNetworkPanel').hidden=!client||$('networkProvider').value!=='embedded';
}
async function pollPrivateNetwork(){
  if(privateNetworkPolling||privateNetworkBusy||$('privateNetworkPanel').hidden||!api.networkStatus)return;
  privateNetworkPolling=true;
  try{
    const status=await api.networkStatus();
    const state=String(status.state||'stopped').toLowerCase().replaceAll('_','-');
    const labels={stopped:'私网尚未连接',starting:'正在连接私网…','needs-login':'请在官方登录页完成授权','needs-approval':'正在等待管理员批准此设备','logged-out':'已退出私网账号',running:'私网已连接，正在核对主服务器',unavailable:'内置连接组件暂不可用',error:'私网连接异常'};
    $('privateNetworkStatus').textContent=status.message||labels[state]||'正在检查私网状态…';
    if(connectionState.networkSuspended){$('privateNetworkStatus').textContent='连接已暂停；如退出尚未完成，请结束任务后再次退出，或重新连接。';}
    else if(state==='running'&&!connectionState.connected&&Date.now()-networkLastVerification>15000){
      networkLastVerification=Date.now();
      try{await api.checkConnection();await loadConnection();await load();$('privateNetworkStatus').textContent='已连接主服务器';}
      catch(error){$('privateNetworkStatus').textContent='私网已登录，暂时无法连接主服务器。请核对主机在线状态和设备授权。';message(error);}
    }else if(state==='running'&&connectionState.connected)$('privateNetworkStatus').textContent='已连接主服务器';
  }catch(error){$('privateNetworkStatus').textContent=error.message||'内置连接组件暂不可用';}
  finally{privateNetworkPolling=false;}
}
async function privateNetworkAction(action){
  if(privateNetworkBusy)return;
  privateNetworkBusy=true;
  clearDisplayedCache();
  if(isClient()){connectionState.connected=false;rows=rows.map(row=>({...row,status:'unavailable',authorized:false}));render();}
  for(const id of ['privateNetworkLogin','privateNetworkConnect','privateNetworkLogout'])$(id).disabled=true;
  try{
    const result=await api[action](networkSelection());
    networkLastVerification=0;
    await loadConnection();
    if(action==='networkLogout'){
      connectionState.connected=false;
      rows=['warehouse','purchase','sales','overview','exporter'].map(id=>({id,remote:true,status:'unavailable',authorized:false}));render();
      message('已退出私网账号，主服务器账本与本机旧资料均保留。');
    }else if(result.loginOpened)message('请在官方登录页完成授权，工作台会自动检查连接。');
  }catch(error){await loadConnection().catch(()=>{});message(error);}
  finally{privateNetworkBusy=false;for(const id of ['privateNetworkLogin','privateNetworkConnect','privateNetworkLogout'])$(id).disabled=false;await pollPrivateNetwork();await pollConnectionStatus({force:true});}
}
async function loadConnection(){
  if(!api.connection)return;
  const previous=connectionState;
  const previousHealthConfiguration=healthConfiguration();
  connectionState=await api.connection();
  if(connectionState.cacheLocked||JSON.stringify([previous.mode,previous.serverUrl,previous.configurationId,previous.pins,previous.moduleCacheLocks])!==JSON.stringify([connectionState.mode,connectionState.serverUrl,connectionState.configurationId,connectionState.pins,connectionState.moduleCacheLocks]))clearDisplayedCache();
  if(isClient()&&(!connectionState.connected||rows.some(row=>!row.remote))){rows=['warehouse','purchase','sales','overview','exporter'].map(id=>({id,remote:true,status:'unavailable',authorized:false}));render();}
  $('connectionMode').value=connectionState.mode;$('serverUrl').value=connectionState.serverUrl||connectionState.suggestedServerUrl||'';
  $('networkProvider').value=connectionState.networkProvider||(isClient()?'system':'embedded');networkVisibility();
  if(previousHealthConfiguration!==healthConfiguration()){
    connectionHealthSequence++;
    renderConnectionHealth({state:'checking',label:'正在检查连接…',detail:connectionState.mode==='server'?'正在核对本机网关及私网 HTTPS 入口。':'正在读取实际连接状态。'});
  }
  $('migrationStatus').textContent=isClient()&&!connectionState.canWrite?'检测到旧账本，完成两次迁移核对前只允许查询。':isClient()?'客户端不启动本机业务服务。':'';
  $('refresh').hidden=$('offline').hidden=true;
  document.querySelector('#homePanel .intro p').textContent=isClient()?'各模块统一连接主服务器。离线仅查看已缓存的只读快照。':'选择需要的模块。独立运行，本地保存，随时回来继续。';
  void pollConnectionStatus({force:true});
}
async function finishInstall(id){
  await load();
  if(id.endsWith('-runtime')){message(names[id]+' 已安装。');return;}
  if(id==='exporter'&&currentPanel==='desk'&&activeDesk)await open(activeDesk);
  await open(id);message(names[id]+' 已安装并打开。');
}
function render() {
  $('cards').replaceChildren();
  for (const group of [
    {id:'daily',title:'每天使用',note:'每天同步菜鸟云仓库存',ids:['warehouse']},
    {id:'monthly',title:'每月填写',note:'每月 15 号填写销售与采购记录，核对整体收支',ids:['overview','sales','purchase']}
  ]) {
    const section=node('section','','workflowGroup '+group.id),heading=node('div','','workflowHeading'),title=node('h2',group.title);
    title.id=group.id+'Heading';section.setAttribute('aria-labelledby',title.id);section.dataset.frequency=group.id;
    heading.append(title,node('p',group.note));
    const cards=node('div','','workflowCards');
    for (const id of group.ids) {
      const row=rows.find(r=>r.id===id),card=node('article','','card'),copy=node('div','','cardCopy'),actions=node('div','','cardAction');
      card.dataset.module=id;
      copy.append(node('h3',names[id]),node('p',descriptions[id]));
      card.append(node('span',{overview:'↗',warehouse:'☁',purchase:'购',sales:'销'}[id],'symbol'),copy,actions);
      addAction(actions,row);cards.append(card);
    }
    section.append(heading,cards);$('cards').append(section);
  }
  $('moduleList').replaceChildren();
  $('runtimeList').replaceChildren();
  for (const row of rows) {
    if(row.id.endsWith('-runtime')&&!row.installed&&!row.available)continue;
    const box=node('article','','moduleRow'),info=node('div','','moduleInfo'),actions=node('div','','actions');
    box.dataset.moduleRow=row.id;
    const stateLabels={running:'运行中',stopped:'待启动',installed:'已安装',missing:'未安装',unavailable:'暂不可用',incompatible:'版本不兼容'};
    info.append(node('strong',names[row.id]),node('span',row.remote?'主服务器 · '+(stateLabels[row.status]||'暂不可用'):row.installed?'已安装':row.external?'已接入原服务':'未安装','badge'));
    info.append(node('p','版本：'+(row.version||row.installed?.version||'—')+(row.updateAvailable?' · 新版本 '+row.available.version:'')));
    if(row.external){const location=node('details','','pathDetails');location.append(node('summary','原数据位置'),node('p',row.external.dataDir));info.append(location);}
    if(row.progress?.error)info.append(node('p',row.progress.error));
    if(!row.id.endsWith('-runtime'))addAction(actions,row);
    if(!isClient()&&(row.installed||row.external)&&!row.id.endsWith('-runtime')){
      const more=moreMenu(names[row.id]);
      more.actions.append(button('数据位置',()=>api.openData(row.id)),button('诊断',async()=>{const found=(await api.services()).find(item=>(item.extension||item.id)===row.id);message(found?names[row.id]+'：'+(found.error||found.status)+' · '+(found.version||row.version||'版本未知'):names[row.id]+'：尚未启动。打开功能时会按需启动。');}));
      actions.append(more.details);
    }
    box.append(info,actions);$(row.id.endsWith('-runtime')?'runtimeList':'moduleList').append(box);
  }
  $('runtimeSettings').hidden=!$('runtimeList').children.length;
}
function addAction(container,row) {
  if(!row)return;
  const available=row.remote||row.installed||row.external;
  const action=button(row.remote?(row.status==='unavailable'?'暂不可用':row.status==='missing'?'主机功能缺失':'连接使用'):available?'打开':'需要修复',()=>open(row.id),true);
  if(!available||row.remote&&(['missing','unavailable','incompatible'].includes(row.status)||row.authorized===false))action.disabled=true;
  if(openingId){action.disabled=true;if(openingId===row.id)action.textContent='正在启动…';}
  container.append(action);
}
async function prepare(id) {
  await api.hide();
  let plan;
  try {
  chosenOffline=offlineToken&&offlineIds.has(id)?offlineToken:null;
  if(chosenOffline)plan=await api.offlinePlan({token:chosenOffline,id});
  else{
    try { plan=await api.plan(id); }
    catch { await api.refresh();plan=await api.plan(id); }
  }
  chosen=id;$('installTitle').textContent='安装 '+names[id];
  $('installSummary').textContent=(chosenOffline?'本次从离线包安装 ':'本次需要下载 ')+mb(plan.bytes)+'。';
  $('dependencies').replaceChildren(...plan.packages.map(p=>node('li',`${names[p.id]} ${p.version} · ${mb(p.bytes)}`)));
  $('confirmInstall').textContent=chosenOffline?'离线安装':'下载并安装';$('installDialog').showModal();
  } catch(error) {
    if(currentPanel==='desk'&&activeDesk)await open(activeDesk);
    throw error;
  }
}
async function open(id,route) {
  if(openingId)throw Error('正在启动'+names[openingId]+'，请稍候');
  const previousPanel=currentPanel;
  beginOpening(id);
  try{
    if(!isClient()&&['exporter','warehouse'].includes(id)){await api.open(id);return;}
    await panel('desk');activeDesk=id;$('deskTitle').textContent=names[id];
    await syncDeskBounds(true);
    await api.open(id,route);
  }catch(error){
    const invalidIdentity=identityFailure(error);
    if(invalidIdentity)clearDisplayedCache();
    if(isClient()&&(/主服务器暂不可用|ERR_(?:INTERNET_DISCONNECTED|CONNECTION|NETWORK|TUNNEL|PROXY|ADDRESS_UNREACHABLE)|fetch failed|failed to fetch|ENET|ECONN|timeout|超时/i.test(error.message||'')||['EMBEDDED_BOOTSTRAP_FAILED','EMBEDDED_BOOTSTRAP_TIMEOUT'].includes(error.code))){
      const snapshot=await api.cached(id).catch(()=>null);
      if(snapshot){await panel('cache');$('cacheStatus').textContent=names[id]+' · 更新时间 '+new Date(snapshot.updatedAt).toLocaleString()+' · '+error.message;$('cacheData').textContent=JSON.stringify(snapshot.data,null,2);return;}
    }
    if(currentPanel==='desk'&&previousPanel!=='desk')try{await panel(invalidIdentity||previousPanel==='cache'?'home':previousPanel);}catch{}
    throw error;
  }finally{endOpening();}
}
$('home').onclick=$('back').onclick=()=>panel('home').catch(message);
$('settings').onclick=()=>panel('settings').then(load).catch(message);
$('refresh').onclick=async()=>{try{await api.refresh();offlineIds.clear();await load();message('已检查官方扩展目录。');}catch(e){message(e);}};
$('dismissInstall').onclick=()=>{$('installDialog').close();if(currentPanel==='desk'&&activeDesk)open(activeDesk).catch(message);};
$('confirmInstall').onclick=async()=>{
  $('installDialog').close();const id=chosen;
  try {await (chosenOffline?api.offlineInstall({token:chosenOffline,id}):api.install(id));await finishInstall(id);}
  catch(e){message(e);await load();}
};
$('offline').onclick=async()=>{
  try {
    const bundle=await api.offline();if(!bundle)return;
    if(offlineToken)await api.offlineClose(offlineToken);
    offlineToken=bundle.token;
    offlineIds=new Set(bundle.packages.map(p=>p.id));
    // An offline bundle is inspected first; the user chooses modules explicitly.
    $('installTitle').textContent='离线扩展包已验证';
    $('installSummary').textContent='选择需要安装的模块：';
    $('dependencies').replaceChildren(...bundle.packages.filter(p=>!p.id.endsWith('-runtime')).map(p=>{
      const li=node('li','');li.append(button(`${names[p.id]} ${p.version}`,async()=>{
        chosen=p.id;$('installDialog').close();
        try{await api.offlineInstall({token:offlineToken,id:p.id});await finishInstall(p.id);}catch(e){message(e);}
      }));return li;
    }));
    $('confirmInstall').hidden=true;$('installDialog').showModal();
  }catch(e){message(e);}
};
$('installDialog').addEventListener('close',()=>{$('confirmInstall').hidden=false;if(currentPanel==='desk'&&activeDesk)open(activeDesk).catch(message);});
$('help').onclick=async()=>{await api.hide();$('helpDialog').showModal();};
$('closeHelp').onclick=()=>{$('helpDialog').close();if(currentPanel==='desk'&&activeDesk)open(activeDesk).catch(message);};
api.onProgress(value=>{const row=rows.find(r=>r.id===value.id);if(row){row.progress=value;render();}});
api.onMessage(message);
api.onUpdate(state=>{$('hostUpdateStatus').textContent=state.message;$('hostInstall').hidden=state.status!=='ready';});
$('hostUpdate').onclick=()=>api.checkUpdate().catch(message);
$('hostInstall').onclick=()=>api.installUpdate().catch(message);
$('serviceRefresh').onclick=async()=>{
  try{
    const services=await api.services();$('serviceList').replaceChildren();
    for(const service of services){
      const box=node('article','','moduleRow'),info=node('div','');
      info.append(node('strong',names[service.extension]),node('p',service.error||`${service.status} · ${service.version||'—'}`),node('p',service.dataDir));
      box.append(info);
      if(!isClient()&&service.status==='running'){const stop=button('停止后台',()=>api.stop(service.extension).then(()=>$('serviceRefresh').click()));stop.disabled=service.busy;box.append(stop);}
      $('serviceList').append(box);
    }
  }catch(e){message(e);}
};
api.onNavigate(({id,route})=>{
  if(id==='logs'){openLogPanel().catch(message);return;}
  if(id==='settings'){$('settings').click();return;}
  if(id==='help'){$('help').click();return;}
  if(id==='home'){panel('home').catch(message);return;}
  const row=rows.find(r=>r.id===id);
  if(row?.remote||row?.installed||row?.external)open(id,route).catch(message);else message(Error('功能程序文件不完整，请在设置中统一更新或重新安装工作台。'));
});
window.addEventListener('resize',()=>{void syncDeskBounds().catch(message);});
if(typeof ResizeObserver==='function')new ResizeObserver(()=>{void syncDeskBounds().catch(message);}).observe($('extensionFrame'));
$('messageClose').onclick=()=>message('');
document.addEventListener('click',event=>{for(const details of document.querySelectorAll('details.moduleMore[open]'))if(!details.contains(event.target)||event.target.closest('button'))details.open=false;});
document.addEventListener('toggle',event=>{if(event.target.matches?.('details.moduleMore[open]'))for(const details of document.querySelectorAll('details.moduleMore[open]'))if(details!==event.target)details.open=false;},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menus=[...document.querySelectorAll('details.moduleMore[open]')];for(const details of menus)details.open=false;if(menus.length){event.preventDefault();menus.at(-1).querySelector('summary').focus();}}});
$('home').setAttribute('aria-current','page');
Promise.resolve().then(async()=>{await panel('home');await loadConnection();await load();}).catch(message).finally(()=>api.ready?.().catch(message));
$('cacheBack').onclick=()=>panel('home').catch(message);
$('saveConnection').onclick=async()=>{try{const mode=$('connectionMode').value;let networkToken;
  if(mode==='server'){const proposal=await api.networkPlan();if(!window.confirm('本次私网配置：\n'+(proposal.difference.add.join('\n')||'复用已有工作台入口')+'\n保留：'+proposal.difference.preserve.join('、')+'\n不启用公网 Funnel。\n回滚配置已保存：'+proposal.backup+'\n\n启用主服务器？'))return;networkToken=proposal.token;}
  clearDisplayedCache();await api.saveConnection({mode,serverUrl:$('serverUrl').value,networkToken,...(mode==='client'?{networkProvider:$('networkProvider').value}:{})});await loadConnection();await load();message('统一连接已保存。');}catch(e){await loadConnection();if(isClient())await load().catch(()=>{});message(e);}};
$('checkConnection').onclick=async()=>{const button=$('checkConnection');button.disabled=true;connectionHealthSequence++;renderConnectionHealth({state:'checking',label:'正在检查连接…',detail:'正在核对实际服务和身份。'});try{await api.checkConnection();await loadConnection();if(isClient())await load();}catch(e){message(e);}finally{button.disabled=false;await pollConnectionStatus({force:true});}};
$('connectionMode').onchange=networkVisibility;
$('networkProvider').onchange=networkVisibility;
$('privateNetworkLogin').onclick=()=>privateNetworkAction('networkLogin');
$('privateNetworkConnect').onclick=()=>privateNetworkAction('networkConnect');
$('privateNetworkLogout').onclick=()=>privateNetworkAction('networkLogout');
setInterval(()=>{if(currentPanel==='settings')void pollPrivateNetwork();},2500);
setInterval(()=>void pollConnectionStatus(),10000);

$('openRepository').onclick=()=>api.openLink('repository').catch(message);
$('openWebsite').onclick=()=>api.openLink('website').catch(message);

if(api.preferences)api.preferences().then(value=>{$('startAtLogin').checked=value.startAtLogin===true;}).catch(message);
$('startAtLogin').onchange=async()=>{const input=$('startAtLogin'),next=input.checked;input.disabled=true;try{await api.savePreferences({startAtLogin:next});message(next?'已启用登录 Windows 时启动工作台。':'已关闭登录 Windows 时启动工作台。');}catch(error){input.checked=!next;message(error);}finally{input.disabled=false;}};
if(api.integrationConfig)api.integrationConfig().then(value=>{$('integrationConfig').textContent=JSON.stringify(value,null,2);$('workbenchVersion').textContent='工作台'+(typeof value.version==='string'?' '+value.version:'');}).catch(message);
$('copyMcp').onclick=()=>api.copyIntegration('mcp').then(()=>message('MCP 配置已复制。')).catch(message);
$('copyCli').onclick=()=>api.copyIntegration('cli').then(()=>message('CLI 配置已复制。')).catch(message);

let logsLoading=false,logsRevision=0;
const logOptions=()=>({source:$('logSource').value,level:$('logLevel').value,query:$('logQuery').value,limit:500});
async function refreshLogPanel(){
 if(logsLoading)return;logsLoading=true;const revision=++logsRevision;$('logRefresh').disabled=true;
 try{const result=await api.readLogs(logOptions());if(revision!==logsRevision)return;
  const list=$('logEntries');list.replaceChildren();
  for(const row of result.entries){const entry=document.createElement('div');entry.className='logLine';entry.dataset.level=row.level;const label=document.createElement('span');label.className='logTag';label.textContent=({info:'信息',warning:'警告',error:'错误'}[row.level]||row.level)+' · '+(names[row.source]||{workbench:'工作台',network:'私网连接',gateway:'业务网关'}[row.source]||row.source);const text=document.createElement('pre');text.textContent=row.text;entry.append(label,text);list.append(entry);}
  if(!result.entries.length){const empty=document.createElement('p');empty.className='logEmpty';empty.textContent='暂无匹配日志。可切换模块、调整筛选条件，或在复现问题后刷新。';list.append(empty);}
  $('logStatus').textContent='最近检查 '+new Date(result.checkedAt).toLocaleTimeString()+' · '+result.entries.length+' 条'+(result.truncated?' · 仅显示最近部分记录':'')+(result.mode==='client'?' · 客户端仅显示本机日志，业务日志请在主机查看':'');
  $('logIssue').textContent=[result.storageError,...result.issues.map(i=>(names[i.source]||i.source)+'：'+i.error)].filter(Boolean).join('；');
 }catch(error){$('logIssue').textContent=error.message;}finally{logsLoading=false;$('logRefresh').disabled=false;}
}
async function openLogPanel(){await panel('logs');await refreshLogPanel();}
$('logs').onclick=()=>openLogPanel().catch(message);$('logsBack').onclick=()=>panel('home').catch(message);
$('logRefresh').onclick=()=>refreshLogPanel();
for(const id of ['logSource','logLevel'])$(id).onchange=()=>refreshLogPanel();
$('logQuery').onkeydown=event=>{if(event.key==='Enter')void refreshLogPanel();};
for(const [id,run]of [['logCopy',()=>api.copyLogs(logOptions()).then(r=>message('已复制 '+r.copied+' 条日志。'))],['logExport',()=>api.exportLogs().then(r=>{if(r.exported)message('诊断报告已保存：'+r.filename);})],['logFolder',()=>api.openLogsFolder()]])$(id).onclick=async()=>{$(id).disabled=true;try{await run();}catch(e){message(e);}finally{$(id).disabled=false;}};
setInterval(()=>{if(currentPanel==='logs'&&!document.hidden&&$('logAuto').checked)void refreshLogPanel();},5000);
window.addEventListener('error',event=>{Promise.resolve(api.reportDiagnostic?.({level:'error',text:String(event.error?.stack||event.message||'页面运行异常').slice(0,6000)})).catch(()=>{});});
window.addEventListener('unhandledrejection',event=>{Promise.resolve(api.reportDiagnostic?.({level:'error',text:String(event.reason?.stack||event.reason||'页面请求异常').slice(0,6000)})).catch(()=>{});});
