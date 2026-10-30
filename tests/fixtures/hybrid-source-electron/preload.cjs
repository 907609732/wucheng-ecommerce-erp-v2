const {contextBridge,ipcRenderer}=require('electron');
const invoke=name=>(...args)=>ipcRenderer.invoke(name,...args);
const on=name=>callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on(name,listener);return()=>ipcRenderer.removeListener(name,listener);};
contextBridge.exposeInMainWorld('launcher',{
  ready:invoke('launcher:ready'),agentRequest:invoke('agent:request'),
  open:invoke('modules:open'),hide:invoke('desks:hide'),bounds:invoke('desks:bounds'),
  services:invoke('desks:status'),onNavigate:on('desks:navigate'),onMessage:on('modules:message')
});
window.addEventListener('DOMContentLoaded',()=>{
  const banner=document.querySelector('.development-preview');
  if(banner)banner.textContent='源码隔离验收 · 合成空账本 · 非完整测试包 · 请勿填写公司密钥';
});
