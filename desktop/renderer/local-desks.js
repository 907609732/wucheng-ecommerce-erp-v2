const deskApi=window.inventoryApp,deskNames={purchase:'采购台',sales:'销售台',overview:'经营收支总览'};
let openId='',openSequence=0;
const text=(tag,value)=>Object.assign(document.createElement(tag),{textContent:value});
function sendBounds(){const r=document.getElementById('extensionFrame').getBoundingClientRect();return deskApi.deskBounds({x:r.x,y:r.y,width:r.width});}
async function showDesk(id,route){
  if(!deskNames[id])return;
  const sequence=++openSequence;openId=id;
  document.body.classList.add('extension-active');
  document.getElementById('featureManualButton').classList.add('hidden');
  document.querySelectorAll('[data-view-panel]').forEach(p=>p.classList.add('hidden'));
  document.querySelector('.view-tabs').classList.add('hidden');
  document.getElementById('backHome').classList.remove('hidden');
  document.querySelector('h1').textContent=deskNames[id];document.querySelector('.subtitle').textContent='独立服务 · 原账本 · 本机连接';
  const frame=document.getElementById('extensionFrame');frame.classList.remove('hidden');frame.replaceChildren(text('p','正在检查并连接 '+deskNames[id]+'…'));
  document.getElementById('deskSwitcher').classList.remove('hidden');
  try{await sendBounds();await deskApi.openDesk({id,route});if(sequence!==openSequence)return;frame.replaceChildren();}
  catch(e){if(sequence===openSequence)frame.replaceChildren(text('p',e.message),text('p','请到全局设置查看服务路径、版本与运行日志。'));}
}
window.addEventListener('erp:view',()=>{
  document.body.classList.remove('extension-active');
  document.getElementById('featureManualButton').classList.remove('hidden');
  openId='';openSequence++;void deskApi.hideDesks();document.getElementById('extensionFrame').classList.add('hidden');document.getElementById('deskSwitcher').classList.add('hidden');
  if(document.querySelector('[data-view-panel="settings"]')?.classList.contains('hidden')===false)void showStatus();
});
window.addEventListener('resize',()=>{if(openId)void sendBounds();});
document.querySelectorAll('[data-open-desk]').forEach(b=>b.addEventListener('click',()=>showDesk(b.dataset.openDesk)));
deskApi.onDeskNavigate(({id,route})=>{if(id==='home')document.getElementById('backHome').click();else void showDesk(id,route);});
async function showStatus(){
  const list=document.getElementById('deskServiceList');list.replaceChildren(text('p','正在读取服务状态…'));
  try{
    const rows=await deskApi.deskStatus();list.replaceChildren();
    for(const row of rows){
      const box=document.createElement('article');box.className='desk-status-row';
      box.append(text('strong',(deskNames[row.extension]||'订单导出台')+' · '+({running:'运行中',stopped:'未运行',installed:'已安装',missing:'未安装',error:'连接异常'}[row.status]||row.status)));
      box.append(text('p','版本：'+(row.version||'—')+' · 工作区：'+row.root));
      if(row.dataDir)box.append(text('p','数据：'+row.dataDir));
      if(row.error)box.append(text('p',row.error));
      if(row.extension!=='exporter'){
        const logs=text('button','查看运行日志');logs.type='button';logs.onclick=()=>deskApi.deskLogs(row.extension);box.append(logs);
        if(row.status==='running'){const stop=text('button',row.busy?'任务进行中':'停止后台');stop.type='button';stop.disabled=row.busy;stop.onclick=async()=>{stop.disabled=true;try{await deskApi.stopDesk(row.extension);await new Promise(r=>setTimeout(r,500));await showStatus();}catch(e){box.append(text('p',e.message));stop.disabled=false;}};box.append(stop);}
      }list.append(box);
    }
  }catch(e){list.replaceChildren(text('p',e.message));}
}
document.getElementById('refreshDeskServices').addEventListener('click',showStatus);
