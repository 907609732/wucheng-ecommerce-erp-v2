import ExcelJS from 'exceljs';

export const PURCHASE_SHEET = 'purchase-details';
export const PURCHASE_ORDERS_SHEET = 'purchase-orders';
const headers = ['月份', '平台', '账号ID', '下单时间', '订单号', '商品', '规格/SKU', '数量', '单价', '商品金额', '运费', '优惠', '实付款', '供应商', '订单状态', '快递单号', '备注'];
const orderHeaders = ['月份', '平台', '下单时间', '订单号', '商品数', '商品金额', '运费', '实付款', '供应商', '订单状态'];
const cell = value => ({ v: value ?? '', t: typeof value === 'number' ? 2 : 1 });
const platformLabel = platform => platform === 'taobao' ? '淘宝' : platform === 'goofish' ? '闲鱼' : platform === 'pdd' ? '拼多多' : '1688';
const recordValues = row => [row.month, platformLabel(row.platform), row.account_label, row.ordered_at, row.order_id, row.item, row.sku, row.quantity, row.unit_price, row.item_amount, row.freight, row.discount, row.paid_amount, row.supplier, row.status, row.tracking_number, ''];

// 按订单聚合商品行：一行一个订单，运费/实付款取订单级值，商品金额累加。
function buildOrderRows(lines) {
  const map = new Map();
  for (const row of lines) {
    const key = String(row.order_id);
    if (!map.has(key)) map.set(key, { month: row.month, platform: row.platform, ordered_at: row.ordered_at, order_id: row.order_id, count: 0, item_amount: 0, freight: row.freight, paid_amount: row.paid_amount, supplier: row.supplier, status: row.status });
    const agg = map.get(key);
    agg.count += 1;
    agg.item_amount = Math.round((agg.item_amount + Number(row.item_amount || 0)) * 100) / 100;
  }
  return [...map.values()].sort((a, b) => String(a.ordered_at).localeCompare(String(b.ordered_at)) || String(a.order_id).localeCompare(String(b.order_id)));
}
const orderRecordValues = row => [row.month, platformLabel(row.platform), row.ordered_at, row.order_id, row.count, row.item_amount, row.freight, row.paid_amount, row.supplier, row.status];

