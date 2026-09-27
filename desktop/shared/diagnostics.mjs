const ERROR_MARKERS = ["error", "failed", "失败", "错误", "异常", "退出码", "失效", "验证码", "滑块", "blocked"];
const WARNING_MARKERS = ["warn", "warning", "警告", "提醒", "⚠", "未配置", "跳过"];

export function sanitizeDiagnosticText(value, sensitiveValues = []) {
  let text = String(value ?? "");
  for (const secret of sensitiveValues) {
    const candidate = String(secret || "").trim();
    if (candidate.length >= 4) text = text.split(candidate).join("[REDACTED]");
  }
  return text
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/(access_token|password|passwd|client[_ -]?secret|webhook|authorization|token|secret)(\s*[=:]\s*)([^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

export function redactDiagnosticValue(value, sensitiveValues = [], depth = 0) {
  if (depth > 12) return "[MAX_DEPTH]";
  if (typeof value === "string") return sanitizeDiagnosticText(value, sensitiveValues);
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => redactDiagnosticValue(item, sensitiveValues, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [key, redactDiagnosticValue(item, sensitiveValues, depth + 1)]));
  }
  if (["number", "boolean"].includes(typeof value) || value === null) return value;
  return String(value ?? "");
}

export function diagnosticLogLevel(line) {
  const normalized = String(line || "").toLowerCase();
  if (ERROR_MARKERS.some((marker) => normalized.includes(marker))) return "error";
  if (WARNING_MARKERS.some((marker) => normalized.includes(marker))) return "warning";
  return "info";
}

export function searchDiagnosticLines(lines, { query = "", level = "any", limit = 50, sensitiveValues = [] } = {}) {
  const needle = String(query || "").trim().toLowerCase().slice(0, 100);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  return lines
    .map((line) => sanitizeDiagnosticText(line, sensitiveValues))
    .filter((line) => !needle || line.toLowerCase().includes(needle))
    .filter((line) => level === "any" || diagnosticLogLevel(line) === level)
    .slice(-safeLimit);
}

export function diagnosticHealth(checks) {
  const errors = checks.filter((check) => check.status === "error");
  const warnings = checks.filter((check) => check.status === "warning");
  return {
    status: errors.length ? "error" : (warnings.length ? "warning" : "healthy"),
    errorCount: errors.length,
    warningCount: warnings.length
  };
}
