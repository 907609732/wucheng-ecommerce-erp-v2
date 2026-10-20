import { getDb, nowDate } from "./db.js";
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
