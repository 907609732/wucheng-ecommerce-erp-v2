import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db.js";
import { findColumn, readSheetRows, toText } from "./sheets.js";
import {
  buildApplicationRobotMentionText,
  dingtalkReminderConfig
} from "../dingtalk-inventory-reminder.js";
import { sendDingTalkAppRobotMessage } from "../dingtalk-app-robot.js";

const REPORT_TYPE = "warehouse-monthly-sales";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthBounds(month) {
  assertMonth(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const endDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(endDay).padStart(2, "0")}`
  };
}

export function previousMonth(month) {
  assertMonth(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function latestCompleteMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function validateWarehouseMonthlySalesFile({ file, month, now = new Date() }) {
  if (!file || !fs.existsSync(file)) throw new Error("月销量源文件不存在。");
  assertMonth(month);
  const sourceFileHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const rows = readSheetRows(file);
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const columns = {
    period: findColumn(headers, ["日期", "统计日期", "时间范围", "月份", "时间粒度"]),
    sku: findColumn(headers, ["货品商家编码", "商家编码", "SKU", "sku编码", "货品编码"]),
    name: findColumn(headers, ["货品名称", "商品名称", "品名", "名称"]),
    toc: findColumn(headers, ["toC销售出", "toC销售", "toc销售出"]),
    tob: findColumn(headers, ["toB销售出", "toB销售", "tob销售出"])
  };
  const requiredColumns = ["period", "sku", "toc", "tob"];
  const missingColumns = requiredColumns.filter((key) => !columns[key]);
  const expected = monthBounds(month);
  const checks = {
    fileNotEmpty: rows.length > 0,
    requiredColumns: missingColumns.length === 0,
    completeNaturalMonth: true,
    uniqueSku: true,
    nonNegativeSales: true,
    finishedMonth: month <= latestCompleteMonth(now)
  };
  const errors = [];
  if (!checks.fileNotEmpty) errors.push("文件为空");
  if (!checks.requiredColumns) errors.push(`缺少必要列：${missingColumns.join("、")}`);
  if (!checks.finishedMonth) errors.push("当前月份尚未结束，不能进入正式月销量趋势");

  const seen = new Set();
  const items = [];
  let detectedStart = "";
  let detectedEnd = "";
  if (checks.requiredColumns) {
    rows.forEach((row, index) => {
      const sku = toText(row[columns.sku]);
      if (!sku) {
        errors.push(`第 ${index + 2} 行 SKU 为空`);
        return;
      }
      if (seen.has(sku)) {
        checks.uniqueSku = false;
        errors.push(`SKU 重复：${sku}`);
        return;
      }
      seen.add(sku);

      const range = parseDateRange(row[columns.period]);
      if (!range || range.start !== expected.start || range.end !== expected.end) {
        checks.completeNaturalMonth = false;
        errors.push(`SKU ${sku} 的日期范围不是 ${expected.start} 至 ${expected.end}`);
      } else {
        detectedStart = range.start;
        detectedEnd = range.end;
      }

      const tocSales = parseSales(row[columns.toc]);
      const tobSales = parseSales(row[columns.tob]);
      if (tocSales == null || tobSales == null) {
        checks.nonNegativeSales = false;
        errors.push(`SKU ${sku} 的 toC/toB 销量不是非负数`);
        return;
      }
      items.push({
        sku,
        productName: columns.name ? toText(row[columns.name]) : "",
        tocSales,
        tobSales,
        salesQuantity: tocSales + tobSales
      });
    });
  }
  checks.fileNotEmpty = rows.length > 0 && items.length > 0;
  if (!checks.fileNotEmpty && !errors.includes("文件为空")) errors.push("文件没有可导入的 SKU 数据");

  return {
    valid: Object.values(checks).every(Boolean) && errors.length === 0,
    month,
    periodStart: detectedStart || expected.start,
    periodEnd: detectedEnd || expected.end,
    sourceFile: path.basename(file),
    sourceFileHash,
    rowCount: rows.length,
    skuCount: items.length,
    totalSalesQuantity: items.reduce((sum, item) => sum + item.salesQuantity, 0),
    checks,
    errors: [...new Set(errors)],
    items
  };
}

export function importWarehouseMonthlySalesFile({ file, month, warehouseId = "cainiao", now = new Date() }) {
  const validation = validateWarehouseMonthlySalesFile({ file, month, now });
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO warehouses (id, name) VALUES (?, ?)").run(
    warehouseId,
    warehouseId === "cainiao" ? "菜鸟云仓" : warehouseId
  );
  if (!validation.valid) {
    insertValidation(db, warehouseId, validation, "invalid");
    const error = new Error(`月销量文件校验失败：${validation.errors.join("；")}`);
    error.code = "MONTHLY_SALES_VALIDATION_FAILED";
    error.validation = validation;
    throw error;
  }

  const existing = db.prepare(
    `SELECT COUNT(*) AS count, MIN(source_file_hash) AS sourceFileHash
       FROM warehouse_monthly_sales WHERE warehouse_id = ? AND month = ?`
  ).get(warehouseId, month);
  if (Number(existing.count) === validation.skuCount && existing.sourceFileHash === validation.sourceFileHash) {
    return { ...validation, warehouseId, unchanged: true };
  }

  const upsertSku = db.prepare(
    `INSERT INTO skus (sku, name, barcode, source, status)
     VALUES (@sku, @name, @sku, 'inventory', 'active')
     ON CONFLICT(sku) DO UPDATE SET
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE skus.name END,
       source = CASE WHEN skus.source = 'manual' THEN skus.source ELSE 'inventory' END,
       status = 'active',
       updated_at = CURRENT_TIMESTAMP`
  );
  const insertSale = db.prepare(
    `INSERT INTO warehouse_monthly_sales
       (warehouse_id, sku, month, product_name, period_start, period_end,
        toc_sales, tob_sales, sales_quantity, source_file, source_file_hash)
     VALUES (@warehouseId, @sku, @month, @productName, @periodStart, @periodEnd,
        @tocSales, @tobSales, @salesQuantity, @sourceFile, @sourceFileHash)`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM warehouse_monthly_sales WHERE warehouse_id = ? AND month = ?").run(warehouseId, month);
    validation.items.forEach((item) => {
      upsertSku.run({ sku: item.sku, name: item.productName });
      insertSale.run({
        ...item,
        warehouseId,
        month,
        periodStart: validation.periodStart,
        periodEnd: validation.periodEnd,
        sourceFile: validation.sourceFile,
        sourceFileHash: validation.sourceFileHash
      });
    });
    insertValidation(db, warehouseId, validation, "valid");
  })();
  return { ...validation, warehouseId, unchanged: false };
}

export function getWarehouseMonthlySales({ from, to, warehouseId = "cainiao", sku = "" } = {}) {
  const effectiveTo = to || latestCompleteMonth();
  const effectiveFrom = from || shiftMonth(effectiveTo, -11);
  assertMonth(effectiveFrom);
  assertMonth(effectiveTo);
  if (effectiveFrom > effectiveTo) throw new Error("from 不能晚于 to。");
  const months = listMonths(effectiveFrom, effectiveTo);
  const db = getDb();
  const validationRows = db.prepare(
    `SELECT v.month, v.status, v.row_count AS rowCount, v.sku_count AS skuCount,
            v.total_sales_quantity AS totalSalesQuantity, v.created_at AS updatedAt
       FROM warehouse_monthly_sales_validations v
       JOIN (
         SELECT month, MAX(id) AS id
           FROM warehouse_monthly_sales_validations
          WHERE warehouse_id = ? AND month BETWEEN ? AND ? GROUP BY month
       ) latest ON latest.id = v.id`
  ).all(warehouseId, effectiveFrom, effectiveTo);
  const validations = new Map(validationRows.map((row) => [row.month, row]));
  const search = String(sku || "").trim();
  const salesRows = db.prepare(
    `SELECT s.month, s.sku, COALESCE(NULLIF(s.product_name, ''), k.name, s.sku) AS productName,
            s.toc_sales AS tocSales, s.tob_sales AS tobSales, s.sales_quantity AS salesQuantity,
            s.imported_at AS importedAt
       FROM warehouse_monthly_sales s
       LEFT JOIN skus k ON k.sku = s.sku
      WHERE s.warehouse_id = ? AND s.month BETWEEN ? AND ?
        AND (? = '' OR s.sku LIKE ? OR s.product_name LIKE ?)
      ORDER BY s.sku, s.month`
  ).all(warehouseId, effectiveFrom, effectiveTo, search, `%${search}%`, `%${search}%`);

  const monthTotals = new Map();
  const skuMap = new Map();
  salesRows.forEach((row) => {
    const monthTotal = monthTotals.get(row.month) || { totalSales: 0, skuCount: 0, updatedAt: "" };
    monthTotal.totalSales += Number(row.salesQuantity);
    monthTotal.skuCount += 1;
    monthTotal.updatedAt = maxText(monthTotal.updatedAt, row.importedAt);
    monthTotals.set(row.month, monthTotal);
    if (!skuMap.has(row.sku)) skuMap.set(row.sku, { sku: row.sku, productName: row.productName, values: new Map() });
    skuMap.get(row.sku).values.set(row.month, Number(row.salesQuantity));
  });

  const monthly = months.map((month) => {
    const total = monthTotals.get(month);
    const validation = validations.get(month);
    return {
      month,
      totalSales: total ? total.totalSales : null,
      skuCount: total ? total.skuCount : 0,
      completeness: validation?.status || "missing",
      updatedAt: total?.updatedAt || validation?.updatedAt || ""
    };
  });
  const series = [...skuMap.values()].map((item) => {
    const values = months.map((month) => item.values.has(month) ? item.values.get(month) : null);
    return {
      sku: item.sku,
      productName: item.productName,
      values,
      totalSales: values.reduce((sum, value) => sum + Number(value || 0), 0)
    };
  }).sort((a, b) => b.totalSales - a.totalSales || a.sku.localeCompare(b.sku, "zh-CN"));
  // `to` 同时是页面“指定月份”的排名月份；即使缺失也保持该月份并返回空排名，
  // 不能悄悄回退到更早月份造成误读。
  const rankingMonth = effectiveTo;
  const previousRankingMonth = previousMonth(rankingMonth);
  const ranking = series.map((item) => {
    const current = item.values[months.indexOf(rankingMonth)] ?? null;
    const previousIndex = months.indexOf(previousRankingMonth);
    const previous = previousIndex >= 0 ? item.values[previousIndex] : getSkuMonthValue(db, warehouseId, item.sku, previousRankingMonth);
    return {
      sku: item.sku,
      productName: item.productName,
      salesQuantity: current,
      previousSalesQuantity: previous,
      mom: rateChange(current, previous)
    };
  }).filter((item) => item.salesQuantity != null).sort((a, b) => b.salesQuantity - a.salesQuantity || a.sku.localeCompare(b.sku, "zh-CN"));
  const latest = monthly.find((item) => item.month === rankingMonth);
  const previousTotal = monthTotals.get(previousRankingMonth)?.totalSales ?? getMonthTotal(db, warehouseId, previousRankingMonth);
  return {
    filters: { from: effectiveFrom, to: effectiveTo, warehouseId, sku: search },
    months,
    monthly,
    summary: {
      month: rankingMonth,
      totalSales: latest?.totalSales ?? null,
      skuCount: latest?.skuCount || 0,
      mom: rateChange(latest?.totalSales, previousTotal),
      topSku: ranking[0] || null,
      completeness: latest?.completeness || "missing",
      updatedAt: latest?.updatedAt || ""
    },
    top5: series.slice(0, 5),
    skuSeries: series,
    rankingMonth,
    ranking,
    table: series
  };
}

export function buildWarehouseMonthlySalesMarkdown(month, { publicUrl = process.env.ERP_PUBLIC_URL || "" } = {}) {
  assertMonth(month);
  const report = getWarehouseMonthlySales({ from: previousMonth(month), to: month });
  if (report.summary.month !== month || report.summary.completeness !== "valid") {
    const error = new Error(`${month} 月销量数据不完整，禁止生成正式月报。`);
    error.code = "MONTHLY_SALES_INCOMPLETE";
    throw error;
  }
  const top10 = report.ranking.slice(0, 10);
  const comparable = report.ranking.filter((item) => item.mom != null);
  const growth = [...comparable].sort((a, b) => b.mom - a.mom)[0] || null;
  const decline = [...comparable].sort((a, b) => a.mom - b.mom)[0] || null;
  const link = publicUrl ? `${publicUrl.replace(/\/$/, "")}#warehouse-monthly-sales` : "";
  const text = [
    `## 菜鸟云仓 SKU 月销量月报（${month}）`,
    "",
    `- 总销量：**${formatQuantity(report.summary.totalSales)} 件**（toC销售出 + toB销售出）`,
    `- 环比：**${formatRate(report.summary.mom)}**`,
    `- 活跃 SKU：**${report.summary.skuCount} 个**`,
    `- 数据完整性：**完整自然月，校验通过**`,
    "",
    "### Top 10 SKU",
    ...top10.map((item, index) => `${index + 1}. ${item.sku} ${item.productName || ""}：${formatQuantity(item.salesQuantity)} 件（环比 ${formatRate(item.mom)}）`),
    "",
    `- 增长最多：${growth ? `${growth.sku}（${formatRate(growth.mom)}）` : "暂无可比数据"}`,
    `- 下降最多：${decline ? `${decline.sku}（${formatRate(decline.mom)}）` : "暂无可比数据"}`,
    ...(link ? ["", `[查看网站趋势看板](${link})`] : [])
  ].join("\n");
  return { title: `菜鸟云仓 ${month} SKU 月销量月报`, text, data: report };
}

