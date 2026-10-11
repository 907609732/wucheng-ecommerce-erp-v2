/**
 * 财务账版：全新的账本。不得读取 business_*、运营 Excel 或钉钉经营数据。
 * 先建店铺 → 导入原始账单并选择字段 → 核对 → 保存填表草稿 → 导出。
 * 金额用整数分；平台收入、结算收入、费用分开，草稿不是正式纳税申报。
 * 详细使用方法/取账边界见 docs/finance-ledger.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
XLSX.set_fs(fs);
XLSX.set_cptable(cptable);

export const BILL_KINDS = { income: '收入账单', expense: '支出账单', tax: '涉税信息报送账单' };
export const DRAFT_FIELDS = { taxable: '应税销售额（不含税，待确认）', exempt: '免税销售额（待确认）', specialInvoice: '专票销售额（不含税）', ordinaryInvoice: '普票销售额（不含税）', uninvoiced: '未开票销售额（不含税）', adjustment: '其他调整金额' };
const json = v => JSON.stringify(v);
const parse = v => JSON.parse(v);
const hash = v => createHash('sha256').update(v).digest('hex');
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
export function validMonth(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value)) || +String(value).slice(0, 4) < 2000) throw new Error('请选择有效的账期（YYYY-MM）');
  return String(value);
}
export function shiftFinanceMonth(value, delta) {
  validMonth(value); const [y, m] = value.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
export function chinaDate(now = new Date()) {
  const date = new Date(now.getTime() + 8 * 3600000).toISOString();
  return { month: date.slice(0, 7), day: +date.slice(8, 10), hour: +date.slice(11, 13) };
}
// Latest due month: before the 15th, the previous scheduled cycle remains eligible
// for catch-up. Jobs persist before opening the browser; login failures never loop.
export function dueFinanceMonth(now = new Date()) {
  const c = chinaDate(now); return shiftFinanceMonth(c.month, c.day > 15 || (c.day === 15 && c.hour >= 9) ? -1 : -2);
}
export function cents(value) {
  if (value === null || value === undefined || String(value).trim() === '' || /^[—–-]$/.test(String(value).trim())) return null;
  let s = String(value).trim().replace(/[,，￥¥\s]/g, '').replace(/元$/, '');
  if (/^\(.+\)$/.test(s)) s = '-' + s.slice(1, -1);
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`无法识别金额或超过两位小数：${clean(value, 40)}`);
  const sign = s.startsWith('-') ? -1 : 1; const [whole, fraction = ''] = s.replace(/^[+-]/, '').split('.');
  const n = sign * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(n) || Math.abs(n) > 1e14) throw new Error('金额超出支持范围');
  return n;
}
const total = (rows, key) => rows.length && rows.every(r => r[key] !== null) ? rows.reduce((s, r) => s + r[key], 0) : null;
function workbook(file) {
  if (fs.statSync(file).size > 80 * 1024 * 1024) throw new Error('账单超过 80 MB，请按月份拆分导出');
  if (path.extname(file).toLowerCase() === '.xlsx') {
    const zip = new AdmZip(file); if (zip.getEntries().reduce((n, e) => n + e.header.size, 0) > 300 * 1024 * 1024) throw new Error('账单解压后过大');
  }
  let b;
  if (path.extname(file).toLowerCase() === '.csv') {
    const bytes = fs.readFileSync(file); let content;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) content = new TextDecoder('utf-16le').decode(bytes);
    else { try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { content = new TextDecoder('gb18030').decode(bytes); } }
    b = XLSX.read(content, { type: 'string', raw: true, cellFormula: true });
  } else b = XLSX.readFile(file, { cellFormula: true, cellDates: false, raw: true });
  if (!b.SheetNames.length) throw new Error('文件中没有工作表'); return b;
}
function monthOf(v) {
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}` : ''; }
  const m = String(v ?? '').match(/(20\d{2})[-年/.](\d{1,2})(?:月|[-/.\sT]|$)/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : '';
}
function parseBill(file, options) {
  const b = workbook(file); const ws = b.Sheets[options.sheet]; if (!ws) throw new Error('工作表不存在');
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const first = Number(options.firstRow); const last = Number(options.lastRow);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 2 || last < first || last > range.e.r + 1 || last - first > 100000) throw new Error('请指定有效的数据行范围（不含表头、合计）');
  if (!BILL_KINDS[options.kind]) throw new Error('请选择账单类型');
  validMonth(options.month);
  if (!options.confirmScope) throw new Error('请确认本店本月的账单范围，且未混用合计和明细');
  const map = options.mapping || {};
  if (options.kind === 'expense' ? !map.expense : !(map.gross || map.net)) throw new Error('请选择支出金额列，或收入总额/收入净额列');
  const mapped = Object.values(map).filter(Boolean);
  if (new Set(mapped).size !== mapped.length) throw new Error('不同字段不能选择同一列');
  for (const col of mapped) if (!/^[A-Z]{1,3}$/.test(col) || XLSX.utils.decode_col(col) > range.e.c) throw new Error('字段列无效');
  const rows = [], issues = [], seen = new Set();
  for (let r = first; r <= last; r++) {
    const raw = {}; let any = false;
    for (let c = 0; c <= range.e.c; c++) { const address = `${XLSX.utils.encode_col(c)}${r}`; const cell = ws[address]; if (cell) { raw[address] = { value: cell.v ?? null, formula: cell.f ?? null, type: cell.t }; if (cell.v !== undefined || cell.f) any = true; } }
    if (!any) continue;
    const row = { row: r, sheet: options.sheet, gross: null, refund: null, net: null, expense: null, raw, source: {}, note: '' };
    for (const key of ['gross', 'refund', 'net', 'expense', 'date', 'reference']) {
      if (!map[key]) continue; const addr = `${map[key]}${r}`; const cell = ws[addr]; row.source[key] = addr;
      if (cell?.f && (cell.v === undefined || cell.v === null)) issues.push(`${options.sheet}!${addr} 的公式缺少缓存结果`);
      if (cell?.t === 'e') issues.push(`${options.sheet}!${addr} 为公式错误`);
      if (['date', 'reference'].includes(key)) row[key] = String(cell?.v ?? '');
      else { try { row[key] = cents(cell?.v); } catch (e) { issues.push(`${addr}：${e.message}`); } }
      if (key === 'date' && monthOf(cell?.v) !== options.month) issues.push(`${addr} 的账期与 ${options.month} 不一致或无法识别`);
    }
    if (row.net === null && row.gross !== null && row.refund !== null && !map.net) { row.net = row.gross - row.refund; row.note = '净额由收入总额减退款计算'; }
    if (row.gross !== null && row.refund !== null && row.net !== null && row.gross - row.refund !== row.net) issues.push(`第 ${r} 行：收入总额减退款与净额不一致，保留原值`);
    if (options.kind === 'expense' ? row.expense === null : row.gross === null && row.net === null) issues.push(`第 ${r} 行金额缺失，不能按零处理`);
    const fingerprint = hash(json(Object.values(raw).map(c => c.value)));
    if (seen.has(fingerprint)) issues.push(`第 ${r} 行与前面的数据完全相同，请核对是否重复`); seen.add(fingerprint);
    rows.push(row);
  }
  if (!rows.length) throw new Error('选定范围没有账单数据；空表不作为零收入凭证');
  if (!map.date) issues.push('原表未映射日期列，账期由导入时人工确认');
  return { rows, issues: [...new Set(issues)], totals: Object.fromEntries(['gross', 'refund', 'net', 'expense'].map(k => [k, total(rows, k)])) };
}

export class FinanceLedger {
  constructor(directory) {
    this.directory = directory; fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'finance.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_shop_rollbacks(id TEXT PRIMARY KEY, capability TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bills(id TEXT PRIMARY KEY, shop TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, file TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, shop TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, job TEXT NOT NULL, shop TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, plan TEXT NOT NULL, message TEXT NOT NULL, created TEXT NOT NULL, closed TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS job_items(id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, shop TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, subtype TEXT NOT NULL DEFAULT '', batch TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(shop TEXT NOT NULL, period TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(shop,period));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, shop TEXT NOT NULL, month TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, created TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, created TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_version ON versions(shop,month,kind) WHERE active=1;`);
    this.#migrate();
  }
  /** 老库升级：补列、放开“一个账期同类型只能有一个文件”的旧限制。 */
  #migrate() {
    const columns = this.db.prepare('PRAGMA table_info(bills)').all().map(c => c.name);
    for (const [name, type] of [['version', 'TEXT'], ['batch', 'TEXT'], ['subtype', "TEXT NOT NULL DEFAULT ''"], ['source_task', "TEXT NOT NULL DEFAULT ''"], ['bytes', 'INTEGER'], ['sha256', 'TEXT'], ['downloaded_at', "TEXT NOT NULL DEFAULT ''"]]) {
      if (!columns.includes(name)) this.db.exec(`ALTER TABLE bills ADD COLUMN ${name} ${type}`);
    }
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
    if (!jobColumns.includes('note')) this.db.exec("ALTER TABLE jobs ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    const batchColumns = this.db.prepare('PRAGMA table_info(batches)').all().map(c => c.name);
    if (!batchColumns.includes('closed')) this.db.exec("ALTER TABLE batches ADD COLUMN closed TEXT NOT NULL DEFAULT ''");
    // 旧索引限制同店同月同类型只能有一个 active 文件，与分片/批次模型冲突，直接移除。
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='active_bill'").get()) this.db.exec('DROP INDEX active_bill');
    // Preserve pre-batch saved bills and their active selection as recoverable versions.
    if (!this.db.prepare("SELECT 1 FROM bills WHERE state='saved' AND (version IS NULL OR version='') LIMIT 1").get()) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const bill of this.db.prepare("SELECT * FROM bills WHERE state='saved' AND (version IS NULL OR version='')").all()) {
        const versionId = `legacy:${bill.id}`;
        this.db.prepare("INSERT INTO versions(id,shop,month,kind,active,state,data,created) VALUES(?,?,?,?,?,'saved',?,?)")
          .run(versionId, bill.shop, bill.month, bill.kind, bill.active, json({ parts: [bill.id], migrated: true }), bill.created);
        this.db.prepare('UPDATE bills SET version=? WHERE id=?').run(versionId, bill.id);
      }
      this.db.exec('COMMIT');
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
  audit(action, data) { this.db.prepare('INSERT INTO audit(created,action,data) VALUES(?,?,?)').run(new Date().toISOString(), action, json(data)); }
  shops() { return this.db.prepare('SELECT data FROM shops ORDER BY rowid').all().map(r => parse(r.data)); }
  shop(id) { const shop = this.shops().find(s => s.id === id); if (!shop) throw new Error('请先选择财务店铺'); return shop; }
  createLoginShop(input, rollbackKey = '') {
    const id = clean(input.id, 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('登录会话标识无效，请重新添加店铺');
    if (rollbackKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rollbackKey)) throw new Error('临时店铺回滚权限无效');
    if (!clean(input.account) && !clean(input.platformShopId)) throw new Error('尚未读取到店铺账号或店铺ID，请先完成登录');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.shops().some(shop => shop.id === id)) throw new Error('该登录会话已保存');
      const shop = this.saveShop({ ...input, id: '' }, id);
      if (rollbackKey) this.db.prepare('INSERT INTO login_shop_rollbacks(id,capability,snapshot) VALUES(?,?,?)').run(id, hash(rollbackKey), json(shop));
      this.db.exec('COMMIT'); return shop;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** 仅持有本次创建能力且原记录未变、没有任何账单或任务的临时新店可撤回。 */
  rollbackLoginShop(id, rollbackKey) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const proof = this.db.prepare('SELECT * FROM login_shop_rollbacks WHERE id=?').get(id);
      if (!proof || typeof rollbackKey !== 'string' || proof.capability !== hash(rollbackKey)) throw new Error('只能回滚本次创建的临时店铺，回滚权限不符');
      const row = this.db.prepare('SELECT data FROM shops WHERE id=?').get(id);
      if (!row || row.data !== proof.snapshot) throw new Error('临时店铺已修改，不能回滚');
      for (const table of ['bills', 'versions', 'jobs', 'job_items', 'batches', 'drafts']) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE shop=? LIMIT 1`).get(id)) throw new Error('店铺已有账单或任务，不能回滚');
      }
      this.db.prepare('DELETE FROM shops WHERE id=?').run(id);
      this.db.prepare('DELETE FROM login_shop_rollbacks WHERE id=?').run(id);
      this.audit('login-shop-rollback', { id });
      this.db.exec('COMMIT'); return { rolledBack: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveShop(input, newId = '') {
    const old = input.id ? this.shop(input.id) : null;
    const name = clean(input.name); if (!name) throw new Error('请填写店铺名称');
    const id = old?.id || newId || randomUUID();
    const categoryMap = {};
    for (const [label, kind] of Object.entries(input.categoryMap || {})) {
      if (!BILL_KINDS[kind]) continue;
      const key = clean(label, 30); if (key) categoryMap[key] = kind;
    }
    const data = { id, name, platform: '淘宝/天猫', account: clean(input.account), platformShopId: clean(input.platformShopId ?? old?.platformShopId), entity: clean(input.entity), taxId: clean(input.taxId, 40),
      entityType: ['enterprise', 'individual'].includes(input.entityType) ? input.entityType : '', taxpayer: ['general', 'small'].includes(input.taxpayer) ? input.taxpayer : '',
      cycle: ['monthly', 'quarterly'].includes(input.cycle) ? input.cycle : '', schedule: Boolean(input.schedule), startMonth: validMonth(input.startMonth || shiftFinanceMonth(chinaDate().month, -1)),
      billUrl: clean(input.billUrl, 300), categoryMap,
      excludeSubtypes: Array.isArray(input.excludeSubtypes) ? [...new Set(input.excludeSubtypes.map(v => clean(v, 30)).filter(Boolean))].slice(0, 20) : (old?.excludeSubtypes || []),
      created: old?.created || new Date().toISOString() };
    if (data.schedule && !data.account) throw new Error('启用定时取账前，请填写后台可见的店铺账号，用于核对店铺');
    this.db.prepare('INSERT INTO shops(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, json(data)); this.audit('shop-save', { id }); return data;
  }
  stage(shopId, sourcePath, name = path.basename(sourcePath), meta = {}) {
    this.shop(shopId); const ext = path.extname(name).toLowerCase();
    if (!['.xlsx', '.xls', '.csv'].includes(ext)) throw new Error('请导入 Excel 或 CSV 原始账单');
    const bytes = fs.readFileSync(sourcePath); const digest = hash(bytes);
    const batch = clean(meta.batch, 60);
    if (batch) {
      const context = this.db.prepare('SELECT shop,month,kind FROM batches WHERE id=?').get(batch);
      if (!context || context.shop !== shopId || (meta.month && meta.month !== context.month) || (meta.kind && meta.kind !== context.kind)) throw new Error('文件与批次的店铺、账期或类型不一致');
      if (this.db.prepare("SELECT id FROM bills WHERE batch=? AND state IN ('preview','saved','retained','duplicate') LIMIT 1").get(batch)) throw new Error('该批次已预览或提交，请建立新批次，避免修改已核对的文件');
      const existing = this.db.prepare('SELECT id FROM bills WHERE batch=? AND digest=? AND subtype=?').get(batch, digest, clean(meta.subtype, 120));
      if (existing) return { token: existing.id, digest, duplicate: true };
    }
    workbook(sourcePath); const token = randomUUID();
    const dir = path.join(this.directory, 'originals'); fs.mkdirSync(dir, { recursive: true }); const target = path.join(dir, `${digest}${ext}`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx' });
    const record = { bytes: bytes.length, sha256: digest, downloadedAt: clean(meta.downloadedAt, 40), intentAt: clean(meta.intentAt, 40), shard: clean(meta.shard, 80), batch };
    this.db.prepare('INSERT INTO bills(id,shop,month,kind,digest,file,name,state,data,created,batch,subtype,source_task,bytes,sha256,downloaded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(token, shopId, clean(meta.month, 7), clean(meta.kind, 12), digest, target, clean(name), 'staged', json(record), new Date().toISOString(),
        batch, clean(meta.subtype, 120), clean(meta.sourceTask, 60), bytes.length, digest, clean(meta.downloadedAt, 40));
    if (batch) return { token, digest, duplicate: false };
    return this.inspect(token);
  }
  inspect(token) {
    const b = this.bill(token); const book = workbook(b.file);
    return { token, shopId: b.shop, name: b.name, batch: b.batch || '', month: b.month || '', kind: b.kind || '', subtype: b.subtype || '', bytes: b.bytes || null, sha256: b.sha256 || '', downloadedAt: b.downloaded_at || '', state: b.state, sheets: book.SheetNames.map(sheet => { const ws = book.Sheets[sheet]; const range = XLSX.utils.decode_range(ws['!ref'] || 'A1'); return { name: sheet, lastRow: range.e.r + 1, columns: Array.from({ length: Math.min(range.e.c + 1, 200) }, (_, i) => XLSX.utils.encode_col(i)), sample: XLSX.utils.sheet_to_json(ws, { header: 1, range: { s: range.s, e: { r: Math.min(range.e.r, 7), c: Math.min(range.e.c, 199) } }, blankrows: true, defval: '' }) }; }) };
  }
  bill(id) { const b = this.db.prepare('SELECT * FROM bills WHERE id=?').get(id); if (!b) throw new Error('账单不存在'); return b; }
  activeVersion(shop, month, kind) { return this.db.prepare('SELECT * FROM versions WHERE shop=? AND month=? AND kind=? AND active=1').get(shop, month, kind) || null; }
  versionParts(versionId) { return this.db.prepare('SELECT * FROM bills WHERE version=? ORDER BY rowid').all(versionId); }
  /**
   * 选出“入账口径”的那一份文件。
   * 同一账期同一账单类型可能有多个视图（月汇总 / 日汇总 / 收入明细 等），它们是同一批数据的
   * 不同粒度，直接相加会重复计账。默认只把「月汇总」计入账，其余作为核对凭证保留原件。
   */
  #ledgerParts(parts, preferred) {
    const views = new Set(['月汇总', '日汇总', '收入明细', '支出明细']);
    const labels = [...new Set(parts.map(part => clean(part.subtype, 120)))];
    const wanted = clean(preferred, 120);
    if (wanted) {
      const selected = parts.filter(part => clean(part.subtype, 120) === wanted);
      if (!selected.length) throw new Error(`批次中没有「${wanted}」入账口径，请重新选择`);
      return { parts: selected, wanted, matched: true };
    }
    const viewLabels = labels.filter(label => views.has(label));
    if (!viewLabels.length) return { parts, wanted: '', matched: true }; // 货款、补贴等独立业务分片仍须完整合计。
    if (viewLabels.length !== labels.length) throw new Error('批次混有汇总视图和业务子类型，请拆分核对或明确选择入账口径');
    const selectedView = viewLabels.includes('月汇总') ? '月汇总' : (viewLabels.length === 1 ? viewLabels[0] : '');
    if (!selectedView) throw new Error('批次包含多个重叠视图，请明确选择入账口径');
    return { parts: parts.filter(part => clean(part.subtype, 120) === selectedView), wanted: selectedView, matched: true };
  }
  /** 把“当前生效版本”写回 bills.active，保持只读查询简单一致。 */
  #activate(shop, month, kind, versionId) {
    this.db.prepare('UPDATE bills SET active=0 WHERE shop=? AND month=? AND kind=?').run(shop, month, kind);
    this.db.prepare('UPDATE versions SET active=0 WHERE shop=? AND month=? AND kind=?').run(shop, month, kind);
    if (!versionId) return;
    this.db.prepare('UPDATE versions SET active=1 WHERE id=?').run(versionId);
    const version = this.db.prepare('SELECT data FROM versions WHERE id=?').get(versionId);
    const data = parse(version.data);
    const parts = this.versionParts(versionId);
    // 旧版分片账本没有选择字段，按原有 saved 文件恢复，不擅自丢弃明细或重算历史账。
    const selected = data.ledgerTokens || (data.ledger ? [data.ledger] : parts.filter(part => part.state === 'saved').map(part => part.id));
    if (!selected.length || selected.some(id => !parts.some(part => part.id === id))) throw new Error('版本入账口径缺失或损坏，请从原文件重新预览，当前账本未改变');
    for (const id of selected) this.db.prepare('UPDATE bills SET active=1 WHERE id=? AND version=?').run(id, versionId);
  }
  preview(token, options) {
    const b = this.bill(token); if (b.state !== 'staged' && b.state !== 'preview') throw new Error('该预览已提交，请重新导入');
    if (b.batch) throw new Error('批次文件请通过整批核对入账，不能单独改变其中一份');
    const parsed = parseBill(b.file, options);
    const current = this.activeVersion(b.shop, options.month, options.kind);
    const previous = current ? this.versionParts(current.id)[0] : null;
    const data = { ...parsed, options, previousId: previous?.id || null, previousVersion: current?.id || null };
    this.db.prepare('UPDATE bills SET state=?,month=?,kind=?,data=? WHERE id=?').run('preview', options.month, options.kind, json(data), token);
    return { token, month: options.month, kind: options.kind, records: parsed.rows.length, totals: parsed.totals, issues: parsed.issues, previousId: data.previousId, duplicate: previous?.digest === b.digest };
  }
  commit(token, acknowledged) {
    const b = this.bill(token); if (b.state !== 'preview') throw new Error('请先预览账单'); const data = parse(b.data);
    if (b.batch) throw new Error('批次文件请通过整批核对入账，不能单独提交其中一份');
    // 只接受布尔 true：字符串 "false"、数字、对象等都不能当作确认。
    if (acknowledged !== true) throw new Error('请确认预览和核对问题后保存');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.activeVersion(b.shop, b.month, b.kind);
      if ((current?.id || null) !== (data.previousVersion || null)) throw new Error('账单版本已变化，请重新预览');
      const prevParts = current ? this.versionParts(current.id) : [];
      const prevPart = prevParts.length === 1 ? prevParts[0] : null;
      if (prevPart && prevPart.digest === b.digest && json(parse(prevPart.data).options) === json(data.options)) { this.db.prepare("UPDATE bills SET state='duplicate' WHERE id=?").run(token); this.db.exec('COMMIT'); return { duplicate: true, id: prevPart.id }; }
      const versionId = randomUUID();
      this.db.prepare("INSERT INTO versions(id,shop,month,kind,active,state,data,created) VALUES(?,?,?,?,0,'saved',?,?)")
        .run(versionId, b.shop, b.month, b.kind, json({ options: data.options, parts: [token], batch: clean(b.batch, 60) }), new Date().toISOString());
      this.db.prepare("UPDATE bills SET state='saved',version=? WHERE id=?").run(versionId, token);
      this.#activate(b.shop, b.month, b.kind, versionId);
      this.audit('bill-save', { id: token, versionId, previousId: current?.id || null }); this.db.exec('COMMIT'); return { id: token, versionId };
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  restore(id) {
    let version = this.db.prepare('SELECT * FROM versions WHERE id=?').get(id);
    if (!version) { const bill = this.db.prepare('SELECT * FROM bills WHERE id=?').get(id); if (!bill) throw new Error('账单不存在'); version = bill.version ? this.db.prepare('SELECT * FROM versions WHERE id=?').get(bill.version) : null; }
    if (!version) throw new Error('该账单没有可恢复的版本记录，请重新导入');
    if (version.state !== 'saved') throw new Error('只能恢复已保存的账单');
    if (!this.versionParts(version.id).length) throw new Error('该版本没有文件，无法恢复');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.#activate(version.shop, version.month, version.kind, version.id); this.audit('bill-restore', { id, versionId: version.id }); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { restored: true };
  }
  period(shop, month) {
    validMonth(month); if (shop.cycle !== 'quarterly') return { key: month, months: [month] };
    const start = `${month.slice(0, 4)}-${String(Math.floor((+month.slice(5) - 1) / 3) * 3 + 1).padStart(2, '0')}`;
    return { key: `${month.slice(0, 4)}-Q${Math.floor((+month.slice(5) - 1) / 3) + 1}`, months: [start, shiftFinanceMonth(start, 1), shiftFinanceMonth(start, 2)] };
  }
  report(shopId, month) {
    const shops = this.shops(); if (!shopId) return { shops, bills: [], rows: [], issues: [], jobs: [], history: [] };
    const shop = this.shop(shopId); validMonth(month); const period = this.period(shop, month);
    const all = this.db.prepare("SELECT * FROM bills WHERE shop=? AND state IN ('saved','retained') ORDER BY created DESC").all(shopId);
    const bills = all.filter(b => b.active && b.state === 'saved' && b.month === month).map(b => ({ id: b.id, name: b.name, kind: b.kind, month: b.month, created: b.created, ...parse(b.data) }));
    const rows = bills.flatMap(b => b.rows.map(r => ({ ...r, billId: b.id, kind: b.kind, filename: b.name })));
    const periodBills = all.filter(b => b.active && b.state === 'saved' && period.months.includes(b.month));
    const signature = hash(json({ shop, ids: periodBills.map(b => b.id).sort() }));
    const draft = this.db.prepare('SELECT data FROM drafts WHERE shop=? AND period=?').get(shopId, period.key);
    const savedDraft = draft ? parse(draft.data) : { values: {}, note: '', signature: null };
    const issues = bills.flatMap(b => b.issues.map(i => `${BILL_KINDS[b.kind]}：${i}`));
    for (const kind of Object.keys(BILL_KINDS)) if (!bills.some(b => b.kind === kind)) issues.push(`${BILL_KINDS[kind]}尚未导入，不能视为零金额`);
    const kindTotals = Object.fromEntries(Object.keys(BILL_KINDS).map(kind => [kind,
      Object.fromEntries(['gross', 'refund', 'net', 'expense'].map(key => [key, total(rows.filter(row => row.kind === kind), key)]))]));
    const income = kindTotals.income.net; const tax = kindTotals.tax.net;
    if (income != null && tax != null && income !== tax) issues.push('收支账单净额与涉税报送净额不一致，请说明结算时间、补贴等口径差异');
    const draftIssues = [];
    if (!shop.entity || !shop.taxId || !shop.entityType || !shop.taxpayer || !shop.cycle) draftIssues.push('店铺纳税主体、税号、类型或申报周期未设置完整');
    for (const m of period.months) for (const k of Object.keys(BILL_KINDS)) if (!periodBills.some(b => b.month === m && b.kind === k)) draftIssues.push(`${m} ${BILL_KINDS[k]}待补齐`);
    for (const b of periodBills) if (parse(b.data).issues.length) draftIssues.push(`${b.month} ${BILL_KINDS[b.kind]}存在待核对事项`);
    if (shops.some(s => s.id !== shopId && shop.taxId && s.taxId === shop.taxId)) draftIssues.push('相同税号还有其他店铺：本店资料不是该纳税主体的完整申报额，请汇总后核对');
    if (savedDraft.signature && savedDraft.signature !== signature) draftIssues.push('账单或店铺设置发生变化，请重新核对并保存草稿');
    const taxRows = periodBills.filter(b => b.kind === 'tax').flatMap(b => parse(b.data).rows);
    return { shops, shop, month, period, bills: bills.map(({ rows, ...b }) => ({ ...b, records: rows.length })), rows, kindTotals, issues, draftIssues, signature,
      platformTotals: Object.fromEntries(['gross','refund','net'].map(k => [k, period.months.every(m => periodBills.some(b=>b.kind==='tax'&&b.month===m)) ? total(taxRows, k) : null])), draft: savedDraft,
      pending: this.db.prepare("SELECT id,name,created,month,kind,subtype,batch,bytes FROM bills WHERE shop=? AND state IN ('staged','preview') ORDER BY created DESC LIMIT 100").all(shopId),
      jobs: this.db.prepare('SELECT id,month,state,message,created,note FROM jobs WHERE shop=? ORDER BY created DESC LIMIT 30').all(shopId).map(job => ({ ...job, note: job.note ? parse(job.note) : null, items: this.jobItems(job.id) })),
      batches: this.db.prepare('SELECT * FROM batches WHERE shop=? AND month=? ORDER BY created DESC').all(shopId, month).map(batch => ({
        id: batch.id, job: batch.job, kind: batch.kind, state: batch.state, message: batch.message, created: batch.created,
        plan: batch.plan ? parse(batch.plan) : {}, closed: batch.closed,
        parts: this.db.prepare('SELECT id,name,subtype,bytes,sha256,downloaded_at,state FROM bills WHERE batch=? ORDER BY rowid').all(batch.id)
      })),
      history: (() => {
        const groups = new Map();
        for (const bill of all.filter(b => b.month === month)) { const key = bill.version || `legacy:${bill.id}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(bill); }
        return [...groups.values()].map(parts => ({
          id: parts[0].id, versionId: parts[0].version || null, kind: parts[0].kind,
          name: parts.map(p => p.name).join('、'), created: parts[0].created, active: parts.some(p => p.active),
          parts: parts.map(p => ({ id: p.id, name: p.name, subtype: p.subtype, bytes: p.bytes, sha256: p.sha256, downloadedAt: p.downloaded_at, role: p.state === 'retained' ? 'voucher' : 'ledger' }))
        })).sort((a, b) => String(b.created).localeCompare(String(a.created)));
      })() };
  }
  jobItems(jobId) { return this.db.prepare('SELECT * FROM job_items WHERE job=? ORDER BY id').all(jobId); }
  jobDetail(jobId) { const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId); if (!job) throw new Error('取账记录不存在'); return { ...job, note: job.note ? parse(job.note) : null, items: this.jobItems(jobId) }; }
  /** 同店同账期已有任务时复用它，用于“重试失败项/继续人工处理”，不新建重复任务。 */
  openJob(shopId, month) {
    this.shop(shopId); validMonth(month);
    const existing = this.db.prepare("SELECT id FROM jobs WHERE shop=? AND month=? ORDER BY created DESC LIMIT 1").get(shopId, month);
    if (existing) { this.db.prepare("UPDATE jobs SET state='running',message='正在重试或继续处理' WHERE id=?").run(existing.id); return existing.id; }
    return this.newJob(shopId, month);
  }
  updateJob(id, patch = {}) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); if (!job) throw new Error('取账记录不存在');
    const note = { ...(job.note ? parse(job.note) : {}), ...(patch.note || {}) };
    this.db.prepare('UPDATE jobs SET state=?,message=?,note=? WHERE id=?').run(clean(patch.state || job.state), clean(patch.message ?? job.message, 600), json(note), id);
    return { updated: true };
  }
  openBatch(jobId, shopId, month, kind, plan = {}) {
    this.shop(shopId); validMonth(month); if (!BILL_KINDS[kind]) throw new Error('请选择账单类型');
    const job = this.db.prepare('SELECT shop,month,state FROM jobs WHERE id=?').get(jobId);
    if (!job || job.shop !== shopId || job.month !== month) throw new Error('取账任务与批次的店铺或账期不一致');
    if (job.state !== 'running') throw new Error('取账任务已结束，请先开始新任务或继续处理');
    const id = randomUUID();
    this.db.prepare("INSERT INTO batches(id,job,shop,month,kind,state,plan,message,created,closed) VALUES(?,?,?,?,?,'running',?,?,?,'')")
      .run(id, clean(jobId, 60), shopId, month, kind, json(plan), '正在取账', new Date().toISOString());
    this.#item(jobId, shopId, month, kind, '', id, 'running', '开始取账');
    return id;
  }
  #item(jobId, shopId, month, kind, subtype, batch, state, message) {
    const existing = this.db.prepare('SELECT id FROM job_items WHERE job=? AND kind=? AND subtype=?').get(jobId, kind, subtype);
    if (existing) { this.db.prepare('UPDATE job_items SET state=?,message=?,batch=?,updated=? WHERE id=?').run(state, clean(message, 400), batch || '', new Date().toISOString(), existing.id); return existing.id; }
    return this.db.prepare('INSERT INTO job_items(job,shop,month,kind,subtype,batch,state,message,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(jobId, shopId, month, kind, clean(subtype, 120), batch || '', state, clean(message, 400), new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  }
  /** 记录一个文件为批次分片；实际文件已由 stage 落到 originals。 */
  addPart(batchId, meta) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId); if (!batch) throw new Error('取账批次不存在');
    if (this.db.prepare("SELECT id FROM bills WHERE batch=? AND state IN ('saved','retained','duplicate') LIMIT 1").get(batchId)) throw new Error('该批次已提交，请建立新批次，避免修改历史凭证');
    if (meta.shopId && meta.shopId !== batch.shop) throw new Error('文件店铺与批次不一致，已拒绝入账以避免串店');
    if (meta.month && meta.month !== batch.month) throw new Error('文件账期与批次不一致，已拒绝入账');
    if (meta.kind && meta.kind !== batch.kind) throw new Error('文件账单类型与批次不一致，已拒绝入账');
    const namedKinds = Object.entries(BILL_KINDS).filter(([,label]) => String(meta.name || '').includes(label)).map(([kind]) => kind);
    if (namedKinds.length === 1 && namedKinds[0] !== batch.kind) throw new Error('原文件名标明的账单类型与批次不一致，已拒绝归类；下载文件保留，请人工核对');
    const result = this.stage(batch.shop, meta.file, meta.name, { ...meta, batch: batchId, month: batch.month, kind: batch.kind });
    const token = result.token;
    if (!result.duplicate) this.db.prepare('UPDATE bills SET source_task=?, downloaded_at=? WHERE id=?')
      .run(clean(meta.sourceTask, 60), clean(meta.downloadedAt, 40), token);
    const subtype = clean(meta.subtype, 120) || BILL_KINDS[batch.kind];
    this.#item(batch.job, batch.shop, batch.month, batch.kind, subtype, batchId, 'received', result.duplicate ? '该文件已存在，未重复入账' : '已收到，等待人工核对入账');
    return { token, duplicate: Boolean(result.duplicate), subtype };
  }
  closeBatch(batchId, summary = {}) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId); if (!batch) throw new Error('取账批次不存在');
    if (this.db.prepare("SELECT id FROM bills WHERE batch=? AND state IN ('preview','saved','retained','duplicate') LIMIT 1").get(batchId)) throw new Error('该批次已核对或提交，不能重新改变完整性状态');
    const parts = this.db.prepare('SELECT id,subtype FROM bills WHERE batch=?').all(batchId);
    const previousPlan = batch.plan ? parse(batch.plan) : {};
    const expected = Array.isArray(summary.expected) ? summary.expected : (previousPlan.expected || []);
    const received = [...new Set(parts.map(p => p.subtype).filter(Boolean))];
    const missing = expected.filter(item => !received.includes(item));
    const failed = summary.state && !['complete', 'received'].includes(summary.state);
    const state = parts.length === 0 ? (summary.state === 'empty' ? 'empty' : 'incomplete') : (missing.length || failed ? 'partial' : 'complete');
    const plan = { ...(batch.plan ? parse(batch.plan) : {}), expected, received, missing, shards: summary.shards || null };
    this.db.prepare('UPDATE batches SET state=?,plan=?,message=?,closed=? WHERE id=?')
      .run(state, json(plan), clean(summary.message || '', 400), new Date().toISOString(), batchId);
    this.#item(batch.job, batch.shop, batch.month, batch.kind, '', batchId,
      state === 'complete' ? 'received' : (state === 'empty' ? 'empty' : 'needs_review'),
      summary.message || (state === 'complete' ? '文件已收齐，等待人工核对' : (state === 'empty' ? '平台明确无账单' : '批次尚未完整')));
    for (const item of expected) if (parts.some(p => p.subtype === item)) this.#item(batch.job, batch.shop, batch.month, batch.kind, item, batchId, 'received', '已收到文件，等待人工核对');
    if (!parts.length && summary.state === 'empty') this.#item(batch.job, batch.shop, batch.month, batch.kind, '', batchId, 'empty', '平台明确提示无数据，已记录为空（不按零入账）');
    if (missing.length) this.#item(batch.job, batch.shop, batch.month, batch.kind, missing.join('、'), batchId, 'needs_review', `缺少：${missing.join('、')}`);
    return { state, missing, parts: parts.length };
  }
  /** 重新核对：哪些账单类型还没拿到完整文件，用于“重试失败项”。 */
  retryPlan(shopId, month) {
    this.shop(shopId); validMonth(month);
    const job = this.db.prepare('SELECT id FROM jobs WHERE shop=? AND month=? ORDER BY created DESC,rowid DESC LIMIT 1').get(shopId, month);
    if (!job) return { jobId: null, kinds: Object.keys(BILL_KINDS), reason: '该账期还没有取账记录' };
    const kinds = [];
    for (const kind of Object.keys(BILL_KINDS)) {
      const latest = this.db.prepare('SELECT state FROM batches WHERE job=? AND shop=? AND month=? AND kind=? ORDER BY rowid DESC LIMIT 1').get(job.id, shopId, month, kind);
      const version = this.activeVersion(shopId, month, kind);
      if (latest ? ['complete', 'empty'].includes(latest.state) : Boolean(version)) continue;
      kinds.push(kind);
    }
    return { jobId: job.id, kinds, reason: '' };
  }
  saveDraft(shopId, month, payload) {
    const r = this.report(shopId, month); if (payload.signature !== r.signature) throw new Error('账单或店铺设置已变化，请刷新后重新核对');
    const values = {}; for (const key of Object.keys(DRAFT_FIELDS)) { const input = payload.values?.[key] || {}; values[key] = { cents: cents(input.amount), basis: clean(input.basis, 1000) }; if (values[key].cents !== null && !values[key].basis) throw new Error(`${DRAFT_FIELDS[key]}需要填写来源/计算依据`); }
    const data = { values, note: clean(payload.note, 2000), signature: r.signature, saved: new Date().toISOString() };
    this.db.prepare('INSERT INTO drafts(shop,period,data) VALUES(?,?,?) ON CONFLICT(shop,period) DO UPDATE SET data=excluded.data').run(shopId, r.period.key, json(data)); this.audit('draft-save', { shopId, period: r.period.key }); return { saved: true };
  }
  newJob(shop, month) { this.shop(shop); validMonth(month); const id = randomUUID(); this.db.prepare('INSERT INTO jobs(id,shop,month,state,message,created,note) VALUES(?,?,?,?,?,?,?)').run(id, shop, month, 'running', '正在准备取账', new Date().toISOString(), ''); return id; }
  finishJob(id, state, message) { this.db.prepare('UPDATE jobs SET state=?,message=? WHERE id=?').run(clean(state), clean(message, 600), id); }
  /** 重启后识别中断任务：保留已完成分片，后续只补未完成部分。 */
  recoverJobs() {
    const interrupted = this.db.prepare("SELECT id FROM jobs WHERE state='running'").all();
    const now = new Date().toISOString();
    this.db.prepare("UPDATE jobs SET state='interrupted',message='上次取账中断，请重试失败项；已下载的分片保留在待核对文件' WHERE state='running'").run();
    this.db.prepare("UPDATE job_items SET state='interrupted',message='上次取账中断',updated=? WHERE state='running'").run(now);
    this.db.prepare("UPDATE batches SET state='interrupted',message='上次取账中断，已完成分片保留' WHERE state='running'").run();
    return interrupted.length;
  }
  batchDetail(batchId) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId); if (!batch) throw new Error('取账批次不存在');
    return { ...batch, plan: batch.plan ? parse(batch.plan) : {}, parts: this.db.prepare('SELECT id,name,subtype,bytes,sha256,downloaded_at,state,month,kind FROM bills WHERE batch=? ORDER BY rowid').all(batchId) };
  }
  /** 多文件/分片批次：一次预览整批，作为一个可追溯版本入账，后一个文件不会覆盖前一个。 */
  previewBatch(batchId, options) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId); if (!batch) throw new Error('取账批次不存在');
    if (batch.state !== 'complete') throw new Error('该批次尚未完整，请补齐文件并核对账单范围后再入账');
    const parts = this.db.prepare("SELECT * FROM bills WHERE batch=? AND state IN ('staged','preview') ORDER BY rowid").all(batchId);
    if (!parts.length) throw new Error('该批次没有待核对的原始文件');
    const labels = new Set(parts.map(part => clean(part.subtype)));
    if (labels.size > 1 && [...labels].some(label => /^(全部|全部类型|所有类型|全部业务)$/.test(label))) {
      throw new Error('批次混有“全部”和具体子类型，可能重复计账；请保留一种完整口径后重新导入，原始文件已保留');
    }
    validMonth(options.month); if (!BILL_KINDS[options.kind]) throw new Error('请选择账单类型');
    if (parts.some(part => part.month && part.month !== options.month)) throw new Error('批次内文件账期与选择不一致，请分别核对');
    if (parts.some(part => part.kind && part.kind !== options.kind)) throw new Error('批次内文件账单类型与选择不一致，请分别核对');
    const parsed = parts.map(part => {
      const data = parseBill(part.file, { ...(options.perPart?.[part.id] || options), kind: options.kind, month: options.month });
      return { token: part.id, name: part.name, subtype: part.subtype, ...data, records: data.rows.length };
    });
    // 只把入账口径那一份计入金额：月汇总 / 日汇总 / 收入明细 是同一批数据的不同粒度。
    const ledger = this.#ledgerParts(parts, options.ledgerView);
    const ledgerTokens = ledger.parts.map(part => part.id);
    const ledgerParsed = parsed.filter(part => ledgerTokens.includes(part.token));
    const current = this.activeVersion(batch.shop, options.month, options.kind);
    const versionId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO versions(id,shop,month,kind,active,state,data,created) VALUES(?,?,?,?,0,'preview',?,?)")
        .run(versionId, batch.shop, options.month, options.kind, json({ options, batch: batchId, parts: parts.map(part => part.id), ledgerTokens }), new Date().toISOString());
      parts.forEach((part, index) => {
        const perPart = options.perPart?.[part.id] || options;
        // 逻辑指纹按“解析后的账单内容 + 字段映射”计算，与文件里的时间戳等元信息无关。
        const logicalDigest = hash(Buffer.from(JSON.stringify({ kind: options.kind, month: options.month, rows: parsed[index].rows, options: perPart }), 'utf8'));
        this.db.prepare('UPDATE bills SET state=?,month=?,kind=?,data=?,version=? WHERE id=?')
          .run('preview', options.month, options.kind, json({ ...parsed[index], logicalDigest, options: perPart, previousId: null, previousVersion: current?.id || null }), versionId, part.id);
      });
      this.db.exec('COMMIT');
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
    // 金额只取入账口径那一份：多个视图相加会重复计账，其余仅作核对凭证。
    const totals = Object.fromEntries(['gross','refund','net','expense'].map(key => [key, ledgerParsed.every(part => part.totals[key] !== null) ? ledgerParsed.reduce((sum, part) => sum + part.totals[key], 0) : null]));
    const vouchers = parsed.filter(part => !ledgerTokens.includes(part.token));
    const issues = [...new Set(parsed.flatMap(part => part.issues))];
    return {
      batchId, versionId, month: options.month, kind: options.kind, previousId: null,
      records: ledgerParsed.reduce((sum, part) => sum + part.records, 0), totals, issues,
      ledgerToken: ledgerTokens[0], ledgerTokens, ledgerSubtype: ledger.wanted, ledgerMatched: ledger.matched, ledgerView: ledger.wanted,
      vouchers: vouchers.map(part => ({ token: part.token, name: part.name, subtype: part.subtype, records: part.records, totals: part.totals })),
      parts: parsed.map(part => ({ token: part.token, name: part.name, subtype: part.subtype, records: part.records, totals: part.totals, issues: part.issues, role: ledgerTokens.includes(part.token) ? 'ledger' : 'voucher' }))
    };
  }
  commitBatch(batchId, acknowledged) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId); if (!batch) throw new Error('取账批次不存在');
    if (batch.state !== 'complete') throw new Error('该批次尚未完整，请重新核对后保存');
    // 只接受布尔 true：字符串 "false"、数字、对象等都不能当作确认。
    if (acknowledged !== true) throw new Error('请确认预览和核对问题后保存');
    const parts = this.db.prepare("SELECT * FROM bills WHERE batch=? AND state='preview' ORDER BY rowid").all(batchId);
    if (!parts.length) throw new Error('请先预览整个批次');
    const version = parts[0].version ? this.db.prepare('SELECT * FROM versions WHERE id=?').get(parts[0].version) : null;
    if (!version) throw new Error('批次预览记录已失效，请重新预览');
    const versionData = parse(version.data);
    const ledgerTokens = versionData.ledgerTokens || (versionData.ledger ? [versionData.ledger] : null);
    if (!ledgerTokens?.length || parts.some(part => part.version !== version.id) || ledgerTokens.some(id => !parts.some(part => part.id === id))) throw new Error('批次预览口径已失效，请重新预览整个批次');
    const expectedVersion = parse(parts[0].data).previousVersion || null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.activeVersion(batch.shop, version.month, version.kind);
      if ((current?.id || null) !== expectedVersion) throw new Error('账单版本已变化，请重新预览');
      // 重复运行不重复入账：账单内容（解析结果 + 字段映射）与当前版本一致时只标记为重复。
      // Compare a multiset: subtype and file multiplicity must not disappear in a Set.
      const signature = list => list.map(part => {
        const data = parse(part.data), opts = data.options || {};
        return hash(json({ subtype: part.subtype || '', rows: data.rows,
          mapping: opts.mapping, sheet: opts.sheet, firstRow: opts.firstRow, lastRow: opts.lastRow }));
      }).sort().join(',');
      const previous = current ? this.versionParts(current.id) : [];
      const selectedSignature = list => signature(list.filter(part => ledgerTokens.includes(part.id)));
      if (previous.length && signature(previous) === signature(parts) && signature(previous.filter(part => part.state === 'saved')) === selectedSignature(parts)) {
        for (const part of parts) this.db.prepare("UPDATE bills SET state='duplicate' WHERE id=?").run(part.id);
        this.db.prepare("UPDATE versions SET state='duplicate' WHERE id=?").run(version.id);
        this.audit('batch-duplicate', { batchId, versionId: current.id });
        this.db.exec('COMMIT');
        return { duplicate: true, id: (previous.find(part => part.active) || previous[0]).id, versionId: current.id };
      }
      // 只有入账口径那一份进入账本；其余分片保留为核对凭证（原件不丢、可追溯、不计金额）。
      const ledgerToken = ledgerTokens[0];
      this.db.prepare("UPDATE versions SET state='saved' WHERE id=?").run(version.id);
      for (const part of parts) this.db.prepare('UPDATE bills SET state=? WHERE id=?').run(ledgerTokens.includes(part.id) ? 'saved' : 'retained', part.id);
      this.#activate(batch.shop, version.month, version.kind, version.id);
      // 文件内容变了但子类型集合没变：作为新版本保存，同时提示人工核对是否真的换了账单。
      const labelSet = list => [...new Set(list.map(part => part.subtype || ''))].sort().join('|');
      const sameSubtypes = previous.length > 0 && labelSet(previous) === labelSet(parts);
      this.audit('batch-save', { batchId, versionId: version.id, parts: parts.map(part => part.id), sameSubtypes });
      this.db.exec('COMMIT');
      return { id: ledgerToken, versionId: version.id, parts: parts.length, vouchers: parts.length - ledgerTokens.length, ledgerToken, ledgerTokens, sameSubtypes };
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  due(now = new Date()) {
    const month = dueFinanceMonth(now);
    return this.shops().filter(s => s.schedule && s.startMonth <= month && !this.db.prepare('SELECT id FROM jobs WHERE shop=? AND month=? LIMIT 1').get(s.id, month)).map(shop => ({ shop, month }));
  }
  async export(shopId, month) {
    const r = this.report(shopId, month); const book = new ExcelJS.Workbook(); book.creator = '财务账版';
    const add = (name, headers, rows) => { const s = book.addWorksheet(name); s.addRow(headers); s.addRows(rows); s.getRow(1).font = { bold: true }; s.views = [{ state: 'frozen', ySplit: 1 }]; s.columns.forEach(c => c.width = 26); s.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } }; return s; };
    const yuan = n => n === null || n === undefined ? null : n / 100;
    add('使用说明', ['项目', '内容'], [['用途','申报填表工作底稿，未经确认，不代表已申报或电子税务局正式模板'],['店铺',r.shop.name],['主体',r.shop.entity],['纳税人识别号',r.shop.taxId],['期间',r.period.key],['取账日','每月15日09:00（北京时间）获取上月账单；软件需运行'],['口径','平台报送收入、结算收入、费用分开；不直接以到账净额计算应税销售额'],['范围','店铺独立；同税号多店及其他收入须在主体申报时合并核对'],['缺失值','空白表示未确认，不能按零处理'],['状态',r.draftIssues.join('；') || '草稿待人工核对'],['备注',r.draft.note || '']]);
    add('填表草稿', ['申报项目','金额（元）','来源及计算依据'], Object.entries(DRAFT_FIELDS).map(([k, label]) => [label, yuan(r.draft.values[k]?.cents), r.draft.values[k]?.basis || '待填写']));
    add('平台报送参考', ['期间','收入总额（含税）','退款金额','收入净额','用途'], [[r.period.key,yuan(r.platformTotals.gross),yuan(r.platformTotals.refund),yuan(r.platformTotals.net),'仅用于核对，不自动转换申报销售额']]);
    add('当月账单明细', ['账单类型','原文件','工作表','源行','收入总额','退款','收入净额','支出','来源单元格','说明'], r.rows.map(x => [BILL_KINDS[x.kind],x.filename,x.sheet,x.row,yuan(x.gross),yuan(x.refund),yuan(x.net),yuan(x.expense),json(x.source),x.note]));
    add('核对问题', ['范围','问题'], [...r.issues.map(v => ['当月',v]),...r.draftIssues.map(v => ['申报期间',v])]);
    const sources = this.db.prepare("SELECT b.* FROM bills b JOIN versions v ON v.id=b.version WHERE b.shop=? AND v.active=1 AND b.state IN ('saved','retained')").all(shopId).filter(b => r.period.months.includes(b.month));
    add('期间来源清单', ['账期','账单类型','文件','SHA256','版本','导入时间','用途'], sources.map(b => [b.month,BILL_KINDS[b.kind],b.name,b.digest,b.version,b.created,b.state === 'retained' ? '核对凭证（不计金额）' : '入账文件']));
    add('原值与公式', ['账期','文件','工作表','单元格','原值或缓存值','原公式'], sources.flatMap(b => parse(b.data).rows.flatMap(row => Object.entries(row.raw).map(([addr,c]) => [b.month,b.name,row.sheet,addr,typeof c.value === 'object' ? json(c.value) : c.value,c.formula || '']))));
    return Buffer.from(await book.xlsx.writeBuffer());
  }
}
