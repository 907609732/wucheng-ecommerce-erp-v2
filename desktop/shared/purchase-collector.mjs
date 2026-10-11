import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import XLSX from 'xlsx';
import { initializePurchaseWorkbooks, readPurchaseWorkbook, savePurchaseWorkbook, exportPurchaseWorkbook, exportYearlyPurchase, listWorkbookHistory, readWorkbookRevision, diffWorkbookRevision } from './purchase-workbook.mjs';

const ALIASES = {
  orderId: ['订单号', '订单编号', '主订单号', 'orderId', 'order id'],
  orderedAt: ['下单时间', '订单创建时间', '创建时间', '成交时间', 'gmtCreate'],
  item: ['商品名称', '货品名称', '产品名称', '宝贝名称', '标题', 'itemName'],
  sku: ['规格', '规格属性', 'SKU属性', '型号', 'skuName'],
  unitPrice: ['单价', '商品单价', '价格', 'price'], quantity: ['数量', '购买数量', '件数', 'quantity', 'qty'],
  itemAmount: ['商品金额', '货品金额', '货款', '商品总额', 'itemAmount'], freight: ['运费', '快递费', '物流费用', 'postage', 'freight'],
  discount: ['优惠金额', '优惠', '折扣金额', '减免', 'discount'], paidAmount: ['实付款', '实付金额', '订单金额', '应付金额', '总金额', 'payAmount'],
  supplier: ['供应商', '卖家', '店铺名称', '卖家公司', '供应商公司', 'sellerName'], status: ['订单状态', '状态', '交易状态', 'status'],
  itemId: ['商品ID', '宝贝ID', '货品ID', 'itemId', 'productId'],
  trackingNumber: ['快递单号', '运单号', '物流单号', '快递号', 'trackingNumber', 'tracking_number', 'waybill']
};
const PLATFORM_LABEL = { taobao: '淘宝', alibaba_1688: '1688', goofish: '闲鱼', pdd: '拼多多' };
const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const number = value => { const match = clean(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return match ? Number(match[0]) : null; };
const amount = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const normalized = value => clean(value).replace(/\s+/g, '').toLowerCase();
function column(headers, names) { return headers.find(h => names.some(name => normalized(h) === normalized(name))) || headers.find(h => names.some(name => normalized(h).includes(normalized(name)))); }
function readRows(file) {
  const workbook = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: true, raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}
function monthOf(value) { const match = clean(value).match(/(20\d{2})[-/年.](\d{1,2})/); return match ? `${match[1]}-${match[2].padStart(2, '0')}` : ''; }
function parseRows(file, meta) {
  const source = readRows(file), headers = source.length ? Object.keys(source[0]) : [];
  const map = Object.fromEntries(Object.entries(ALIASES).map(([key, aliases]) => [key, column(headers, aliases)]));
  const missing = ['orderId', 'item', 'paidAmount'].filter(key => !map[key]);
  if (missing.length) throw new Error(`导出文件缺少关键列：${missing.join('、')}；实际表头：${headers.join('、')}`);
  const occurrences = new Map();
  const rows = source.map((raw) => {
    const get = key => map[key] ? raw[map[key]] : '';
    const orderedAt = clean(get('orderedAt'));
    const quantity = number(get('quantity'));
    let itemAmount = number(get('itemAmount')), unitPrice = number(get('unitPrice'));
    if (itemAmount == null && unitPrice != null && quantity != null) itemAmount = unitPrice * quantity;
    if (unitPrice == null && itemAmount != null && quantity) unitPrice = itemAmount / quantity;
    const freight = number(get('freight')) || 0, discount = Math.abs(number(get('discount')) || 0);
    let paidAmount = number(get('paidAmount'));
    if (paidAmount == null && itemAmount != null) paidAmount = itemAmount + freight - discount;
    const item = [clean(get('item')), clean(get('sku'))].filter(Boolean).join(' ');
    const orderId = clean(get('orderId'));
    const identity = [meta.platform, meta.account, orderId, clean(get('itemId')), item].join('\u0000');
    const occurrence = occurrences.get(identity) || 0; occurrences.set(identity, occurrence + 1);
    return { lineKey: createHash('sha256').update(`${identity}\u0000${occurrence}`).digest('hex'), platform: meta.platform, account: meta.account, accountLabel: meta.accountLabel || meta.account, orderId, orderedAt, month: monthOf(orderedAt), item, itemId: clean(get('itemId')), sku: clean(get('sku')), unitPrice: amount(unitPrice), quantity, itemAmount: amount(itemAmount), freight: amount(freight), discount: amount(discount), paidAmount: amount(paidAmount), supplier: clean(get('supplier')), status: clean(get('status')) || '未知', trackingNumber: clean(get('trackingNumber')), raw };
  }).filter(row => row.orderId && row.item && row.paidAmount != null);
  return { rows, headers, ignored: source.length - rows.length };
}

export class PurchaseCollector {
  constructor(databasePath, directory) {
    fs.mkdirSync(directory, { recursive: true }); this.directory = directory;
    this.db = new DatabaseSync(databasePath, { timeout: 10000 });
    this.db.exec(`CREATE TABLE IF NOT EXISTS purchase_imports (id TEXT PRIMARY KEY, state TEXT NOT NULL, platform TEXT NOT NULL, account TEXT NOT NULL, account_label TEXT NOT NULL, month TEXT NOT NULL, filename TEXT NOT NULL, file_hash TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT);
      CREATE TABLE IF NOT EXISTS purchase_lines (line_key TEXT PRIMARY KEY, import_id TEXT NOT NULL, platform TEXT NOT NULL, account TEXT NOT NULL, account_label TEXT NOT NULL, month TEXT NOT NULL, order_id TEXT NOT NULL, ordered_at TEXT, item TEXT NOT NULL, item_id TEXT, sku TEXT, unit_price REAL, quantity REAL, item_amount REAL, freight REAL NOT NULL, discount REAL NOT NULL, paid_amount REAL NOT NULL, supplier TEXT, status TEXT, tracking_number TEXT, raw_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS purchase_lines_month ON purchase_lines(month); CREATE INDEX IF NOT EXISTS purchase_lines_source ON purchase_lines(platform, account, order_id);
      CREATE TABLE IF NOT EXISTS purchase_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, op_type TEXT NOT NULL, month TEXT, import_id TEXT, detail TEXT NOT NULL, row_count INTEGER DEFAULT 0, created_at TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(purchase_lines)').all().map(c => c.name);
    if (!columns.includes('tracking_number')) this.db.exec('ALTER TABLE purchase_lines ADD COLUMN tracking_number TEXT');
  }
  close() { this.db.close(); }
  readWorkbook() { initializePurchaseWorkbooks(this.db); return readPurchaseWorkbook(this.db); }
  saveWorkbook(payload) { initializePurchaseWorkbooks(this.db); return savePurchaseWorkbook(this.db, payload); }
  exportWorkbook(snapshot, file) { return exportPurchaseWorkbook(snapshot, file); }
  exportYearly(year, file) { return exportYearlyPurchase(this.db, year, file); }
  listHistory() { initializePurchaseWorkbooks(this.db); return listWorkbookHistory(this.db); }
  readRevision(revision) { initializePurchaseWorkbooks(this.db); return readWorkbookRevision(this.db, revision); }
  diffRevision(revision) { initializePurchaseWorkbooks(this.db); return diffWorkbookRevision(this.db, revision); }
  manualPreview(rows, meta) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('请填写至少一条采购明细');
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '订单明细');
    const file = path.join(this.directory, `${randomUUID()}.xlsx`);
    fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    try { return this.preview(file, meta); } catch (error) { fs.rmSync(file, { force: true }); throw error; }
  }
  preview(file, meta = {}) {
    const platform = String(meta.platform || '').trim(); if (!platform || platform.length > 40) throw new Error('请选择或填写采购平台');
    const account = clean(meta.account); if (!account || account.length > 60) throw new Error('请填写账号别名（不填真实账号）');
    const parsed = parseRows(file, { platform, account, accountLabel: clean(meta.accountLabel) || account });
    const month = String(meta.month || '').trim(); if (!/^20\d{2}-\d{2}$/.test(month)) throw new Error('请选择统计月份');
    const inDateRange = row => {
      const match = row.orderedAt.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
      const date = match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
      return date && date >= meta.startDate && date <= meta.endDate;
    };
    if (meta.automated && (parsed.ignored || parsed.rows.some(row => !row.month))) throw new Error('平台导出存在缺少订单号、日期、商品或金额的记录，未入库；请检查原始文件');
    const rows = parsed.rows.filter(row => meta.startDate && meta.endDate ? inDateRange(row) : !row.month || row.month === month);
    if (!rows.length) throw new Error(`没有找到 ${month} 的有效采购明细，请检查导出时间范围和表头`);
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const duplicate = this.db.prepare("SELECT id FROM purchase_imports WHERE file_hash=? AND platform=? AND account=? AND month=? AND state='committed'").get(hash, platform, account, month);
    const existing = this.db.prepare('SELECT line_key FROM purchase_lines').all().map(row => row.line_key); const known = new Set(existing);
    if (duplicate && rows.every(row => known.has(row.lineKey))) return { duplicate: true, message: '所选范围内的导出明细已经入库，无需重复导入。' };
    const id = randomUUID(), destination = path.join(this.directory, `${id}${path.extname(file).toLowerCase() || '.xlsx'}`);
    fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
    const total = amount(rows.reduce((sum, row) => sum + row.paidAmount, 0));
    this.db.prepare('INSERT INTO purchase_imports (id,state,platform,account,account_label,month,filename,file_hash,raw_json,created_at,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(id, 'pending', platform, account, clean(meta.accountLabel) || account, month, path.basename(meta.originalName || file), hash, JSON.stringify(rows), new Date().toISOString());
    return { token: id, platform: PLATFORM_LABEL[platform] || platform, account: clean(meta.accountLabel) || account, month: meta.startDate ? `${meta.startDate} 至 ${meta.endDate}` : month, rows: rows.length, total, duplicates: rows.filter(row => known.has(row.lineKey)).length, ignored: parsed.ignored, excluded: parsed.rows.length - rows.length, sample: rows.slice(0, 8).map(row => ({ orderId: row.orderId, orderedAt: row.orderedAt, item: row.item, paidAmount: row.paidAmount, supplier: row.supplier, status: row.status })) };
  }
  cancel(token) { const row = this.db.prepare("SELECT id FROM purchase_imports WHERE id=? AND state='pending'").get(String(token)); if (!row) return; this.db.prepare('DELETE FROM purchase_imports WHERE id=?').run(row.id); for (const file of fs.readdirSync(this.directory)) if (file.startsWith(row.id)) fs.rmSync(path.join(this.directory, file), { force: true }); }
  commit(token) {
    const batch = this.db.prepare("SELECT * FROM purchase_imports WHERE id=? AND state='pending'").get(String(token)); if (!batch) throw new Error('导入预览已失效，请重新选择文件');
    const rows = JSON.parse(batch.raw_json); let inserted = 0, skipped = 0;
    const statement = this.db.prepare('INSERT OR IGNORE INTO purchase_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE'); try { for (const row of rows) { const result = statement.run(row.lineKey, batch.id, row.platform, row.account, row.accountLabel, row.month || batch.month, row.orderId, row.orderedAt, row.item, row.itemId, row.sku, row.unitPrice, row.quantity, row.itemAmount, row.freight, row.discount, row.paidAmount, row.supplier, row.status, row.trackingNumber || '', JSON.stringify(row.raw)); result.changes ? inserted++ : skipped++; } this.db.prepare("UPDATE purchase_imports SET state='committed', committed_at=? WHERE id=?").run(new Date().toISOString(), batch.id); this.db.prepare('INSERT INTO purchase_operations (op_type, month, import_id, detail, row_count, created_at) VALUES (?,?,?,?,?,?)').run('import', batch.month, batch.id, `导入采购明细：${PLATFORM_LABEL[batch.platform] || batch.platform} ${batch.month}，新增 ${inserted} 条${skipped ? `，跳过重复 ${skipped} 条` : ''}`, inserted, new Date().toISOString()); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { inserted, skipped, month: batch.month };
  }
  rollback(importId) {
    const batch = this.db.prepare("SELECT * FROM purchase_imports WHERE id=? AND state='committed'").get(String(importId));
    if (!batch) throw new Error('未找到该入库批次，或它已被撤回');
    const lines = this.db.prepare('SELECT line_key FROM purchase_lines WHERE import_id=?').all(batch.id);
    if (!lines.length) throw new Error('该批次没有可撤回的明细');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM purchase_lines WHERE import_id=?').run(batch.id);
      this.db.prepare("UPDATE purchase_imports SET state='rolled_back', committed_at=NULL WHERE id=?").run(batch.id);
      this.db.prepare('INSERT INTO purchase_operations (op_type, month, import_id, detail, row_count, created_at) VALUES (?,?,?,?,?,?)').run('rollback', batch.month, batch.id, `撤回入库：${PLATFORM_LABEL[batch.platform] || batch.platform} ${batch.month}，撤回 ${lines.length} 条`, lines.length, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { removed: lines.length, month: batch.month };
  }
  rollbackLast() {
    const latest = this.db.prepare("SELECT id FROM purchase_imports WHERE state='committed' ORDER BY committed_at DESC, id DESC LIMIT 1").get();
    if (!latest) throw new Error('没有可撤回的入库记录');
    return this.rollback(latest.id);
  }
  operations(limit = 100) {
    return this.db.prepare('SELECT id, op_type AS opType, month, import_id AS importId, detail, row_count AS rowCount, created_at AS createdAt FROM purchase_operations ORDER BY id DESC LIMIT ?').all(Number(limit));
  }
  read(filters = {}) {
    const month = String(filters.month || ''); const values = [], where = [];
    if (filters.startDate && filters.endDate) { where.push("substr(replace(ordered_at,'/','-'),1,10)>=? AND substr(replace(ordered_at,'/','-'),1,10)<=?"); values.push(String(filters.startDate), String(filters.endDate)); }
    else if (month) { where.push('month=?'); values.push(month); }
    const rows = this.db.prepare(`SELECT platform,account,account_label AS accountLabel,order_id AS orderId,ordered_at AS orderedAt,item,item_id AS itemId,sku,unit_price AS unitPrice,quantity,item_amount AS itemAmount,freight,discount,paid_amount AS paidAmount,supplier,status,tracking_number AS trackingNumber FROM purchase_lines ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ordered_at DESC, order_id DESC LIMIT 5000`).all(...values);
    const months = this.db.prepare('SELECT DISTINCT month FROM purchase_lines ORDER BY month DESC').all().map(row => row.month);
    const total = amount(rows.reduce((sum, row) => sum + Number(row.paidAmount || 0), 0));
    return { rows, months, total, count: rows.length, platforms: [...new Set(rows.map(row => PLATFORM_LABEL[row.platform] || row.platform))] };
  }
  missingMonths(year, platform = '') {
    const yearStr = String(year);
    if (!/^20\d{2}$/.test(yearStr)) throw new Error('请选择有效年份');
    const sql = platform
      ? 'SELECT DISTINCT month FROM purchase_lines WHERE month LIKE ? AND platform = ?'
      : 'SELECT DISTINCT month FROM purchase_lines WHERE month LIKE ?';
    const args = platform ? [`${yearStr}-%`, platform] : [`${yearStr}-%`];
    const existing = new Set(this.db.prepare(sql).all(...args).map(row => row.month));
    const now = new Date(), currentYear = now.getFullYear(), currentMonth = now.getMonth() + 1;
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const month = `${yearStr}-${String(m).padStart(2, '0')}`;
      if (Number(yearStr) > currentYear || (Number(yearStr) === currentYear && m > currentMonth)) break;
      if (!existing.has(month)) months.push(month);
    }
    return months;
  }
}
