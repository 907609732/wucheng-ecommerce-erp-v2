import fs from "node:fs";
import path from "node:path";
import { getDb, nowDate } from "./db.js";
import { readSheetRows, toNumber, toText } from "./sheets.js";

const REQUIRED_COLUMNS = [
  "日期",
  "货品条码",
  "期初库存",
  "入库汇总",
  "出库汇总",
  "期末库存",
  "近30天销量"
];

export function previousBusinessDate(date = nowDate(), days = 1) {
  const [year, month, day] = String(date).split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export function validateCainiaoInventoryFile({
  file,
  expectedSourceDate = previousBusinessDate(),
  previousFile = "",
  minRows = 10
}) {
  const rows = readSheetRows(file);
  const previousRows = previousFile ? readSheetRows(previousFile) : [];
  return validateCainiaoInventoryRows(rows, {
    file,
    expectedSourceDate,
    previousRows,
    previousFile,
    minRows
  });
}

export function validateCainiaoInventoryRows(rows, {
  file = "",
  expectedSourceDate = previousBusinessDate(),
  previousRows = [],
  previousFile = "",
  minRows = 10
} = {}) {
  const errors = [];
  const warnings = [];
  const headers = Object.keys(rows[0] || {});
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missingColumns.length) errors.push(`缺少必需列：${missingColumns.join("、")}`);
  if (rows.length < minRows) errors.push(`库存行数过少：${rows.length}，最低要求 ${minRows}`);

  const sourceDates = new Set();
  const skuRows = new Map();
  let totalQuantity = 0;
  let invalidFormulaCount = 0;
  let invalidNumberCount = 0;
  let duplicateCount = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const period = parseDailyPeriod(row["日期"]);
    if (!period) {
      errors.push(`第 ${rowNumber} 行日期不是单日范围：${toText(row["日期"]) || "空"}`);
    } else {
      sourceDates.add(period);
    }

    const sku = toText(row["货品条码"]);
    if (!sku) {
      errors.push(`第 ${rowNumber} 行货品条码为空`);
      return;
    }
    if (skuRows.has(sku)) {
      duplicateCount += 1;
      errors.push(`货品条码重复：${sku}`);
      return;
    }

    const numericColumns = ["期初库存", "入库汇总", "出库汇总", "期末库存", "近30天销量"];
    const values = {};
    for (const column of numericColumns) {
      const raw = toText(row[column]);
      if (raw === "" || !Number.isFinite(Number(raw.replace(/,/g, "")))) {
        invalidNumberCount += 1;
        errors.push(`第 ${rowNumber} 行 ${column} 不是有效数字`);
      }
      values[column] = toNumber(row[column]);
      if (values[column] < 0) errors.push(`第 ${rowNumber} 行 ${column} 不能为负数`);
    }

    const calculatedEnding = values["期初库存"] + values["入库汇总"] - values["出库汇总"];
    if (Math.abs(calculatedEnding - values["期末库存"]) > 0.001) {
      invalidFormulaCount += 1;
      errors.push(
        `第 ${rowNumber} 行 ${sku} 库存不平：${values["期初库存"]} + ${values["入库汇总"]} - ${values["出库汇总"]} != ${values["期末库存"]}`
      );
    }
    totalQuantity += values["期末库存"];
    skuRows.set(sku, { sku, beginning: values["期初库存"], ending: values["期末库存"] });
  });

  if (sourceDates.size !== 1) {
    errors.push(`库存文件必须只有一个来源日期，实际为：${[...sourceDates].join("、") || "空"}`);
  }
  const sourceDate = sourceDates.size === 1 ? [...sourceDates][0] : "";
  if (sourceDate && expectedSourceDate && sourceDate !== expectedSourceDate) {
    errors.push(`来源日期异常：期望 ${expectedSourceDate}，实际 ${sourceDate}`);
  }

  const previous = summarizePreviousRows(previousRows);
  if (previous.sourceDate && sourceDate) {
    const expectedPreviousDate = previousBusinessDate(sourceDate);
    if (previous.sourceDate === expectedPreviousDate) {
      const continuityErrors = [];
      let overlap = 0;
      for (const [sku, current] of skuRows) {
        const prior = previous.skuRows.get(sku);
        if (!prior) continue;
        overlap += 1;
        if (Math.abs(prior.ending - current.beginning) > 0.001) {
          continuityErrors.push(`${sku}: 前日 ${prior.ending}，本日期初 ${current.beginning}`);
        }
      }
      const minimumOverlap = Math.ceil(Math.min(skuRows.size, previous.skuRows.size) * 0.8);
      if (overlap < minimumOverlap) errors.push(`与前日库存重合 SKU 过少：${overlap}/${minimumOverlap}`);
      if (continuityErrors.length) {
        errors.push(`跨日库存不连续：${continuityErrors.slice(0, 8).join("；")}`);
      }
    } else {
      warnings.push(`未找到相邻日期基线，最近文件日期为 ${previous.sourceDate}`);
    }
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "valid" : "invalid",
    file: path.basename(file || ""),
    previousFile: path.basename(previousFile || ""),
    sourceDate,
    expectedSourceDate,
    rowCount: rows.length,
    skuCount: skuRows.size,
    totalQuantity,
    invalidFormulaCount,
    invalidNumberCount,
    duplicateCount,
    errors,
    warnings
  };
}

