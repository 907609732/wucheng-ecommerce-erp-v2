import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";

const appPath = path.resolve("dist", "win-unpacked", "云仓库存同步（测试版）.exe");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cainiao-desktop-ui-"));
const screenshotPath = path.resolve("dist", "desktop-ui-smoke.png");
const firstRunScreenshotPath = path.resolve("dist", "desktop-first-run-smoke.png");
const inventoryScreenshotPath = path.resolve("dist", "desktop-inventory-smoke.png");
const salesScreenshotPath = path.resolve("dist", "desktop-sales-smoke.png");
const salesWideScreenshotPath = path.resolve("dist", "desktop-sales-wide-smoke.png");
const salesAllProductsScreenshotPath = path.resolve("dist", "desktop-sales-all-products-smoke.png");
const salesDeclinersScreenshotPath = path.resolve("dist", "desktop-sales-decliners-smoke.png");

const dataDir = path.join(userDataDir, "workspace", "data");
fs.mkdirSync(dataDir, { recursive: true });
const database = new DatabaseSync(path.join(dataDir, "erp.sqlite"));
database.exec(`
  CREATE TABLE skus (
    sku TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    barcode TEXT NOT NULL DEFAULT '',
    low_stock_threshold INTEGER NOT NULL DEFAULT 10
  );
  CREATE TABLE inventory_snapshots (
    sku TEXT NOT NULL,
    warehouse_id TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    quantity REAL NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE inventory_data_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_id TEXT NOT NULL,
    source_date TEXT NOT NULL,
    status TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    total_quantity REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE monthly_outbound (
    sku TEXT NOT NULL,
    month TEXT NOT NULL,
    total_outbound REAL NOT NULL DEFAULT 0,
    near_30_days_sales REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE warehouse_monthly_sales (
    warehouse_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    month TEXT NOT NULL,
    product_name TEXT NOT NULL,
    toc_sales REAL NOT NULL,
    tob_sales REAL NOT NULL,
    sales_quantity REAL NOT NULL
  );
  CREATE TABLE warehouse_monthly_sales_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_id TEXT NOT NULL,
    month TEXT NOT NULL,
    status TEXT NOT NULL
  );
  INSERT INTO skus (sku, name, barcode, low_stock_threshold) VALUES
    ('SKU-A', '产品A', '1001', 10),
    ('SKU-B', '产品B', '1002', 5),
    ('SKU-C', '产品C', '1003', 2);
  INSERT INTO inventory_snapshots (sku, warehouse_id, snapshot_date, quantity) VALUES
    ('SKU-A', 'cainiao', '2026-09-25', 20),
    ('SKU-B', 'cainiao', '2026-09-25', 5),
    ('SKU-C', 'cainiao', '2026-09-25', 10);
  INSERT INTO monthly_outbound (sku, month, total_outbound, near_30_days_sales) VALUES
    ('SKU-A', '2026-09', 10, 10),
    ('SKU-B', '2026-09', 30, 30),
    ('SKU-C', '2026-09', 15, 0);
  INSERT INTO inventory_data_validations
    (warehouse_id, source_date, status, row_count, total_quantity)
  VALUES ('cainiao', '2026-09-25', 'valid', 3, 35);
`);
const insertMonthlySale = database.prepare("INSERT INTO warehouse_monthly_sales (warehouse_id, sku, month, product_name, toc_sales, tob_sales, sales_quantity) VALUES ('cainiao', ?, ?, ?, ?, ?, ?)");
const insertMonthlyValidation = database.prepare("INSERT INTO warehouse_monthly_sales_validations (warehouse_id, month, status) VALUES ('cainiao', ?, 'valid')");
for (let index = 0; index < 24; index += 1) {
  const date = new Date(Date.UTC(2024, 8 + index, 1));
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  if (month === "2026-02") continue;
  insertMonthlyValidation.run(month);
  insertMonthlySale.run("SKU-A", month, "产品A", 10 + index, 2, 12 + index);
  insertMonthlySale.run("SKU-B", month, "产品B", 3 + index, 1, 4 + index);
  insertMonthlySale.run("SKU-C", month, "产品C", 2, 0, 2);
  for (let skuIndex = 4; skuIndex <= 21; skuIndex += 1) {
    const value = index === 23 && skuIndex % 2 === 0 ? skuIndex : 20 + skuIndex + index;
    insertMonthlySale.run(`SKU-${skuIndex}`, month, `产品${skuIndex}`, value, 0, value);
  }
}
database.close();

