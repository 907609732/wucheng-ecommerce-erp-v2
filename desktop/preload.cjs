const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inventoryApp", {
  getFinance: (shop, month) => ipcRenderer.invoke('finance:report', shop, month),
  saveFinanceShop: shop => ipcRenderer.invoke('finance:shop-save', shop),
  beginFinanceShopLogin: month => ipcRenderer.invoke('finance:shop-login-begin', month),
  inspectFinanceShopLogin: token => ipcRenderer.invoke('finance:shop-login-inspect', token),
  confirmFinanceShopLogin: (token, input) => ipcRenderer.invoke('finance:shop-login-confirm', token, input),
  cancelFinanceShopLogin: token => ipcRenderer.invoke('finance:shop-login-cancel', token),
  collectFinance: (shop, month, options) => ipcRenderer.invoke('finance:collect', shop, month, options),
  retryFinance: (shop, month, kinds) => ipcRenderer.invoke('finance:retry', shop, month, kinds),
  cancelFinance: shop => ipcRenderer.invoke('finance:cancel', shop),
  probeFinance: (shop, month) => ipcRenderer.invoke('finance:probe', shop, month),
  getFinanceBatch: id => ipcRenderer.invoke('finance:batch', id),
  previewFinanceBatch: (id, options) => ipcRenderer.invoke('finance:preview-batch', id, options),
  commitFinanceBatch: (id, acknowledged) => ipcRenderer.invoke('finance:commit-batch', id, acknowledged),
  retryFinancePlan: (shop, month) => ipcRenderer.invoke('finance:retry-plan', shop, month),
  getFinanceJob: id => ipcRenderer.invoke('finance:job', id),
  closeFinanceWindow: shop => ipcRenderer.invoke('finance:close-window', shop),
  openFinance: (shop, month) => ipcRenderer.invoke('finance:open', shop, month),
  importFinance: shop => ipcRenderer.invoke('finance:import', shop),
  inspectFinance: id => ipcRenderer.invoke('finance:inspect', id),
  previewFinance: (token, options) => ipcRenderer.invoke('finance:preview', token, options),
  commitFinance: (token, acknowledged) => ipcRenderer.invoke('finance:commit', token, acknowledged),
  restoreFinance: id => ipcRenderer.invoke('finance:restore', id),
  saveFinanceDraft: (shop, month, data) => ipcRenderer.invoke('finance:draft', shop, month, data),
  exportFinance: (shop, month, originalId) => ipcRenderer.invoke('finance:export', shop, month, originalId),
  openFinanceFolder: () => ipcRenderer.invoke('finance:folder'),
  onFinanceChanged: callback => { const listener = (_event, message) => callback(message); ipcRenderer.on('finance:changed', listener); return () => ipcRenderer.removeListener('finance:changed',listener); },
  getBusiness: (filters) => ipcRenderer.invoke('business:get', filters),
  syncBusinessDingTalk: () => ipcRenderer.invoke('business:dingtalk-sync'),
  openBusinessDingTalk: () => ipcRenderer.invoke('business:dingtalk-open'),
  onBusinessProgress: (callback) => { const listener = (_event,message) => callback(message); ipcRenderer.on('business:progress',listener); return () => ipcRenderer.removeListener('business:progress',listener); },
  getBusinessSheets: (year) => ipcRenderer.invoke('business:sheets', year),
  saveBusinessCells: (payload) => ipcRenderer.invoke('business:save-cells', payload),
  previewBusinessImport: () => ipcRenderer.invoke('business:preview'),
  commitBusinessImport: (preview) => ipcRenderer.invoke('business:commit', preview),
  cancelBusinessImport: (token) => ipcRenderer.invoke('business:cancel', token),
  getBusinessVersions: () => ipcRenderer.invoke('business:versions'),
  restoreBusinessVersion: (id) => ipcRenderer.invoke('business:restore', id),
  getBusinessImage: (id) => ipcRenderer.invoke('business:image', id),
  exportBusiness: (payload) => ipcRenderer.invoke('business:export', payload),
  getPurchaseCollection: (filters) => ipcRenderer.invoke('purchase:read', filters),
  getPurchaseWorkbook: () => ipcRenderer.invoke('purchase:workbook-read'),
  savePurchaseWorkbook: payload => ipcRenderer.invoke('purchase:workbook-save', payload),
  listPurchaseWorkbookHistory: () => ipcRenderer.invoke('purchase:workbook-history'),
  diffPurchaseWorkbookRevision: (revision) => ipcRenderer.invoke('purchase:workbook-diff', revision),
  setPurchaseWorkbookDirty: value => ipcRenderer.invoke('purchase:workbook-dirty', value),
  exportPurchaseWorkbook: snapshot => ipcRenderer.invoke('purchase:workbook-export', snapshot),
  getPurchaseAutoState: () => ipcRenderer.invoke('purchase:auto-state'),
  openPurchaseLogs: () => ipcRenderer.invoke('purchase:open-logs'),
  startPurchaseAuto: meta => ipcRenderer.invoke('purchase:auto-start', meta),
  stopPurchaseAuto: () => ipcRenderer.invoke('purchase:auto-stop'),
  openPurchaseAuto: meta => ipcRenderer.invoke('purchase:auto-open', meta),
  onPurchaseProgress: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('purchase:progress', listener); return () => ipcRenderer.removeListener('purchase:progress', listener); },
  previewPurchaseImport: (meta) => ipcRenderer.invoke('purchase:preview', meta),
  manualPreviewPurchase: (rows, meta) => ipcRenderer.invoke('purchase:manual-preview', rows, meta),
  commitPurchaseImport: (token) => ipcRenderer.invoke('purchase:commit', token),
  cancelPurchaseImport: (token) => ipcRenderer.invoke('purchase:cancel', token),
  openPurchasePlatform: (platform) => ipcRenderer.invoke('purchase:open-platform', platform),
  backfillPurchaseMonths: (input) => ipcRenderer.invoke('purchase:backfill', input),
  exportYearlyPurchase: (year) => ipcRenderer.invoke('purchase:export-yearly', year),
  rollbackPurchase: (importId) => ipcRenderer.invoke('purchase:rollback', importId),
  rollbackLastPurchase: () => ipcRenderer.invoke('purchase:rollback-last'),
  getPurchaseOperations: (limit) => ipcRenderer.invoke('purchase:operations', limit),
  launchInvoiceAssistant: () => ipcRenderer.invoke('invoice:launch-assistant'),
  launchInvoiceWatch: () => ipcRenderer.invoke('invoice:launch-watch'),
  openInvoiceFolder: () => ipcRenderer.invoke('invoice:folder'),
  getInvoiceInspectionSummary: () => ipcRenderer.invoke('invoice-inspection:summary'),
  getInvoiceInspectionHistory: (limit) => ipcRenderer.invoke('invoice-inspection:history', limit),
  getInvoiceInspectionSchedule: () => ipcRenderer.invoke('invoice-inspection:schedule'),
  saveInvoiceInspectionSchedule: (value) => ipcRenderer.invoke('invoice-inspection:save-schedule', value),
  scanInvoiceInspectionNow: () => ipcRenderer.invoke('invoice-inspection:scan-now'),
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
