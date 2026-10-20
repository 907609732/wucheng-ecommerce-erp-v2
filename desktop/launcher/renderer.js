const api = window.launcher, $ = id => document.getElementById(id);
const names = {warehouse:'云仓同步',purchase:'采购台',sales:'销售台',overview:'经营收支总览',exporter:'历史订单导出台','node-runtime':'共享运行环境','browser-runtime':'浏览器组件'};
const descriptions = {warehouse:'同步云仓库存，查看库存与销售变化。',purchase:'采购记账、历史订单导入与支出核对。',sales:'销售账单、运费费用与经营收支总览。'};
let rows = [], chosen, offlineToken, chosenOffline, offlineIds=new Set(), currentPanel = 'home', activeDesk = '';
const node = (tag, text, className) => Object.assign(document.createElement(tag), {textContent:text, ...(className ? {className} : {})});
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
const message = error => { $('message').textContent = error?.message || error || ''; };
const busy = row => row.progress && !['installed','error','cancelled'].includes(row.progress.phase);
const phases = {queued:'等待安装',downloading:'正在下载',verifying:'正在校验',activating:'正在检查服务','component-installed':'组件已安装'};
const button = (label, action, primary = false) => {const b=node('button',label,primary?'primary':'');b.onclick=()=>Promise.resolve().then(action).catch(message);return b;};
async function panel(name) {
  currentPanel = name;
  await api.hide();
  for (const p of ['home','settings','desk']) $(p+'Panel').hidden = p !== name;
}
async function load() { rows=await api.list();render(); }
async function finishInstall(id){
  await load();
  if(id==='exporter'&&currentPanel==='desk'&&activeDesk)await open(activeDesk);
  await open(id);message(names[id]+' 已安装并打开。');
}
function render() {
  $('cards').replaceChildren();
  for (const id of ['warehouse','purchase','sales']) {
    const row=rows.find(r=>r.id===id), card=node('article','','card');
    card.append(node('span',{warehouse:'☁',purchase:'购',sales:'销'}[id],'symbol'),node('h2',names[id]),node('p',descriptions[id]));
    addAction(card,row);$('cards').append(card);
  }
  $('moduleList').replaceChildren();
  for (const row of rows) {
    if(row.id.endsWith('-runtime')&&!row.installed&&!row.available)continue;
    const box=node('article','','moduleRow'),info=node('div',''),actions=node('div','','actions');
    info.append(node('strong',names[row.id]),node('span',row.installed?'已安装':row.external?'已接入原服务':'未安装','badge'));
    info.append(node('p','版本：'+(row.installed?.version||'—')+(row.updateAvailable?' · 新版本 '+row.available.version:'')));
    if(row.external)info.append(node('p','原数据位置：'+row.external.dataDir));
    if(row.progress?.error)info.append(node('p',row.progress.error));
    if(row.installed&&row.updateAvailable)actions.append(button('更新',()=>prepare(row.id)));
    if(row.external&&!busy(row))actions.append(button('安装扩展包版本',()=>prepare(row.id)));
    if(!row.id.endsWith('-runtime'))addAction(actions,row);
    if(row.installed&&!busy(row))actions.append(button('卸载',async()=>{
      if(!window.confirm('卸载 '+names[row.id]+' 的程序文件？账本和登录数据会保留。'))return;
      await api.uninstall(row.id);await load();message('已卸载程序文件，数据已保留。');
    }));
    if((row.installed||row.external)&&!row.id.endsWith('-runtime'))actions.append(button('数据位置',()=>api.openData(row.id)));
    box.append(info,actions);$('moduleList').append(box);
  }
}
function addAction(container,row) {
  if(!row)return;
  if(busy(row)){
    const progress=node('progress','');progress.max=row.progress.total||1;progress.value=row.progress.received||0;
    container.append(node('span',phases[row.progress.phase]||'正在安装'),progress);
    const cancel=button('取消',()=>api.cancel(row.id));cancel.disabled=row.progress.phase==='activating';container.append(cancel);
  }else container.append(button(row.installed||row.external?'打开':'下载使用',()=>row.installed||row.external?open(row.id):prepare(row.id),true));
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
  if(['exporter','warehouse'].includes(id)){await api.open(id);return;}
  await panel('desk');activeDesk=id;$('deskTitle').textContent=names[id];
  const rect=$('extensionFrame').getBoundingClientRect();
  await api.bounds({x:rect.x,y:rect.y,width:rect.width});
  await api.open(id,route);
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
      if(service.status==='running'){const stop=button('停止后台',()=>api.stop(service.extension).then(()=>$('serviceRefresh').click()));stop.disabled=service.busy;box.append(stop);}
      $('serviceList').append(box);
    }
  }catch(e){message(e);}
};
api.onNavigate(({id,route})=>{
  if(id==='home'){panel('home').catch(message);return;}
  const row=rows.find(r=>r.id===id);
  (row?.installed||row?.external?open(id,route):prepare(id)).catch(message);
});
window.addEventListener('resize',()=>{if(currentPanel==='desk'){const r=$('extensionFrame').getBoundingClientRect();api.bounds({x:r.x,y:r.y,width:r.width}).catch(message);}});
load().catch(message);
