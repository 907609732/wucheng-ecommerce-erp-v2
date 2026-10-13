const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inventoryApp", {
  getPddMonthlyState: () => ipcRenderer.invoke('pdd-monthly:state'),
  openPddMonthly: input => ipcRenderer.invoke('pdd-monthly:open', input),
  startPddMonthly: input => ipcRenderer.invoke('pdd-monthly:start', input),
  stopPddMonthly: () => ipcRenderer.invoke('pdd-monthly:stop'),
  exportPddMonthly: input => ipcRenderer.invoke('pdd-monthly:export', input),
  onPddMonthlyProgress: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('pdd-monthly:progress', listener); return () => ipcRenderer.removeListener('pdd-monthly:progress', listener); },
  launchInvoiceAssistant: () => ipcRenderer.invoke('invoice:launch-assistant'),
  launchInvoiceWatch: () => ipcRenderer.invoke('invoice:launch-watch'),
  launchInvoiceLegacy: () => ipcRenderer.invoke('invoice:launch-legacy'),
  openInvoiceFolder: () => ipcRenderer.invoke('invoice:folder'),
  listInvoiceShops: () => ipcRenderer.invoke('invoice-shops:list'),
  addInvoiceShop: (name, platform) => ipcRenderer.invoke('invoice-shops:add', name, platform),
  renameInvoiceShop: (id, name) => ipcRenderer.invoke('invoice-shops:rename', id, name),
  openInvoiceShopLogin: (id) => ipcRenderer.invoke('invoice-shops:open-login', id),
  readInvoiceShopAccount: (id) => ipcRenderer.invoke('invoice-shops:login-account', id),
  confirmInvoiceShop: (id, account) => ipcRenderer.invoke('invoice-shops:confirm', id, account),
  removeInvoiceShop: (id) => ipcRenderer.invoke('invoice-shops:remove', id),
  getInvoiceLogs: () => ipcRenderer.invoke('invoice:logs'),
  openInvoiceLogs: () => ipcRenderer.invoke('invoice:open-logs'),
  onInvoiceLog: (callback) => { const listener = (_event, entry) => callback(entry); ipcRenderer.on('invoice:log', listener); return () => ipcRenderer.removeListener('invoice:log', listener); },
  getInvoiceInspectionSummary: () => ipcRenderer.invoke('invoice-inspection:summary'),
  getInvoiceInspectionHistory: (limit) => ipcRenderer.invoke('invoice-inspection:history', limit),
  getInvoiceInspectionSchedule: () => ipcRenderer.invoke('invoice-inspection:schedule'),
  saveInvoiceInspectionSchedule: (value) => ipcRenderer.invoke('invoice-inspection:save-schedule', value),
  scanInvoiceInspectionNow: () => ipcRenderer.invoke('invoice-inspection:scan-now'),
  scanInvoiceShop: (id) => ipcRenderer.invoke('invoice-inspection:scan-shop', id),
  onInvoiceInspectionChanged: (callback) => { const listener = (_event, summary) => callback(summary); ipcRenderer.on('invoice-inspection:changed', listener); return () => ipcRenderer.removeListener('invoice-inspection:changed', listener); },
  getBranding: () => ipcRenderer.invoke("branding:get"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getAbout: () => ipcRenderer.invoke("app:about"),
  getEditableSecrets: () => ipcRenderer.invoke("secrets:get-editable"),
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  saveSettingsSection: (payload) => ipcRenderer.invoke("settings:save-section", payload),
  loginRemoteServer: () => ipcRenderer.invoke("remote:login"),
  testRemoteServer: () => ipcRenderer.invoke("remote:test"),
  runNow: () => ipcRenderer.invoke("task:run"),
  refreshLogin: () => ipcRenderer.invoke("task:login"),
  stopTask: () => ipcRenderer.invoke("task:stop"),
  getState: () => ipcRenderer.invoke("task:state"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  getInventory: () => ipcRenderer.invoke("inventory:get"),
  getMonthlySales: (filters) => ipcRenderer.invoke("monthly-sales:get", filters),
  syncMonthlySales: (payload) => ipcRenderer.invoke("monthly-sales:sync", payload),
  backfillMonthlySales: (payload) => ipcRenderer.invoke("monthly-sales:backfill", payload),
  openLogs: () => ipcRenderer.invoke("logs:open"),
  openData: () => ipcRenderer.invoke("data:open"),
  openRepository: () => ipcRenderer.invoke("repository:open"),
  getIntegration: () => ipcRenderer.invoke("integration:get"),
  getUpdateState: () => ipcRenderer.invoke("update:get"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("inventory:state", listener);
    return () => ipcRenderer.removeListener("inventory:state", listener);
  },
  onLog: (callback) => {
    const listener = (_event, item) => callback(item);
    ipcRenderer.on("inventory:log", listener);
    return () => ipcRenderer.removeListener("inventory:log", listener);
  },
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },
  onSettingsRefresh: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("settings:refresh", listener);
    return () => ipcRenderer.removeListener("settings:refresh", listener);
  },
  onInventoryUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("inventory:updated", listener);
    return () => ipcRenderer.removeListener("inventory:updated", listener);
  },
  onMonthlySalesUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("monthly-sales:updated", listener);
    return () => ipcRenderer.removeListener("monthly-sales:updated", listener);
  },
  onRemoteConnection: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("remote:connection", listener);
    return () => ipcRenderer.removeListener("remote:connection", listener);
  }
});
