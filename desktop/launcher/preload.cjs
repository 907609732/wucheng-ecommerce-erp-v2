const {contextBridge, ipcRenderer} = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(name, ...args);
const on = name => callback => { const listener = (_event, value) => callback(value); ipcRenderer.on(name, listener); return () => ipcRenderer.removeListener(name, listener); };
contextBridge.exposeInMainWorld('launcher', {
  agentRequest: invoke('agent:request'),
  openLink: invoke('links:open'),
  readLogs:invoke('diagnostics:read'),copyLogs:invoke('diagnostics:copy'),exportLogs:invoke('diagnostics:export'),openLogsFolder:invoke('diagnostics:open-folder'),reportDiagnostic:invoke('diagnostics:event'),
  ready:invoke('launcher:ready'),
  personnelState:invoke('personnel:state'),selectPersonnel:invoke('personnel:select'),
  preferences:invoke('launcher:preferences'),savePreferences:invoke('launcher:preferences-save'),integrationConfig:invoke('launcher:integration-config'),copyIntegration:invoke('launcher:copy-integration'),
  connection:invoke('connection:get'),connectionStatus:invoke('connection:status'),saveConnection:invoke('connection:save'),checkConnection:invoke('connection:check'),cached:invoke('connection:cached'),
  networkPlan:invoke('connection:network-plan'),
  networkStatus:invoke('tailnet:status'),networkLogin:invoke('tailnet:login'),networkConnect:invoke('tailnet:connect'),networkLogout:invoke('tailnet:logout'),
  migrationStage:invoke('migration:stage'),migrationGet:invoke('migration:get'),migrationSelect:invoke('migration:select'),migrationConfirm:invoke('migration:confirm'),migrationCommit:invoke('migration:commit'),migrationArchive:invoke('migration:archive'),
  migrationRecover:invoke('migration:recover'),
  migrationList:invoke('migration:list'),
  releaseSource:invoke('migration:release-source'),
  permissions:invoke('permissions:get'),savePermissions:invoke('permissions:save'),
  list: invoke('modules:list'), refresh: invoke('modules:refresh'), plan: invoke('modules:plan'),
  install: invoke('modules:install'), cancel: invoke('modules:cancel'), uninstall: invoke('modules:uninstall'),
  open: invoke('modules:open'), offline: invoke('modules:offline'), offlineInstall: invoke('modules:offline-install'),
  offlinePlan:invoke('modules:offline-plan'),
  offlineClose: invoke('modules:offline-close'), openData: invoke('modules:open-data'),
  hide: invoke('desks:hide'), bounds: invoke('desks:bounds'), services: invoke('desks:status'), stop: invoke('desks:stop'),
  onProgress: on('modules:progress'), onNavigate: on('desks:navigate'), onMessage: on('modules:message')
  ,checkUpdate:invoke('launcher:update-check'),installUpdate:invoke('launcher:update-install'),onUpdate:on('launcher:update')
});
