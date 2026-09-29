import assert from "node:assert/strict";
import test from "node:test";
import { buildMonthlySalesDashboard, defaultBackfillRange } from "../core/erp/monthly-sales-dashboard.js";

function row(month, sku, productName, tocSales, tobSales) {
  return { month, sku, productName, tocSales, tobSales, salesQuantity: tocSales + tobSales };
}

test("dashboard aggregates monthly, yearly, Top 5 and keeps missing months null", () => {
  const rows = [
    row("2025-12", "A", "商品A", 2, 3),
    row("2026-01", "A", "商品A", 5, 5),
    row("2026-01", "B", "商品B", 2, 1),
    row("2026-03", "A", "商品A", 4, 2),
    row("2026-03", "B", "商品B", 1, 1)
  ];
  const validations = ["2025-12", "2026-01", "2026-03"].map((month) => ({ month, status: "valid" }));
  const report = buildMonthlySalesDashboard({ rows, validations, year: "2026", selectedMonth: "2026-03", scope: "sku", sku: "A", now: new Date("2026-09-27T08:00:00Z") });
  assert.equal(report.available, true);
  assert.equal(report.overallSeries.monthly[0], 13);
  assert.equal(report.overallSeries.monthly[1], null);
  assert.equal(report.selectedSeries.monthly[2], 6);
  assert.equal(report.top5Series.find((item) => item.sku === "B").monthly[0], 3);
  assert.equal(report.top5Series.find((item) => item.sku === "B").monthly[2], 2);
  assert.equal(report.summary.totalSales, 16);
  assert.equal(report.summary.validMonthCount, 2);
  assert.equal(report.summary.incomplete, true);
  assert.equal(report.ranking[0].sku, "A");
  assert.equal(report.ranking[0].tocSales, 4);
  assert.equal(report.ranking[0].tobSales, 2);
  assert.equal(report.ranking[0].mom, null);
  assert.equal(report.top5Series.length, 2);
  assert.equal(report.coverage.find((item) => item.year === "2026").validMonthCount, 2);
  assert.equal(report.dueMonth, "2026-08");
});

test("a SKU absent from a validated month is zero while an unvalidated month is null", () => {
  const report = buildMonthlySalesDashboard({
    rows: [row("2026-01", "A", "商品A", 5, 0), row("2026-03", "B", "商品B", 2, 0)],
    validations: ["2026-01", "2026-03"].map((month) => ({ month, status: "valid" })),
    year: "2026",
    scope: "sku",
    sku: "A",
    now: new Date("2026-09-27T08:00:00Z")
  });
  assert.equal(report.selectedSeries.monthly[0], 5);
  assert.equal(report.selectedSeries.monthly[1], null);
  assert.equal(report.selectedSeries.monthly[2], 0);
  assert.equal(report.selectedSeries.annual[0].value, 5);
});

test("complete years are marked complete while partial years remain cumulative", () => {
  const rows = [];
  const validations = [];
  for (let month = 1; month <= 12; month += 1) {
    const value = `2025-${String(month).padStart(2, "0")}`;
    validations.push({ month: value, status: "valid" });
    rows.push(row(value, "A", "商品A", month, 0));
  }
  const report = buildMonthlySalesDashboard({ rows, validations, year: "2025", scope: "overall", now: new Date("2026-09-27T08:00:00Z") });
  assert.equal(report.summary.validMonthCount, 12);
  assert.equal(report.summary.incomplete, false);
  assert.deepEqual(report.overallSeries.annual.find((item) => item.year === "2025"), { year: "2025", value: 78, validMonthCount: 12, complete: true });
});

test("default history range covers 24 complete natural months", () => {
  assert.deepEqual(defaultBackfillRange(new Date("2026-09-27T08:00:00Z")), { from: "2024-09", to: "2026-08" });
});

test("multi-product modes support Top 10, all products, and the steepest month-over-month declines", () => {
  const rows = [];
  for (let index = 1; index <= 12; index += 1) {
    rows.push(row("2026-07", `SKU-${index}`, `商品${index}`, 30 + index, 0));
    rows.push(row("2026-08", `SKU-${index}`, `商品${index}`, index === 12 ? 1 : 30 + index, 0));
  }
  const validations = ["2026-07", "2026-08"].map((month) => ({ month, status: "valid" }));
  const base = { rows, validations, year: "2026", selectedMonth: "2026-08", scope: "multi", now: new Date("2026-09-27T08:00:00Z") };
  const top10 = buildMonthlySalesDashboard({ ...base, seriesMode: "top10" });
  assert.equal(top10.chartSeries.length, 10);
  assert.equal(top10.seriesMode, "top10");
  const all = buildMonthlySalesDashboard({ ...base, seriesMode: "all" });
  assert.equal(all.chartSeries.length, 12);
  const decliners = buildMonthlySalesDashboard({ ...base, seriesMode: "decliners" });
  assert.deepEqual(decliners.chartSeries.map((item) => item.sku), ["SKU-12"]);
  assert.deepEqual(decliners.seriesContext, { fromMonth: "2026-07", toMonth: "2026-08", comparable: true, itemCount: 1 });
});
