import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import XLSX from "xlsx";
XLSX.set_fs?.(fs);

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-warehouse-monthly-sales-"));
process.env.ERP_DATA_DIR = testDir;
const {
  buildWarehouseMonthlySalesMarkdown,
  getWarehouseMonthlySales,
  importWarehouseMonthlySalesFile,
  sendWarehouseMonthlySalesReport,
  validateWarehouseMonthlySalesFile
} = await import("../core/erp/warehouse-monthly-sales.js");
const { getDb } = await import("../core/erp/db.js");
const { backfillWarehouseMonthlySales, monthsBetween } = await import("../core/backfill-cainiao-monthly-sales.js");

function writeWorkbook(name, rows) {
  const file = path.join(testDir, name);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "库存明细");
  XLSX.writeFile(workbook, file);
  return file;
}

function validRows(month, values = [["SKU-A", "产品A", 10, 2], ["SKU-B", "产品B", 3, 4]]) {
  const [year, monthNumber] = month.split("-").map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const range = `${month}-01~${month}-${String(end).padStart(2, "0")}`;
  return values.map(([sku, name, toc, tob]) => ({
    日期: range,
    货品商家编码: sku,
    货品名称: name,
    toC销售出: toc,
    toB销售出: tob,
    出库汇总: 999,
    调拨出库: 888
  }));
}

test("完整自然月导入只计算 toC + toB，并保持幂等", () => {
  const file = writeWorkbook("valid-2026-05.xlsx", validRows("2026-05"));
  const first = importWarehouseMonthlySalesFile({ file, month: "2026-05", now: new Date("2026-08-30T00:00:00Z") });
  assert.equal(first.valid, true);
  assert.equal(first.totalSalesQuantity, 19);
  assert.equal(first.unchanged, false);

  const second = importWarehouseMonthlySalesFile({ file, month: "2026-05", now: new Date("2026-08-30T00:00:00Z") });
  assert.equal(second.unchanged, true);
  const rows = getDb().prepare("SELECT sku, toc_sales, tob_sales, sales_quantity FROM warehouse_monthly_sales ORDER BY sku").all();
  assert.deepEqual(rows, [
    { sku: "SKU-A", toc_sales: 10, tob_sales: 2, sales_quantity: 12 },
    { sku: "SKU-B", toc_sales: 3, tob_sales: 4, sales_quantity: 7 }
  ]);
});

test("单日、跨月、重复 SKU、负数和缺列均被拒绝", () => {
  const cases = [
    ["single-day.xlsx", [{ 日期: "2026-04-01~2026-04-01", 货品商家编码: "S1", toC销售出: 1, toB销售出: 0 }]],
    ["cross-month.xlsx", [{ 日期: "2026-03-31~2026-04-30", 货品商家编码: "S1", toC销售出: 1, toB销售出: 0 }]],
    ["duplicate.xlsx", validRows("2026-04", [["S1", "一", 1, 0], ["S1", "一", 2, 0]])],
    ["negative.xlsx", validRows("2026-04", [["S1", "一", -1, 0]])],
    ["missing-column.xlsx", [{ 日期: "2026-04-01~2026-04-30", 货品商家编码: "S1", toC销售出: 1 }]]
  ];
  for (const [name, rows] of cases) {
    const validation = validateWarehouseMonthlySalesFile({
      file: writeWorkbook(name, rows),
      month: "2026-04",
      now: new Date("2026-08-30T00:00:00Z")
    });
    assert.equal(validation.valid, false, name);
  }
});

