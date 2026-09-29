const api = window.inventoryApp;
let configured = false;
let inventoryGrid = null;
let inventoryReport = null;
let inventoryFilter = "all";
let monthlySalesReport = null;
let monthlySalesScope = "overall";
let monthlySalesChart = null;
let annualSalesChart = null;
let salesChartResizeObserver = null;
let selectedSalesSku = "";
const salesLegendSelection = { monthly: {}, annual: {} };
const byId = (id) => document.getElementById(id);
const fields = {
  cainiaoUsername: byId("cainiaoUsername"),
  scheduleTime: byId("scheduleTime"),
  monthlySalesTime: byId("monthlySalesTime"),
  lowStockThreshold: byId("lowStockThreshold"),
  scheduleEnabled: byId("scheduleEnabled"),
  monthlySalesEnabled: byId("monthlySalesEnabled"),
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
  byId("cliCommand").textContent = `"${cli.command || "云仓库存同步.exe"}" ${cli.examples?.[0] || "--cli status"}`;
  byId("debugCommand").textContent = `"${cli.command || "云仓库存同步.exe"}" ${cli.examples?.[1] || "--cli doctor"}`;
  byId("runtimeModes").textContent = `${(runtime.modes || ["source", "cli", "mcp-stdio", "portable", "installed"]).join(" / ")} · API ${runtime.apiVersion || "1.0.0"}`;
  byId("extensionDirectory").textContent = runtime.extensionDirectory || "workspace\\extensions";
  byId("mcpCommand").textContent = JSON.stringify({ command: mcp.command || "云仓库存同步.exe", args: mcp.args || ["--mcp-stdio"] }, null, 2);
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

function formatQuantity(value) {
  if (value == null) return "--";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value));
}

