import fs from "node:fs";
import path from "node:path";
import XLSX from "../xlsx.js";

export function readSheetRows(file) {
  if (/\.(csv|tsv)$/i.test(file)) {
    return readDelimitedRows(file);
  }

  const workbook = XLSX.readFile(file, { cellDates: true });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return [];

  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
    defval: "",
    raw: false
  });
}

function readDelimitedRows(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const delimiter = path.extname(file).toLowerCase() === ".tsv" || text.includes("\t") ? "\t" : ",";
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const table = lines.map((line) => parseDelimitedLine(line, delimiter));
  if (table.length === 0) return [];

  const firstDataIndex = table.findIndex((row) => looksLikeDataRow(row[0]));
  if (firstDataIndex > 0) {
    const headers = table
      .slice(0, firstDataIndex)
      .flatMap((row) => row.map((cell) => toText(cell)).filter(Boolean));
    return table.slice(firstDataIndex).map((row) => rowToObject(headers, row));
  }

  const headers = table[0].map((cell) => toText(cell));
  return table.slice(1).map((row) => rowToObject(headers, row));
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function rowToObject(headers, row) {
  const object = {};
  headers.forEach((header, index) => {
    if (!header) return;
    object[header] = row[index] ?? "";
  });
  return object;
}

function looksLikeDataRow(value) {
  const text = toText(value);
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text) || /^\d{10,}$/.test(text);
}

export function normalizeHeader(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[()（）【】\[\]：:]/g, "")
    .toLowerCase();
}

export function findColumn(headers, candidates = []) {
  const normalizedHeaders = headers.map((header) => ({
    raw: header,
    normalized: normalizeHeader(header)
  }));
  const normalizedCandidates = candidates.map(normalizeHeader);

  for (const candidate of normalizedCandidates) {
    const exact = normalizedHeaders.find((header) => header.normalized === candidate);
    if (exact) return exact.raw;
  }

  for (const candidate of normalizedCandidates) {
    const partial = normalizedHeaders.find(
      (header) => header.normalized.includes(candidate) || candidate.includes(header.normalized)
    );
    if (partial) return partial.raw;
  }

  return null;
}

export function toNumber(value) {
  if (typeof value === "number") return value;
  const normalized = String(value || "")
    .replace(/,/g, "")
    .replace(/[￥¥元]/g, "")
    .trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

export function toText(value) {
  return String(value || "").trim();
}

export function toDateText(value) {
  const text = toText(value);
  if (!text) return new Date().toISOString().slice(0, 10);

  const normalized = text.replace(/\//g, "-");
  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);

  return text.slice(0, 10);
}

export function monthFromDateText(value) {
  return toDateText(value).slice(0, 7);
}
