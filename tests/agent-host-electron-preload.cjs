const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('hostSmoke',{request:value=>ipcRenderer.invoke('agent:request',value)});
