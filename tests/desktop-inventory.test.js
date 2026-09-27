import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCainiaoInventory } from "../desktop/shared/inventory-store.mjs";

test("desktop inventory reads every SKU from the latest validated Cainiao snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cainiao-inventory-view-"));
  const databasePath = path.join(root, "erp.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
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
        ('SKU-A', 'cainiao', '2026-09-24', 99),
        ('SKU-A', 'cainiao', '2026-09-25', 20),
        ('SKU-B', 'cainiao', '2026-09-25', 5),
        ('SKU-C', 'cainiao', '2026-09-25', 10);
      INSERT INTO monthly_outbound (sku, month, total_outbound, near_30_days_sales) VALUES
        ('SKU-A', '2026-08', 90, 90),
        ('SKU-A', '2026-09', 10, 10),
        ('SKU-B', '2026-09', 30, 30),
        ('SKU-C', '2026-09', 15, 0);
      INSERT INTO inventory_data_validations
        (warehouse_id, source_date, status, row_count, total_quantity)
      VALUES ('cainiao', '2026-09-25', 'valid', 3, 35);
    `);
  } finally {
    database.close();
  }

  try {
    const report = readCainiaoInventory(databasePath);
    assert.equal(report.available, true);
    assert.equal(report.sourceDate, "2026-09-25");
    assert.equal(report.skuCount, 3);
    assert.equal(report.totalQuantity, 35);
    assert.equal(report.lowStockCount, 2);
    assert.equal(report.validation.matchesSnapshot, true);
    assert.deepEqual(report.items.map((item) => [item.sku, item.quantity, item.near30DaysSales, Math.round(item.sellableDays), item.stockAlert.level]), [
      ["SKU-B", 5, 30, 5, "critical"],
      ["SKU-C", 10, 0, 20, "warning"],
      ["SKU-A", 20, 10, 60, "ok"]
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop inventory reports an empty state when the database is missing", () => {
  const report = readCainiaoInventory(path.join(os.tmpdir(), `missing-${Date.now()}.sqlite`));
  assert.equal(report.available, false);
  assert.deepEqual(report.items, []);
});
