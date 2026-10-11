import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-layout-verify-"));
const application = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${userDataDir}`],
  cwd: process.cwd()
});
const applicationProcess = application.process();

try {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator("h1").waitFor();

  if (await page.locator("#firstRunSetup").isVisible()) {
    await page.locator('[data-setup-mode="standalone"]').click();
    await page.locator("#finishFirstRun").click();
    await page.locator("#firstRunSetup").waitFor({ state: "hidden" });
  }

  await page.locator('[data-view="dashboard"]').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.resolve("dist", "layout-verify-dashboard.png"), fullPage: true });

  await page.locator('[data-view="settings"]').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.resolve("dist", "layout-verify-settings.png"), fullPage: true });

  const dashboardButtons = await page.locator('[data-view-panel="dashboard"] .actions button:not(.hidden)').allTextContents();
  console.log("dashboard visible buttons:", JSON.stringify(dashboardButtons));
  const heroButtonCount = await page.locator(".hero button").count();
  console.log("hero button count:", heroButtonCount);
  const badgeInSettings = await page.locator('[data-view-panel="settings"] #statusBadge').isVisible();
  console.log("statusBadge in settings:", badgeInSettings);
  const maintenanceVisible = await page.locator("#maintenanceCard").isVisible();
  console.log("maintenance card visible in settings:", maintenanceVisible);
  console.log("OK");
} finally {
  if (applicationProcess?.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(applicationProcess.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
  }
  await application.close().catch(() => {});
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch {
    console.warn(`临时验证目录将在系统释放句柄后清理：${userDataDir}`);
  }
}
