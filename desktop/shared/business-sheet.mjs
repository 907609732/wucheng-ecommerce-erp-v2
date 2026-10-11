import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import FormulaParser from 'fast-formula-parser';
import { parseBusinessWorkbook, exportBusinessWorkbook } from './business-workbook.mjs';

const originalSheets = ['店铺的销售额具体内容月报', '人力费用', '2025采购信息', '年度采购金额', '结余'];
const keyOf = (sheet, cell) => `${sheet}!${cell}`;
const imageFormula = c => c.formula?.includes('DISPIMG');

export async function createSheetSnapshot(data, original, assets) {
  let cells = structuredClone(data.sourceCells), layouts = data.sheetLayouts || [];
  const raw = originalSheets.every(name => cells.some(c => c.sheet === name));
  if (raw) {
    const recovered = parseBusinessWorkbook(original).data;
    const formats = new Map(recovered.sourceCells.map(c => [keyOf(c.sheet, c.cell), c]));
    cells = cells.map(c => ({ ...formats.get(keyOf(c.sheet, c.cell)), ...c }));
    layouts = originalSheets.map(name => layouts.find(l => l.name === name) || recovered.sheetLayouts.find(l => l.name === name) || { name });
  } else {
    // Normalized imports also get a usable editable table, rather than a blank
    // source sheet. Omit the provenance relay so it cannot hide updated values.
    const bytes = await exportBusinessWorkbook(data, assets);
    const workbook = XLSX.read(bytes, { type: 'buffer', cellStyles: true, cellNF: true });
    const names = ['店铺月报', '月度收支', '采购明细', '人力明细', '原表汇总', '看板说明', '数据核对', '图片凭证'];
    cells = [];
    layouts = names.map(name => ({ name, ref: workbook.Sheets[name]['!ref'], merges: [], cols: [], rows: [] }));
    for (const name of names) for (const [cell, value] of Object.entries(workbook.Sheets[name])) {
      if (!cell.startsWith('!')) cells.push({ sheet: name, cell, value: value.v ?? null, formula: value.f || null, format: value.z || 'General', color: value.s?.fgColor?.rgb || null, type: value.t });
    }
  }
  const images = data.images.map((image, i) => raw ? image : { ...image, sheet: '图片凭证', cell: `I${i + 2}` });
  return { year: data.year, raw, sheets: layouts.map(l => ({ ...l, cells: cells.filter(c => c.sheet === l.name), images: images.filter(i => i.sheet === l.name) })) };
}

