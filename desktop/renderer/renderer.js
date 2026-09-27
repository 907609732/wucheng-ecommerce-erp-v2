const api = window.inventoryApp;
let configured = false;
let inventoryGrid = null;
let inventoryReport = null;
let inventoryFilter = "all";
const byId = (id) => document.getElementById(id);
const fields = {
  cainiaoUsername: byId("cainiaoUsername"),
  scheduleTime: byId("scheduleTime"),
  lowStockThreshold: byId("lowStockThreshold"),
  scheduleEnabled: byId("scheduleEnabled"),
  startAtLogin: byId("startAtLogin"),
  dingtalkRobotCode: byId("dingtalkRobotCode"),
  dingtalkConversationId: byId("dingtalkConversationId"),
  dingtalkTargetUserId: byId("dingtalkTargetUserId"),
  dingtalkTargetName: byId("dingtalkTargetName")
};
const editableSecretFields = [
  "cainiaoPassword",
  "dingtalkClientId",
  "dingtalkClientSecret",
  "dingtalkWebhook",
  "dingtalkWebhookSecret"
];

function setSecretVisible(fieldId, visible) {
  const input = byId(fieldId);
  const button = document.querySelector(`[data-secret-target="${fieldId}"]`);
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "隐藏" : "显示";
  button.setAttribute("aria-pressed", String(visible));
  const label = input.closest(".secret-field")?.querySelector("label")?.textContent?.trim() || "敏感内容";
  button.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}${label}`);
}

function hideAllSecrets() {
  for (const fieldId of editableSecretFields) setSecretVisible(fieldId, false);
}

function hydrateSecrets(secrets = {}) {
  for (const fieldId of editableSecretFields) byId(fieldId).value = String(secrets[fieldId] || "");
  hideAllSecrets();
}

function hydrateIntegration(integration) {
  const cli = integration?.cli || {};
  const mcp = integration?.mcp || {};
  const runtime = integration?.runtime || {};
  byId("cliCommand").textContent = `"${cli.command || "五成电子商务集团 ERP V2.exe"}" ${cli.examples?.[0] || "--cli status"}`;
  byId("debugCommand").textContent = `"${cli.command || "五成电子商务集团 ERP V2.exe"}" ${cli.examples?.[1] || "--cli doctor"}`;
  byId("runtimeModes").textContent = `${(runtime.modes || ["source", "cli", "mcp-stdio", "portable", "installed"]).join(" / ")} · API ${runtime.apiVersion || "1.0.0"}`;
  byId("extensionDirectory").textContent = runtime.extensionDirectory || "workspace\\extensions";
  byId("mcpCommand").textContent = JSON.stringify({ command: mcp.command || "五成电子商务集团 ERP V2.exe", args: mcp.args || ["--mcp-stdio"] }, null, 2);
}

function deliveryMode() {
  return document.querySelector('input[name="deliveryMode"]:checked')?.value || "app";
}

function hasAccount(settings) {
  return Boolean(settings.cainiaoUsername && settings.secretFlags.cainiaoPassword);
}

function hasRobot(settings) {
  return settings.deliveryMode === "app"
    ? Boolean(settings.dingtalkRobotCode && settings.dingtalkConversationId && settings.secretFlags.dingtalkClientId && settings.secretFlags.dingtalkClientSecret)
    : Boolean(settings.secretFlags.dingtalkWebhook);
}

function setConfigState(id, ready) {
  const target = byId(id);
  target.textContent = ready ? "已配置" : "待配置";
  target.classList.toggle("ready", ready);
}

function toggleDeliveryFields() {
  const appMode = deliveryMode() === "app";
  byId("appFields").classList.toggle("hidden", !appMode);
  byId("webhookFields").classList.toggle("hidden", appMode);
}

function formatDate(iso) {
  if (!iso) return "未启用";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function formatInventoryUpdatedAt(value) {
  if (!value) return "";
  const normalized = String(value).includes("T") ? String(value) : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function filteredInventoryItems() {
  const items = inventoryReport?.items || [];
  if (inventoryFilter === "critical") return items.filter((item) => item.stockAlert.level === "critical");
  if (inventoryFilter === "alert") return items.filter((item) => item.stockAlert.level !== "ok");
  return items;
}

function renderInventoryGrid() {
  const data = filteredInventoryItems().map((item) => [
    item.name,
    item.sku,
    `${item.quantity} / ${item.near30DaysSales || 0}`,
    Number.isFinite(item.sellableDays) ? Math.round(item.sellableDays) : "—",
    item.stockAlert
  ]);
  const config = {
    columns: [
      { name: "货品名称", width: "320px" },
      { name: "SKU", width: "180px" },
      { name: "库存/销量", width: "140px" },
      { name: "可售天数", width: "120px" },
      {
        name: "预警",
        width: "180px",
        sort: { compare: (a, b) => ({ critical: 0, urgent: 1, warning: 2, ok: 3 }[a.level] - { critical: 0, urgent: 1, warning: 2, ok: 3 }[b.level]) },
        formatter: (cell) => gridjs.html(`<span class="stock-pill ${cell.level}">${cell.label}</span>`)
      }
    ],
    data,
    sort: true,
    search: true,
    pagination: { enabled: true, limit: 50, summary: true },
    language: {
      search: { placeholder: "搜索货品名称或 SKU" },
      pagination: { previous: "上一页", next: "下一页", showing: "显示", results: () => "条", of: "共", to: "至" },
      noRecordsFound: "没有符合条件的库存商品",
      error: "库存表格加载失败"
    }
  };
  if (inventoryGrid) inventoryGrid.updateConfig({ data }).forceRender();
  else inventoryGrid = new gridjs.Grid(config).render(byId("inventoryGrid"));
}

function applyInventoryReport(report) {
  inventoryReport = report;
  if (!report?.available) {
    byId("inventorySourceDate").textContent = "--";
    byId("inventorySkuCount").textContent = "0";
    byId("inventoryTotal").textContent = "0";
    byId("inventoryLowCount").textContent = "0";
    byId("inventoryValidationState").textContent = "暂无数据";
    byId("inventoryValidationState").classList.remove("ready");
    byId("inventoryMessage").textContent = report?.message || "尚无库存数据。";
    byId("inventoryGrid").classList.add("hidden");
    return;
  }
  byId("inventorySourceDate").textContent = report.sourceDate || "--";
  byId("inventorySkuCount").textContent = String(report.skuCount || 0);
  byId("inventoryTotal").textContent = String(report.totalQuantity || 0);
  byId("inventoryLowCount").textContent = String(report.lowStockCount || 0);
  const valid = Boolean(report.validation?.matchesSnapshot);
  byId("inventoryValidationState").textContent = valid ? "校验通过" : "需检查";
  byId("inventoryValidationState").classList.toggle("ready", valid);
  byId("inventoryMessage").textContent = `共 ${report.skuCount} 个 SKU，库存合计 ${report.totalQuantity}。${report.importedAt ? ` 本地更新于 ${formatInventoryUpdatedAt(report.importedAt)}。` : ""}`;
  byId("inventoryGrid").classList.remove("hidden");
  renderInventoryGrid();
}

async function loadInventory() {
  byId("refreshInventory").disabled = true;
  byId("inventoryMessage").textContent = "正在读取本地已校验库存…";
  try {
    applyInventoryReport(await api.getInventory());
  } catch (error) {
    byId("inventoryMessage").textContent = `库存读取失败：${error.message}`;
    byId("inventoryValidationState").textContent = "读取失败";
    byId("inventoryValidationState").classList.remove("ready");
  } finally {
    byId("refreshInventory").disabled = false;
  }
}

function applyState(state) {
  const running = Boolean(state?.running);
  byId("runState").textContent = running ? (state.runningKind === "login" ? "正在登录" : "正在同步") : "空闲";
  byId("nextRun").textContent = formatDate(state?.nextScheduledRun);
  byId("statusBadge").textContent = running ? "运行中" : (configured ? "已就绪" : "待配置");
  byId("statusBadge").className = `status ${running ? "running" : (configured ? "ready" : "")}`;
  byId("runNow").disabled = running;
  byId("refreshLogin").disabled = running;
}

function appendLog(item) {
  const target = byId("logs");
  if (target.textContent === "等待运行…") target.textContent = "";
  target.textContent += `${item.line}\n`;
  target.scrollTop = target.scrollHeight;
}

function applyUpdateState(state) {
  byId("updateState").textContent = state?.message || "未检查";
  byId("installUpdate").classList.toggle("hidden", state?.status !== "ready");
  byId("checkUpdate").disabled = ["checking", "downloading"].includes(state?.status);
}

function hydrateSettings(settings) {
  configured = hasAccount(settings) && hasRobot(settings);
  for (const [key, input] of Object.entries(fields)) input[input.type === "checkbox" ? "checked" : "value"] = settings[key];
  document.querySelector(`input[name="deliveryMode"][value="${settings.deliveryMode}"]`).checked = true;
  byId("cainiaoPassword").placeholder = settings.secretFlags.cainiaoPassword ? "密码已加密保存" : "请输入密码";
  byId("dingtalkClientId").placeholder = settings.secretFlags.dingtalkClientId ? "Client ID 已加密保存" : "请输入 Client ID";
  byId("dingtalkClientSecret").placeholder = settings.secretFlags.dingtalkClientSecret ? "Client Secret 已加密保存" : "请输入 Client Secret";
  byId("dingtalkWebhook").placeholder = settings.secretFlags.dingtalkWebhook ? "Webhook 已加密保存" : "请输入 Webhook";
  byId("dingtalkWebhookSecret").placeholder = settings.secretFlags.dingtalkWebhookSecret ? "加签密钥已加密保存" : "可选";
  byId("loginState").textContent = hasAccount(settings) ? "凭据已保存" : "待配置";
  setConfigState("accountConfigState", hasAccount(settings));
  setConfigState("robotConfigState", hasRobot(settings));
  toggleDeliveryFields();
}

function showSaveResult(id, message, error = false) {
  const target = byId(id);
  target.textContent = message;
  target.classList.toggle("error", error);
}

async function saveSection(section, settings, secrets, messageId) {
  showSaveResult(messageId, "正在保存…");
  try {
    const saved = await api.saveSettingsSection({ section, settings, secrets });
    hydrateSettings(saved);
    hydrateSecrets(await api.getEditableSecrets());
    applyState(await api.getState());
    showSaveResult(messageId, "保存成功");
  } catch (error) {
    showSaveResult(messageId, error.message, true);
  }
}

async function load() {
  const [settings, secrets, integration] = await Promise.all([api.getSettings(), api.getEditableSecrets(), api.getIntegration()]);
  hydrateSettings(settings);
  hydrateSecrets(secrets);
  hydrateIntegration(integration);
  applyState(await api.getState());
  applyUpdateState(await api.getUpdateState());
  const logs = await api.getLogs();
  for (const item of logs) appendLog(item);
}

async function refreshSettings() {
  hydrateSettings(await api.getSettings());
  hydrateSecrets(await api.getEditableSecrets());
  applyState(await api.getState());
}

document.querySelectorAll(".view-tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".view-tab").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.viewPanel !== button.dataset.view));
  if (button.dataset.view !== "settings") hideAllSecrets();
  if (button.dataset.view === "inventory") loadInventory();
}));

document.querySelectorAll("[data-inventory-filter]").forEach((button) => button.addEventListener("click", () => {
  inventoryFilter = button.dataset.inventoryFilter;
  document.querySelectorAll("[data-inventory-filter]").forEach((item) => item.classList.toggle("active", item === button));
  if (inventoryReport?.available) renderInventoryGrid();
}));

document.querySelectorAll("[data-secret-target]").forEach((button) => button.addEventListener("click", () => {
  const fieldId = button.dataset.secretTarget;
  setSecretVisible(fieldId, byId(fieldId).type === "password");
}));
window.addEventListener("blur", hideAllSecrets);

document.querySelectorAll('input[name="deliveryMode"]').forEach((input) => input.addEventListener("change", toggleDeliveryFields));
byId("accountSettingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSection("account", { cainiaoUsername: fields.cainiaoUsername.value }, {
    cainiaoPassword: byId("cainiaoPassword").value
  }, "accountSaveMessage");
});
byId("robotSettingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSection("robot", {
    deliveryMode: deliveryMode(),
    dingtalkRobotCode: fields.dingtalkRobotCode.value,
    dingtalkConversationId: fields.dingtalkConversationId.value,
    dingtalkTargetUserId: fields.dingtalkTargetUserId.value,
    dingtalkTargetName: fields.dingtalkTargetName.value
  }, {
    dingtalkClientId: byId("dingtalkClientId").value,
    dingtalkClientSecret: byId("dingtalkClientSecret").value,
    dingtalkWebhook: byId("dingtalkWebhook").value,
    dingtalkWebhookSecret: byId("dingtalkWebhookSecret").value
  }, "robotSaveMessage");
});
byId("automationSettingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSection("automation", {
    scheduleTime: fields.scheduleTime.value,
    lowStockThreshold: Number(fields.lowStockThreshold.value),
    scheduleEnabled: fields.scheduleEnabled.checked,
    startAtLogin: fields.startAtLogin.checked
  }, {}, "automationSaveMessage");
});
byId("runNow").addEventListener("click", async () => { try { await api.runNow(); } catch (error) { appendLog({ line: `无法启动：${error.message}` }); } });
byId("refreshLogin").addEventListener("click", async () => { try { await api.refreshLogin(); } catch (error) { appendLog({ line: `无法启动登录：${error.message}` }); } });
byId("openData").addEventListener("click", () => api.openData());
byId("openLogs").addEventListener("click", () => api.openLogs());
byId("refreshInventory").addEventListener("click", loadInventory);
byId("checkUpdate").addEventListener("click", async () => {
  try { applyUpdateState(await api.checkForUpdates()); }
  catch (error) { appendLog({ line: `检查更新失败：${error.message}` }); }
});
byId("installUpdate").addEventListener("click", () => api.installUpdate());
api.onState(applyState);
api.onLog(appendLog);
api.onUpdateState(applyUpdateState);
api.onSettingsRefresh(() => {
  refreshSettings().catch((error) => appendLog({ line: `刷新配置失败：${error.message}` }));
});
api.onInventoryUpdated(loadInventory);
load().catch((error) => appendLog({ line: `初始化失败：${error.message}` }));
