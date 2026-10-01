const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inventoryApp", {
  getBranding: () => ipcRenderer.invoke("branding:get"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
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