const application = await electron.launch({
  executablePath: appPath,
  args: [`--user-data-dir=${userDataDir}`]
});

try {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("h1").waitFor();
  if ((await page.locator("h1").textContent())?.trim() !== "云仓库存同步（测试版）") {
    throw new Error("桌面窗口标题不正确");
  }
  await page.locator("#firstRunSetup").waitFor({ state: "visible" });
  if (!(await page.getByRole("heading", { name: "这台电脑怎么使用 ERP？" }).isVisible())) {
    throw new Error("首次启动未显示角色选择向导");
  }
  await page.locator('[data-setup-mode="server"]').click();
  if (!(await page.locator("#firstRunOperatorField").isVisible()) || !(await page.locator("#firstRunAutostartField").isVisible())) {
    throw new Error("主服务器向导未显示操作员与自启动配置");
  }
  await page.locator('[data-setup-mode="client"]').click();
  if (!(await page.locator("#firstRunServerUrl").isVisible()) || !(await page.locator("#firstRunOperatorField").isHidden())) {
    throw new Error("客户端向导字段显示不正确");
  }
  await page.screenshot({ path: firstRunScreenshotPath, fullPage: true });
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator("#finishFirstRun").click();
  await page.locator("#firstRunSetup").waitFor({ state: "hidden" });
  if (!(await page.locator("#runNow").isVisible()) || !(await page.locator("#checkUpdate").isVisible())) {
    throw new Error("桌面核心控件不可见");
  }
  if (!(await page.locator("#openRepository").isVisible()) || !(await page.locator("#openRepository").innerText()).includes("GitHub 仓库")) {
    throw new Error("顶部 GitHub 仓库入口不可见");
  }
  await page.locator('[data-view="inventory"]').click();
  await page.locator("#inventorySkuCount").getByText("3", { exact: true }).waitFor();
  await page.getByText("产品A", { exact: true }).waitFor();
  await page.getByText("产品C", { exact: true }).waitFor();
  for (const heading of ["库存/销量", "可售天数", "预警"]) {
    await page.getByRole("columnheader", { name: heading }).waitFor();
  }
  await page.getByText("5 / 30", { exact: true }).waitFor();
  await page.getByText("🔴 不够卖 1 周", { exact: true }).waitFor();
  if ((await page.locator("#inventoryValidationState").textContent())?.trim() !== "校验通过") {
    throw new Error("库存页未显示校验通过");
  }
  await page.locator('[data-inventory-filter="alert"]').click();
  await page.getByText("产品B", { exact: true }).waitFor();
  await page.getByText("产品A", { exact: true }).waitFor({ state: "hidden" });
  if (!(await page.getByText(/钉钉报告仍只发送/).isVisible())) {
    throw new Error("库存页未说明钉钉仍只发送预警商品");
  }
  await page.locator('[data-inventory-filter="all"]').click();
  await page.getByText("产品A", { exact: true }).waitFor();
  await page.screenshot({ path: inventoryScreenshotPath, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('[data-view="sales"]').click();
  await page.locator("#salesYearTotal").getByText(/件$/).waitFor();
  if (!(await page.locator("#monthlySalesChart canvas").isVisible()) || !(await page.locator("#annualSalesChart canvas").isVisible())) {
    throw new Error("月销量或年度折线图未渲染");
  }
  if (!(await page.locator("#salesValidMonths").textContent()).includes("不完整")) throw new Error("缺失月份未标记为不完整");
  const series = await page.evaluate(() => echarts.getInstanceByDom(document.getElementById("monthlySalesChart")).getOption().series);
  if (series[0].connectNulls !== false || series[0].data[1] !== null) throw new Error("缺失月份未保留为折线断点");
  await page.locator('[data-sales-scope="multi"]').click();
  await page.waitForFunction(() => echarts.getInstanceByDom(document.getElementById("monthlySalesChart"))?.getOption().series.length === 5);
  await page.locator("#salesSeriesMode").selectOption("all");
  await page.waitForFunction(() => echarts.getInstanceByDom(document.getElementById("monthlySalesChart"))?.getOption().series.length === 21);
  await page.screenshot({ path: salesAllProductsScreenshotPath, fullPage: true });
  await page.locator("#salesSeriesMode").selectOption("decliners");
  await page.waitForFunction(() => document.getElementById("monthlySalesMessage")?.textContent.includes("销量下降最多"));
  const declinerCount = await page.evaluate(() => echarts.getInstanceByDom(document.getElementById("monthlySalesChart"))?.getOption().series.length);
  if (declinerCount !== 9) throw new Error(`下滑商品曲线数量错误：${declinerCount}`);
  await page.screenshot({ path: salesDeclinersScreenshotPath, fullPage: true });
  await page.locator("#salesSku").fill("SKU-A");
  await page.locator("#salesSku").dispatchEvent("change");
  await page.waitForFunction(() => echarts.getInstanceByDom(document.getElementById("monthlySalesChart"))?.getOption().series.length === 2);
  if (!(await page.locator("#salesRankingBody").innerText()).includes("产品A")) throw new Error("单品筛选后排名表未显示产品A");
  await page.evaluate(() => {
    echarts.getInstanceByDom(document.getElementById("monthlySalesChart")).dispatchAction({ type: "legendUnSelect", name: "全店总销量" });
    echarts.getInstanceByDom(document.getElementById("annualSalesChart")).dispatchAction({ type: "legendUnSelect", name: "全店总销量" });
  });
  await page.locator("#salesSku").fill("产品B · SKU-B");
  await page.locator("#salesSku").dispatchEvent("input");
  await page.locator("#salesSku").dispatchEvent("change");
  await page.waitForFunction(() => echarts.getInstanceByDom(document.getElementById("monthlySalesChart"))?.getOption().series?.[1]?.name === "产品B");
  const preservedLegends = await page.evaluate(() => ({
    monthly: echarts.getInstanceByDom(document.getElementById("monthlySalesChart")).getOption().legend[0].selected["全店总销量"],
    annual: echarts.getInstanceByDom(document.getElementById("annualSalesChart")).getOption().legend[0].selected["全店总销量"]
  }));
  if (preservedLegends.monthly !== false || preservedLegends.annual !== false) throw new Error("切换 SKU 后全店销量图例被重新打开");
  if ((await page.locator("#salesSku").inputValue()) !== "产品B · SKU-B") throw new Error("SKU 选择框未显示商品名与 SKU");
  await page.screenshot({ path: salesScreenshotPath, fullPage: true });
  const wideLayout = await page.evaluate(() => {
    const shell = document.querySelector(".shell").getBoundingClientRect();
    const monthly = document.getElementById("monthlySalesChart").getBoundingClientRect();
    const annual = document.getElementById("annualSalesChart").getBoundingClientRect();
    const table = document.querySelector(".sales-table-wrap");
    return { shellWidth: shell.width, monthlyWidth: monthly.width, annualWidth: annual.width, tableFits: table.scrollWidth <= table.clientWidth + 1 };
  });
  if (wideLayout.shellWidth < 1800) throw new Error(`宽屏容器未充分展开：${wideLayout.shellWidth}`);
  if (wideLayout.monthlyWidth < wideLayout.annualWidth * 1.35) throw new Error("宽屏月图未获得更多展示空间");
  if (!wideLayout.tableFits) throw new Error("宽屏排名表仍出现横向溢出");
  await page.screenshot({ path: salesWideScreenshotPath, fullPage: true });
  await page.setViewportSize({ width: 1080, height: 780 });
  await page.locator('[data-view="settings"]').click();
  if (!(await page.getByText("本机每日直发，不依赖服务器、SSH 或 WSL。", { exact: true }).isVisible())) {
    throw new Error("本地直发模式说明不可见");
  }
  if (!(await page.getByRole("heading", { name: "AI Runtime" }).isVisible())) {
    throw new Error("AI Runtime 设置区不可见");
  }
  if (!(await page.locator("#accountSettingsForm").isVisible()) || !(await page.locator("#robotSettingsForm").isVisible())) {
    throw new Error("账号与机器人独立设置区不可见");
  }
  if (!(await page.getByText("不可用", { exact: true }).isVisible())) {
    throw new Error("无凭据的开发打包未显示在线升级不可用");
  }
  if (!(await page.locator("#cliCommand").innerText()).includes("--cli status") || !(await page.locator("#debugCommand").innerText()).includes("--cli doctor") || !(await page.locator("#mcpCommand").innerText()).includes("--mcp-stdio")) {
    throw new Error("AI CLI/MCP 接口信息未显示");
  }
  if (!(await page.locator("#runtimeModes").innerText()).includes("portable") || !(await page.locator("#extensionDirectory").innerText()).includes("extensions")) {
    throw new Error("AI 运行形态或扩展目录未显示");
  }
  await page.locator("#cainiaoUsername").fill("ui-smoke-account");
  await page.locator("#cainiaoPassword").fill("ui-smoke-password");
  await page.locator("#accountSettingsForm button[type='submit']").click();
  await page.locator("#accountSaveMessage").getByText("保存成功", { exact: true }).waitFor();
  if ((await page.locator("#robotConfigState").textContent())?.trim() !== "待配置") {
    throw new Error("账号设置不应要求机器人同时配置");
  }
  await page.locator("#dingtalkClientId").fill("ui-smoke-client");
  await page.locator("#dingtalkClientSecret").fill("ui-smoke-secret");
  await page.locator("#dingtalkRobotCode").fill("ui-smoke-robot");
  await page.locator("#dingtalkConversationId").fill("ui-smoke-conversation");
  await page.locator("#robotSettingsForm button[type='submit']").click();
  await page.locator("#robotSaveMessage").getByText("保存成功", { exact: true }).waitFor();
  await page.locator('[data-view="dashboard"]').click();
  if (!(await page.locator("#stopTask").isHidden())) throw new Error("空闲时不应显示强制中止按钮");
  await page.locator("#refreshLogin").click();
  try {
    await page.locator("#stopTask").waitFor({ state: "visible", timeout: 10000 });
  } catch {
    throw new Error(`登录任务未进入可中止状态：状态=${await page.locator("#runState").textContent()}；日志=${await page.locator("#logs").textContent()}`);
  }
  if ((await page.locator("#runState").textContent())?.trim() !== "正在登录") throw new Error("登录任务状态显示不正确");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#stopTask").click();
  await page.waitForFunction(() => document.getElementById("runState")?.textContent?.trim() === "空闲");
  await page.getByText(/当前任务已由用户强制中止/).waitFor();
  if (!(await page.locator("#stopTask").isHidden())) throw new Error("中止完成后按钮未恢复为空闲状态");
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.locator('[data-view="settings"]').click();
  for (const [selector, expected] of [
    ["#cainiaoPassword", "ui-smoke-password"],
    ["#dingtalkClientId", "ui-smoke-client"],
    ["#dingtalkClientSecret", "ui-smoke-secret"]
  ]) {
    const input = page.locator(selector);
    if ((await input.inputValue()) !== expected || (await input.getAttribute("type")) !== "password") {
      throw new Error(`${selector} 未以密码掩码恢复已保存值`);
    }
  }
  await page.locator('[data-secret-target="cainiaoPassword"]').click();
  if ((await page.locator("#cainiaoPassword").getAttribute("type")) !== "text") {
    throw new Error("菜鸟密码显示按钮未生效");
  }
  await page.locator('[data-secret-target="cainiaoPassword"]').click();
  if ((await page.locator("#cainiaoPassword").getAttribute("type")) !== "password") {
    throw new Error("菜鸟密码隐藏按钮未生效");
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`DESKTOP_UI_SMOKE_OK ${firstRunScreenshotPath} ${screenshotPath} ${inventoryScreenshotPath} ${salesScreenshotPath} ${salesWideScreenshotPath}`);
} finally {
  await application.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
