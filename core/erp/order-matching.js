import { getDb, nowDate } from "./db.js";

export function upsertProductCodeMapping({
  platform = "qianniu",
  codeType = "product_id",
  codeValue = "",
  attributes = "",
  sku = "",
  note = ""
}) {
  if (!codeValue) throw new Error("缺少商品编码。");
  if (!sku) throw new Error("请选择要绑定的 SKU。");
  const db = getDb();
  const skuRow = db
    .prepare("SELECT sku FROM skus WHERE sku = ? AND status = 'active' AND source IN ('manual', 'inventory')")
    .get(sku);
  if (!skuRow) throw new Error(`SKU 不存在：${sku}`);
  db.prepare(
    `INSERT INTO product_code_mappings
       (platform, code_type, code_value, attributes, sku, note)
     VALUES
       (@platform, @codeType, @codeValue, @attributes, @sku, @note)
     ON CONFLICT(platform, code_type, code_value, attributes) DO UPDATE SET
       sku = excluded.sku,
       note = excluded.note,
       updated_at = CURRENT_TIMESTAMP`
  ).run({ platform, codeType, codeValue, attributes, sku, note });
  return findMapping(platform, codeType, codeValue, attributes);
}

export function listProductCodeMappings() {
  return getDb()
    .prepare(
      `SELECT m.id, m.platform, m.code_type AS codeType,
              m.code_value AS codeValue, m.attributes, m.sku,
              s.name AS skuName, m.note, m.updated_at AS updatedAt
       FROM product_code_mappings m
       LEFT JOIN skus s ON s.sku = m.sku
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT 200`
    )
    .all();
}

export function rematchUnmatchedOrders({ platform = "", limit = 2000 } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, platform, order_id AS orderId, sub_order_id AS subOrderId,
              product_id AS productId, name, attributes, quantity,
              paid_amount AS paidAmount, status, refund_status AS refundStatus,
              order_date AS orderDate
       FROM order_unmatched_items
       WHERE (? = '' OR platform = ?)
       ORDER BY order_date DESC, id DESC
       LIMIT ?`
    )
    .all(platform, platform, Math.min(Math.max(Number(limit) || 2000, 1), 10000));

  const upsertItem = db.prepare(
    `INSERT INTO order_items (platform, order_id, sku, name, quantity, paid_amount, refund_status)
     VALUES (@platform, @orderId, @sku, @name, @quantity, @paidAmount, @refundStatus)
     ON CONFLICT(platform, order_id, sku) DO UPDATE SET
       name = excluded.name,
       quantity = order_items.quantity + excluded.quantity,
       paid_amount = order_items.paid_amount + excluded.paid_amount,
       refund_status = excluded.refund_status,
       imported_at = CURRENT_TIMESTAMP`
  );
  const upsertMovement = db.prepare(
    `INSERT INTO inventory_movements
       (sku, warehouse_id, movement_date, quantity, source_type, platform, order_id, sub_order_id, note)
     VALUES
       (@sku, @warehouseId, @movementDate, @quantity, 'order_mapping', @platform, @orderId, @subOrderId, @note)
     ON CONFLICT(source_type, platform, order_id, sub_order_id, sku, warehouse_id) DO UPDATE SET
       movement_date = excluded.movement_date,
       quantity = excluded.quantity,
       note = excluded.note,
       imported_at = CURRENT_TIMESTAMP`
  );
  const deleteUnmatched = db.prepare("DELETE FROM order_unmatched_items WHERE id = ?");

  const tx = db.transaction(() => {
    let matchedCount = 0;
    let deductedQuantity = 0;
    let skippedCount = 0;
    for (const row of rows) {
      const mapping = findMapping(row.platform, "product_id", row.productId, row.attributes);
      if (!mapping) {
        skippedCount += 1;
        continue;
      }
      upsertItem.run({
        platform: row.platform,
        orderId: row.orderId,
        sku: mapping.sku,
        name: row.name,
        quantity: row.quantity,
        paidAmount: row.paidAmount,
        refundStatus: row.refundStatus || row.status
      });
      const shouldDeduct = shouldDeductInventory(row.status, row.refundStatus);
      const movementQuantity = shouldDeduct ? -Math.abs(Number(row.quantity || 0)) : 0;
      upsertMovement.run({
        sku: mapping.sku,
        warehouseId: "cainiao",
        movementDate: row.orderDate || nowDate(),
        quantity: movementQuantity,
        platform: row.platform,
        orderId: row.orderId,
        subOrderId: row.subOrderId || row.orderId,
        note: shouldDeduct ? "商品编码映射补扣库存" : `订单状态不扣减：${row.status || row.refundStatus}`
      });
      if (shouldDeduct) deductedQuantity += Number(row.quantity || 0);
      deleteUnmatched.run(row.id);
      matchedCount += 1;
    }
    return { scannedCount: rows.length, matchedCount, skippedCount, deductedQuantity };
  });

  return tx();
}

export function matchUnmanagedOrderItem(payload = {}) {
  const db = getDb();
  const targetSku = String(payload.sku || "").trim();
  const platform = String(payload.platform || "qianniu").trim();
  const productId = String(payload.productId || "").trim();
  const attributes = String(payload.attributes || "").trim();
  const skuText = String(payload.skuText || "").trim();
  const rowSource = String(payload.rowSource || "").trim();

  if (!targetSku) throw new Error("请选择正式 SKU。");
  const target = db
    .prepare("SELECT sku FROM skus WHERE sku = ? AND status = 'active' AND source IN ('manual', 'inventory')")
    .get(targetSku);
  if (!target) throw new Error(`正式 SKU 不存在：${targetSku}`);

  if (productId) {
    upsertProductCodeMapping({
      platform,
      codeType: "product_id",
      codeValue: productId,
      attributes,
      sku: targetSku,
      note: "从库存总览待维护商品绑定"
    });
    const result = rematchUnmatchedOrders({ platform });
    return {
      mode: "product_mapping",
      sku: targetSku,
      ...result
    };
  }

  if (!skuText) throw new Error("这条待维护商品没有商品编码，暂时无法匹配。");
  const sourceSku = db.prepare("SELECT sku FROM skus WHERE sku = ? AND (status = 'unmanaged' OR source = 'order')").get(skuText);
  if (!sourceSku) {
    return matchUnmatchedSkuText({ platform, skuText, attributes, targetSku });
  }

  return mergeLegacyOrderSku({ sourceSku: skuText, targetSku, rowSource });
}

export function findMapping(platform, codeType, codeValue, attributes = "") {
  if (!platform || !codeValue) return null;
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT id, platform, code_type AS codeType, code_value AS codeValue,
                attributes, sku, note
         FROM product_code_mappings
         WHERE platform = ? AND code_type = ? AND code_value = ? AND attributes = ?`
      )
      .get(platform, codeType, codeValue, attributes || "") ||
    db
      .prepare(
        `SELECT id, platform, code_type AS codeType, code_value AS codeValue,
                attributes, sku, note
         FROM product_code_mappings
         WHERE platform = ? AND code_type = ? AND code_value = ? AND attributes = ''
         LIMIT 1`
      )
      .get(platform, codeType, codeValue)
  );
}

