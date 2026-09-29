import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./erp/db.js";
import { latestCompleteMonth, monthBounds, previousMonth } from "./erp/warehouse-monthly-sales.js";
import { collectWarehouseMonthlySales } from "./sync-cainiao-monthly-sales.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

export function monthsBetween(from, to) {
  monthBounds(from);
  monthBounds(to);
  if (from > to) throw new Error(`起始月份不能晚于结束月份：${from} > ${to}`);
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

export async function backfillWarehouseMonthlySales({
  from: requestedFrom = "",
  to: requestedTo = "",
  database = getDb(),
  collect = collectWarehouseMonthlySales
} = {}) {
  const to = requestedTo || latestCompleteMonth();
  let from = requestedFrom;
  if (!from) {
    from = to;
    for (let index = 1; index < 24; index += 1) from = previousMonth(from);
  }
  const months = monthsBetween(from, to);
  const collected = [];
  const skipped = [];
  for (const month of months) {
    const valid = database.prepare(
      `SELECT 1 FROM warehouse_monthly_sales_validations
        WHERE warehouse_id = 'cainiao' AND month = ? AND status = 'valid' ORDER BY id DESC LIMIT 1`
    ).get(month);
    if (valid) {
      console.log(`${month} 已有校验通过的数据，跳过。`);
      skipped.push(month);
      continue;
    }
    // 每月只调用一次导出。任何登录、验证码、滑块、下载或校验问题都会抛错并立即终止循环。
    await collect({ month, warehouseId: "cainiao" });
    collected.push(month);
  }
  const missing = months.filter((month) => !database.prepare(
    `SELECT 1 FROM warehouse_monthly_sales_validations
      WHERE warehouse_id = 'cainiao' AND month = ? AND status = 'valid' ORDER BY id DESC LIMIT 1`
  ).get(month));
  if (missing.length) throw new Error(`仍有月份未通过校验：${missing.join("、")}`);

  console.log(`历史月销量本地补抓完成：${from} 至 ${to}；不会上传数据库或补发历史钉钉消息。`);
  return { from, to, months, collected, skipped };
}

async function main() {
  await backfillWarehouseMonthlySales({
    from: option("--from"),
    to: option("--to")
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`历史补抓在当前月份停止：${error.message}`);
    process.exitCode = 1;
  });
}
