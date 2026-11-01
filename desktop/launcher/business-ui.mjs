const labels={overview:'经营',purchase:'采购',sales:'销售',warehouse:'云仓',exporter:'订单导出'};
const primary=['overview','purchase','sales'];

/** Each module keeps its existing native view and unsaved form state. */
export function createBusinessWorkspace({launcher=window.launcher,loading,showError,notice,onNavigate}){
  const $=id=>document.getElementById(id),tabs=[...document.querySelectorAll('.business-tabs [data-desk]')],surface=$('business-surface');
  let active='overview',visible=false,nativeVisible=false,opening=false,failed=false,epoch=0,measureEpoch=0,locationEpoch=0,lastBounds='',disposed=false,suspended=false,sourceJourney=null;
  try{const last=localStorage.getItem('wucheng.workbench.lastPrimary');if(primary.includes(last))active=last;}catch{}
  const covered=()=>suspended||document.hidden||$('business-more').open||$('business-review-dialog').open;
  function clearSource(){locationEpoch++;sourceJourney=null;$('business-source-note').hidden=true;$('business-source-retry').hidden=true;}
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
  function sourceMessage(message,status='pending'){
    if(!sourceJourney)return;sourceJourney.status=status;const locator=sourceJourney.locator;
    $('business-source-note').hidden=false;$('business-source-label').textContent=[message,locator.period&&'期间 '+locator.period,locator.recordId&&'记录 '+locator.recordId,locator.sourceId&&'来源 '+locator.sourceId].filter(Boolean).join(' · ');
    $('business-source-back').hidden=!sourceJourney.origin;$('business-source-back').textContent=sourceJourney.origin?'返回'+labels[sourceJourney.origin]+'工作台':'返回原工作台';
    $('business-source-retry').hidden=!['blocked','not-found','error'].includes(status);$('business-source-retry').disabled=status==='pending';
  }
  async function locateSource(){
    const journey=sourceJourney;if(!journey||!visible||!nativeVisible||active!==journey.locator.module)return;const mine=++locationEpoch,operation=epoch;sourceMessage('正在核对来源定位');
    try{const result=await launcher.businessSurface({module:active,action:'navigate',locator:journey.locator});if(mine!==locationEpoch||operation!==epoch||journey!==sourceJourney||!visible)return;
      const messages={located:'已定位来源明细',navigated:'已切换到来源工作面',blocked:'目标页面有未保存内容或正在保存，请处理后重新定位',unsupported:'已打开工作台，暂不支持明细定位','not-found':'未找到目标来源记录，未定位到其他记录'};sourceMessage(messages[result?.status]||'来源定位尚未完成',result?.status||'error');
    }catch(error){if(mine===locationEpoch&&journey===sourceJourney)sourceMessage('来源定位未完成：'+String(error.message||error),'error');}
  }
  async function openDesk(id,route,{preserveSource=false}={}){
    if(!Object.hasOwn(labels,id)||disposed)return;if(!preserveSource)clearSource();
    if(id===active&&nativeVisible&&!opening&&!failed&&!route){await measure();return {opened:true,id,cached:true};}
    if(route&&active===id&&nativeVisible&&!confirm('即将定位到新的'+labels[id]+'页面。请先确认当前表单已经保存，再继续。'))return;
    const mine=++epoch;opening=true;failed=false;$('business-more').open=false;
    try{
      await hideNative();if(mine!==epoch||!visible)return;
      if(typeof launcher?.open!=='function'||typeof launcher?.bounds!=='function')throw Error('当前窗口没有业务内嵌能力，请使用完整桌面版。');
      if(primary.includes(id)){changeActive(id);$('business-failure').hidden=true;loading($('business-loading'),'正在打开'+labels[id]+'工作台','content');}
      const rect=surface.getBoundingClientRect();if(primary.includes(id)){if(covered()||rect.width<=0||rect.height<=0)return;await launcher.bounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height});}
      if(mine!==epoch||!visible||covered())return;const result=await launcher.open(id,route);if(mine!==epoch||!visible||covered()||result?.cancelled){if(!visible||covered())await launcher.hide();return;}
      if(primary.includes(id)||result?.id===id){changeActive(id);nativeVisible=true;}else notice('已请求打开'+labels[id]+'，沿用其现有业务窗口。');
      return {opened:true,id};
    }catch(error){if(mine===epoch){failed=true;$('business-failure-message').textContent=String(error.message||error);$('business-failure').hidden=false;showError(error);}}
    finally{if(mine===epoch){$('business-loading').replaceChildren();opening=false;if(visible)void measure().catch(showError);}}
  }
  async function show({id=active,route,locator,sourceModule}={}){
    if(locator&&(!primary.includes(id)||locator.module!==id)){showError(Error('来源定位与目标工作台不一致，未执行导航。'));return;}
    visible=true;if(locator){sourceJourney={locator:structuredClone(locator),origin:primary.includes(sourceModule)?sourceModule:null};sourceMessage('正在打开来源工作台');}
    const result=await openDesk(id,locator?undefined:route,{preserveSource:!!locator});if(locator&&result?.opened)await locateSource();
  }
  async function leave(){visible=false;const mine=++epoch;opening=false;await launcher.hide();if(mine===epoch){nativeVisible=false;lastBounds='';}}
  for(const button of document.querySelectorAll('[data-desk]'))button.addEventListener('click',()=>void openDesk(button.dataset.desk));
  tabs.forEach((tab,index)=>tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();void openDesk(tabs[next].dataset.desk);}));
  $('business-retry').addEventListener('click',()=>void openDesk(active));
  $('business-more').addEventListener('toggle',()=>{if($('business-more').open)void hideNative().catch(showError);else if(visible&&!opening)void measure().catch(showError);});
  $('business-source-back').addEventListener('click',()=>{const id=sourceJourney?.origin;if(id)void openDesk(id);});$('business-source-retry').addEventListener('click',()=>void locateSource());
  const unsubscribe=launcher?.onNavigate?.(value=>{if(Object.hasOwn(labels,value?.id))void onNavigate('business',{desk:value});else if(['settings','logs','help'].includes(value?.id))void onNavigate('settings');else if(value?.id==='home')void onNavigate('business');});
  const unsubscribeInvalidated=launcher?.onDeskInvalidated?.(value=>{if(value?.id!==active)return;++epoch;opening=false;nativeVisible=false;failed=true;lastBounds='';$('business-loading').replaceChildren();$('business-failure-message').textContent=labels[active]+'页面已退出，点击重试重新打开。';$('business-failure').hidden=false;});
  let measurementFrame=null;
  function scheduleMeasure(){if(disposed||measurementFrame!==null)return;measurementFrame=requestAnimationFrame(()=>{measurementFrame=null;void measure().catch(showError);});}
  const observer=new ResizeObserver(scheduleMeasure);observer.observe($('business-layout'));
  const visibilityChanged=()=>{if(visible)scheduleMeasure();};document.addEventListener('visibilitychange',visibilityChanged);
  async function suspend(){suspended=true;++epoch;opening=false;await launcher.hide();nativeVisible=false;lastBounds='';$('business-loading').replaceChildren();}
  async function resume(){suspended=false;await measure();}
  updateLabels();return {show,leave,measure,suspend,resume,active:()=>active,dispose(){disposed=true;observer.disconnect();if(measurementFrame!==null)cancelAnimationFrame(measurementFrame);document.removeEventListener('visibilitychange',visibilityChanged);unsubscribe?.();unsubscribeInvalidated?.();}};
}
