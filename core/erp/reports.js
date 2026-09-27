import { currentMonth, getDb, nowDate } from "./db.js";
import {
  calculateInventoryAvailability,
  INVENTORY_ALERT_LABELS,
  inventoryAlertLabel
} from "./inventory-alert.js";

export function getWarehouses() {
  return getDb().prepare("SELECT id, name FROM warehouses ORDER BY rowid").all();
}

export function getSkus() {
  return getDb()
    .prepare(
      `SELECT sku, name, barcode, external_product_id AS externalProductId,
              cost_price AS costPrice, low_stock_threshold AS lowStockThreshold,
              cainiao_code AS cainiaoCode, qianniu_code AS qianniuCode,
              jd_code AS jdCode, pdd_code AS pddCode
       FROM skus
       WHERE status = 'active' AND source IN ('manual', 'inventory')
       ORDER BY sku`
    )
    .all();
}

export function updateSku(sku, payload) {
  getDb()
    .prepare(
      `UPDATE skus SET
         name = COALESCE(@name, name),
         barcode = COALESCE(@barcode, barcode),
         cost_price = COALESCE(@costPrice, cost_price),
         low_stock_threshold = COALESCE(@lowStockThreshold, low_stock_threshold),
         cainiao_code = COALESCE(@cainiaoCode, cainiao_code),
         qianniu_code = COALESCE(@qianniuCode, qianniu_code),
         jd_code = COALESCE(@jdCode, jd_code),
         pdd_code = COALESCE(@pddCode, pdd_code),
         updated_at = CURRENT_TIMESTAMP
       WHERE sku = @sku`
    )
    .run({
      sku,
      name: payload.name ?? null,
      barcode: payload.barcode ?? null,
      costPrice: payload.costPrice ?? null,
      lowStockThreshold: payload.lowStockThreshold ?? null,
      cainiaoCode: payload.cainiaoCode ?? null,
      qianniuCode: payload.qianniuCode ?? null,
      jdCode: payload.jdCode ?? null,
      pddCode: payload.pddCode ?? null
    });
  return getDb().prepare("SELECT * FROM skus WHERE sku = ?").get(sku);
}