export function applySheetChanges(snapshot, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 2000) throw new Error('请提交 1 至 2000 个单元格修改');
  const next = structuredClone(snapshot), all = new Map(), changed = new Set(), formulas = new Map(), dependencies = new Map();
  for (const sheet of next.sheets) for (const c of sheet.cells) all.set(keyOf(sheet.name, c.cell), c);
  const originalCells = new Map([...all].map(([k, v]) => [k, structuredClone(v)]));
  for (const change of changes) {
    const sheet = next.sheets.find(s => s.name === change.sheet);
    if (!sheet || !/^[A-Z]{1,3}[1-9]\d{0,4}$/.test(change.cell || '')) throw new Error('单元格位置无效');
    const coord = XLSX.utils.decode_cell(change.cell), bounds = XLSX.utils.decode_range(sheet.ref || 'A1');
    if (coord.c > bounds.e.c || coord.r > bounds.e.r) throw new Error('修改超出工作表范围');
    if (sheet.images.some(i => i.cell === change.cell)) throw new Error('凭证图片不能通过修改数字或文字覆盖');
    if (!next.raw && ['看板说明', '数据核对', '图片凭证'].includes(sheet.name)) throw new Error('此工作表由软件维护，不能编辑');
    if (changed.has(keyOf(change.sheet, change.cell))) throw new Error('同一单元格重复提交');
    let value = change.input;
    if (typeof value !== 'string' || value.length > 2000) throw new Error('单元格内容过长或类型错误');
    const existing = all.get(keyOf(change.sheet, change.cell));
    const cell = existing || { sheet: sheet.name, cell: change.cell, format: 'General', value: null, formula: null };
    if (change.cell.startsWith('A') && /^A\d+$/.test(change.cell) && ['店铺的销售额具体内容月报', '年度采购金额'].includes(sheet.name) && typeof existing?.value === 'number' && existing.value > 40000 && existing.value < 70000 && cell.format === 'General') cell.format = 'yyyy-mm-dd';
    if (value.startsWith('=')) {
      if (value.length > 500 || /\[|\]|DISPIMG|WEBSERVICE|HYPERLINK|ENCODEURL|INDIRECT|OFFSET|NOW\(|RAND\(/i.test(value)) throw new Error('该公式暂不支持，请使用本工作簿内的数值、引用和计算函数');
      cell.formula = value.slice(1); cell.value = null; cell.type = 'n';
    } else {
      const trimmed = value.trim();
      if (trimmed && typeof existing?.value === 'number' && !/^[-+]?\d+(\.\d+)?%?$/.test(trimmed) && !XLSX.SSF.is_date(cell.format || 'General')) throw new Error(`${sheet.name}!${change.cell} 应填写数字`);
      if (trimmed === '') cell.value = null;
      else if (/^[-+]?\d+(\.\d+)?%?$/.test(trimmed)) cell.value = Number(trimmed.replace('%', '')) / (trimmed.endsWith('%') ? 100 : 1);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) && XLSX.SSF.is_date(cell.format || 'General')) {
        const d = new Date(`${trimmed}T00:00:00Z`);
        if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== trimmed) throw new Error('日期无效');
        cell.value = (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
      } else cell.value = value;
      cell.formula = null; cell.type = typeof cell.value === 'number' ? 'n' : 's';
    }
    if (typeof cell.value === 'number' && !Number.isFinite(cell.value)) throw new Error('数字超出有效范围');
    if (!existing) { sheet.cells.push(cell); all.set(keyOf(sheet.name, cell.cell), cell); }
    changed.add(keyOf(sheet.name, cell.cell));
  }
  const depParser = new FormulaParser.DepParser();
  for (const [key, c] of all) if (c.formula && !imageFormula(c)) {
    formulas.set(key, c);
    const pos = XLSX.utils.decode_cell(c.cell);
    try { dependencies.set(key, depParser.parse(c.formula, { sheet: c.sheet, row: pos.r + 1, col: pos.c + 1 })); }
    catch { if (changed.has(key)) throw new Error(`${key} 公式无法识别`); dependencies.set(key, null); }
  }
  function references(ref, key) {
    const c = all.get(key); if (!c || ref.sheet !== c.sheet) return false;
    const p = XLSX.utils.decode_cell(c.cell);
    return ref.from ? p.r + 1 >= ref.from.row && p.r + 1 <= ref.to.row && p.c + 1 >= ref.from.col && p.c + 1 <= ref.to.col : p.r + 1 === ref.row && p.c + 1 === ref.col;
  }
  // Only recalculate edited formulas and their dependants. Unrelated cached
  // source results must not be silently "corrected" when another cell changes.
  const affected = new Set(changed);
  let more = true;
  while (more) {
    more = false;
    for (const [key, refs] of dependencies) if (!affected.has(key) && (!refs || refs.some(r => [...affected].some(k => references(r, k))))) { affected.add(key); more = true; }
  }
  const visiting = new Set(), done = new Set();
  function evaluate(key) {
    const c = all.get(key);
    if (!c) return 0;
    if (c.formula && !affected.has(key) && c.value == null) throw new Error(`${key} 缺少公式缓存结果，请先补全结果`);
    if (!formulas.has(key) || !affected.has(key) || done.has(key)) return c.value ?? 0;
    if (visiting.has(key)) throw new Error(`循环引用：${key}`);
    visiting.add(key);
    const validateReference = ref => {
      if (!next.sheets.some(s => s.name === ref.sheet)) throw new Error(`工作表不存在：${ref.sheet}`);
      if ((ref.row || ref.from?.row) < 1 || (ref.col || ref.from?.col) < 1) throw new Error('引用位置无效');
    };
    const parser = new FormulaParser({
      onCell: ref => { validateReference(ref); return evaluate(keyOf(ref.sheet, XLSX.utils.encode_cell({ r: ref.row - 1, c: ref.col - 1 }))); },
      onRange: ref => {
        validateReference(ref);
        if ((ref.to.row - ref.from.row + 1) * (ref.to.col - ref.from.col + 1) > 100000) throw new Error('引用范围过大');
        return Array.from({ length: ref.to.row - ref.from.row + 1 }, (_, r) => Array.from({ length: ref.to.col - ref.from.col + 1 }, (_, col) => evaluate(keyOf(ref.sheet, XLSX.utils.encode_cell({ r: ref.from.row + r - 1, c: ref.from.col + col - 1 })))));
      }
    });
    try {
      const pos = XLSX.utils.decode_cell(c.cell), value = parser.parse(c.formula, { sheet: c.sheet, row: pos.r + 1, col: pos.c + 1 });
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean' || typeof value === 'number' && !Number.isFinite(value)) throw new Error('公式结果无效');
      if (typeof value === 'string' && /^#(REF|DIV|VALUE|NAME|N\/A|NUM)/.test(value)) throw new Error(value);
      c.value = value; c.type = typeof value === 'number' ? 'n' : 's'; done.add(key); return value;
    } catch (error) { throw new Error(`${key} 计算失败：${error.message || error}`); }
    finally { visiting.delete(key); }
  }
  for (const key of affected) evaluate(key);
  next.changes = [...changed].map(key => ({ sheet: all.get(key).sheet, cell: all.get(key).cell, before: originalCells.get(key)?.value ?? null, beforeFormula: originalCells.get(key)?.formula || null, after: all.get(key).value, afterFormula: all.get(key).formula }));
  next.recalculated = [...done];
  return next;
}

