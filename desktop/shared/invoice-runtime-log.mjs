import fs from 'node:fs';
import path from 'node:path';
import { sanitizeDiagnosticText } from './diagnostics.mjs';

// 独立于 ERP 主日志与库存数据库。按本机日期分文件，读取最近记录时跨日合并。
export function invoiceLogDirectory(workspace) { return path.join(workspace, 'invoice-logs'); }
function day(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function clean(value) {
  return sanitizeDiagnosticText(String(value ?? ''))
    .replace(/([?&](?:access_token|token|sign|secret|password|key)=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/("(?:access_token|token|sign|secret|password|key)"\s*:\s*")[^"]+/gi, '$1[REDACTED]')
    .replace(/[\r\n]+/g, ' ').slice(0, 1200);
}
export function appendInvoiceLog(workspace, { level = 'info', source = 'erp', message }, now = new Date()) {
  const dir = invoiceLogDirectory(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { at: now.toISOString(), level: ['info', 'warning', 'error'].includes(level) ? level : 'info', source: clean(source), message: clean(message) };
  fs.appendFileSync(path.join(dir, `${day(now)}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}
export function readInvoiceLogs(workspace, limit = 300) {
  const dir = invoiceLogDirectory(workspace);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
  const max = Math.max(1, Math.min(300, Number(limit) || 300));
  const entries = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1); // discard partial first line
    } finally { fs.closeSync(fd); }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && entries.length < max; i--) {
      if (!lines[i]) continue;
      try {
        const entry = JSON.parse(lines[i]);
        entries.push({ at: entry.at, level: entry.level, source: clean(entry.source), message: clean(entry.message) });
      } catch { /* truncated crash tail: ignore only this line */ }
    }
    if (entries.length >= max) break;
  }
  return entries.reverse();
}
