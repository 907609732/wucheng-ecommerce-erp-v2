const {contextBridge, ipcRenderer} = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(name, ...args);
const on = name => callback => { const listener = (_event, value) => callback(value); ipcRenderer.on(name, listener); return () => ipcRenderer.removeListener(name, listener); };
contextBridge.exposeInMainWorld('launcher', {
  list: invoke('modules:list'), refresh: invoke('modules:refresh'), plan: invoke('modules:plan'),
  install: invoke('modules:install'), cancel: invoke('modules:cancel'), uninstall: invoke('modules:uninstall'),
  open: invoke('modules:open'), offline: invoke('modules:offline'), offlineInstall: invoke('modules:offline-install'),
  offlinePlan:invoke('modules:offline-plan'),
  offlineClose: invoke('modules:offline-close'), openData: invoke('modules:open-data'),
  hide: invoke('desks:hide'), bounds: invoke('desks:bounds'), services: invoke('desks:status'), stop: invoke('desks:stop'),
  onProgress: on('modules:progress'), onNavigate: on('desks:navigate'), onMessage: on('modules:message')
  ,checkUpdate:invoke('launcher:update-check'),installUpdate:invoke('launcher:update-install'),onUpdate:on('launcher:update')
});