function formatRate(value) {
  if (value == null) return "无可比";
  return `${value >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
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

function setSelectOptions(select, values, selected, labelFor = (value) => value) {
  const nextValues = values.map(String);
  if (JSON.stringify([...select.options].map((option) => option.value)) !== JSON.stringify(nextValues)) {
    select.replaceChildren(...nextValues.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labelFor(value);
      return option;
    }));
  }
  if (nextValues.includes(String(selected))) select.value = String(selected);
}

function salesSkuDisplay(item) {
  const name = String(item?.productName || item?.sku || "").trim();
  const sku = String(item?.sku || "").trim();
  return name && name !== sku ? `${name} · ${sku}` : sku;
}

function resolveSalesSku(value, options = monthlySalesReport?.skuOptions || []) {
  const query = String(value || "").trim().toLocaleLowerCase("zh-CN");
  if (!query) return null;
  const exact = options.find((item) => [item.sku, item.productName, salesSkuDisplay(item)]
    .some((candidate) => String(candidate || "").trim().toLocaleLowerCase("zh-CN") === query));
  if (exact) return exact;
  const matches = options.filter((item) => [item.sku, item.productName]
    .some((candidate) => String(candidate || "").toLocaleLowerCase("zh-CN").includes(query)));
  return matches.length === 1 ? matches[0] : null;
}

function renderSalesRanking(report) {
  byId("salesRankingTitle").textContent = `${report.selectedMonth} 商品月销量排名`;
  byId("salesCoverageState").textContent = report.ranking.length ? `${report.ranking.length} 个 SKU` : "该月无数据";
  byId("salesCoverageState").classList.toggle("ready", report.ranking.length > 0);
  byId("salesRankingBody").replaceChildren(...report.ranking.map((item, index) => {
    const row = document.createElement("tr");
    const values = [index + 1, item.productName || item.sku, item.sku, formatQuantity(item.tocSales), formatQuantity(item.tobSales), formatQuantity(item.salesQuantity), formatQuantity(item.previousSalesQuantity), formatRate(item.mom)];
    row.replaceChildren(...values.map((value) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      return cell;
    }));
    return row;
  }));
}

function renderSalesCharts(report) {
  monthlySalesChart ||= echarts.init(byId("monthlySalesChart"));
  annualSalesChart ||= echarts.init(byId("annualSalesChart"));
  if (!salesChartResizeObserver && "ResizeObserver" in window) {
    salesChartResizeObserver = new ResizeObserver(() => {
      monthlySalesChart?.resize();
      annualSalesChart?.resize();
    });
    salesChartResizeObserver.observe(byId("monthlySalesChart"));
    salesChartResizeObserver.observe(byId("annualSalesChart"));
  }
  const colors = ["#d95f3b", "#2c7a58", "#4169a1", "#a0608c", "#c18a26", "#6556a8"];
  const lineStyle = (series, index) => ({ width: index === 0 ? 3 : 2, type: report.scope === "sku" && series.sku === "__overall__" ? "dashed" : "solid" });
  const legendFor = (chart) => ({
    type: "scroll", top: 0, left: 8, right: 8, itemGap: 18,
    formatter: (name) => name.length > 22 ? `${name.slice(0, 22)}…` : name,
    textStyle: { color: "#5f5a52", fontSize: 12 },
    selected: { ...salesLegendSelection[chart] }
  });
  monthlySalesChart.setOption({
    animationDuration: 350,
    color: colors,
    tooltip: { trigger: "axis", valueFormatter: (value) => value == null ? "无数据" : `${formatQuantity(value)} 件` },
    legend: legendFor("monthly"),
    grid: { left: 55, right: 22, top: 54, bottom: 42 },
    xAxis: { type: "category", boundaryGap: false, data: report.months.map((month) => `${month.slice(5)}月`) },
    yAxis: { type: "value", name: "件", minInterval: 1 },
    series: report.chartSeries.map((series, index) => ({
      name: series.name, type: "line", smooth: false, connectNulls: false, symbolSize: 8,
      data: series.monthly, lineStyle: lineStyle(series, index), itemStyle: { color: colors[index % colors.length] }
    }))
  }, true);
  monthlySalesChart.off("click");
  monthlySalesChart.off("legendselectchanged");
  monthlySalesChart.off("legendselected");
  monthlySalesChart.off("legendunselected");
  const rememberMonthlyLegend = (params, selected = null) => {
    salesLegendSelection.monthly = { ...salesLegendSelection.monthly, ...(params.selected || {}) };
    if (params.name && selected != null) salesLegendSelection.monthly[params.name] = selected;
  };
  monthlySalesChart.on("legendselectchanged", (params) => rememberMonthlyLegend(params));
  monthlySalesChart.on("legendselected", (params) => rememberMonthlyLegend(params, true));
  monthlySalesChart.on("legendunselected", (params) => rememberMonthlyLegend(params, false));
  monthlySalesChart.on("click", (params) => {
    const month = report.months[params.dataIndex];
    if (!month) return;
    byId("salesMonth").value = month;
    loadMonthlySales();
  });

  const coverage = new Map(report.coverage.map((item) => [item.year, item.validMonthCount]));
  annualSalesChart.setOption({
    animationDuration: 350,
    color: colors,
    tooltip: {
      trigger: "axis",
      formatter: (items) => {
        const year = items[0]?.axisValue || "";
        const validMonths = coverage.get(String(year)) || 0;
        return [`<strong>${escapeHtml(year)} 年</strong>（${validMonths}/12 个有效月${validMonths === 12 ? "" : "，年内累计"}）`, ...items.map((item) => `${item.marker}${escapeHtml(item.seriesName)}：${item.value == null ? "无数据" : `${formatQuantity(item.value)} 件`}`)].join("<br>");
      }
    },
    legend: legendFor("annual"),
    grid: { left: 55, right: 22, top: 54, bottom: 42 },
    xAxis: { type: "category", boundaryGap: false, data: report.years },
    yAxis: { type: "value", name: "件", minInterval: 1 },
    series: report.chartSeries.map((series, index) => ({
      name: series.name, type: "line", connectNulls: false, symbolSize: 9,
      data: series.annual.map((point) => ({ value: point.value, symbol: point.complete ? "circle" : "emptyCircle", itemStyle: { opacity: point.complete ? 1 : 0.55 } })),
      lineStyle: lineStyle(series, index), itemStyle: { color: colors[index % colors.length] }
    }))
  }, true);
  annualSalesChart.off("legendselectchanged");
  annualSalesChart.off("legendselected");
  annualSalesChart.off("legendunselected");
  const rememberAnnualLegend = (params, selected = null) => {
    salesLegendSelection.annual = { ...salesLegendSelection.annual, ...(params.selected || {}) };
    if (params.name && selected != null) salesLegendSelection.annual[params.name] = selected;
  };
  annualSalesChart.on("legendselectchanged", (params) => rememberAnnualLegend(params));
  annualSalesChart.on("legendselected", (params) => rememberAnnualLegend(params, true));
  annualSalesChart.on("legendunselected", (params) => rememberAnnualLegend(params, false));
}

function applyMonthlySalesReport(report) {
  monthlySalesReport = report;
  setSelectOptions(byId("salesYear"), report.years, report.selectedYear);
  setSelectOptions(byId("salesMonth"), report.months, report.selectedMonth, (month) => `${month.slice(5)} 月`);
  byId("salesSkuOptions").replaceChildren(...report.skuOptions.map((item) => {
    const option = document.createElement("option");
    option.value = salesSkuDisplay(item);
    return option;
  }));
  if (report.selectedSku) {
    selectedSalesSku = report.selectedSku;
    const selected = report.skuOptions.find((item) => item.sku === report.selectedSku);
    if (selected) byId("salesSku").value = salesSkuDisplay(selected);
  }
  byId("salesBackfillFrom").value ||= report.defaultBackfill.from;
  byId("salesBackfillTo").value ||= report.defaultBackfill.to;
  byId("monthlySalesDueBanner").classList.toggle("hidden", !report.dueMonth);
  byId("monthlySalesDueTitle").textContent = report.dueMonth ? `${report.dueMonth} 月销量尚未同步` : "月销量已更新";
  byId("monthlySalesDueText").textContent = report.dueMonth ? "按你的设置这里只提醒，不会自动补跑。" : "";
  byId("syncDueMonthlySales").dataset.month = report.dueMonth || report.latestCompleteMonth;
  byId("monthlySalesEmpty").classList.toggle("hidden", report.available);
  byId("monthlySalesContent").classList.toggle("hidden", !report.available);
  byId("salesTotalLabel").textContent = `${report.summary.label} · ${report.selectedYear}`;
  byId("salesYearTotal").textContent = report.available ? `${formatQuantity(report.summary.totalSales)} 件` : "--";
  byId("salesMonthlyAverage").textContent = report.available ? `${formatQuantity(report.summary.averageSales)} 件` : "--";
  byId("salesPeakMonth").textContent = report.summary.peakMonth ? `${report.summary.peakMonth.slice(5)} 月 · ${formatQuantity(report.summary.peakSales)}` : "--";
  byId("salesValidMonths").textContent = `${report.summary.validMonthCount} / 12${report.summary.incomplete ? " · 不完整" : ""}`;
  byId("monthlySalesMessage").textContent = report.available ? "销量口径：toC销售出 + toB销售出。缺失月份保持断点；不完整年度显示为年内累计。" : "尚无已校验的完整月销量数据。";
  if (!report.available) {
    monthlySalesChart?.clear();
    annualSalesChart?.clear();
    return;
  }
  renderSalesCharts(report);
  renderSalesRanking(report);
}

async function loadMonthlySales() {
  byId("refreshMonthlySales").disabled = true;
  try {
    applyMonthlySalesReport(await api.getMonthlySales({
      year: byId("salesYear").value,
      selectedMonth: byId("salesMonth").value,
      scope: monthlySalesScope,
      sku: selectedSalesSku || resolveSalesSku(byId("salesSku").value)?.sku || byId("salesSku").value.trim()
    }));
  } catch (error) {
    byId("monthlySalesMessage").textContent = `月销量读取失败：${error.message}`;
  } finally {
    byId("refreshMonthlySales").disabled = false;
  }
}

function applyState(state) {
  const running = Boolean(state?.running);
  const runningNames = { login: "正在登录", sync: "正在同步库存", "monthly-sales": "正在同步月销量", "monthly-backfill": "正在补抓历史销量" };
  byId("runState").textContent = running ? (runningNames[state.runningKind] || "正在运行") : "空闲";
  const nextRuns = [state?.nextScheduledRun, state?.nextMonthlyScheduledRun].filter(Boolean).sort();
  byId("nextRun").textContent = formatDate(nextRuns[0]);
  byId("statusBadge").textContent = running ? "运行中" : (configured ? "已就绪" : "待配置");
  byId("statusBadge").className = `status ${running ? "running" : (configured ? "ready" : "")}`;
  byId("runNow").disabled = running;
  byId("refreshLogin").disabled = running;
  byId("stopTask").classList.toggle("hidden", !running);
  byId("stopTask").disabled = !running || Boolean(state?.stopRequested);
  byId("stopTask").textContent = state?.stopRequested ? "正在中止…" : "强制中止当前任务";
  for (const id of ["syncDueMonthlySales", "backfillMonthlySales", "emptyBackfillMonthlySales"]) byId(id).disabled = running;
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
  const credentialState = byId("updateCredentialState");
  if (credentialState) {
    const available = state?.credentialAvailable;
    credentialState.textContent = available === true ? "已配置" : (available === false ? "不可用" : "检测中");
    credentialState.classList.toggle("ready", available === true);
  }
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
  if (button.dataset.view === "sales") {
    loadMonthlySales();
    requestAnimationFrame(() => {
      monthlySalesChart?.resize();
      annualSalesChart?.resize();
    });
  }
}));

document.querySelectorAll("[data-sales-scope]").forEach((button) => button.addEventListener("click", () => {
  monthlySalesScope = button.dataset.salesScope;
  document.querySelectorAll("[data-sales-scope]").forEach((item) => item.classList.toggle("active", item === button));
  loadMonthlySales();
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
    monthlySalesTime: fields.monthlySalesTime.value,
    lowStockThreshold: Number(fields.lowStockThreshold.value),
    scheduleEnabled: fields.scheduleEnabled.checked,
    monthlySalesEnabled: fields.monthlySalesEnabled.checked,
    startAtLogin: fields.startAtLogin.checked
  }, {}, "automationSaveMessage");
});
byId("runNow").addEventListener("click", async () => { try { await api.runNow(); } catch (error) { appendLog({ line: `无法启动：${error.message}` }); } });
byId("refreshLogin").addEventListener("click", async () => { try { await api.refreshLogin(); } catch (error) { appendLog({ line: `无法启动登录：${error.message}` }); } });
byId("stopTask").addEventListener("click", async () => {
  if (!window.confirm("确定强制中止当前任务吗？正在操作的菜鸟窗口也会关闭。")) return;
  byId("stopTask").disabled = true;
  byId("stopTask").textContent = "正在中止…";
  try { await api.stopTask(); }
  catch (error) { appendLog({ line: `强制中止失败：${error.message}` }); }
  finally { applyState(await api.getState()); }
});
byId("openData").addEventListener("click", () => api.openData());
byId("openLogs").addEventListener("click", () => api.openLogs());
byId("refreshInventory").addEventListener("click", loadInventory);
byId("refreshMonthlySales").addEventListener("click", loadMonthlySales);
byId("salesYear").addEventListener("change", () => { byId("salesMonth").value = ""; loadMonthlySales(); });
byId("salesMonth").addEventListener("change", loadMonthlySales);
byId("salesSku").addEventListener("input", () => {
  const selected = monthlySalesReport?.skuOptions.find((item) => item.sku === selectedSalesSku);
  if (!selected || byId("salesSku").value !== salesSkuDisplay(selected)) selectedSalesSku = "";
});
byId("salesSku").addEventListener("change", () => {
  const selected = resolveSalesSku(byId("salesSku").value);
  if (selected) {
    selectedSalesSku = selected.sku;
    byId("salesSku").value = salesSkuDisplay(selected);
    monthlySalesScope = "sku";
    document.querySelectorAll("[data-sales-scope]").forEach((item) => item.classList.toggle("active", item.dataset.salesScope === "sku"));
  } else if (byId("salesSku").value.trim()) {
    byId("monthlySalesMessage").textContent = "没有唯一匹配的商品，请从下拉候选中选择。";
    return;
  }
  loadMonthlySales();
});
byId("syncDueMonthlySales").addEventListener("click", async () => {
  const month = byId("syncDueMonthlySales").dataset.month || monthlySalesReport?.latestCompleteMonth;
  if (!month || !window.confirm(`确认从菜鸟同步 ${month} 完整月销量吗？只写入本机，不发送钉钉。`)) return;
  try { await api.syncMonthlySales({ month }); applyState(await api.getState()); }
  catch (error) { appendLog({ line: `月销量同步未启动：${error.message}` }); }
});
async function startBackfillMonthlySales() {
  const from = byId("salesBackfillFrom").value || monthlySalesReport?.defaultBackfill.from;
  const to = byId("salesBackfillTo").value || monthlySalesReport?.defaultBackfill.to;
  if (!from || !to || !window.confirm(`确认逐月补抓 ${from} 至 ${to} 吗？已有有效月份会跳过，全程不发送钉钉。`)) return;
  try { await api.backfillMonthlySales({ from, to }); applyState(await api.getState()); }
  catch (error) { appendLog({ line: `历史月销量补抓未启动：${error.message}` }); }
}
byId("backfillMonthlySales").addEventListener("click", startBackfillMonthlySales);
byId("emptyBackfillMonthlySales").addEventListener("click", startBackfillMonthlySales);
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
api.onMonthlySalesUpdated(loadMonthlySales);
window.addEventListener("resize", () => {
  monthlySalesChart?.resize();
  annualSalesChart?.resize();
});
load().catch((error) => appendLog({ line: `初始化失败：${error.message}` }));
