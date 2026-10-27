import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildMonthlySalesDashboard } from "../../core/erp/monthly-sales-dashboard.js";

function hasTable(database, table) {
  return Boolean(database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function readMonthlySalesDashboard(databasePath, filters = {}) {
  if (!fs.existsSync(databasePath)) return buildMonthlySalesDashboard(filters);
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 2_000 });
  try {
    if (!hasTable(database, "warehouse_monthly_sales") || !hasTable(database, "warehouse_monthly_sales_validations")) {
      return buildMonthlySalesDashboard(filters);
    }
    const rows = database.prepare(
      `SELECT month, sku, COALESCE(NULLIF(product_name, ''), sku) AS productName,
              toc_sales AS tocSales, tob_sales AS tobSales, sales_quantity AS salesQuantity
         FROM warehouse_monthly_sales
        WHERE warehouse_id = 'cainiao'
        ORDER BY month, sku`
    ).all().map((row) => ({ ...row }));
    const validations = database.prepare(
      `SELECT v.month, v.status
         FROM warehouse_monthly_sales_validations v
         JOIN (
           SELECT month, MAX(id) AS id
             FROM warehouse_monthly_sales_validations
            WHERE warehouse_id = 'cainiao'
            GROUP BY month
         ) latest ON latest.id = v.id
        ORDER BY v.month`
    ).all().map((row) => ({ ...row }));
    return buildMonthlySalesDashboard({ ...filters, rows, validations });
  } finally {
    database.close();
  }
}