export async function sendWarehouseMonthlySalesReport(month, {
  dryRun = false,
  sender = sendDingTalkAppRobotMessage,
  config = dingtalkReminderConfig()
} = {}) {
  const report = buildWarehouseMonthlySalesMarkdown(month);
  if (dryRun) return { preview: true, report };
  if (!config.clientId || !config.clientSecret || !config.robotCode || !config.conversationId || !config.targetUserId) {
    throw new Error("云仓月报需要完整的钉钉企业应用机器人、会话和目标用户配置。");
  }
  const db = getDb();
  const existing = db.prepare(
    "SELECT status, attempted_at AS attemptedAt, sent_at AS sentAt FROM monthly_report_deliveries WHERE report_type = ? AND report_month = ?"
  ).get(REPORT_TYPE, month);
  if (existing && ["sent", "unknown", "pending"].includes(existing.status)) {
    return { skipped: true, reason: existing.status, delivery: existing, report };
  }
  const claim = existing?.status === "failed"
    ? db.prepare(
      `UPDATE monthly_report_deliveries SET status = 'pending', attempted_at = CURRENT_TIMESTAMP,
       sent_at = '', error_text = '', result_json = '{}', updated_at = CURRENT_TIMESTAMP
       WHERE report_type = ? AND report_month = ? AND status = 'failed'`
    ).run(REPORT_TYPE, month)
    : db.prepare(
      `INSERT OR IGNORE INTO monthly_report_deliveries
       (report_type, report_month, status, attempted_at, sent_at, error_text, result_json, updated_at)
       VALUES (?, ?, 'pending', CURRENT_TIMESTAMP, '', '', '{}', CURRENT_TIMESTAMP)`
    ).run(REPORT_TYPE, month);
  if (claim.changes !== 1) {
    const delivery = db.prepare(
      "SELECT status, attempted_at AS attemptedAt, sent_at AS sentAt FROM monthly_report_deliveries WHERE report_type = ? AND report_month = ?"
    ).get(REPORT_TYPE, month);
    return { skipped: true, reason: delivery?.status || "pending", delivery, report };
  }
  try {
    const result = await sender({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      robotCode: config.robotCode,
      conversationId: config.conversationId,
      msgKey: "sampleMarkdown",
      msgParam: {
        title: report.title,
        text: buildApplicationRobotMentionText({
          text: report.text,
          targetUserId: config.targetUserId,
          targetName: config.targetName
        })
      },
      userIds: [config.targetUserId]
    });
    db.prepare(
      `UPDATE monthly_report_deliveries SET status = 'sent', sent_at = CURRENT_TIMESTAMP,
       result_json = ?, error_text = '', updated_at = CURRENT_TIMESTAMP
       WHERE report_type = ? AND report_month = ?`
    ).run(JSON.stringify(sanitizeResult(result)), REPORT_TYPE, month);
    return { sent: true, result, report };
  } catch (error) {
    const status = isUnknownDelivery(error) ? "unknown" : "failed";
    db.prepare(
      `UPDATE monthly_report_deliveries SET status = ?, error_text = ?, updated_at = CURRENT_TIMESTAMP
       WHERE report_type = ? AND report_month = ?`
    ).run(status, String(error.message || error).slice(0, 1000), REPORT_TYPE, month);
    error.deliveryStatus = status;
    throw error;
  }
}

