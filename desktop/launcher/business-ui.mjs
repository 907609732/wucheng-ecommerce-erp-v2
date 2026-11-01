import {loadingMarkup} from '../shared/loading-screen.mjs';
import {createExtensionInstaller} from './extension-installer.mjs';
import {BUSINESS_MODULES,TAB_MODULE_IDS} from './business-modules.mjs';
const labels={...Object.fromEntries(BUSINESS_MODULES.map(module=>[module.id,module.short])),exporter:'订单导出'};
const primary=[...TAB_MODULE_IDS];
const message=error=>String(error?.message||error||'本次操作未完成').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');

/** Each module keeps its existing native view and unsaved form state. */
export function createBusinessWorkspace({launcher=window.launcher,loading,showError,notice,onNavigate}){
  const $=id=>document.getElementById(id),tabs=[...document.querySelectorAll('.business-tabs [data-desk]')],surface=$('business-surface');
  let preparingId=null;
  let active='overview',visible=false,nativeVisible=false,opening=false,failed=false,epoch=0,measureEpoch=0,lastBounds='',disposed=false,suspended=false;
  try{const last=localStorage.getItem('wucheng.workbench.lastPrimary');if(primary.includes(last))active=last;}catch{}
  const covered=()=>suspended||document.hidden||$('business-review-dialog').open;
  const extension=typeof launcher.extensionStatus==='function'?createExtensionInstaller({launcher,beforeShow:async()=>{suspended=true;await hideNative();},afterClose:async()=>{suspended=false;await measure();}}):null;

  function updateLabels(){for(const tab of tabs){const selected=tab.dataset.desk===active;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}if(primary.includes(active)){surface.setAttribute('aria-labelledby','desk-tab-'+active);surface.removeAttribute('aria-label');}else{surface.removeAttribute('aria-labelledby');surface.setAttribute('aria-label',labels[active]);}}
  function changeActive(id){active=id;if(primary.includes(id))try{localStorage.setItem('wucheng.workbench.lastPrimary',id);}catch{}updateLabels();}
  async function hideNative(){lastBounds='';if(nativeVisible||opening){const mine=epoch;await launcher.hide();if(mine===epoch)nativeVisible=false;}}
  async function measure(){
    if(disposed||!visible||opening||failed)return;const mine=epoch,measurement=++measureEpoch,rect=surface.getBoundingClientRect();
    if(covered()||rect.width<=0||rect.height<=0){await hideNative();return;}
    const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height},key=JSON.stringify(bounds);
    if(key!==lastBounds){await launcher.bounds(bounds);if(mine!==epoch||measurement!==measureEpoch||!visible||covered())return;lastBounds=key;}
    if(mine!==epoch||measurement!==measureEpoch||!visible||covered())return;
    if(!nativeVisible){const result=await launcher.open(active);if(mine!==epoch||!visible||covered()||result?.cancelled){if(!visible||covered())await launcher.hide();return;}nativeVisible=true;}
  }


  async function openDesk(id,route){
    if(!Object.hasOwn(labels,id)||disposed)return;
    if(id==='warehouse'&&extension){try{if(!(await extension.request()))return {cancelled:true};}catch(error){showError(error);return {cancelled:true};}}
    if(id===active&&nativeVisible&&!opening&&!failed&&!route){await measure();return {opened:true,id,cached:true};}
    if(route&&active===id&&nativeVisible&&!confirm('即将定位到新的'+labels[id]+'页面。请先确认当前表单已经保存，再继续。'))return;
    const mine=++epoch;preparingId=id;opening=true;failed=false;
    try{
      await hideNative();if(mine!==epoch||!visible)return;
      if(typeof launcher?.open!=='function'||typeof launcher?.bounds!=='function')throw Error('当前窗口没有业务内嵌能力，请使用完整桌面版。');
      if(primary.includes(id)){changeActive(id);$('business-failure').hidden=true;loading($('business-loading'),'正在打开'+labels[id]+'工作台','content');}
      const rect=surface.getBoundingClientRect();if(primary.includes(id)){if(covered()||rect.width<=0||rect.height<=0)return;await launcher.bounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height});}
      if(mine!==epoch||!visible||covered())return;const result=await launcher.open(id,route);if(mine!==epoch||!visible||covered()||result?.cancelled){if(!visible||covered())await launcher.hide();return;}
      if(primary.includes(id)||result?.id===id){changeActive(id);nativeVisible=true;}else notice('已请求打开'+labels[id]+'，沿用其现有业务窗口。');
      return {opened:true,id};
    }catch(error){if(mine===epoch){failed=true;$('business-failure-message').textContent=String(error.message||error);$('business-failure').hidden=false;showError(error);}}
    finally{if(mine===epoch){$('business-loading').replaceChildren();preparingId=null;opening=false;if(visible)void measure().catch(showError);}}
  }
  async function show({id=active,route}={}){visible=true;await openDesk(id,route);}

  async function leave(){visible=false;const mine=++epoch;opening=false;await launcher.hide();if(mine===epoch){nativeVisible=false;lastBounds='';}}
  for(const button of document.querySelectorAll('[data-desk]'))button.addEventListener('click',()=>void openDesk(button.dataset.desk));
  tabs.forEach((tab,index)=>tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();void openDesk(tabs[next].dataset.desk);}));
  $('business-retry').addEventListener('click',()=>void openDesk(active));


  const unsubscribe=launcher?.onNavigate?.(value=>{if(Object.hasOwn(labels,value?.id))void onNavigate('business',{desk:value});else if(['settings','logs','help'].includes(value?.id))void onNavigate('settings');else if(value?.id==='home')void onNavigate('business');});
  const unsubscribeProgress=launcher?.onProgress?.(value=>{
    if(!opening||value?.id!==preparingId||!visible)return;
    const phases={downloading:'正在下载',verify:'正在校验',dependencies:'正在展开依赖',copy:'正在准备程序',runtime:'正在准备运行环境',initialize:'正在初始化测试账本',ready:'准备完成',error:'准备失败',cancelled:'已取消'};
    const total=value.total,current=value.received??value.processed,measured=Number.isFinite(total)&&total>0&&Number.isFinite(current)&&current>=0&&current<=total;
    const target=$('business-loading');target.innerHTML=loadingMarkup({variant:'content',module:preparingId,state:value.phase,status:(phases[value.phase]||'正在准备')+labels[preparingId],note:value.error||(measured?Math.round(current/total*100)+'%':'首次使用需要下载匹配版本的组件。'),progress:measured?{value:current,total}:undefined,logo:'../assets/lingtu-icon.png'});
    if(!['ready','error','cancelled'].includes(value.phase)&&launcher.cancel){const button=document.createElement('button');button.type='button';button.textContent='取消准备';button.addEventListener('click',()=>{button.disabled=true;void launcher.cancel(value.id).catch(showError);});target.append(button);}
  });
  const unsubscribeInvalidated=launcher?.onDeskInvalidated?.(value=>{if(value?.id!==active)return;++epoch;opening=false;nativeVisible=false;failed=true;lastBounds='';$('business-loading').replaceChildren();$('business-failure-message').textContent=labels[active]+'页面已退出，点击重试重新打开。';$('business-failure').hidden=false;});
  let measurementFrame=null;
  function scheduleMeasure(){if(disposed||measurementFrame!==null)return;measurementFrame=requestAnimationFrame(()=>{measurementFrame=null;void measure().catch(showError);});}
  const observer=new ResizeObserver(scheduleMeasure);observer.observe($('business-layout'));
  const visibilityChanged=()=>{if(visible)scheduleMeasure();};document.addEventListener('visibilitychange',visibilityChanged);
  async function suspend(){suspended=true;++epoch;opening=false;await launcher.hide();nativeVisible=false;lastBounds='';$('business-loading').replaceChildren();}
  async function resume(){suspended=false;await measure();}
  updateLabels();return {show,leave,measure,suspend,resume,active:()=>active,dispose(){disposed=true;extension?.dispose();observer.disconnect();if(measurementFrame!==null)cancelAnimationFrame(measurementFrame);document.removeEventListener('visibilitychange',visibilityChanged);unsubscribe?.();unsubscribeInvalidated?.();unsubscribeProgress?.();}};
}
