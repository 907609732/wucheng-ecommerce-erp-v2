const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('lingtuShell',{
  open:id=>ipcRenderer.invoke('desks:child-open',id),
  dataChanged:()=>ipcRenderer.invoke('desks:data-changed'),
  onSourceChanged:callback=>{ipcRenderer.on('desks:source-changed',callback);},
  home:()=>ipcRenderer.invoke('desks:child-home')
});