function insertValidation(db, warehouseId, validation, status) {
  db.prepare(
    `INSERT INTO warehouse_monthly_sales_validations
       (warehouse_id, month, source_file, source_file_hash, period_start, period_end, status,
        row_count, sku_count, total_sales_quantity, checks_json, error_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    warehouseId,
    validation.month,
    validation.sourceFile,
    validation.sourceFileHash,
    validation.periodStart,
    validation.periodEnd,
    status,
    validation.rowCount,
    validation.skuCount,
    validation.totalSalesQuantity,
    JSON.stringify(validation.checks),
    validation.errors.join("；")
  );
}

function parseDateRange(value) {
  const text = toText(value).replace(/\//g, "-");
  const matches = text.match(/\d{4}-\d{1,2}-\d{1,2}/g);
  if (!matches || matches.length < 2) return null;
  return { start: normalizeDate(matches[0]), end: normalizeDate(matches[1]) };
}

function normalizeDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseSales(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (text === "") return 0;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function listMonths(from, to) {
  const result = [];
  let cursor = from;
  while (cursor <= to) {
    result.push(cursor);
    cursor = shiftMonth(cursor, 1);
  }
  return result;
}

function shiftMonth(month, offset) {
  assertMonth(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function rateChange(current, previous) {
  if (current == null || previous == null || Number(previous) === 0) return null;
  return (Number(current) - Number(previous)) / Number(previous);
}

function getMonthTotal(db, warehouseId, month) {
  const row = db.prepare(
    "SELECT SUM(sales_quantity) AS total FROM warehouse_monthly_sales WHERE warehouse_id = ? AND month = ?"
  ).get(warehouseId, month);
  return row?.total == null ? null : Number(row.total);
}

function getSkuMonthValue(db, warehouseId, sku, month) {
  const row = db.prepare(
    "SELECT sales_quantity AS value FROM warehouse_monthly_sales WHERE warehouse_id = ? AND sku = ? AND month = ?"
  ).get(warehouseId, sku, month);
  return row?.value == null ? null : Number(row.value);
}

function maxText(a, b) {
  return String(a || "") > String(b || "") ? a : b;
}

function formatQuantity(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatRate(value) {
  if (value == null) return "无可比数据";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function sanitizeResult(result) {
  if (!result || typeof result !== "object") return { acknowledged: true };
  const safe = {};
  for (const key of ["processQueryKey", "messageId", "success", "code"]) {
    if (result[key] != null) safe[key] = result[key];
  }
  return Object.keys(safe).length ? safe : { acknowledged: true };
}

function isUnknownDelivery(error) {
  const code = String(error?.code || "").toUpperCase();
  return ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH"].includes(code)
    || /timeout|timed out|socket hang up/i.test(String(error?.message || ""));
}

function assertMonth(month) {
  if (!MONTH_PATTERN.test(String(month || ""))) throw new Error(`月份格式无效：${month || "空"}，应为 YYYY-MM。`);
}
