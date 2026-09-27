import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";

const appPath = path.resolve("dist", "win-unpacked", "五成电子商务集团 ERP V2.exe");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cainiao-desktop-ui-"));
const screenshotPath = path.resolve("dist", "desktop-ui-smoke.png");
const inventoryScreenshotPath = path.resolve("dist", "desktop-inventory-smoke.png");

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
database.close();

const application = await electron.launch({
  executablePath: appPath,
  args: [`--user-data-dir=${userDataDir}`]
});

try {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("h1").waitFor();
  if ((await page.locator("h1").textContent())?.trim() !== "五成电子商务集团 ERP V2") {
    throw new Error("桌面窗口标题不正确");
  }
  if (!(await page.locator("#runNow").isVisible()) || !(await page.locator("#checkUpdate").isVisible())) {
    throw new Error("桌面核心控件不可见");
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
  if (!(await page.getByText("已内置", { exact: true }).isVisible())) {
    throw new Error("在线升级未显示为内置配置");
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
  console.log(`DESKTOP_UI_SMOKE_OK ${screenshotPath} ${inventoryScreenshotPath}`);
} finally {
  await application.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
