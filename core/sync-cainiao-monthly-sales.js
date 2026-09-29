import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportFromCainiao } from "./sync-cainiao-inventory.js";
import {
  importWarehouseMonthlySalesFile,
  latestCompleteMonth,
  monthBounds
} from "./erp/warehouse-monthly-sales.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

export async function collectWarehouseMonthlySales({ month, file = "", warehouseId = "cainiao" }) {
  const bounds = monthBounds(month);
  let sourceFile = file ? path.resolve(file) : "";
  if (!sourceFile) {
    console.log(`正在从菜鸟云仓导出 ${bounds.start} 至 ${bounds.end} 的完整自然月数据。`);
    sourceFile = await exportFromCainiao({ startDate: bounds.start, endDate: bounds.end });
  }
  if (!sourceFile || !fs.existsSync(sourceFile)) {
    throw new Error("未获得月销量源文件，已停止本地导入。");
  }
  const result = importWarehouseMonthlySalesFile({ file: sourceFile, month, warehouseId });
  console.log(
    `月销量导入完成：${month}，${result.skuCount} 个 SKU，销量 ${result.totalSalesQuantity} 件${result.unchanged ? "（数据未变化）" : ""}。`
  );
  return result;
}

async function main() {
  const month = option("--month") || latestCompleteMonth();
  await collectWarehouseMonthlySales({
    month,
    file: option("--file"),
    warehouseId: option("--warehouse") || "cainiao"
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`月销量采集失败：${error.message}`);
    process.exitCode = 1;
  });
}
