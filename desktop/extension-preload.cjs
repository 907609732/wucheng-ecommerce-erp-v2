const {contextBridge,ipcRenderer}=require('electron');
let hostVisible=false;
const visibilityListeners=new Set();
ipcRenderer.on('desks:visibility',(_event,value)=>{hostVisible=value?.visible===true;for(const callback of visibilityListeners){try{callback(hostVisible);}catch{}}});
contextBridge.exposeInMainWorld('lingtuShell',{
  isVisible:()=>hostVisible,
  onVisibilityChanged:callback=>{if(typeof callback!=='function')return ()=>{};visibilityListeners.add(callback);callback(hostVisible);return ()=>visibilityListeners.delete(callback);},
  open:id=>ipcRenderer.invoke('desks:child-open',id),
  dataChanged:()=>ipcRenderer.invoke('desks:data-changed'),
  onSourceChanged:callback=>{const listener=()=>callback();ipcRenderer.on('desks:source-changed',listener);return ()=>ipcRenderer.removeListener('desks:source-changed',listener);},
  home:()=>ipcRenderer.invoke('desks:child-home')
});
if(process.isMainFrame){
  window.addEventListener('wucheng-business-navigate',async event=>{
    let response;
    try{
      const value=event.detail,allowed=['module','recordId','sourceId','batchId','period','basis','view'];
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))||!['overview','purchase','sales'].includes(value.module)||JSON.stringify(value).length>4096)throw Error('业务来源参数无效');
      const locator={};for(const key of allowed)if(value[key]!=null){if(typeof value[key]!=='string')throw Error('业务来源字段无效');locator[key]=value[key];}
      response=await ipcRenderer.invoke('desks:child-navigate',locator);
    }catch(error){response={status:'blocked',reason:error.code||'BUSINESS_NAVIGATION_FAILED',message:'来源页面未能完成跳转，请查看工作台提示'};}
    window.dispatchEvent(new CustomEvent('wucheng-business-navigation-result',{detail:response}));
  });
}