export function updateInventoryQuantity(sku, payload) {
  const db = getDb();
  const warehouseId = payload.warehouseId || "cainiao";
  const targetQuantity = Number(payload.quantity);
  if (!sku) throw new Error("缺少 SKU。");
  if (!Number.isFinite(targetQuantity)) throw new Error("库存数量不正确。");

  const report = getInventoryReport({ warehouseId });
  const item = report.items.find((row) => row.sku === sku);
  const warehouse =
    item?.warehouses.find((row) => row.warehouseId === warehouseId) ||
    item?.warehouses[0] ||
    {
      warehouseId,
      warehouseName: warehouseName(warehouseId),
      snapshotDate: nowDate(),
      snapshotQuantity: 0,
      movementQuantity: 0,
      quantity: 0
    };
  const beforeQuantity = Number(warehouse.quantity || 0);
  const totalBeforeQuantity = Number(item?.totalQuantity || 0);
  const diff = targetQuantity - beforeQuantity;
  const newSnapshotQuantity = Number(warehouse.snapshotQuantity || 0) + diff;
  const snapshotDate = warehouse.snapshotDate || nowDate();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO inventory_snapshots (sku, warehouse_id, snapshot_date, quantity, source)
       VALUES (@sku, @warehouseId, @snapshotDate, @quantity, 'manual')
       ON CONFLICT(sku, warehouse_id, snapshot_date) DO UPDATE SET
         quantity = excluded.quantity,
         source = 'manual',
         imported_at = CURRENT_TIMESTAMP`
    ).run({
      sku,
      warehouseId: warehouse.warehouseId || warehouseId,
      snapshotDate,
      quantity: newSnapshotQuantity
    });
    db.prepare(
      `INSERT INTO operation_logs
         (entity_type, entity_id, action, before_value, after_value, note)
       VALUES
         ('inventory', @sku, 'update_quantity', @beforeValue, @afterValue, @note)`
    ).run({
      sku,
      beforeValue: JSON.stringify({
        totalQuantity: totalBeforeQuantity,
        warehouseQuantity: beforeQuantity,
        warehouseId: warehouse.warehouseId || warehouseId,
        snapshotQuantity: warehouse.snapshotQuantity || 0,
        movementQuantity: warehouse.movementQuantity || 0
      }),
      afterValue: JSON.stringify({
        totalQuantity: totalBeforeQuantity + diff,
        warehouseQuantity: targetQuantity,
        warehouseId: warehouse.warehouseId || warehouseId,
        snapshotDate,
        snapshotQuantity: newSnapshotQuantity
      }),
      note: `手动编辑${warehouseName(warehouse.warehouseId || warehouseId)}库存：${beforeQuantity} -> ${targetQuantity}`
    });
  });
  tx();

  return {
    sku,
    warehouseId: warehouse.warehouseId || warehouseId,
    beforeQuantity,
    afterQuantity: targetQuantity,
    beforeTotalQuantity: totalBeforeQuantity,
    afterTotalQuantity: totalBeforeQuantity + diff,
    snapshotDate,
    snapshotQuantity: newSnapshotQuantity
  };
}

export function getOperationLogs({ entityType = "", limit = 80 } = {}) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 80, 1), 200);
  if (entityType) {
    return db
      .prepare(
        `SELECT id, entity_type AS entityType, entity_id AS entityId,
                action, before_value AS beforeValue, after_value AS afterValue,
                note, operator, created_at AS createdAt
         FROM operation_logs
         WHERE entity_type = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(entityType, safeLimit);
  }
  return db
    .prepare(
      `SELECT id, entity_type AS entityType, entity_id AS entityId,
              action, before_value AS beforeValue, after_value AS afterValue,
              note, operator, created_at AS createdAt
       FROM operation_logs
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(safeLimit);
}

export function getInventoryReport({ warehouseId = "" } = {}) {
  // 库存总览 = 最新库存快照 + 快照之后的库存流水。
  // 这样导入一次库存后，后续订单扣减和手工调整都能叠加到当前库存。
  const rows = getDb()
    .prepare(
      `WITH latest AS (
         SELECT sku, warehouse_id, MAX(snapshot_date) AS snapshot_date
         FROM inventory_snapshots
         GROUP BY sku, warehouse_id
       )
       SELECT s.sku, s.name, s.barcode, s.external_product_id AS externalProductId,
              s.cost_price AS costPrice,
              s.low_stock_threshold AS lowStockThreshold,
              w.id AS warehouseId, w.name AS warehouseName,
              i.snapshot_date AS snapshotDate, i.quantity
       FROM latest l
       JOIN inventory_snapshots i
         ON i.sku = l.sku AND i.warehouse_id = l.warehouse_id AND i.snapshot_date = l.snapshot_date
       JOIN skus s ON s.sku = i.sku
       JOIN warehouses w ON w.id = i.warehouse_id
       WHERE s.status = 'active' AND s.source IN ('manual', 'inventory')
       ORDER BY s.sku, w.rowid`
    )
    .all();

  const movementRows = getDb()
    .prepare(
      `WITH latest AS (
         SELECT sku, warehouse_id, MAX(snapshot_date) AS snapshot_date
         FROM inventory_snapshots
         GROUP BY sku, warehouse_id
       )
       SELECT m.sku, m.warehouse_id AS warehouseId,
              SUM(m.quantity) AS movementQuantity
       FROM inventory_movements m
       LEFT JOIN latest l ON l.sku = m.sku AND l.warehouse_id = m.warehouse_id
       WHERE l.snapshot_date IS NULL OR m.movement_date >= l.snapshot_date
       GROUP BY m.sku, m.warehouse_id`
    )
    .all();
  const movementsBySkuWarehouse = new Map(
    movementRows.map((row) => [`${row.sku}\u0000${row.warehouseId}`, Number(row.movementQuantity || 0)])
  );

  const outboundRows = getDb()
    .prepare(
      `WITH latest AS (
         SELECT sku, MAX(month) AS month
         FROM monthly_outbound
         GROUP BY sku
       )
       SELECT o.sku, o.toc_sales AS tocSales, o.tob_sales AS tobSales,
              o.total_outbound AS totalOutbound, o.near_30_days_sales AS near30DaysSales
       FROM monthly_outbound o
       JOIN latest l ON l.sku = o.sku AND l.month = o.month`
    )
    .all();
  const outboundBySku = new Map(outboundRows.map((row) => [row.sku, row]));

  const bySku = new Map();
  const seenSkuWarehouse = new Set();
  for (const row of rows) {
    if (!bySku.has(row.sku)) {
      bySku.set(row.sku, {
        sku: row.sku,
        name: row.name,
        barcode: row.barcode,
        externalProductId: row.externalProductId,
        costPrice: row.costPrice,
        lowStockThreshold: row.lowStockThreshold,
        snapshotQuantity: 0,
        movementQuantity: 0,
        totalQuantity: 0,
        warehouses: []
      });
    }
    const item = bySku.get(row.sku);
    seenSkuWarehouse.add(`${row.sku}\u0000${row.warehouseId}`);
    const snapshotQuantity = Number(row.quantity || 0);
    const movementQuantity = movementsBySkuWarehouse.get(`${row.sku}\u0000${row.warehouseId}`) || 0;
    const currentQuantity = snapshotQuantity + movementQuantity;
    item.snapshotQuantity += snapshotQuantity;
    item.movementQuantity += movementQuantity;
    item.totalQuantity += currentQuantity;
    item.warehouses.push({
      warehouseId: row.warehouseId,
      warehouseName: row.warehouseName,
      snapshotDate: row.snapshotDate,
      snapshotQuantity,
      movementQuantity,
      quantity: currentQuantity
    });
  }

  const skuRows = getDb()
    .prepare(
      `SELECT sku, name, cost_price AS costPrice,
              barcode, external_product_id AS externalProductId,
              low_stock_threshold AS lowStockThreshold
       FROM skus
       WHERE status = 'active' AND source IN ('manual', 'inventory')`
    )
    .all();
  const skuInfo = new Map(skuRows.map((row) => [row.sku, row]));
  for (const row of movementRows) {
    const key = `${row.sku}\u0000${row.warehouseId}`;
    if (seenSkuWarehouse.has(key)) continue;
    const info = skuInfo.get(row.sku);
    if (!info) continue;
    if (!bySku.has(row.sku)) {
      bySku.set(row.sku, {
        sku: row.sku,
        name: info.name,
        barcode: info.barcode || "",
        externalProductId: info.externalProductId || "",
        costPrice: info.costPrice,
        lowStockThreshold: info.lowStockThreshold,
        snapshotQuantity: 0,
        movementQuantity: 0,
        totalQuantity: 0,
        warehouses: []
      });
    }
    const item = bySku.get(row.sku);
    const movementQuantity = Number(row.movementQuantity || 0);
    item.movementQuantity += movementQuantity;
    item.totalQuantity += movementQuantity;
    item.warehouses.push({
      warehouseId: row.warehouseId,
      warehouseName: warehouseName(row.warehouseId),
      snapshotDate: "",
      snapshotQuantity: 0,
      movementQuantity,
      quantity: movementQuantity
    });
  }

  const imagesBySku = getImagesBySku();
  const items = Array.from(bySku.values()).map((item) => {
    const normalizedWarehouses = getWarehouses().map((warehouse) => {
      const current = item.warehouses.find((row) => row.warehouseId === warehouse.id);
      return (
        current || {
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          snapshotDate: "",
          snapshotQuantity: 0,
          movementQuantity: 0,
          quantity: 0
        }
      );
    });
    const selectedWarehouse =
      normalizedWarehouses.find((row) => row.warehouseId === warehouseId) ||
      normalizedWarehouses.find((row) => row.warehouseId === "cainiao") ||
      normalizedWarehouses[0];
    const outbound = outboundBySku.get(item.sku);
    const monthlyOutbound = outbound ? Number(outbound.totalOutbound || 0) : 0;
    const near30DaysSales = outbound ? Number(outbound.near30DaysSales || 0) : 0;
    // 补货预警优先使用近 30 天销量，缺失时回退到月度出库总量。
    // 页面和钉钉都复用 stockAlert，避免出现两个地方口径不一致。
    const { dailyOutbound, sellableDays, stockAlert } = calculateInventoryAvailability({
      totalQuantity: item.totalQuantity,
      monthlyOutbound,
      near30DaysSales
    });

    return {
      ...item,
      warehouses: normalizedWarehouses,
      selectedWarehouse,
      images: imagesBySku.get(item.sku) || [],
      lowStock: item.totalQuantity <= item.lowStockThreshold,
      monthlyOutbound,
      near30DaysSales,
      dailyOutbound,
      sellableDays,
      stockAlert
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    snapshotDate: rows.map((row) => row.snapshotDate).filter(Boolean).sort().at(-1) || nowDate(),
    totalQuantity: items.reduce((sum, item) => sum + item.totalQuantity, 0),
    skuCount: items.length,
    // 历史字段名叫 lowStockItems，但现在含义是“按可售天数得出的补货预警项”。
    // 保留字段名是为了兼容前端和旧接口；新代码请优先看 item.stockAlert。
    lowStockItems: items
      .filter((item) => item.stockAlert.level !== "ok")
      .sort((a, b) => {
        const levelOrder = { critical: 0, urgent: 1, warning: 2, ok: 3 };
        const levelDiff = levelOrder[a.stockAlert.level] - levelOrder[b.stockAlert.level];
        if (levelDiff !== 0) return levelDiff;
        return a.totalQuantity - b.totalQuantity;
      }),
    items
  };
}

export function getUnmanagedOrderItems() {
  const db = getDb();
  const unmatchedRows = db
    .prepare(
      `SELECT MIN(id) AS id, platform, product_id AS productId,
              sku_text AS skuText, name, attributes, status,
              refund_status AS refundStatus,
              COUNT(*) AS lineCount,
              COALESCE(SUM(quantity), 0) AS quantity,
              COALESCE(SUM(paid_amount), 0) AS paidAmount,
              MIN(order_date) AS firstOrderDate,
              MAX(order_date) AS lastOrderDate,
              'unmatched_order' AS rowSource
       FROM order_unmatched_items
       GROUP BY platform, product_id, sku_text, name, attributes, status, refund_status
       ORDER BY lastOrderDate DESC, id DESC
       LIMIT 200`
    )
    .all();

  const legacySkuRows = db
    .prepare(
      `SELECT MIN(oi.id) AS id, oi.platform, '' AS productId,
              s.sku AS skuText, COALESCE(NULLIF(oi.name, ''), s.name) AS name,
              '' AS attributes, COALESCE(o.status, '') AS status,
              oi.refund_status AS refundStatus,
              COUNT(*) AS lineCount,
              COALESCE(SUM(oi.quantity), 0) AS quantity,
              COALESCE(SUM(oi.paid_amount), 0) AS paidAmount,
              MIN(o.order_date) AS firstOrderDate,
              MAX(o.order_date) AS lastOrderDate,
              'legacy_order_sku' AS rowSource
       FROM skus s
       JOIN order_items oi ON oi.sku = s.sku
       LEFT JOIN orders o ON o.platform = oi.platform AND o.order_id = oi.order_id
       WHERE s.status = 'unmanaged' OR s.source = 'order'
       GROUP BY oi.platform, s.sku, COALESCE(NULLIF(oi.name, ''), s.name), oi.refund_status, COALESCE(o.status, '')
       ORDER BY lastOrderDate DESC, id DESC
       LIMIT 200`
    )
    .all();

  const movementOnlyRows = db
    .prepare(
      `SELECT MIN(m.id) AS id, m.platform, '' AS productId,
              s.sku AS skuText, s.name AS name, '' AS attributes,
              '' AS status, '' AS refundStatus,
              COUNT(*) AS lineCount,
              ABS(COALESCE(SUM(CASE WHEN m.quantity < 0 THEN m.quantity ELSE 0 END), 0)) AS quantity,
              0 AS paidAmount,
              MIN(m.movement_date) AS firstOrderDate,
              MAX(m.movement_date) AS lastOrderDate,
              'legacy_movement_sku' AS rowSource
       FROM skus s
       JOIN inventory_movements m ON m.sku = s.sku
       WHERE (s.status = 'unmanaged' OR s.source = 'order')
         AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.sku = s.sku)
       GROUP BY m.platform, s.sku, s.name
       ORDER BY lastOrderDate DESC, id DESC
       LIMIT 200`
    )
    .all();

  const rows = [...unmatchedRows, ...legacySkuRows, ...movementOnlyRows]
    .filter((row) => Number(row.quantity || 0) !== 0 || Number(row.lineCount || 0) !== 0)
    .sort((a, b) => String(b.lastOrderDate || "").localeCompare(String(a.lastOrderDate || "")));

  return {
    count: rows.length,
    quantity: rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    paidAmount: rows.reduce((sum, row) => sum + Number(row.paidAmount || 0), 0),
    items: rows
  };
}

function getImagesBySku() {
  const rows = getDb()
    .prepare(
      `SELECT id, sku, original_name AS originalName, public_url AS publicUrl,
              sort_order AS sortOrder
       FROM product_images
       ORDER BY sku, sort_order, id`
    )
    .all();
  const bySku = new Map();
  for (const row of rows) {
    if (!bySku.has(row.sku)) bySku.set(row.sku, []);
    bySku.get(row.sku).push(row);
  }
  return bySku;
}

function warehouseName(id) {
  return {
    cainiao: "菜鸟云仓",
    shanghai: "上海仓库",
    zhuji: "诸暨仓库"
  }[id] || id;
}

export function getOrdersOverview({ month = "", store = "" } = {}) {
  const db = getDb();
  const cleanMonth = String(month || "").trim();
  const cleanStore = String(store || "").trim();
  const where = [];
  const params = {};
  if (cleanMonth) {
    where.push("substr(o.order_date, 1, 7) = @month");
    params.month = cleanMonth;
  }
  if (cleanStore) {
    where.push("o.store = @store");
    params.store = cleanStore;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const unmatchedWhere = [];
  const unmatchedParams = {};
  if (cleanMonth) {
    unmatchedWhere.push("substr(order_date, 1, 7) = @month");
    unmatchedParams.month = cleanMonth;
  }
  if (cleanStore) {
    unmatchedWhere.push("store = @store");
    unmatchedParams.store = cleanStore;
  }
  const unmatchedWhereSql = unmatchedWhere.length ? `WHERE ${unmatchedWhere.join(" AND ")}` : "";

  const monthRows = db
    .prepare(
      `SELECT substr(order_date, 1, 7) AS month, COUNT(*) AS count
       FROM orders
       WHERE order_date != ''
       GROUP BY substr(order_date, 1, 7)
       ORDER BY month DESC`
    )
    .all();
  const storeRows = db
    .prepare(
      `SELECT store, COUNT(*) AS count
       FROM orders
       GROUP BY store
       ORDER BY count DESC, store`
    )
    .all();
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS orderCount,
              COALESCE(SUM(total_amount), 0) AS totalAmount
       FROM orders o
       ${whereSql}`
    )
    .get(params);
  const itemSummary = db
    .prepare(
      `SELECT COUNT(*) AS matchedLineCount,
              COALESCE(SUM(quantity), 0) AS matchedQuantity,
              COALESCE(SUM(paid_amount), 0) AS matchedAmount
       FROM order_items oi
       JOIN orders o ON o.platform = oi.platform AND o.order_id = oi.order_id
       ${whereSql}`
    )
    .get(params);
  const unmatched = db
    .prepare(
      `SELECT COUNT(*) AS unmatchedLineCount,
              COALESCE(SUM(quantity), 0) AS unmatchedQuantity
       FROM order_unmatched_items
       ${unmatchedWhereSql}`
    )
    .get(unmatchedParams);
  const movements = db
    .prepare(
      `SELECT COUNT(*) AS movementCount,
              COALESCE(SUM(CASE WHEN quantity < 0 THEN -quantity ELSE 0 END), 0) AS deductedQuantity
       FROM inventory_movements m
       LEFT JOIN orders o ON o.platform = m.platform AND o.order_id = m.order_id
       WHERE m.source_type IN ('order', 'order_mapping') AND m.quantity < 0
         ${cleanMonth ? "AND substr(o.order_date, 1, 7) = @month" : ""}
         ${cleanStore ? "AND o.store = @store" : ""}`
    )
    .get(params);
  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount
       FROM orders o
       ${whereSql}
       GROUP BY status
       ORDER BY count DESC
       LIMIT 12`
    )
    .all(params);
  const storeSummaryRows = db
    .prepare(
      `SELECT o.store, COUNT(*) AS orderCount,
              COALESCE(SUM(o.total_amount), 0) AS totalAmount,
              COALESCE(SUM(items.quantity), 0) AS quantity
       FROM orders o
       LEFT JOIN (
         SELECT platform, order_id, SUM(quantity) AS quantity
         FROM order_items
         GROUP BY platform, order_id
       ) items ON items.platform = o.platform AND items.order_id = o.order_id
       ${cleanMonth ? "WHERE substr(o.order_date, 1, 7) = @month" : ""}
       GROUP BY o.store
       ORDER BY totalAmount DESC, orderCount DESC`
    )
    .all(cleanMonth ? { month: cleanMonth } : {});
  const recentOrders = db
    .prepare(
      `SELECT o.platform, o.store, o.order_id AS orderId, o.order_date AS orderDate,
              o.status, o.total_amount AS totalAmount,
              COUNT(oi.id) AS lineCount,
              COALESCE(SUM(oi.quantity), 0) AS quantity
       FROM orders o
       LEFT JOIN order_items oi ON oi.platform = o.platform AND oi.order_id = o.order_id
       ${whereSql}
       GROUP BY o.platform, o.order_id
       ORDER BY o.order_date DESC, o.id DESC
       LIMIT 80`
    )
    .all(params);
  const recentOrderKeys = recentOrders.map((row) => ({
    platform: row.platform,
    orderId: row.orderId
  }));
  const recentOrderItems = recentOrderKeys.length
    ? db
        .prepare(
          `SELECT oi.platform, oi.order_id AS orderId, oi.sku, oi.name,
                  oi.quantity, oi.paid_amount AS paidAmount,
                  oi.refund_status AS refundStatus,
                  s.barcode, s.external_product_id AS externalProductId,
                  s.cainiao_code AS cainiaoCode, s.qianniu_code AS qianniuCode,
                  s.jd_code AS jdCode, s.pdd_code AS pddCode
           FROM order_items oi
           LEFT JOIN skus s ON s.sku = oi.sku
           WHERE oi.platform = @platform AND oi.order_id = @orderId
           ORDER BY oi.id`
        )
    : null;
  const recentUnmatchedItems = recentOrderKeys.length
    ? db
        .prepare(
          `SELECT platform, order_id AS orderId, sub_order_id AS subOrderId,
                  product_id AS productId, sku_text AS skuText, name,
                  attributes, quantity, paid_amount AS paidAmount,
                  status, refund_status AS refundStatus
           FROM order_unmatched_items
           WHERE platform = @platform AND order_id = @orderId
           ORDER BY id`
        )
    : null;
  const itemsByOrder = new Map();
  const unmatchedByOrder = new Map();
  for (const key of recentOrderKeys) {
    const rows = recentOrderItems.all(key);
    const unmatchedRows = recentUnmatchedItems.all(key);
    itemsByOrder.set(`${key.platform}::${key.orderId}`, rows);
    unmatchedByOrder.set(`${key.platform}::${key.orderId}`, unmatchedRows);
  }
  const unmatchedItems = db
    .prepare(
      `SELECT platform, store, order_id AS orderId, sub_order_id AS subOrderId,
              product_id AS productId, name, attributes, quantity,
              paid_amount AS paidAmount, status, refund_status AS refundStatus,
              order_date AS orderDate
       FROM order_unmatched_items
       ${unmatchedWhereSql}
       ORDER BY order_date DESC, id DESC
       LIMIT 80`
    )
    .all(unmatchedParams);

  return {
    filters: {
      month: cleanMonth,
      store: cleanStore,
      months: monthRows,
      stores: storeRows
    },
    summary: {
      ...summary,
      ...itemSummary,
      ...unmatched,
      ...movements
    },
    statusRows,
    storeSummaryRows,
    recentOrders: recentOrders.map((row) => {
      const items = itemsByOrder.get(`${row.platform}::${row.orderId}`) || [];
      const unmatchedOrderItems = unmatchedByOrder.get(`${row.platform}::${row.orderId}`) || [];
      const displayItems = [
        ...items.map((item) => ({ ...item, rowType: "matched" })),
        ...unmatchedOrderItems.map((item) => ({
          ...item,
          rowType: "unmatched",
          sku: item.skuText || "",
          barcode: item.productId || item.skuText || "",
          externalProductId: item.productId || ""
        }))
      ];
      return {
        ...row,
        items,
        unmatchedOrderItems,
        displayItems,
        skuSummary: displayItems.map((item) => item.sku).filter(Boolean).join(" / "),
        barcodeSummary: displayItems.map((item) => item.barcode || item.productId || item.sku).filter(Boolean).join(" / "),
        productSummary: displayItems
          .map((item) => `${item.name || item.sku}${Number(item.quantity || 0) ? ` x${formatReportNumber(item.quantity)}` : ""}`)
          .join("；"),
        refundSummary: [...new Set(displayItems.map((item) => item.refundStatus).filter(Boolean))].join(" / "),
        itemAmount: displayItems.reduce((sum, item) => sum + Number(item.paidAmount || 0), 0)
      };
    }),
    unmatchedItems
  };
}

function formatReportNumber(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

export function getMonthlySalesReport(month = currentMonth()) {
  const db = getDb();
  const sales = db
    .prepare(
      `SELECT oi.sku, COALESCE(NULLIF(oi.name, ''), s.name) AS name,
              SUM(oi.quantity) AS quantity,
              SUM(oi.paid_amount) AS salesAmount,
              SUM(oi.quantity * s.cost_price) AS productCost
       FROM order_items oi
       JOIN orders o ON o.platform = oi.platform AND o.order_id = oi.order_id
       LEFT JOIN skus s ON s.sku = oi.sku
       WHERE substr(o.order_date, 1, 7) = ?
       GROUP BY oi.sku
       ORDER BY salesAmount DESC`
    )
    .all(month);

  const shippingByPlatform = db
    .prepare(
      `SELECT platform, SUM(amount) AS amount
       FROM shipping_fees
       WHERE fee_month = ?
       GROUP BY platform
       ORDER BY platform`
    )
    .all(month);

  const totals = {
    quantity: sales.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    salesAmount: sales.reduce((sum, row) => sum + Number(row.salesAmount || 0), 0),
    productCost: sales.reduce((sum, row) => sum + Number(row.productCost || 0), 0),
    shippingFee: shippingByPlatform.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  };
  totals.estimatedGrossProfit = totals.salesAmount - totals.productCost - totals.shippingFee;

  return {
    month,
    totals,
    shippingByPlatform,
    items: sales.map((row) => ({
      ...row,
      estimatedGrossProfit: Number(row.salesAmount || 0) - Number(row.productCost || 0)
    }))
  };
}

export function getDashboard() {
  const inventory = getInventoryReport();
  const monthly = getMonthlySalesReport(currentMonth());
  const db = getDb();
  const importRecords = db
    .prepare(
      `SELECT type, platform, warehouse_id AS warehouseId, file_name AS fileName,
              row_count AS rowCount, success_count AS successCount,
              error_count AS errorCount, imported_at AS importedAt
       FROM import_records
       ORDER BY id DESC
       LIMIT 8`
    )
    .all();
  const competitorCount = db.prepare("SELECT COUNT(*) AS count FROM competitors").get().count;

  return {
    date: nowDate(),
    month: currentMonth(),
    inventory: {
      skuCount: inventory.skuCount,
      totalQuantity: inventory.totalQuantity,
      lowStockCount: inventory.lowStockItems.length,
      lowStockItems: inventory.lowStockItems.slice(0, 10)
    },
    monthly,
    competitorCount,
    importRecords
  };
}

export function getBusinessOverview({ includePurchaseAfterSales = true } = {}) {
  const db = getDb();
  const monthly = db
    .prepare(
      `SELECT month,
              SUM(sales_amount) AS salesAmount,
              SUM(refund_amount) AS refundAmount,
              SUM(purchase_cost) AS purchaseCost,
              SUM(shipping_fee) AS shippingFee,
              SUM(labor_cost) AS laborCost,
              SUM(gross_profit) AS grossProfit
       FROM monthly_financials
       GROUP BY month
       ORDER BY month`
    )
    .all();

  const orderMonthly = db
    .prepare(
      `SELECT substr(o.order_date, 1, 7) AS month,
              SUM(oi.quantity) AS quantity,
              SUM(oi.paid_amount) AS salesAmount
       FROM order_items oi
       JOIN orders o ON o.platform = oi.platform AND o.order_id = oi.order_id
       WHERE o.order_date != ''
       GROUP BY substr(o.order_date, 1, 7)
       ORDER BY month`
    )
    .all();

  const platformSales = db
    .prepare(
      `SELECT platform, store, SUM(sales_amount) AS salesAmount,
              SUM(refund_amount) AS refundAmount
       FROM monthly_financials
       GROUP BY platform, store
       HAVING salesAmount != 0 OR refundAmount != 0
       ORDER BY salesAmount DESC
       LIMIT 20`
    )
    .all();

  const purchaseMonthly = includePurchaseAfterSales
    ? db
        .prepare(
          `SELECT substr(purchase_date, 1, 7) AS month,
                  COUNT(*) AS count,
                  SUM(amount) AS amount
           FROM purchase_records
           WHERE purchase_date != ''
           GROUP BY substr(purchase_date, 1, 7)
           ORDER BY month`
        )
        .all()
    : [];

  const returnMonthly = includePurchaseAfterSales
    ? db
        .prepare(
          `SELECT substr(apply_time, 1, 7) AS month,
                  COUNT(*) AS count,
                  SUM(refund_amount) AS refundAmount
           FROM return_records
           WHERE apply_time != ''
           GROUP BY substr(apply_time, 1, 7)
           ORDER BY month`
        )
        .all()
    : [];

  const shippingMonthly = db
    .prepare(
      `SELECT fee_month AS month,
              COUNT(*) AS count,
              SUM(amount) AS amount
       FROM shipping_fees
       GROUP BY fee_month
       ORDER BY month`
    )
    .all();

  const monthlyByMonth = new Map();
  for (const row of monthly) {
    monthlyByMonth.set(row.month, {
      month: row.month,
      financeSalesAmount: Number(row.salesAmount || 0),
      orderSalesAmount: 0,
      salesAmount: Number(row.salesAmount || 0),
      refundAmount: Number(row.refundAmount || 0),
      purchaseCost: Number(row.purchaseCost || 0),
      shippingFee: Number(row.shippingFee || 0),
      laborCost: Number(row.laborCost || 0),
      grossProfit: Number(row.grossProfit || 0),
      quantity: 0
    });
  }
  for (const row of orderMonthly) {
    const current =
      monthlyByMonth.get(row.month) ||
      {
        month: row.month,
        financeSalesAmount: 0,
        orderSalesAmount: 0,
        salesAmount: 0,
        refundAmount: 0,
        purchaseCost: 0,
        shippingFee: 0,
        laborCost: 0,
        grossProfit: 0,
        quantity: 0
      };
    current.orderSalesAmount = Number(row.salesAmount || 0);
    current.quantity = Number(row.quantity || 0);
    current.salesAmount = current.financeSalesAmount || current.orderSalesAmount;
    monthlyByMonth.set(row.month, current);
  }

  const salesMonthly = Array.from(monthlyByMonth.values()).sort((a, b) => a.month.localeCompare(b.month));

  const totals = {
    salesAmount: salesMonthly.reduce((sum, row) => sum + Number(row.salesAmount || 0), 0),
    orderSalesAmount: orderMonthly.reduce((sum, row) => sum + Number(row.salesAmount || 0), 0),
    refundAmount: monthly.reduce((sum, row) => sum + Number(row.refundAmount || 0), 0),
    shippingFee: shippingMonthly.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    purchaseAmount: includePurchaseAfterSales
      ? db.prepare("SELECT COALESCE(SUM(amount), 0) AS value FROM purchase_records").get().value
      : 0,
    returnCount: includePurchaseAfterSales
      ? db.prepare("SELECT COUNT(*) AS value FROM return_records").get().value
      : 0,
    assetValue: db.prepare("SELECT COALESCE(SUM(original_value), 0) AS value FROM fixed_assets").get().value,
    savedFileCount: db.prepare("SELECT COUNT(*) AS value FROM imported_files").get().value
  };

  const latestReturns = includePurchaseAfterSales
    ? db
        .prepare(
          `SELECT platform, store, order_id AS orderId, refund_id AS refundId,
                  tracking_no AS trackingNo, product_name AS productName,
                  refund_amount AS refundAmount, reason, status, apply_time AS applyTime
           FROM return_records
           ORDER BY imported_at DESC, id DESC
           LIMIT 20`
        )
        .all()
    : [];

  const latestPurchases = includePurchaseAfterSales
    ? db
        .prepare(
          `SELECT purchase_date AS purchaseDate, item_name AS itemName, amount,
                  platform, note
           FROM purchase_records
           ORDER BY imported_at DESC, id DESC
           LIMIT 20`
        )
        .all()
    : [];

  const assets = db
    .prepare(
      `SELECT asset_code AS assetCode, asset_name AS assetName, model,
              quantity, category, original_value AS originalValue, note
       FROM fixed_assets
       ORDER BY original_value DESC
       LIMIT 20`
    )
    .all();

  return {
    totals,
    monthly,
    salesMonthly,
    orderMonthly,
    platformSales,
    purchaseMonthly,
    returnMonthly,
    shippingMonthly,
    latestReturns,
    latestPurchases,
    assets
  };
}

const ALERT_LABEL_SHORT = INVENTORY_ALERT_LABELS;

export function formatInventoryAlertLabel(level) {
  return inventoryAlertLabel(level);
}

function buildInventoryList(items) {
  return items
    .slice(0, 30)
    .map((item) => {
      const sellableText =
        item.sellableDays && item.sellableDays !== Infinity ? `，可售约 ${Math.round(item.sellableDays)} 天` : "";
      const outboundText = item.monthlyOutbound
        ? `，月出库 ${item.monthlyOutbound}，近30天销量 ${item.near30DaysSales}${sellableText}`
        : "";
      const label = ALERT_LABEL_SHORT[item.stockAlert.level] || item.stockAlert.text;
      return `- **${item.sku}** ${item.name || ""}｜库存 ${item.totalQuantity}${outboundText} → ${label}`;
    })
    .join("\n");
}

function buildInventoryTable(items) {
  // 4 列手机端刚好一屏，无需滑动
  const header = "| SKU | 库存/销量 | 天数 | 预警 |\n|---|---|---|---|";
  const rows = items
    .slice(0, 30)
    .map((item) => {
      const days = Number.isFinite(item.sellableDays) ? Math.round(item.sellableDays) : "—";
      const label = ALERT_LABEL_SHORT[item.stockAlert.level] || "正常";
      // 名称缩到 10 字，避免撑宽
      const shortName = (item.name || "").replace(item.sku, "").trim().slice(0, 10);
      const skuCell = shortName ? `${item.sku}<br>${shortName}` : item.sku;
      const stockSales = `${item.totalQuantity} / ${item.near30DaysSales || 0}`;
      return `| ${skuCell} | ${stockSales} | ${days} | ${label} |`;
    })
    .join("\n");
  return [header, rows].join("\n");
}

function buildInventoryGrouped(items) {
  const groups = { critical: [], urgent: [], warning: [] };
  for (const item of items) {
    if (groups[item.stockAlert.level]) groups[item.stockAlert.level].push(item);
  }
  const lines = [];
  if (groups.critical.length) {
    lines.push("**🔴 严重缺货（<7天）**");
    lines.push(buildInventoryList(groups.critical));
  }
  if (groups.urgent.length) {
    lines.push("\n**🟠 急需补货（7-14天）**");
    lines.push(buildInventoryList(groups.urgent));
  }
  if (groups.warning.length) {
    lines.push("\n**🟡 需要补货（15-30天）**");
    lines.push(buildInventoryList(groups.warning));
  }
  return lines.join("\n");
}

function buildInventoryChart(items) {
  // Unicode 文本柱状图，在钉钉 markdown 中直接显示
  if (!items.length) return "暂无预警数据。";
  const maxVal = Math.max(...items.map((i) => i.totalQuantity));
  const maxBarLen = 12;
  const lines = items.slice(0, 15).map((item) => {
    const barLen = maxVal > 0 ? Math.round((item.totalQuantity / maxVal) * maxBarLen) : 0;
    const bar = "█".repeat(barLen) + "░".repeat(maxBarLen - barLen);
    const shortName = (item.name || item.sku).slice(0, 10);
    const label = ALERT_LABEL_SHORT[item.stockAlert.level] || "";
    return `${bar} ${item.totalQuantity.toString().padStart(3)} ${shortName} ${label}`;
  });
  return ["**库存量分布**", "```", ...lines, "```"].join("\n");
}

export function buildInventoryActionCard() {
  const report = getInventoryReport();
  const reportDate = report.snapshotDate || nowDate();
  const summary = [
    `**📦 ERP库存预警 ${reportDate}**`,
    "",
    `· SKU 总数：**${report.skuCount}**`,
    `· 库存合计：**${report.totalQuantity}**`,
    `· 需补货 SKU：**${report.lowStockItems.length}**`,
    ""
  ];

  // 前 5 条预警精简展示
  const top5 = report.lowStockItems.slice(0, 5).map((item) => {
    const days = Number.isFinite(item.sellableDays) ? `${Math.round(item.sellableDays)}天` : "—";
    const label = ALERT_LABEL_SHORT[item.stockAlert.level] || "";
    return `· ${item.sku}｜库存 ${item.totalQuantity}｜可售 ${days} → ${label}`;
  });

  const text = [...summary, ...top5].join("\n");

  return {
    title: `ERP库存预警 ${reportDate}`,
    text,
    singleTitle: "📊 查看完整报表",
    singleUrl: "http://localhost:3000"
  };
}

export function buildInventoryMarkdown(format = "grouped", reportOverride = null) {
  const report = reportOverride || getInventoryReport();
  const reportDate = report.snapshotDate || nowDate();
  const alertItems = report.lowStockItems;
  const criticalItems = alertItems.filter((item) => item.stockAlert.level === "critical");
  const periodSummary = buildInventoryPeriodSummary(alertItems);
  const rows = alertItems.slice(0, 30).map((item) => {
    const days = Number.isFinite(item.sellableDays) ? Math.round(item.sellableDays) : "N/A";
    const productName = String(item.name || "—").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
    return "| " + productName + " | " + item.sku + " | " + item.totalQuantity + " / " + (item.near30DaysSales || 0) + " | " + days + " | " + formatInventoryAlertLabel(item.stockAlert.level) + " |";
  });
  const lowStockText = rows.length
    ? ["| \u8D27\u54C1\u540D\u79F0 | SKU | \u5E93\u5B58/\u9500\u91CF | \u53EF\u552E\u5929\u6570 | \u9884\u8B66 |", "|---|---|---|---:|---|", ...rows].join("\n")
    : "\u2705 \u6682\u65E0\u9884\u8B66\u4E00\u4E2A\u6708\u5185\u9700\u8981\u8865\u8D27\u7684 SKU\u3002";
  return {
    title: "ERP\u5E93\u5B58\u9884\u8B66 " + reportDate,
    shouldNotify: criticalItems.length > 0,
    criticalItems,
    alertItems,
    periodSummary,
    text: [
      "## ERP\u5E93\u5B58\u9884\u8B66 " + reportDate,
      "",
      "SKU \u6570\uFF1A**" + report.skuCount + "** \uFF5C\u5E93\u5B58\u5408\u8BA1\uFF1A**" + report.totalQuantity + "**",
      "\u5C11\u4E8E 1 \u5468\uFF1A**" + periodSummary.week + "** \uFF5C\u5C11\u4E8E 2 \u5468\uFF1A**" + periodSummary.twoWeeks + "** \uFF5C\u5C11\u4E8E\u534A\u4E2A\u6708\uFF1A**" + periodSummary.halfMonth + "** \uFF5C\u5C11\u4E8E 1 \u4E2A\u6708\uFF1A**" + periodSummary.month + "**",
      "",
      "\u4EE5\u4E0B\u660E\u7EC6\u6309\u53EF\u552E\u5929\u6570\u6392\u5E8F\uFF0C\u6BCF\u4E2A SKU \u4EC5\u5C55\u793A\u4E00\u6B21\u3002\u4EC5\u5728\u5C11\u4E8E 1 \u5468\u65F6\u89E6\u53D1 @ \u63D0\u9192\u3002",
      "",
      lowStockText
    ].join("\n")
  };
}

export function buildInventoryPeriodSummary(items) {
  const sellableDays = items
    .map((item) => Number(item.sellableDays))
    .filter(Number.isFinite);
  return {
    week: sellableDays.filter((days) => days < 7).length,
    twoWeeks: sellableDays.filter((days) => days < 14).length,
    halfMonth: sellableDays.filter((days) => days < 15).length,
    month: sellableDays.filter((days) => days < 30).length
  };
}

export function buildMonthlyMarkdown(month = currentMonth()) {
  const report = getMonthlySalesReport(month);
  const topItems = report.items.length
    ? report.items
        .slice(0, 20)
        .map((item) => `- ${item.sku}：销量 ${item.quantity}，销售额 ${money(item.salesAmount)}`)
        .join("\n")
    : "暂无订单数据。";

  return {
    title: `ERP月度销售报表 ${month}`,
    text: [
      `## ERP月度销售报表 ${month}`,
      "",
      `- 销量：${report.totals.quantity}`,
      `- 销售额：${money(report.totals.salesAmount)}`,
      `- 商品成本：${money(report.totals.productCost)}`,
      `- 邮费：${money(report.totals.shippingFee)}`,
      `- 预估毛利：${money(report.totals.estimatedGrossProfit)}`,
      "",
      "### SKU明细",
      topItems
    ].join("\n")
  };
}

function money(value) {
  return `￥${Number(value || 0).toFixed(2)}`;
}