export async function exportSheetSnapshot(snapshot, assets) {
  const workbook = new ExcelJS.Workbook(), byId = new Map(assets.map(a => [a.id, a])), added = new Map();
  workbook.creator = '五成电子商务集团';
  workbook.calcProperties.fullCalcOnLoad = false;
  if(snapshot.cloud && snapshot.nativeData) {
    const guide=workbook.addWorksheet('钉钉快照说明');
    guide.addRow(['版本','WUCHENG_DINGTALK_V1']);
    guide.addRow(['说明','钉钉来源快照，公式保留来源定义及缓存值；修改数据后建议回到钉钉同步。请保留此工作表以便重新导入。']);
    const json=JSON.stringify(snapshot.nativeData);
    for(let i=0;i<json.length;i+=30000) guide.addRow([i/30000,json.slice(i,i+30000)]);
    guide.state='veryHidden';
  }
  for (const source of snapshot.sheets) {
    const sheet = workbook.addWorksheet(source.name);
    for (const [index, col] of (source.cols || []).entries()) if (col) sheet.getColumn(index + 1).width = Math.min(col.wch || col.width || 18, 90);
    for (const [index, row] of (source.rows || []).entries()) if (row?.hpt) sheet.getRow(index + 1).height = row.hpt;
    const imageCells = new Set(source.images.map(i => i.cell));
    for (const c of source.cells) {
      if (imageCells.has(c.cell) || imageFormula(c)) continue;
      const target = sheet.getCell(c.cell);
      target.value = c.formula ? { formula: c.formula, ...(c.value != null ? { result: c.value } : {}) } : c.value;
      if (c.format) target.numFmt = c.format;
      if (/^[A-Fa-f0-9]{6}$/.test(c.color || '')) target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${c.color}` } };
      target.alignment = { vertical: 'middle', wrapText: true };
      target.border = { bottom: { style: 'hair', color: { argb: 'FFD6DCD8' } } };
    }
    for (const merge of source.merges || []) sheet.mergeCells(XLSX.utils.encode_range(merge));
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: source.name === originalSheets[0] ? 2 : 1 }];
    for (const image of source.images) {
      const asset = byId.get(image.assetId); if (!asset) throw new Error('凭证图片缺失，无法导出');
      if (!added.has(asset.id)) added.set(asset.id, workbook.addImage({ buffer: Buffer.from(asset.data), extension: asset.extension }));
      const { r, c } = XLSX.utils.decode_cell(image.cell);
      const position = snapshot.cloud ? image.position || 0 : 0;
      sheet.addImage(added.get(asset.id), { tl: { row: r + Math.floor(position / 2) * .34, col: c + (position % 2) * .47 }, ext: { width: snapshot.cloud ? 68 : 150, height: snapshot.cloud ? 60 : 90 }, editAs: 'oneCell' });
      const count = snapshot.cloud ? source.images.filter(i=>i.cell === image.cell).length : 1;
      sheet.getRow(r + 1).height = Math.max(sheet.getRow(r + 1).height || 20, snapshot.cloud ? Math.ceil(count/2)*51 : 74);
      sheet.getColumn(c + 1).width = Math.max(sheet.getColumn(c + 1).width || 18, 23);
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