export function findLatestPriorCainiaoFile({ dir, currentFile, sourceDate }) {
  if (!fs.existsSync(dir)) return "";
  const candidates = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.xlsx$/i.test(name)) continue;
    const file = path.join(dir, name);
    if (path.resolve(file) === path.resolve(currentFile)) continue;
    try {
      const rows = readSheetRows(file);
      const candidateDate = uniqueSourceDate(rows);
      if (candidateDate && candidateDate < sourceDate) candidates.push({ file, sourceDate: candidateDate });
    } catch {
      // A broken historical export is not a valid baseline.
    }
  }
  candidates.sort((a, b) => b.sourceDate.localeCompare(a.sourceDate));
  return candidates[0]?.file || "";
}

export function recordInventoryValidation(result, { warehouseId = "cainiao" } = {}) {
  getDb().prepare(
    `INSERT INTO inventory_data_validations
       (warehouse_id, source_file, source_date, expected_source_date, status,
        row_count, total_quantity, checks_json, error_text)
     VALUES (@warehouseId, @sourceFile, @sourceDate, @expectedSourceDate, @status,
             @rowCount, @totalQuantity, @checksJson, @errorText)`
  ).run({
    warehouseId,
    sourceFile: result.file || "",
    sourceDate: result.sourceDate || "",
    expectedSourceDate: result.expectedSourceDate || "",
    status: result.ok ? "valid" : "invalid",
    rowCount: Number(result.rowCount || 0),
    totalQuantity: Number(result.totalQuantity || 0),
    checksJson: JSON.stringify(result),
    errorText: (result.errors || []).join("；")
  });
}

export function getInventoryNotificationGate({ warehouseId = "cainiao", expectedSourceDate = process.env.CAINIAO_EXPECTED_SOURCE_DATE || "" } = {}) {
  const db = getDb();
  const validation = db.prepare(
    `SELECT id, source_file AS sourceFile, source_date AS sourceDate,
            expected_source_date AS expectedSourceDate, status, row_count AS rowCount,
            total_quantity AS totalQuantity, error_text AS errorText, created_at AS createdAt
       FROM inventory_data_validations
      WHERE warehouse_id = ?
      ORDER BY id DESC
      LIMIT 1`
  ).get(warehouseId);
  if (!validation) return { ok: false, reason: "unvalidated", message: "库存数据尚未通过发布校验。" };
  if (validation.status !== "valid") {
    return { ok: false, reason: "invalid", message: validation.errorText || "最近一次库存校验失败。", validation };
  }
  if (expectedSourceDate && validation.sourceDate !== expectedSourceDate) {
    return {
      ok: false,
      reason: "stale_source_date",
      message: `库存来源日期不是应发布日期：期望 ${expectedSourceDate}，实际 ${validation.sourceDate}`,
      validation
    };
  }
  const snapshot = db.prepare(
    `SELECT snapshot_date AS snapshotDate, COUNT(*) AS rowCount, COALESCE(SUM(quantity), 0) AS totalQuantity
       FROM inventory_snapshots
      WHERE warehouse_id = ? AND snapshot_date = (
        SELECT MAX(snapshot_date) FROM inventory_snapshots WHERE warehouse_id = ?
      )`
  ).get(warehouseId, warehouseId);
  if (!snapshot || snapshot.snapshotDate !== validation.sourceDate) {
    return { ok: false, reason: "snapshot_date_mismatch", message: "ERP 最新库存日期与校验记录不一致。", validation, snapshot };
  }
  if (Number(snapshot.rowCount) !== Number(validation.rowCount) || Math.abs(Number(snapshot.totalQuantity) - Number(validation.totalQuantity)) > 0.001) {
    return { ok: false, reason: "snapshot_content_mismatch", message: "ERP 库存内容与已校验文件不一致。", validation, snapshot };
  }
  return { ok: true, reason: "validated", sourceDate: validation.sourceDate, validation, snapshot };
}

function parseDailyPeriod(value) {
  const matches = toText(value).match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (!matches.length) return "";
  return matches.every((date) => date === matches[0]) ? matches[0] : "";
}

function uniqueSourceDate(rows) {
  const dates = new Set(rows.map((row) => parseDailyPeriod(row["日期"])).filter(Boolean));
  return dates.size === 1 ? [...dates][0] : "";
}

function summarizePreviousRows(rows) {
  const skuRows = new Map();
  for (const row of rows) {
    const sku = toText(row["货品条码"]);
    if (!sku) continue;
    skuRows.set(sku, { ending: toNumber(row["期末库存"]) });
  }
  return { sourceDate: uniqueSourceDate(rows), skuRows };
}
