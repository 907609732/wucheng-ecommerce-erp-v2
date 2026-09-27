import assert from "node:assert/strict";
import test from "node:test";
import { validateCainiaoInventoryRows } from "../core/erp/inventory-validation.js";

function row({ date, sku, beginning, inbound, outbound, ending, sales = 30 }) {
  return {
    "日期": `${date}~${date}`,
    "货品条码": sku,
    "期初库存": String(beginning),
    "入库汇总": String(inbound),
    "出库汇总": String(outbound),
    "期末库存": String(ending),
    "近30天销量": String(sales)
  };
}

test("accepts a complete daily inventory file with continuous stock", () => {
  const previousRows = [
    row({ date: "2026-07-15", sku: "A", beginning: 10, inbound: 0, outbound: 2, ending: 8 }),
    row({ date: "2026-07-15", sku: "B", beginning: 5, inbound: 1, outbound: 0, ending: 6 })
  ];
  const rows = [
    row({ date: "2026-07-16", sku: "A", beginning: 8, inbound: 0, outbound: 3, ending: 5 }),
    row({ date: "2026-07-16", sku: "B", beginning: 6, inbound: 4, outbound: 1, ending: 9 })
  ];
  const result = validateCainiaoInventoryRows(rows, {
    expectedSourceDate: "2026-07-16",
    previousRows,
    minRows: 2
  });
  assert.equal(result.ok, true);
  assert.equal(result.sourceDate, "2026-07-16");
  assert.equal(result.totalQuantity, 14);
});

test("blocks a file whose source date or stock arithmetic is wrong", () => {
  const rows = [
    row({ date: "2026-07-17", sku: "A", beginning: 8, inbound: 0, outbound: 3, ending: 7 }),
    row({ date: "2026-07-17", sku: "A", beginning: 6, inbound: 0, outbound: 1, ending: 5 })
  ];
  const result = validateCainiaoInventoryRows(rows, {
    expectedSourceDate: "2026-07-16",
    minRows: 2
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /来源日期异常/);
  assert.match(result.errors.join("\n"), /库存不平/);
  assert.match(result.errors.join("\n"), /货品条码重复/);
});

test("blocks a cross-day discontinuity", () => {
  const previousRows = [
    row({ date: "2026-07-15", sku: "A", beginning: 10, inbound: 0, outbound: 2, ending: 8 }),
    row({ date: "2026-07-15", sku: "B", beginning: 5, inbound: 1, outbound: 0, ending: 6 })
  ];
  const rows = [
    row({ date: "2026-07-16", sku: "A", beginning: 80, inbound: 0, outbound: 3, ending: 77 }),
    row({ date: "2026-07-16", sku: "B", beginning: 6, inbound: 0, outbound: 1, ending: 5 })
  ];
  const result = validateCainiaoInventoryRows(rows, {
    expectedSourceDate: "2026-07-16",
    previousRows,
    minRows: 2
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /跨日库存不连续/);
});