function shouldDeductInventory(status = "", refundStatus = "") {
  const text = `${status} ${refundStatus}`;
  if (/交易关闭|已关闭|订单关闭|退款成功|已退款|取消/.test(text)) return false;
  return /已付款|等待卖家发货|已发货|交易成功|等待买家确认/.test(text);
}

function mergeLegacyOrderSku({ sourceSku, targetSku, rowSource = "" }) {
  const db = getDb();
  const orderRows = db
    .prepare(
      `SELECT id, platform, order_id AS orderId, name, quantity,
              paid_amount AS paidAmount, refund_status AS refundStatus
       FROM order_items
       WHERE sku = ?`
    )
    .all(sourceSku);
  const movementRows = db
    .prepare(
      `SELECT id, warehouse_id AS warehouseId, movement_date AS movementDate,
              quantity, source_type AS sourceType, platform, order_id AS orderId,
              sub_order_id AS subOrderId, note
       FROM inventory_movements
       WHERE sku = ?`
    )
    .all(sourceSku);

  const tx = db.transaction(() => {
    let migratedOrderLines = 0;
    let deductedQuantity = 0;

    for (const row of orderRows) {
      const existing = db
        .prepare("SELECT id FROM order_items WHERE platform = ? AND order_id = ? AND sku = ?")
        .get(row.platform, row.orderId, targetSku);
      if (existing) {
        db.prepare(
          `UPDATE order_items
           SET quantity = quantity + ?,
               paid_amount = paid_amount + ?,
               imported_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(row.quantity, row.paidAmount, existing.id);
        db.prepare("DELETE FROM order_items WHERE id = ?").run(row.id);
      } else {
        db.prepare("UPDATE order_items SET sku = ?, imported_at = CURRENT_TIMESTAMP WHERE id = ?").run(targetSku, row.id);
      }
      migratedOrderLines += 1;
    }

    for (const row of movementRows) {
      db.prepare(
        `INSERT INTO inventory_movements
           (sku, warehouse_id, movement_date, quantity, source_type, platform, order_id, sub_order_id, note)
         VALUES
           (@sku, @warehouseId, @movementDate, @quantity, @sourceType, @platform, @orderId, @subOrderId, @note)
         ON CONFLICT(source_type, platform, order_id, sub_order_id, sku, warehouse_id) DO UPDATE SET
           quantity = inventory_movements.quantity + excluded.quantity,
           note = excluded.note,
           imported_at = CURRENT_TIMESTAMP`
      ).run({
        sku: targetSku,
        warehouseId: row.warehouseId,
        movementDate: row.movementDate || nowDate(),
        quantity: row.quantity,
        sourceType: row.sourceType || "order_mapping",
        platform: row.platform || "",
        orderId: row.orderId || "",
        subOrderId: row.subOrderId || row.orderId || "",
        note: `待维护SKU ${sourceSku} 合并到 ${targetSku}${row.note ? `；${row.note}` : ""}`
      });
      if (Number(row.quantity || 0) < 0) deductedQuantity += Math.abs(Number(row.quantity || 0));
      db.prepare("DELETE FROM inventory_movements WHERE id = ?").run(row.id);
    }

    db.prepare("UPDATE skus SET status = 'merged', updated_at = CURRENT_TIMESTAMP WHERE sku = ?").run(sourceSku);
    db.prepare(
      `INSERT INTO operation_logs
         (entity_type, entity_id, action, before_value, after_value, note)
       VALUES
         ('inventory', @targetSku, 'merge_unmanaged_order_sku', @beforeValue, @afterValue, @note)`
    ).run({
      targetSku,
      beforeValue: JSON.stringify({ sourceSku, rowSource }),
      afterValue: JSON.stringify({ targetSku, migratedOrderLines, movementCount: movementRows.length, deductedQuantity }),
      note: `待维护订单商品 ${sourceSku} 已绑定到正式SKU ${targetSku}`
    });

    return {
      mode: "legacy_merge",
      sku: targetSku,
      sourceSku,
      matchedCount: migratedOrderLines,
      scannedCount: orderRows.length,
      skippedCount: 0,
      deductedQuantity,
      movementCount: movementRows.length
    };
  });

  return tx();
}

function matchUnmatchedSkuText({ platform, skuText, attributes = "", targetSku }) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, platform, order_id AS orderId, sub_order_id AS subOrderId,
              product_id AS productId, name, attributes, quantity,
              paid_amount AS paidAmount, status, refund_status AS refundStatus,
              order_date AS orderDate
       FROM order_unmatched_items
       WHERE platform = ?
         AND sku_text = ?
         AND (? = '' OR attributes = ?)
       ORDER BY order_date DESC, id DESC`
    )
    .all(platform, skuText, attributes, attributes);
  if (rows.length === 0) throw new Error(`没有找到可补扣的待维护订单商品：${skuText}`);

  const upsertItem = db.prepare(
    `INSERT INTO order_items (platform, order_id, sku, name, quantity, paid_amount, refund_status)
     VALUES (@platform, @orderId, @sku, @name, @quantity, @paidAmount, @refundStatus)
     ON CONFLICT(platform, order_id, sku) DO UPDATE SET
       name = excluded.name,
       quantity = order_items.quantity + excluded.quantity,
       paid_amount = order_items.paid_amount + excluded.paid_amount,
       refund_status = excluded.refund_status,
       imported_at = CURRENT_TIMESTAMP`
  );
  const upsertMovement = db.prepare(
    `INSERT INTO inventory_movements
       (sku, warehouse_id, movement_date, quantity, source_type, platform, order_id, sub_order_id, note)
     VALUES
       (@sku, @warehouseId, @movementDate, @quantity, 'order_mapping', @platform, @orderId, @subOrderId, @note)
     ON CONFLICT(source_type, platform, order_id, sub_order_id, sku, warehouse_id) DO UPDATE SET
       movement_date = excluded.movement_date,
       quantity = excluded.quantity,
       note = excluded.note,
       imported_at = CURRENT_TIMESTAMP`
  );

  const tx = db.transaction(() => {
    let deductedQuantity = 0;
    for (const row of rows) {
      upsertItem.run({
        platform: row.platform,
        orderId: row.orderId,
        sku: targetSku,
        name: row.name,
        quantity: row.quantity,
        paidAmount: row.paidAmount,
        refundStatus: row.refundStatus || row.status
      });
      const shouldDeduct = shouldDeductInventory(row.status, row.refundStatus);
      const movementQuantity = shouldDeduct ? -Math.abs(Number(row.quantity || 0)) : 0;
      upsertMovement.run({
        sku: targetSku,
        warehouseId: "cainiao",
        movementDate: row.orderDate || nowDate(),
        quantity: movementQuantity,
        platform: row.platform,
        orderId: row.orderId,
        subOrderId: row.subOrderId || row.orderId,
        note: shouldDeduct ? `待维护商家编码 ${skuText} 绑定补扣库存` : `订单状态不扣减：${row.status || row.refundStatus}`
      });
      if (shouldDeduct) deductedQuantity += Number(row.quantity || 0);
      db.prepare("DELETE FROM order_unmatched_items WHERE id = ?").run(row.id);
    }
    db.prepare(
      `INSERT INTO operation_logs
         (entity_type, entity_id, action, before_value, after_value, note)
       VALUES
         ('inventory', @targetSku, 'match_unmanaged_sku_text', @beforeValue, @afterValue, @note)`
    ).run({
      targetSku,
      beforeValue: JSON.stringify({ platform, skuText, attributes }),
      afterValue: JSON.stringify({ targetSku, matchedCount: rows.length, deductedQuantity }),
      note: `待维护订单编码 ${skuText} 已绑定到正式SKU ${targetSku}`
    });
    return {
      mode: "sku_text_mapping",
      sku: targetSku,
      matchedCount: rows.length,
      scannedCount: rows.length,
      skippedCount: 0,
      deductedQuantity
    };
  });

  return tx();
}
