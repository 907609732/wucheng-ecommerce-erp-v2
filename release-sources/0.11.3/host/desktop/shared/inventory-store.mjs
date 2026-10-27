import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { calculateInventoryAvailability, inventoryAlertLabel } from "../../core/erp/inventory-alert.js";

function plainRow(row) {
  return row == null ? row : { ...row };
}

export function readCainiaoInventory(databasePath) {
  if (!fs.existsSync(databasePath)) {
    return { available: false, message: "尚无本地库存数据，请先完成一次同步。", items: [] };
  }

  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 2_000 });
  try {
    const inventoryTable = database.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'inventory_snapshots'"
    ).get();
    if (!inventoryTable) {
      return { available: false, message: "本地数据库尚无库存快照。", items: [] };
    }

    const latest = plainRow(database.prepare(
      "SELECT MAX(snapshot_date) AS sourceDate FROM inventory_snapshots WHERE warehouse_id = ?"
    ).get("cainiao"));
    if (!latest?.sourceDate) {
      return { available: false, message: "尚无菜鸟云仓库存快照。", items: [] };
    }

    const rows = database.prepare(
      `SELECT i.sku,
              COALESCE(NULLIF(s.name, ''), i.sku) AS name,
              COALESCE(s.barcode, '') AS barcode,
              i.quantity,
              COALESCE(s.low_stock_threshold, 10) AS lowStockThreshold,
              i.snapshot_date AS sourceDate,
              i.imported_at AS importedAt
         FROM inventory_snapshots i
         LEFT JOIN skus s ON s.sku = i.sku
        WHERE i.warehouse_id = ? AND i.snapshot_date = ?
        ORDER BY i.quantity ASC, i.sku ASC`
    ).all("cainiao", latest.sourceDate).map(plainRow);

    const validationTable = database.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'inventory_data_validations'"
    ).get();
    const validation = validationTable
      ? plainRow(database.prepare(
        `SELECT source_date AS sourceDate, status, row_count AS rowCount,
                total_quantity AS totalQuantity, created_at AS createdAt
           FROM inventory_data_validations
          WHERE warehouse_id = ?
          ORDER BY id DESC
          LIMIT 1`
      ).get("cainiao"))
      : null;

    const outboundTable = database.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'monthly_outbound'"
    ).get();
    const outboundRows = outboundTable
      ? database.prepare(
        `WITH latest AS (
           SELECT sku, MAX(month) AS month
             FROM monthly_outbound
            GROUP BY sku
         )
         SELECT o.sku, o.total_outbound AS monthlyOutbound,
                o.near_30_days_sales AS near30DaysSales
           FROM monthly_outbound o
           JOIN latest l ON l.sku = o.sku AND l.month = o.month`
      ).all().map(plainRow)
      : [];
    const outboundBySku = new Map(outboundRows.map((row) => [String(row.sku), row]));

    const items = rows.map((row) => {
      const quantity = Number(row.quantity || 0);
      const lowStockThreshold = Number(row.lowStockThreshold || 0);
      const outbound = outboundBySku.get(String(row.sku));
      const monthlyOutbound = Number(outbound?.monthlyOutbound || 0);
      const near30DaysSales = Number(outbound?.near30DaysSales || 0);
      const { dailyOutbound, sellableDays, stockAlert } = calculateInventoryAvailability({
        totalQuantity: quantity,
        monthlyOutbound,
        near30DaysSales
      });
      return {
        sku: String(row.sku || ""),
        name: String(row.name || ""),
        barcode: String(row.barcode || ""),
        quantity,
        lowStockThreshold,
        stockState: quantity <= 0 ? "empty" : quantity <= lowStockThreshold ? "low" : "ok",
        monthlyOutbound,
        near30DaysSales,
        dailyOutbound,
        sellableDays,
        stockAlert: { ...stockAlert, label: inventoryAlertLabel(stockAlert.level) },
        sourceDate: String(row.sourceDate || ""),
        importedAt: String(row.importedAt || "")
      };
    });
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const validationMatches = Boolean(
      validation &&
      validation.status === "valid" &&
      validation.sourceDate === latest.sourceDate &&
      Number(validation.rowCount) === items.length &&
      Math.abs(Number(validation.totalQuantity) - totalQuantity) < 0.001
    );

    return {
      available: true,
      sourceDate: latest.sourceDate,
      importedAt: items.map((item) => item.importedAt).filter(Boolean).sort().at(-1) || "",
      skuCount: items.length,
      totalQuantity,
      lowStockCount: items.filter((item) => item.stockAlert.level !== "ok").length,
      validation: {
        status: validationMatches ? "valid" : String(validation?.status || "unknown"),
        matchesSnapshot: validationMatches,
        createdAt: String(validation?.createdAt || "")
      },
      items
    };
  } finally {
    database.close();
  }
}
