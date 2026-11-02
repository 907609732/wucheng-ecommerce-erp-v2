import test from "node:test";
import assert from "node:assert/strict";
import { sourceRecords } from "../apps/overview/lib/sources.mjs";
test("overview indexing preserves first-match semantics, unknown shops and source files", () => {
  const rows = sourceRecords({
    sales: [
      {
        id: "a",
        shop_id: "s",
        batch_id: "b",
        amount: 123,
        kind: "sale",
        currency: "CNY",
        note: "{}",
      },
      {
        id: "x",
        shop_id: "missing",
        batch_id: "missing",
        amount: 1,
        kind: "sale",
        note: "{}",
        source: "manual",
      },
    ],
    shops: [
      { id: "s", name: "first" },
      { id: "s", name: "second" },
    ],
    imports: [
      { id: "b", filename: "first.xlsx" },
      { id: "b", filename: "second.xlsx" },
    ],
    purchase: [],
  });
  assert.equal(rows[0].party, "first");
  assert.equal(rows[0].sourceFile, "first.xlsx");
  assert.equal(rows[1].party, "待确认店铺");
  assert.equal(rows[1].sourceFile, "manual");
});
test("overview source lookup work grows linearly with the number of records", () => {
  let visits = 0;
  const n = 200;
  const imports = Array.from({ length: n }, (_, i) => ({
    get id() {
      visits++;
      return String(i);
    },
    filename: "bill" + i,
  }));
  const sales = Array.from({ length: n }, (_, i) => ({
    id: String(i),
    shop_id: "s",
    batch_id: String(i),
    amount: 1,
    kind: "sale",
    note: "{}",
  }));
  assert.equal(
    sourceRecords({ sales, imports, shops: [], purchase: [] }).length,
    n,
  );
  assert(visits <= n * 3, `lookup visits ${visits} exceed linear bound`);
});
