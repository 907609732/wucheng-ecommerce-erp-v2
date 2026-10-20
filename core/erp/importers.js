import path from "node:path";
import { getDb, nowDate } from "./db.js";
import { findColumn, readSheetRows, toDateText, toNumber, toText } from "./sheets.js";
import { loadConfig } from "../config.js";

function firstValue(row, column) {
  return column ? row[column] : "";
}

function headersFor(rows) {
  return rows[0] ? Object.keys(rows[0]) : [];
}

function findColumns(headers, aliases = []) {
  return aliases.map((alias) => findColumn(headers, [alias])).filter(Boolean);
}

function recordImport({ type, platform = "", store = "", warehouseId = "", file, rowCount, successCount, errorCount, message = "" }) {
  getDb()
    .prepare(
      `INSERT INTO import_records
       (type, platform, store, warehouse_id, file_name, row_count, success_count, error_count, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(type, platform, store, warehouseId, path.basename(file), rowCount, successCount, errorCount, message);
}

function upsertSku({
  sku,
  name = "",
  barcode = "",
  externalProductId = "",
  lowStockThreshold = 10,
  updateName = true,
  source = "inventory",
  status = "active"
}) {
  // 正式 SKU 的唯一入口之一：人工维护或库存/月出库导入。
  // 订单导入不会调用这里创建新 SKU，避免淘宝标题和临时编码污染库存主数据。
  if (!sku) return;
  getDb()
    .prepare(
      `INSERT INTO skus (sku, name, barcode, external_product_id, source, status, low_stock_threshold)
       VALUES (@sku, @name, @barcode, @externalProductId, @source, @status, @lowStockThreshold)
       ON CONFLICT(sku) DO UPDATE SET
         name = CASE WHEN @updateName = 1 AND excluded.name != '' THEN excluded.name ELSE skus.name END,
         barcode = CASE WHEN excluded.barcode != '' THEN excluded.barcode ELSE skus.barcode END,
         external_product_id = CASE WHEN excluded.external_product_id != '' THEN excluded.external_product_id ELSE skus.external_product_id END,
         source = excluded.source,
         status = excluded.status,
         low_stock_threshold = CASE WHEN excluded.low_stock_threshold IS NOT NULL THEN excluded.low_stock_threshold ELSE skus.low_stock_threshold END,
         updated_at = CURRENT_TIMESTAMP`
    )
    .run({ sku, name, barcode, externalProductId, source, status, lowStockThreshold, updateName: updateName ? 1 : 0 });
}

export function importInventoryFile({ file, warehouseId = "cainiao", snapshotDate = nowDate() }) {
  const config = loadConfig();
  const rows = readSheetRows(file);
  if (rows.length === 0) throw new Error("库存文件为空。");

  const headers = headersFor(rows);
  const columns = config.inventoryColumns || {};
  const warehouseName = (config.erp?.warehouses || []).find((warehouse) => warehouse.id === warehouseId)?.name || "";
  const skuColumn = findColumn(headers, columns.sku || []);
  const nameColumn = findColumn(headers, columns.name || []);
  const warehouseQuantityColumn = findColumn(headers, warehouseName ? [`${warehouseName}库存`, `${warehouseName}库存数`] : []);
  const quantityColumn = warehouseQuantityColumn || findColumn(headers, columns.quantity || []);
  const barcodeColumn = findColumn(headers, columns.barcode || ["货品条码", "条码", "商品条码", "商品编码", "货品编码"]);
  const externalProductIdColumn = findColumn(headers, ["外部商品ID", "外部商品id", "商品ID", "商品id"]);
  const costColumn = findColumn(headers, ["成本价", "商品成本", "成本"]);
  const lowStockColumn = findColumn(headers, ["预警线", "低库存预警", "库存预警线"]);
  const tocSalesColumn = findColumn(headers, ["toC销售出", "toC销售", "toc销售出"]);
  const tobSalesColumn = findColumn(headers, ["toB销售出", "toB销售", "tob销售出"]);
  const totalOutboundColumn = findColumn(headers, ["出库汇总", "总出库量", "出库合计"]);
  const near30DaysSalesColumn = findColumn(headers, ["近30天销量", "近30天销售", "30天销量"]);
  const monthColumn = findColumn(headers, ["日期", "月份", "时间粒度"]);
  const hasOutboundColumns = tocSalesColumn || tobSalesColumn || totalOutboundColumn || near30DaysSalesColumn;

  // 菜鸟有些“库存明细”表同时包含库存和销量列。
  // 识别到销量列时顺手写 monthly_outbound，但当前库存仍由 quantityColumn 控制。
  if (!quantityColumn) {
    throw new Error(`没有识别到库存数量列。当前列名：${headers.join("、")}`);
  }

  const db = getDb();
  const insertSnapshot = db.prepare(
    `INSERT INTO inventory_snapshots (sku, warehouse_id, snapshot_date, quantity)
     VALUES (@sku, @warehouseId, @snapshotDate, @quantity)
     ON CONFLICT(sku, warehouse_id, snapshot_date) DO UPDATE SET
       quantity = excluded.quantity,
       imported_at = CURRENT_TIMESTAMP`
  );

  const insertOutbound = hasOutboundColumns
    ? db.prepare(
        `INSERT INTO monthly_outbound (sku, warehouse_id, month, toc_sales, tob_sales, total_outbound, near_30_days_sales)
         VALUES (@sku, @warehouseId, @month, @tocSales, @tobSales, @totalOutbound, @near30DaysSales)
         ON CONFLICT(sku, warehouse_id, month) DO UPDATE SET
           toc_sales = excluded.toc_sales,
           tob_sales = excluded.tob_sales,
           total_outbound = excluded.total_outbound,
           near_30_days_sales = excluded.near_30_days_sales,
           imported_at = CURRENT_TIMESTAMP`
      )
    : null;

  const tx = db.transaction(() => {
    let successCount = 0;
    for (const row of rows) {
      const name = toText(firstValue(row, nameColumn));
      const sku = toText(firstValue(row, skuColumn)) || name;
      if (!sku) continue;

      upsertSku({
        sku,
        name,
        barcode: toText(firstValue(row, barcodeColumn)) || sku,
        externalProductId: toText(firstValue(row, externalProductIdColumn)),
        source: "inventory",
        status: "active",
        lowStockThreshold:
          toNumber(firstValue(row, lowStockColumn)) ||
          Number(config.erp?.defaultLowStockThreshold || process.env.LOW_STOCK_THRESHOLD || 10)
      });
      const costPrice = toNumber(firstValue(row, costColumn));
      if (costColumn && Number.isFinite(costPrice)) {
        db.prepare("UPDATE skus SET cost_price = ?, updated_at = CURRENT_TIMESTAMP WHERE sku = ?").run(costPrice, sku);
      }
      insertSnapshot.run({
        sku,
        warehouseId,
        snapshotDate,
        quantity: toNumber(firstValue(row, quantityColumn))
      });
      if (insertOutbound) {
        const monthText = toText(firstValue(row, monthColumn));
        const monthMatch = monthText.match(/(\d{4}-\d{2})/);
        const month = monthMatch ? monthMatch[1] : snapshotDate.slice(0, 7);
        insertOutbound.run({
          sku,
          warehouseId,
          month,
          tocSales: toNumber(firstValue(row, tocSalesColumn)),
          tobSales: toNumber(firstValue(row, tobSalesColumn)),
          totalOutbound: toNumber(firstValue(row, totalOutboundColumn)),
          near30DaysSales: toNumber(firstValue(row, near30DaysSalesColumn))
        });
      }
      successCount += 1;
    }
    recordImport({
      type: "inventory",
      warehouseId,
      file,
      rowCount: rows.length,
      successCount,
      errorCount: rows.length - successCount
    });
    return successCount;
  });

  const successCount = tx();
  return { type: "inventory", rowCount: rows.length, successCount, warehouseId, snapshotDate };
}

export function importMonthlyOutboundFile({ file, warehouseId = "cainiao", month = "" }) {
  const config = loadConfig();
  const rows = readSheetRows(file);
  if (rows.length === 0) throw new Error("月度出库文件为空。");

  const headers = headersFor(rows);
  const skuColumn = findColumn(headers, ["货品条码", "SKU", "sku", "商家编码", "商品编码", "货品编码"]);
  const barcodeColumn = findColumn(headers, ["货品条码", "条码", "商品条码", "商品编码", "货品编码"]);
  const nameColumn = findColumn(headers, ["货品名称", "商品名称", "品名", "名称"]);
  const externalProductIdColumn = findColumn(headers, ["外部商品ID", "外部商品id", "商品ID", "商品id"]);
  const monthColumn = findColumn(headers, ["日期", "月份", "时间粒度"]);
  const tocSalesColumn = findColumn(headers, ["toC销售出", "toC销售", "toc销售出"]);
  const tobSalesColumn = findColumn(headers, ["toB销售出", "toB销售", "tob销售出"]);
  const totalOutboundColumn = findColumn(headers, ["出库汇总", "总出库量", "出库合计"]);
  const near30DaysSalesColumn = findColumn(headers, ["近30天销量", "近30天销售", "30天销量"]);

  // 月度出库表主要用于补货判断，不应把表里的期末库存写成当前库存。
  // 如果未来需要导入“期末库存”，请走 importInventoryFile 或单独新增快照入口。
  if (!skuColumn) throw new Error(`月度出库文件需要货品条码/SKU列。当前列名：${headers.join("、")}`);
  if (!totalOutboundColumn && !tocSalesColumn && !tobSalesColumn && !near30DaysSalesColumn) {
    throw new Error(`月度出库文件需要出库汇总或销量列。当前列名：${headers.join("、")}`);
  }

  const db = getDb();
  const insertOutbound = db.prepare(
    `INSERT INTO monthly_outbound (sku, warehouse_id, month, toc_sales, tob_sales, total_outbound, near_30_days_sales)
     VALUES (@sku, @warehouseId, @month, @tocSales, @tobSales, @totalOutbound, @near30DaysSales)
     ON CONFLICT(sku, warehouse_id, month) DO UPDATE SET
       toc_sales = excluded.toc_sales,
       tob_sales = excluded.tob_sales,
       total_outbound = excluded.total_outbound,
       near_30_days_sales = excluded.near_30_days_sales,
       imported_at = CURRENT_TIMESTAMP`
  );

  const tx = db.transaction(() => {
    let successCount = 0;
    for (const row of rows) {
      const sku = toText(firstValue(row, skuColumn));
      if (!sku) continue;
      const rowMonth = resolveOutboundMonth(month, firstValue(row, monthColumn));
      const tocSales = toNumber(firstValue(row, tocSalesColumn));
      const tobSales = toNumber(firstValue(row, tobSalesColumn));
      const explicitTotal = toNumber(firstValue(row, totalOutboundColumn));
      const totalOutbound = explicitTotal || tocSales + tobSales;

      upsertSku({
        sku,
        name: toText(firstValue(row, nameColumn)),
        barcode: toText(firstValue(row, barcodeColumn)) || sku,
        externalProductId: toText(firstValue(row, externalProductIdColumn)),
        source: "inventory",
        status: "active",
        lowStockThreshold: Number(config.erp?.defaultLowStockThreshold || process.env.LOW_STOCK_THRESHOLD || 10)
      });
      insertOutbound.run({
        sku,
        warehouseId,
        month: rowMonth,
        tocSales,
        tobSales,
        totalOutbound,
        near30DaysSales: toNumber(firstValue(row, near30DaysSalesColumn)) || totalOutbound
      });
      successCount += 1;
    }
    recordImport({
      type: "monthly_outbound",
      platform: "cainiao",
      warehouseId,
      file,
      rowCount: rows.length,
      successCount,
      errorCount: rows.length - successCount
    });
    return successCount;
  });

  const successCount = tx();
  return { type: "monthly_outbound", rowCount: rows.length, successCount, warehouseId, month };
}

function resolveOutboundMonth(inputMonth, value) {
  const direct = toText(inputMonth);
  if (/^\d{4}-\d{2}$/.test(direct)) return direct;
  const text = toText(value);
  const match = text.match(/(\d{4})[-/.年](\d{1,2})/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, "0")}`;
  return nowDate().slice(0, 7);
}
