import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import AdmZip from "adm-zip";
import { getDb, nowDate } from "./db.js";
import { findColumn, monthFromDateText, readSheetRows, toDateText, toNumber, toText } from "./sheets.js";
import { loadConfig } from "../config.js";
import { findMapping } from "./order-matching.js";

function firstValue(row, column) {
  return column ? row[column] : "";
}

function headersFor(rows) {
  return rows[0] ? Object.keys(rows[0]) : [];
}

function findColumns(headers, aliases = []) {
  return aliases.map((alias) => findColumn(headers, [alias])).filter(Boolean);
}

function firstNonEmpty(row, columns = []) {
  for (const column of columns) {
    const value = toText(firstValue(row, column));
    if (value) return value;
  }
  return "";
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

function findActiveSku(sku) {
  if (!sku) return null;
  return getDb()
    .prepare("SELECT sku FROM skus WHERE sku = ? AND status = 'active' AND source IN ('manual', 'inventory')")
    .get(sku);
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

export function importOrdersFile({ file, platform = "qianniu", store = "店口五金店" }) {
  const config = loadConfig();
  const rows = readSheetRows(file);
  if (rows.length === 0) throw new Error("订单文件为空。");

  const headers = headersFor(rows);
  const aliases = config.erp?.importColumns?.orders || {};
  const orderIdColumn = findColumn(headers, aliases.orderId || []);
  const subOrderIdColumn = findColumn(headers, ["子订单编号", "子订单号", "明细订单号"]);
  const productIdColumn = findColumn(headers, ["商品ID", "商品id", "宝贝ID", "宝贝id"]);
  const skuColumns = findColumns(headers, aliases.sku || []);
  const externalSkuColumn = findColumn(headers, ["外部系统编号", "外部编码", "外部商家编码"]);
  const nameColumn = findColumn(headers, aliases.name || []);
  const quantityColumn = findColumn(headers, aliases.quantity || []);
  const amountColumn = findColumn(headers, aliases.amount || []);
  const refundColumn = findColumn(headers, ["退款状态", "售后状态", "退款/售后状态"]);
  const attributeColumn = findColumn(headers, ["商品属性", "销售属性", "规格", "规格属性"]);
  const statusColumn = findColumn(headers, aliases.status || []);
  const dateColumn = findColumn(headers, aliases.orderDate || []);
  const customerColumn = findColumn(headers, aliases.customer || []);
  const storeColumn = findColumn(headers, aliases.store || ["店铺", "店铺名称", "店铺名", "网店", "来源店铺"]);
  const fallbackStore = toText(store) || "店口五金店";

  if (!orderIdColumn) {
    throw new Error(`订单文件至少需要订单号列。当前列名：${headers.join("、")}`);
  }

  const db = getDb();
  const upsertOrder = db.prepare(
    `INSERT INTO orders (platform, store, order_id, order_date, status, customer, total_amount)
     VALUES (@platform, @store, @orderId, @orderDate, @status, @customer, @totalAmount)
     ON CONFLICT(platform, order_id) DO UPDATE SET
       store = excluded.store,
       order_date = excluded.order_date,
       status = excluded.status,
       customer = excluded.customer,
       total_amount = excluded.total_amount,
       imported_at = CURRENT_TIMESTAMP`
  );
  const upsertItem = db.prepare(
    `INSERT INTO order_items (platform, order_id, sku, name, quantity, paid_amount, refund_status)
     VALUES (@platform, @orderId, @sku, @name, @quantity, @paidAmount, @refundStatus)
     ON CONFLICT(platform, order_id, sku) DO UPDATE SET
       name = excluded.name,
       quantity = excluded.quantity,
       paid_amount = excluded.paid_amount,
       refund_status = excluded.refund_status,
       imported_at = CURRENT_TIMESTAMP`
  );
  const upsertUnmatched = db.prepare(
    `INSERT INTO order_unmatched_items
       (platform, order_id, sub_order_id, store, product_id, name, sku_text, attributes,
        quantity, paid_amount, status, refund_status, order_date)
     VALUES
       (@platform, @orderId, @subOrderId, @store, @productId, @name, @skuText, @attributes,
        @quantity, @paidAmount, @status, @refundStatus, @orderDate)
     ON CONFLICT(platform, order_id, sub_order_id, product_id, name, attributes) DO UPDATE SET
       store = excluded.store,
       sku_text = excluded.sku_text,
       quantity = excluded.quantity,
       paid_amount = excluded.paid_amount,
       status = excluded.status,
       refund_status = excluded.refund_status,
       order_date = excluded.order_date,
       imported_at = CURRENT_TIMESTAMP`
  );
  const upsertMovement = db.prepare(
    `INSERT INTO inventory_movements
       (sku, warehouse_id, movement_date, quantity, source_type, platform, order_id, sub_order_id, note)
     VALUES
       (@sku, @warehouseId, @movementDate, @quantity, 'order', @platform, @orderId, @subOrderId, @note)
     ON CONFLICT(source_type, platform, order_id, sub_order_id, sku, warehouse_id) DO UPDATE SET
       movement_date = excluded.movement_date,
       quantity = excluded.quantity,
       note = excluded.note,
       imported_at = CURRENT_TIMESTAMP`
  );
  const deleteExistingItems = db.prepare("DELETE FROM order_items WHERE platform = ? AND order_id = ?");
  const deleteExistingUnmatched = db.prepare("DELETE FROM order_unmatched_items WHERE platform = ? AND order_id = ?");
  const deleteExistingMovements = db.prepare(
    "DELETE FROM inventory_movements WHERE platform = ? AND order_id = ? AND source_type IN ('order', 'order_mapping')"
  );

  const orderTotals = new Map();
  const matchedLines = new Map();
  const unmatchedLines = [];

  for (const row of rows) {
    const orderId = toText(firstValue(row, orderIdColumn));
    if (!orderId) continue;

    const subOrderId = toText(firstValue(row, subOrderIdColumn)) || orderId;
    const skuText = firstNonEmpty(row, [...skuColumns, externalSkuColumn].filter(Boolean));
    let sku = normalizeSku(skuText);
    const name = toText(firstValue(row, nameColumn));
    const status = toText(firstValue(row, statusColumn));
    const refundStatus = toText(firstValue(row, refundColumn)) || status;
    const orderDate = toDateText(firstValue(row, dateColumn));
    const quantity = toNumber(firstValue(row, quantityColumn)) || 1;
    const paidAmount = toNumber(firstValue(row, amountColumn));
    const customer = toText(firstValue(row, customerColumn));
    const rowStore = toText(firstValue(row, storeColumn)) || fallbackStore;
    const attributes = toText(firstValue(row, attributeColumn));
    const productId = toText(firstValue(row, productIdColumn));
    // 订单里的商家编码只有在正式 SKU 已存在时才允许扣库存；
    // 不存在时进入待匹配区，由用户建立平台商品编码映射后再补扣。
    if (sku && !findActiveSku(sku)) {
      sku = "";
    }
    if (!sku && productId) {
      const mapping = findMapping(platform, "product_id", productId, attributes);
      if (mapping?.sku) sku = mapping.sku;
    }
    if (sku && !findActiveSku(sku)) {
      sku = "";
    }

    const orderTotal = orderTotals.get(orderId) || {
      platform,
      store: rowStore,
      orderId,
      orderDate,
      status,
      customer,
      totalAmount: 0
    };
    orderTotal.orderDate ||= orderDate;
    orderTotal.status = mergeStatus(orderTotal.status, status);
    orderTotal.customer ||= customer;
    orderTotal.totalAmount += paidAmount;
    orderTotals.set(orderId, orderTotal);

    if (!sku) {
      unmatchedLines.push({
        platform,
        store: rowStore,
        orderId,
        subOrderId,
        productId,
        name,
        skuText,
        attributes,
        quantity,
        paidAmount,
        status,
        refundStatus,
        orderDate
      });
      continue;
    }

    const key = `${orderId}\u0000${sku}`;
    const line = matchedLines.get(key) || {
      platform,
      store: rowStore,
      orderId,
      subOrderIds: new Set(),
      sku,
      name,
      quantity: 0,
      paidAmount: 0,
      refundStatus: "",
      status: "",
      orderDate
    };
    line.subOrderIds.add(subOrderId);
    line.name ||= name;
    line.quantity += quantity;
    line.paidAmount += paidAmount;
    line.refundStatus = mergeStatus(line.refundStatus, refundStatus);
    line.status = mergeStatus(line.status, status);
    line.orderDate ||= orderDate;
    matchedLines.set(key, line);
  }

  const tx = db.transaction(() => {
    let deductedCount = 0;
    let replacedOrderCount = 0;
    for (const order of orderTotals.values()) {
      // 覆盖导入必须先删除旧流水，否则同一个订单反复导入会重复扣库存。
      deleteExistingMovements.run(platform, order.orderId);
      deleteExistingItems.run(platform, order.orderId);
      deleteExistingUnmatched.run(platform, order.orderId);
      replacedOrderCount += 1;
    }
    for (const order of orderTotals.values()) {
      upsertOrder.run(order);
    }
    for (const line of matchedLines.values()) {
      upsertItem.run({
        platform,
        orderId: line.orderId,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity,
        paidAmount: line.paidAmount,
        refundStatus: line.refundStatus
      });
      const shouldDeduct = shouldDeductInventory(line.status, line.refundStatus);
      const movementQuantity = shouldDeduct ? -Math.abs(line.quantity) : 0;
      upsertMovement.run({
        sku: line.sku,
        warehouseId: config.erp?.defaultOrderWarehouse || "cainiao",
        movementDate: line.orderDate || nowDate(),
        quantity: movementQuantity,
        platform,
        orderId: line.orderId,
        subOrderId: Array.from(line.subOrderIds).join(",").slice(0, 180),
        note: shouldDeduct ? "订单导入自动扣减库存" : `订单状态不扣减：${line.status || line.refundStatus}`
      });
      if (shouldDeduct) deductedCount += line.quantity;
    }
    for (const line of unmatchedLines) {
      upsertUnmatched.run(line);
    }
    recordImport({
      type: "orders",
      platform,
      store: fallbackStore,
      file,
      rowCount: rows.length,
      successCount: matchedLines.size,
      errorCount: unmatchedLines.length,
      message: `覆盖 ${replacedOrderCount} 个订单，已匹配 ${matchedLines.size} 个SKU明细，待匹配 ${unmatchedLines.length} 行，扣减库存 ${deductedCount} 件`
    });
    return { matchedCount: matchedLines.size, unmatchedCount: unmatchedLines.length, deductedCount, replacedOrderCount };
  });

  const result = tx();
  return {
    type: "orders",
    rowCount: rows.length,
    successCount: result.matchedCount,
    unmatchedCount: result.unmatchedCount,
    deductedCount: result.deductedCount,
    replacedOrderCount: result.replacedOrderCount,
    platform,
    store: fallbackStore
  };
}

function normalizeSku(value) {
  const sku = toText(value);
  return sku && !/^无$|^-$|^null$/i.test(sku) ? sku : "";
}

function mergeStatus(current, next) {
  if (!current) return next || "";
  if (!next || current.includes(next)) return current;
  return `${current} / ${next}`;
}

function shouldDeductInventory(status = "", refundStatus = "") {
  // 只对明确处于付款/发货/成功链路的订单扣库存；
  // 关闭、取消、退款成功的订单保留订单信息，但 movement 数量写 0。
  const text = `${status} ${refundStatus}`;
  if (/交易关闭|已关闭|订单关闭|退款成功|已退款|取消/.test(text)) return false;
  return /已付款|等待卖家发货|已发货|交易成功|等待买家确认/.test(text);
}

export function importShippingFile({ file, platform = "cainiao", feeMonth = "" }) {
  file = resolveShippingSourceFile(file);
  const config = loadConfig();
  const rows = readSheetRows(file);
  if (rows.length === 0) throw new Error("邮费文件为空。");

  const headers = headersFor(rows);
  const aliases = config.erp?.importColumns?.shipping || {};
  const orderIdColumn = findColumn(headers, aliases.orderId || []);
  const amountColumn = findColumn(headers, aliases.amount || []);
  const monthColumn = findColumn(headers, aliases.month || []);
  const dateColumn = findColumn(headers, aliases.date || []);
  const noteColumn = findColumn(headers, aliases.note || []);

  if (!amountColumn) {
    throw new Error(`邮费文件需要金额列。当前列名：${headers.join("、")}`);
  }

  const db = getDb();
  const upsertFee = db.prepare(
    `INSERT INTO shipping_fees (platform, fee_month, order_id, amount, note)
     VALUES (@platform, @feeMonth, @orderId, @amount, @note)
     ON CONFLICT(platform, fee_month, order_id) DO UPDATE SET
       amount = excluded.amount,
       note = excluded.note,
       imported_at = CURRENT_TIMESTAMP`
  );

  const tx = db.transaction(() => {
    let successCount = 0;
    rows.forEach((row, index) => {
      const orderId = toText(firstValue(row, orderIdColumn)) || `ROW-${index + 1}`;
      const rowMonth =
        feeMonth ||
        toText(firstValue(row, monthColumn)).slice(0, 7) ||
        monthFromDateText(firstValue(row, dateColumn));
      const amount = toNumber(firstValue(row, amountColumn));
      upsertFee.run({
        platform,
        feeMonth: rowMonth,
        orderId,
        amount,
        note: toText(firstValue(row, noteColumn))
      });
      successCount += 1;
    });
    recordImport({
      type: "shipping",
      platform,
      file,
      rowCount: rows.length,
      successCount,
      errorCount: rows.length - successCount
    });
    return successCount;
  });

  const successCount = tx();
  return { type: "shipping", rowCount: rows.length, successCount, platform, feeMonth };
}

function resolveShippingSourceFile(file) {
  if (!/\.zip$/i.test(file)) return file;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-shipping-"));
  const zip = new AdmZip(file);
  const candidates = [];

  zip.getEntries().forEach((entry, index) => {
    if (entry.isDirectory || !/\.(xlsx|xls|csv|tsv)$/i.test(entry.entryName)) return;
    const ext = path.extname(entry.entryName) || ".xlsx";
    const target = path.join(tempDir, `part-${index + 1}${ext}`);
    fs.writeFileSync(target, entry.getData());
    candidates.push(target);
  });

  if (candidates.length === 0) {
    throw new Error("zip 中没有找到 xlsx/xls/csv/tsv 文件。");
  }

  const scored = candidates.map((candidate) => {
    const rows = readSheetRows(candidate);
    const headers = rows[0] ? Object.keys(rows[0]).join(" ") : "";
    let score = 0;
    if (/交易账单/.test(headers) || /计费金额合计/.test(headers)) score += 100;
    if (/计费金额合计/.test(headers)) score += 50;
    if (/计费明细/.test(headers) || /费用项/.test(headers)) score += 10;
    return { candidate, score, rows: rows.length };
  });

  scored.sort((a, b) => b.score - a.score || b.rows - a.rows);
  return scored[0].candidate;
}
