import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { getDb } from "./erp/db.js";
import { latestCompleteMonth, previousMonth } from "./erp/warehouse-monthly-sales.js";
import { collectWarehouseMonthlySales } from "./sync-cainiao-monthly-sales.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function monthsBetween(from, to) {
  const months = [];
  let cursor = from;
  while (cursor <= to) {
    months.push(cursor);
    const [year, month] = cursor.split("-").map(Number);
    const next = new Date(Date.UTC(year, month, 1));
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return months;
}

async function main() {
  const to = option("--to") || latestCompleteMonth();
  let from = option("--from");
  if (!from) {
    from = to;
    for (let index = 1; index < 12; index += 1) from = previousMonth(from);
  }
  const db = getDb();
  const months = monthsBetween(from, to);
  for (const month of months) {
    const valid = db.prepare(
      `SELECT 1 FROM warehouse_monthly_sales_validations
        WHERE warehouse_id = 'cainiao' AND month = ? AND status = 'valid' ORDER BY id DESC LIMIT 1`
    ).get(month);
    if (valid) {
      console.log(`${month} 已有校验通过的数据，跳过。`);
      continue;
    }
    // 每月只调用一次导出。任何登录、验证码、滑块、下载或校验问题都会抛错并立即终止循环。
    await collectWarehouseMonthlySales({ month, warehouseId: "cainiao" });
  }
  const missing = months.filter((month) => !db.prepare(
    `SELECT 1 FROM warehouse_monthly_sales_validations
      WHERE warehouse_id = 'cainiao' AND month = ? AND status = 'valid' ORDER BY id DESC LIMIT 1`
  ).get(month));
  if (missing.length) throw new Error(`仍有月份未通过校验：${missing.join("、")}`);

  console.log("全部月份已验证，开始上传一次一致性数据库快照；不会补发历史钉钉消息。");
  const sync = spawnSync(process.execPath, [
    path.join(process.cwd(), "core", "run-monthly-sales-cloud.js"),
    "--month", to,
    "--sync-only",
    "--skip-report"
  ], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  if (sync.error) throw sync.error;
  if (sync.status !== 0) throw new Error(`历史数据云端同步失败，退出码 ${sync.status}`);
  console.log(`历史补抓及单次云端同步完成：${from} 至 ${to}。`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`历史补抓在当前月份停止：${error.message}`);
    process.exitCode = 1;
  });
}
