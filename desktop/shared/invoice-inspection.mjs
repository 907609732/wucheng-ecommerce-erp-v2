/**
 * 开票巡检账本：记录每家店铺每日「待处理申请 / 待录入开票」数量，并汇总发送钉钉提醒。
 *
 * 只做只读巡检、登记与提醒，不审批、不实际开票、不回传平台。
 * 数量口径沿用千牛「给买家开票」页：待处理申请 + 待录入开票；待录入不等于尚未开具。
 * 登录失败 / 查询失败记为「未知」，不记成零，避免把失败当成「无待开票」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const OUTCOMES = Object.freeze(['observed', 'needs_login', 'error']);
export const COVERAGES = Object.freeze(['platform_available_range', 'visible_range', 'unknown']);
const json = v => JSON.stringify(v);
const parse = v => JSON.parse(v);
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);

/** 北京时间当天日期（YYYY-MM-DD）。 */
export function chinaDateString(now = new Date()) {
  const d = new Date(now.getTime() + 8 * 3600000).toISOString();
  return d.slice(0, 10);
}

/** 校验一次巡检结果，返回规范化后的观测。无效输入直接抛错，避免把失败写成零。 */
export function validateInvoiceObservation(value) {
  const result = { ...value };
  if (typeof result.shop !== 'string' || !result.shop.trim()) throw new Error('必须提供已经核实的店铺名称');
  result.shop = result.shop.trim();
  if (!OUTCOMES.includes(result.outcome)) throw new Error('检查结果无效（observed / needs_login / error）');
  if (!COVERAGES.includes(result.coverage)) throw new Error('查询覆盖范围无效');
  for (const key of ['pending_count', 'unrecorded_count']) {
    const count = result[key];
    if (count !== null && count !== undefined && (!Number.isInteger(count) || count < 0)) throw new Error('申请数量必须是非负整数，未知不能填零');
  }
  if (result.outcome !== 'observed') {
    if (result.pending_count !== null && result.pending_count !== undefined) throw new Error('登录或查询失败时不能记录待处理数量');
    if (result.unrecorded_count !== null && result.unrecorded_count !== undefined) throw new Error('登录或查询失败时不能记录待录入数量');
    if (!clean(result.message)) throw new Error('失败时必须记录原因');
    result.pending_count = null;
    result.unrecorded_count = null;
    result.coverage = 'unknown';
    result.state = result.outcome;
  } else {
    if (result.pending_count === null || result.pending_count === undefined) throw new Error('正常观察必须核实待处理数量');
    if ((result.unrecorded_count === null || result.unrecorded_count === undefined) && result.metric !== 'pending_only') throw new Error('正常观察必须核实待录入数量');
    if (result.metric === 'pending_only' && result.unrecorded_count !== null) throw new Error('仅待开票口径不可填待录入数量');
    if (result.coverage === 'unknown') throw new Error('成功观察必须明确实际查询范围');
    const start = clean(result.scope_start, 10);
    const end = clean(result.scope_end, 10);
    if (result.coverage === 'platform_available_range') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('声明已核实平台完整范围时必须提供起止日期');
      if (start > end || end > chinaDateString()) throw new Error('日期范围无效或结束日期在未来');
    }
    result.scope_start = /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : '';
    result.scope_end = /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : '';
    if (result.pending_count || result.unrecorded_count) result.state = 'attention';
    else if (result.coverage !== 'platform_available_range') result.state = 'partial';
    else result.state = 'clear';
  }
  result.checked_at = new Date().toISOString();
  result.id = result.id || randomUUID();
  return result;
}

/** 店铺最新一条 + 汇总。 */
export function summarizeChecks(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (!latest.has(row.shop) || String(row.checked_at) > String(latest.get(row.shop).checked_at)) latest.set(row.shop, row);
  }
  const shops = [...latest.values()].sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)));
  const totalPending = shops.reduce((sum, row) => sum + (Number(row.pending_count) || 0), 0);
  const totalUnrecorded = shops.reduce((sum, row) => sum + (Number(row.unrecorded_count) || 0), 0);
  return { shops, total_pending: totalPending, total_unrecorded: totalUnrecorded };
}

/** 钉钉提醒正文（纯函数，便于测试）。 */
export function buildInvoiceInspectionText(summary, { date = chinaDateString(), time = '20:00' } = {}) {
  const { shops, total_pending, total_unrecorded } = summary || { shops: [], total_pending: 0, total_unrecorded: 0 };
  const lines = [`【每日开票巡检】${date} ${time}`];
  if (!shops.length) {
    lines.push('暂无店铺巡检记录，不能视为没有待开票申请。');
  } else {
    lines.push(shops.some(row => row.shop.startsWith('拼多多·'))
      ? `共 ${shops.length} 家店铺，待处理/待开票 ${total_pending} 笔，淘宝待录入开票 ${total_unrecorded} 笔（拼多多不适用）。`
      : `共 ${shops.length} 家店铺，待处理申请 ${total_pending} 笔，待录入开票 ${total_unrecorded} 笔。`);
    lines.push('');
    for (const row of shops) {
      if (row.state === 'needs_login') lines.push(`- ${row.shop}：需要登录（${row.message || '请打开目标店铺工作台'}）`);
      else if (row.state === 'error') lines.push(`- ${row.shop}：检查失败（${row.message || '请查看运行日志'}）`);
      else if (row.unrecorded_count === null && row.shop.startsWith('拼多多·')) lines.push(`- ${row.shop}：待开票 ${row.pending_count ?? '未知'} · 待录入 不适用（订单开票列表）`);
      else lines.push(`- ${row.shop}：待处理 ${row.pending_count ?? '未知'} · 待录入 ${row.unrecorded_count ?? '未知'}`);
    }
  }
  lines.push('');
  lines.push('待录入开票不等于尚未开具，请逐份核对外部开票记录。登录或查询失败的店铺不记为 0。');
  return lines.join('\n');
}

export class InvoiceInspectionStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'invoice-inspection.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS checks(
        id TEXT PRIMARY KEY,
        shop TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        state TEXT NOT NULL,
        pending_count INTEGER,
        unrecorded_count INTEGER,
        scope_start TEXT NOT NULL DEFAULT '',
        scope_end TEXT NOT NULL DEFAULT '',
        coverage TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checks_shop ON checks(shop, checked_at DESC);`);
  }
  close() { this.db.close(); }
  record(observation) {
    const row = validateInvoiceObservation(observation);
    this.db.prepare('INSERT INTO checks(id,shop,checked_at,state,pending_count,unrecorded_count,scope_start,scope_end,coverage,message,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.shop, row.checked_at, row.state, row.pending_count, row.unrecorded_count, row.scope_start || '', row.scope_end || '', row.coverage, clean(row.message, 600), json(row));
    return row;
  }
  history(limit = 100) {
    const n = Math.max(1, Math.min(Number(limit) || 100, 1000));
    return this.db.prepare('SELECT * FROM checks ORDER BY checked_at DESC, rowid DESC LIMIT ?').all(n).map(r => ({ ...r, payload: parse(r.payload) }));
  }
  summary() {
    return summarizeChecks(this.db.prepare('SELECT * FROM checks').all());
  }
}
