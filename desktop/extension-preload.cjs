const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('lingtuShell',{
  open:id=>ipcRenderer.invoke('desks:child-open',id),
  dataChanged:()=>ipcRenderer.invoke('desks:data-changed'),
  onSourceChanged:callback=>{ipcRenderer.on('desks:source-changed',callback);},
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