export function initializePurchaseWorkbooks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS purchase_workbook (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, source_keys_json TEXT NOT NULL, saved_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS purchase_workbook_history (revision INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL, source_keys_json TEXT NOT NULL, saved_at TEXT NOT NULL);`);
}

function initialWorkbook() {
  return { id: 'purchase-workbook', name: '采购数据', appVersion: '1.0.4', locale: 'zhCN', sheetOrder: [PURCHASE_SHEET, PURCHASE_ORDERS_SHEET, 'purchase-analysis'],
    styles: { header: { bg: { rgb: '#E4F0E8' }, bl: 1, cl: { rgb: '#245D3F' }, fs: 11 }, money: { n: { pattern: '#,##0.00' } } },
    sheets: {
      [PURCHASE_SHEET]: { id: PURCHASE_SHEET, name: '采购明细', rowCount: 200, columnCount: 26, defaultRowHeight: 28, defaultColumnWidth: 135,
        freeze: { startRow: 1, startColumn: -1, ySplit: 1, xSplit: 0 },
        columnData: { 0: { w: 95 }, 1: { w: 80 }, 3: { w: 175 }, 4: { w: 205 }, 5: { w: 300 }, 13: { w: 240 }, 15: { w: 240 } },
        cellData: { 0: Object.fromEntries(headers.map((name, index) => [index, { ...cell(name), s: 'header' }])) } },
      [PURCHASE_ORDERS_SHEET]: { id: PURCHASE_ORDERS_SHEET, name: '订单汇总', rowCount: 200, columnCount: 26, defaultRowHeight: 28, defaultColumnWidth: 135,
        freeze: { startRow: 1, startColumn: -1, ySplit: 1, xSplit: 0 },
        columnData: { 0: { w: 95 }, 1: { w: 80 }, 2: { w: 175 }, 3: { w: 205 }, 5: { w: 110 }, 6: { w: 100 }, 7: { w: 110 }, 8: { w: 240 }, 9: { w: 100 } },
        cellData: { 0: Object.fromEntries(orderHeaders.map((name, index) => [index, { ...cell(name), s: 'header' }])) } },
      'purchase-analysis': { id: 'purchase-analysis', name: '分析表', rowCount: 100, columnCount: 26, defaultRowHeight: 28, defaultColumnWidth: 150,
        cellData: { 0: { 0: { ...cell('采购数据分析'), s: 'header' } }, 1: { 0: cell('实付款合计'), 1: { f: "=SUM('采购明细'!M:M)", s: 'money' } }, 2: { 0: cell('说明'), 1: cell('此页可自由添加公式和统计。编辑表格不会改写原始采集记录。') } }, columnData: { 1: { w: 480 } } }
    } };
}

export function readPurchaseWorkbook(db) {
  const stored = db.prepare('SELECT * FROM purchase_workbook WHERE id=1').get();
  let snapshot = stored ? JSON.parse(stored.snapshot_json) : initialWorkbook();
  let sourceKeys = stored ? JSON.parse(stored.source_keys_json) : [];
  // 迁移：旧快照表头缺「快递单号」列时，重置为初始工作簿，所有来源记录重新追加（数据在 purchase_lines，不会丢）。
  const headerCells = snapshot.sheets?.[PURCHASE_SHEET]?.cellData?.[0];
  if (headerCells && Object.keys(headerCells).length && !Object.values(headerCells).some(c => c?.v === '快递单号')) {
    snapshot = initialWorkbook();
    sourceKeys = [];
  }
  const known = new Set(sourceKeys);
  const sources = db.prepare('SELECT * FROM purchase_lines ORDER BY ordered_at,order_id,line_key LIMIT 20001').all();
  if (sources.length > 20000) throw new Error('采购记录超过当前单工作簿20000条上限，未截断数据；请先联系管理员分册');
  const additions = sources.filter(row => !known.has(row.line_key));
  if (additions.length) {
    const sheet = snapshot.sheets[PURCHASE_SHEET];
    if (!sheet) throw new Error('采购明细工作表已被删除，无法安全补入新采集记录，请恢复该工作表后重试');
    const columns = headers.map(name => Object.entries(sheet.cellData?.[0] || {}).filter(([, value]) => value?.v === name));
    if (columns.some(matches => matches.length !== 1)) throw new Error('采购明细第1行的来源字段已改名或删除，无法安全补入新记录；请恢复原字段名称后重新载入');
    snapshot.styles ||= {};
    snapshot.styles['purchase-money'] = { n: { pattern: '#,##0.00' } };
    let index = Math.max(0, ...Object.keys(sheet.cellData || {}).map(Number)) + 1;
    if (index + additions.length > 50000) throw new Error('表格超过50000行，无法补入新记录');
    for (const row of additions) {
      sheet.cellData[index++] = Object.fromEntries(recordValues(row).map((value, column) => [columns[column][0][0], { ...cell(value), ...(column >= 8 && column <= 12 ? { s: 'purchase-money' } : {}) }]));
      sourceKeys.push(row.line_key);
    }
    sheet.rowCount = Math.min(50000, Math.max(sheet.rowCount, index + 100));
    // 重建订单汇总表：按订单聚合，一行一个订单（商品数、商品金额累加，运费/实付款取订单级值）。
    let orderSheet = snapshot.sheets[PURCHASE_ORDERS_SHEET];
    if (!orderSheet) {
      orderSheet = { id: PURCHASE_ORDERS_SHEET, name: '订单汇总', rowCount: 200, columnCount: 26, defaultRowHeight: 28, defaultColumnWidth: 135,
        freeze: { startRow: 1, startColumn: -1, ySplit: 1, xSplit: 0 },
        columnData: { 0: { w: 95 }, 1: { w: 80 }, 2: { w: 175 }, 3: { w: 205 }, 5: { w: 110 }, 6: { w: 100 }, 7: { w: 110 }, 8: { w: 240 }, 9: { w: 100 } },
        cellData: { 0: Object.fromEntries(orderHeaders.map((name, index) => [index, { ...cell(name), s: 'header' }])) } };
      snapshot.sheets[PURCHASE_ORDERS_SHEET] = orderSheet;
      if (!snapshot.sheetOrder.includes(PURCHASE_ORDERS_SHEET)) snapshot.sheetOrder.splice(snapshot.sheetOrder.indexOf(PURCHASE_SHEET) + 1, 0, PURCHASE_ORDERS_SHEET);
    }
    const orderColumns = orderHeaders.map(name => Object.entries(orderSheet.cellData?.[0] || {}).filter(([, value]) => value?.v === name));
    if (orderColumns.some(matches => matches.length !== 1)) throw new Error('订单汇总第1行的字段已改名或删除，请恢复原字段名称后重新载入');
    const orderRows = buildOrderRows(sources);
    const orderCellData = { 0: Object.fromEntries(orderHeaders.map((name, index) => [index, { ...cell(name), s: 'header' }])) };
    orderRows.forEach((row, offset) => {
      orderCellData[1 + offset] = Object.fromEntries(orderRecordValues(row).map((value, column) => [orderColumns[column][0][0], { ...cell(value), ...(column >= 5 && column <= 7 ? { s: 'purchase-money' } : {}) }]));
    });
    orderSheet.cellData = orderCellData;
    orderSheet.rowCount = Math.min(50000, Math.max(orderSheet.rowCount, orderRows.length + 100));
  }
  return { snapshot, sourceKeys, revision: stored?.revision || 0, savedAt: stored?.saved_at || '', added: additions.length, sourceCount: sources.length };
}

export function validatePurchaseWorkbook(snapshot) {
  if (!snapshot || snapshot.id !== 'purchase-workbook' || !Array.isArray(snapshot.sheetOrder) || snapshot.sheetOrder.length < 1 || snapshot.sheetOrder.length > 12) throw new Error('采购工作簿结构无效，支持1至12个工作表');
  if (!snapshot.sheets?.[PURCHASE_SHEET] || !snapshot.sheetOrder.includes(PURCHASE_SHEET)) throw new Error('请保留采购明细工作表，以便后续补入采集记录');
  if (JSON.stringify(snapshot).length > 24 * 1024 * 1024) throw new Error('工作簿超过24MB保存限制');
  const names = new Set();
  if (new Set(snapshot.sheetOrder).size !== snapshot.sheetOrder.length) throw new Error('工作表标识重复');
  for (const id of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[id];
    if (!sheet || !Number.isInteger(sheet.rowCount) || sheet.rowCount < 1 || sheet.rowCount > 50000 || !Number.isInteger(sheet.columnCount) || sheet.columnCount < 1 || sheet.columnCount > 200 || !sheet.cellData || typeof sheet.cellData !== 'object') throw new Error('工作表范围无效，最多50000行、200列');
    if (!sheet.name || sheet.name.length > 31 || /[\\/?*\[\]:]/.test(sheet.name)) throw new Error('工作表名称无效');
    if (names.has(sheet.name.toLowerCase())) throw new Error('工作表名称不能重复');
    names.add(sheet.name.toLowerCase());
    for (const [row, columns] of Object.entries(sheet.cellData)) {
      if (!/^\d+$/.test(row) || Number(row) >= sheet.rowCount || !columns || typeof columns !== 'object') throw new Error('单元格行号超出工作表范围');
      for (const [column, data] of Object.entries(columns)) if (!/^\d+$/.test(column) || Number(column) >= sheet.columnCount || data !== null && (typeof data !== 'object' || data.v != null && !['string','number','boolean'].includes(typeof data.v) || data.f != null && typeof data.f !== 'string')) throw new Error('单元格内容或列号无效');
    }
  }
  return snapshot;
}

export function savePurchaseWorkbook(db, payload) {
  validatePurchaseWorkbook(payload?.snapshot);
  if (!Number.isInteger(payload.revision) || payload.revision < 0 || !Array.isArray(payload.sourceKeys) || payload.sourceKeys.length > 20000) throw new Error('工作簿版本或来源标识无效');
  const known = new Set(db.prepare('SELECT line_key FROM purchase_lines').all().map(row => row.line_key));
  const sourceKeySet = new Set(payload.sourceKeys);
  if (sourceKeySet.size !== payload.sourceKeys.length || payload.sourceKeys.some(key => !known.has(key))) throw new Error('工作簿来源标识与原始记录不符');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM purchase_workbook WHERE id=1').get();
    if ((previous?.revision || 0) !== payload.revision) throw new Error('表格已被其他窗口保存，请先保留当前编辑内容并重新载入，不会覆盖新版本');
    if (previous && JSON.parse(previous.source_keys_json).some(key => !sourceKeySet.has(key))) throw new Error('工作簿来源标识不能丢失，请重新载入');
    if (previous) db.prepare('INSERT INTO purchase_workbook_history VALUES (?,?,?,?)').run(previous.revision, previous.snapshot_json, previous.source_keys_json, previous.saved_at);
    const revision = payload.revision + 1, savedAt = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO purchase_workbook VALUES (1,?,?,?,?)').run(revision, JSON.stringify(payload.snapshot), JSON.stringify(payload.sourceKeys), savedAt);
    db.exec('COMMIT'); return { revision, savedAt };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function exportPurchaseWorkbook(snapshot, file) {
  validatePurchaseWorkbook(snapshot);
  const workbook = new ExcelJS.Workbook();
  for (const id of snapshot.sheetOrder) {
    const data = snapshot.sheets[id], sheet = workbook.addWorksheet(data.name);
    for (const [rowIndex, columns] of Object.entries(data.cellData)) for (const [columnIndex, value] of Object.entries(columns)) {
      if (!value) continue;
      const target = sheet.getCell(Number(rowIndex) + 1, Number(columnIndex) + 1), style = typeof value.s === 'string' ? snapshot.styles?.[value.s] || {} : value.s || {};
      target.value = value.f ? { formula: value.f.replace(/^=/, ''), result: value.v ?? undefined } : value.v ?? value.p?.body?.dataStream?.trimEnd() ?? '';
      target.font = { name: style.ff || 'Microsoft YaHei', size: style.fs || 11, bold: Boolean(style.bl), italic: Boolean(style.it), ...(style.cl?.rgb ? { color: { argb: style.cl.rgb.replace('#', 'FF') } } : {}) };
      if (style.bg?.rgb) target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.bg.rgb.replace('#', 'FF') } };
      if (style.n?.pattern) target.numFmt = style.n.pattern;
    }
    for (const [column, config] of Object.entries(data.columnData || {})) if (config?.w) sheet.getColumn(Number(column) + 1).width = config.w / 7;
    for (const range of data.mergeData || []) sheet.mergeCells(range.startRow + 1, range.startColumn + 1, range.endRow + 1, range.endColumn + 1);
    if (data.freeze?.startRow > 0) sheet.views = [{ state: 'frozen', ySplit: data.freeze.startRow }];
  }
  await workbook.xlsx.writeFile(file);
  return { file };
}

// 按年导出采购明细为独立 .xlsx：年内按月份排序，月份交替底色 + 月份起始分隔线。
export async function exportYearlyPurchase(db, year, filePath) {
  const yearStr = String(year);
  if (!/^20\d{2}$/.test(yearStr)) throw new Error('请选择有效年份');
  // 默认剔除交易关闭的订单
  const rows = db.prepare("SELECT * FROM purchase_lines WHERE month LIKE ? AND (status IS NULL OR status <> '交易关闭') ORDER BY month, ordered_at, order_id, line_key").all(`${yearStr}-%`);
  if (!rows.length) throw new Error(`${yearStr} 年没有可导出的采购数据（已剔除交易关闭订单）`);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '五成电子商务集团 ERP';
  const sheet = workbook.addWorksheet(`${yearStr}年采购明细`);
  const headers = ['月份', '平台', '账号ID', '下单时间', '订单号', '商品', '规格/SKU', '数量', '单价', '商品金额', '运费', '优惠', '实付款', '供应商', '订单状态', '快递单号', '备注'];
  const headerRow = sheet.addRow(headers);
  headerRow.eachCell(cell => { cell.font = { bold: true, color: { argb: 'FF245D3F' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4F0E8' } }; cell.alignment = { vertical: 'middle' }; });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  const monthFills = ['FFFFFFFF', 'FFF2F7F2']; // 月份交替底色
  let prevMonth = '', fillIndex = 0;
  for (const row of rows) {
    const startsNewMonth = row.month !== prevMonth;
    if (startsNewMonth) { prevMonth = row.month; fillIndex = 1 - fillIndex; }
    const excelRow = sheet.addRow([row.month, platformLabel(row.platform), row.account_label, row.ordered_at, row.order_id, row.item, row.sku, row.quantity, row.unit_price, row.item_amount, row.freight, row.discount, row.paid_amount, row.supplier, row.status, row.tracking_number, '']);
    const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: monthFills[fillIndex] } };
    excelRow.eachCell(cell => { cell.fill = fill; });
    if (startsNewMonth) excelRow.eachCell(cell => { cell.border = { top: { style: 'medium', color: { argb: 'FF9DBFA3' } } }; });
    for (let column = 9; column <= 13; column++) excelRow.getCell(column).numFmt = '#,##0.00';
  }
  const widths = [9, 8, 14, 18, 20, 28, 16, 8, 10, 11, 9, 9, 11, 22, 10, 16, 16];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  await workbook.xlsx.writeFile(filePath);
  return { file: filePath, rows: rows.length, months: [...new Set(rows.map(row => row.month))] };
}

// 单元格展示值：公式 > 值 > 富文本
const cellDisplayValue = cell => {
  if (!cell) return '';
  if (cell.f != null) return String(cell.f);
  if (cell.v != null) return String(cell.v);
  if (cell.p?.body?.dataStream) return String(cell.p.body.dataStream);
  return '';
};

// 工作表表头列名映射（第 0 行）
const sheetColumns = sheet => {
  const header = sheet?.cellData?.[0] || {};
  const columns = {};
  for (const [col, cell] of Object.entries(header)) if (cell?.v != null) columns[Number(col)] = String(cell.v);
  return columns;
};

// 对比两个工作簿快照，返回单元格级差异（精确到工作表、行、列）
export function diffPurchaseWorkbooks(oldSnapshot, newSnapshot) {
  const changes = [];
  const sheetIds = [...new Set([...(oldSnapshot?.sheetOrder || []), ...(newSnapshot?.sheetOrder || [])])];
  for (const sheetId of sheetIds) {
    const oldSheet = oldSnapshot?.sheets?.[sheetId];
    const newSheet = newSnapshot?.sheets?.[sheetId];
    const sheetName = (newSheet || oldSheet)?.name || sheetId;
    if (!oldSheet) { changes.push({ sheet: sheetName, row: 0, column: '', oldValue: '', newValue: '', type: 'sheet-added' }); continue; }
    if (!newSheet) { changes.push({ sheet: sheetName, row: 0, column: '', oldValue: '', newValue: '', type: 'sheet-removed' }); continue; }
    const columns = sheetColumns(newSheet);
    const rows = new Set([...Object.keys(oldSheet.cellData || {}), ...Object.keys(newSheet.cellData || {})]);
    for (const rowKey of rows) {
      const oldRow = oldSheet.cellData?.[rowKey] || {};
      const newRow = newSheet.cellData?.[rowKey] || {};
      const cols = new Set([...Object.keys(oldRow), ...Object.keys(newRow)]);
      for (const colKey of cols) {
        const oldValue = cellDisplayValue(oldRow[colKey]);
        const newValue = cellDisplayValue(newRow[colKey]);
        if (oldValue === newValue) continue;
        changes.push({ sheet: sheetName, row: Number(rowKey) + 1, column: columns[Number(colKey)] || `第${Number(colKey) + 1}列`, oldValue, newValue });
      }
    }
  }
  return changes;
}

// 列出工作簿全部版本（新到旧，含当前版本）及每个版本相对上一版的修改数
export function listWorkbookHistory(db) {
  const current = db.prepare('SELECT * FROM purchase_workbook WHERE id=1').get();
  const history = db.prepare('SELECT * FROM purchase_workbook_history ORDER BY revision DESC').all();
  const all = [];
  if (current) all.push({ revision: current.revision, savedAt: current.saved_at, current: true, snapshot: JSON.parse(current.snapshot_json) });
  for (const h of history) all.push({ revision: h.revision, savedAt: h.saved_at, current: false, snapshot: JSON.parse(h.snapshot_json) });
  return all.map((entry, index) => {
    const previous = all[index + 1];
    const changeCount = previous ? diffPurchaseWorkbooks(previous.snapshot, entry.snapshot).length : 0;
    return { revision: entry.revision, savedAt: entry.savedAt, current: entry.current, changeCount };
  });
}

// 读取某个版本的工作簿快照
export function readWorkbookRevision(db, revision) {
  const rev = Number(revision);
  if (!Number.isInteger(rev) || rev < 1) throw new Error('版本号无效');
  const current = db.prepare('SELECT * FROM purchase_workbook WHERE id=1').get();
  if (current && current.revision === rev) return { revision: rev, savedAt: current.saved_at, current: true, snapshot: JSON.parse(current.snapshot_json) };
  const h = db.prepare('SELECT * FROM purchase_workbook_history WHERE revision=?').get(rev);
  if (!h) throw new Error(`版本 ${rev} 不存在`);
  return { revision: rev, savedAt: h.saved_at, current: false, snapshot: JSON.parse(h.snapshot_json) };
}

// 返回某个版本相对其上一版本的单元格差异
export function diffWorkbookRevision(db, revision) {
  const rev = Number(revision);
  const target = readWorkbookRevision(db, rev);
  const previous = rev >= 2 ? readWorkbookRevision(db, rev - 1) : null;
  const changes = previous ? diffPurchaseWorkbooks(previous.snapshot, target.snapshot) : [];
  return { revision: rev, savedAt: target.savedAt, previousRevision: previous?.revision || 0, changes };
}
