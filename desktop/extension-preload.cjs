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

}