test("API 数据保留缺失月份 null，并输出排名、环比和 Top 5", () => {
  const april = writeWorkbook("valid-2026-04.xlsx", validRows("2026-04", [["SKU-A", "产品A", 5, 1], ["SKU-B", "产品B", 1, 1]]));
  importWarehouseMonthlySalesFile({ file: april, month: "2026-04", now: new Date("2026-08-30T00:00:00Z") });
  const report = getWarehouseMonthlySales({ from: "2026-04", to: "2026-06", warehouseId: "cainiao" });
  assert.deepEqual(report.months, ["2026-04", "2026-05", "2026-06"]);
  assert.equal(report.monthly[2].totalSales, null);
  assert.equal(report.monthly[2].completeness, "missing");
  assert.deepEqual(report.skuSeries.find((item) => item.sku === "SKU-A").values, [6, 12, null]);
  assert.equal(report.rankingMonth, "2026-06");
  assert.equal(report.ranking.length, 0);
  assert.equal(report.top5.length, 2);
  const may = getWarehouseMonthlySales({ from: "2026-04", to: "2026-05", warehouseId: "cainiao" });
  assert.equal(may.ranking[0].sku, "SKU-A");
  assert.equal(may.ranking[0].mom, 1);
});

test("月报含真实 @ 参数，已发送防重", async () => {
  const sent = [];
  const config = {
    clientId: "client",
    clientSecret: "secret",
    robotCode: "robot",
    conversationId: "cid-group",
    targetUserId: "user-1",
    targetName: "测试用户"
  };
  const sender = async (payload) => {
    sent.push(payload);
    return { processQueryKey: "accepted" };
  };
  const preview = buildWarehouseMonthlySalesMarkdown("2026-05", { publicUrl: "https://erp.example" });
  assert.match(preview.text, /toC销售出 \+ toB销售出/);
  assert.match(preview.text, /查看网站趋势看板/);
  assert.doesNotMatch(buildWarehouseMonthlySalesMarkdown("2026-05").text, /查看网站趋势看板/);
  const first = await sendWarehouseMonthlySalesReport("2026-05", { sender, config });
  assert.equal(first.sent, true);
  assert.match(sent[0].msgParam.text, /^@user-1 测试用户/);
  assert.deepEqual(sent[0].userIds, ["user-1"]);
  const second = await sendWarehouseMonthlySalesReport("2026-05", { sender, config });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "sent");
  assert.equal(sent.length, 1);
});

test("网络未知状态记账且不自动重发", async () => {
  const march = writeWorkbook("valid-2026-03.xlsx", validRows("2026-03"));
  importWarehouseMonthlySalesFile({ file: march, month: "2026-03", now: new Date("2026-08-30T00:00:00Z") });
  const config = {
    clientId: "client",
    clientSecret: "secret",
    robotCode: "robot",
    conversationId: "cid-group",
    targetUserId: "user-1",
    targetName: "测试用户"
  };
  let calls = 0;
  await assert.rejects(
    sendWarehouseMonthlySalesReport("2026-03", {
      config,
      sender: async () => {
        calls += 1;
        const error = new Error("request timeout");
        error.code = "ETIMEDOUT";
        throw error;
      }
    }),
    (error) => error.deliveryStatus === "unknown"
  );
  const result = await sendWarehouseMonthlySalesReport("2026-03", {
    config,
    sender: async () => { calls += 1; }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "unknown");
  assert.equal(calls, 1);
});

test("历史补抓只写本地，跳过已验证月份且不调用云同步", async () => {
  assert.deepEqual(monthsBetween("2025-12", "2026-02"), ["2025-12", "2026-01", "2026-02"]);
  assert.throws(() => monthsBetween("2026-03", "2026-02"), /起始月份不能晚于结束月份/);
  assert.throws(() => monthsBetween("bad-month", "2026-02"));

  const validMonths = new Set(["2026-01"]);
  const collected = [];
  const database = {
    prepare: () => ({
      get: (month) => validMonths.has(month) ? { valid: 1 } : undefined
    })
  };
  const result = await backfillWarehouseMonthlySales({
    from: "2026-01",
    to: "2026-03",
    database,
    collect: async ({ month, warehouseId }) => {
      assert.equal(warehouseId, "cainiao");
      collected.push(month);
      validMonths.add(month);
    }
  });

  assert.deepEqual(collected, ["2026-02", "2026-03"]);
  assert.deepEqual(result.skipped, ["2026-01"]);
  assert.deepEqual(result.collected, ["2026-02", "2026-03"]);
});
