const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inventoryApp", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getEditableSecrets: () => ipcRenderer.invoke("secrets:get-editable"),
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  saveSettingsSection: (payload) => ipcRenderer.invoke("settings:save-section", payload),
  runNow: () => ipcRenderer.invoke("task:run"),
  refreshLogin: () => ipcRenderer.invoke("task:login"),
  getState: () => ipcRenderer.invoke("task:state"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  getInventory: () => ipcRenderer.invoke("inventory:get"),
  openLogs: () => ipcRenderer.invoke("logs:open"),
  openData: () => ipcRenderer.invoke("data:open"),
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
  }
});
