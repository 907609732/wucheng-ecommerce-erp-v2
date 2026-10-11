import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import ExcelJS from 'exceljs';
import { projectDingTalk, columnName } from './business-dingtalk.mjs';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, parseAttributeValue: false });
const list = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
export const SHOPS = ['店口五金淘宝', '店口五金拼多多', '西施五金淘宝'];
const hash = (v) => createHash('sha256').update(v).digest('hex');
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
export const total = (rows, key) => {
  const values = rows.map(r => r[key]).filter(v => typeof v === 'number');
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100 : null;
};
function date(v) {
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const m = String(v || '').match(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}
function zipTarget(base, target) {
  const p = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(base), target));
  if (!p.startsWith('xl/') || p.includes('..')) throw new Error('图片路径不合法');
  return p;
}
function relationships(zip, base) {
  const rel = path.posix.join(path.posix.dirname(base), '_rels', path.posix.basename(base) + '.rels');
  if (!zip.getEntry(rel)) return {};
  return Object.fromEntries(list(xml.parse(zip.readAsText(rel)).Relationships?.Relationship)
    .filter(r => r.TargetMode !== 'External' && /\/(image|worksheet|drawing)$/.test(r.Type)).map(r => [r.Id, zipTarget(base, r.Target)]));
}
function imageParts(zip, workbook) {
  const assets = new Map(), refs = [], byName = new Map();
  function asset(part) {
    if (!part || !zip.getEntry(part)) throw new Error('找不到表格引用的图片');
    const data = zip.readFile(part), extension = path.posix.extname(part).slice(1).toLowerCase().replace('jpg', 'jpeg');
    if (!['png', 'jpeg', 'gif'].includes(extension)) throw new Error(`暂不支持图片格式 ${extension}`);
    const id = hash(data);
    if (!assets.has(id)) assets.set(id, { id, extension, data });
    return id;
  }
  if (zip.getEntry('xl/cellimages.xml')) {
    const rel = relationships(zip, 'xl/cellimages.xml');
    for (const entry of list(xml.parse(zip.readAsText('xl/cellimages.xml')).cellImages?.cellImage)) {
      const pic = entry.pic;
      byName.set(pic.nvPicPr.cNvPr.name, asset(rel[pic.blipFill.blip.embed]));
    }
  }
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    for (const [cell, value] of Object.entries(sheet)) {
      if (cell.startsWith('!') || !value.f?.includes('DISPIMG')) continue;
      const id = value.f.match(/DISPIMG\("([^"]+)"/i)?.[1];
      if (!byName.has(id)) throw new Error(`图片引用缺失：${name}!${cell}`);
      refs.push({ id: `${name}!${cell}`, sheet: name, cell, assetId: byName.get(id) });
    }
  }
  // Standard Excel drawings are used by the normalized export/template. WPS's
  // hidden backup drawing must not become a second copy of every DISPIMG image.
  const bookRel = relationships(zip, 'xl/workbook.xml');
  const sheets = list(xml.parse(zip.readAsText('xl/workbook.xml')).workbook?.sheets?.sheet);
  for (const s of sheets) {
    if (s.state === 'veryHidden' || s.name.startsWith('WpsReserved_')) continue;
    const part = bookRel[s.id];
    if (!part || !zip.getEntry(part)) continue;
    const tree = xml.parse(zip.readAsText(part)).worksheet;
    const sr = relationships(zip, part);
    for (const drawing of list(tree.drawing)) {
      const dp = sr[drawing.id];
      if (!dp || !zip.getEntry(dp)) continue;
      const dr = relationships(zip, dp), root = xml.parse(zip.readAsText(dp)).wsDr;
      for (const anchor of [...list(root?.twoCellAnchor), ...list(root?.oneCellAnchor)]) {
        if (!anchor.pic || !anchor.from) continue;
        const cell = XLSX.utils.encode_cell({ r: Number(anchor.from.row), c: Number(anchor.from.col) });
        if (workbook.Sheets[s.name]?.[cell]?.f?.includes('DISPIMG')) continue;
        refs.push({ id: `${s.name}!${cell}`, sheet: s.name, cell, assetId: asset(dr[anchor.pic.blipFill.blip.embed]) });
      }
    }
  }
  return { assets: [...assets.values()], refs };
}

const schemas = {
  monthly: ['店铺月报', { id: '记录编号', month: '月份', shop: '店铺', target: '目标销售额', paid: '支付金额', refund: '退款金额', returnRefund: '退货退款金额', net: '净支付金额', deduction: '扣款合计', visitors: '访客数', quantity: '销量', conversion: '转化率', average: '客单价', promotion: '推广费用', profit: '原表净收益金额', targetRate: '目标完成率', returnOrders: '退款订单数', penalty: '罚款', service: '技术服务费', other: '其他费用', returnRate: '退货订单率', followers: '关注用户数', buyers: '成交买家数', oldBuyerRate: '老买家占比', stay: '停留时长', sourceSheet: '来源工作表', sourceRow: '来源行' }],
  finance: ['月度收支', { id: '记录编号', month: '月份', postage: '总邮费', warehousePostage: '云仓邮费', shippingPostage: '寄件邮费', intercept: '逆向拦截服务费', purchase: '采购金额', dropship: '代发金额', dropshipCustomer: '代发客户', xishi: '西施五金净收益', earnings: '原表收益', sourceSheet: '来源工作表', sourceRow: '来源行' }],
  purchases: ['采购明细', { id: '记录编号', month: '月份', date: '日期', item: '采购物品', amount: '金额', platform: '购买平台', note: '备注', sourceSheet: '来源工作表', sourceRow: '来源行' }],
  labor: ['人力明细', { id: '记录编号', month: '月份', date: '日期', item: '项目', amount: '金额', person: '人员', sourceSheet: '来源工作表', sourceRow: '来源行' }],
  controls: ['原表汇总', { id: '记录编号', year: '年份', metric: '指标', amount: '金额', sourceSheet: '来源工作表', sourceCell: '来源单元格' }]
};
const textFields = new Set(['id', 'month', 'shop', 'date', 'item', 'platform', 'note', 'person', 'metric', 'sourceSheet', 'sourceCell', 'dropshipCustomer']);

export function parseBusinessWorkbook(input) {
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buffer.length > 500 * 1024 * 1024) throw new Error('文件超过 500 MB');
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw new Error('文件损坏，请选择有效的 .xlsx 文件'); }
  if (!zip.getEntry('xl/workbook.xml')) throw new Error('请选择 .xlsx 工作簿');
  const entries = zip.getEntries();
  if (entries.length > 10000 || entries.reduce((s, e) => s + e.header.size, 0) > 750 * 1024 * 1024) throw new Error('工作簿解压大小超出限制');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellDates: false, cellStyles: true, cellNF: true });
  const images = imageParts(zip, workbook);
  if(workbook.Sheets['钉钉快照说明']) {
    const guide=workbook.Sheets['钉钉快照说明'];
    if(guide.B1?.v!=='WUCHENG_DINGTALK_V1') throw new Error('钉钉快照版本不支持');
    let native;
    try {native=JSON.parse(XLSX.utils.sheet_to_json(guide,{header:1}).slice(2).map(r=>r[1]||'').join(''));} catch {throw new Error('钉钉快照结构损坏');}
    if(!Array.isArray(native.dingtalkTables)||native.dingtalkTables.length>30||!Array.isArray(native.images)||!Number.isInteger(native.year)) throw new Error('钉钉快照结构无效');
    const tables=structuredClone(native.dingtalkTables), assetIds=new Set(images.assets.map(a=>a.id));
    if(images.refs.length!==native.images.length||native.images.some(i=>!assetIds.has(i.assetId))) throw new Error('钉钉快照凭证数量或内容变化，未导入');
    for(const table of tables) {
      const sheet=workbook.Sheets[table.name];
      if(!sheet || !Array.isArray(table.fields)||!table.fields.length||table.fields.length>100||!Array.isArray(table.records)||table.records.length>20000) throw new Error('钉钉快照缺少数据表或字段');
      for(const [r,record] of table.records.entries()) for(const [c,field] of table.fields.entries()) {
        if(sheet[`${columnName(c)}1`]?.v!==field.fieldName) throw new Error('钉钉快照表头变化，不能安全关联凭证');
        if(field.type!=='attachment') record.cells[field.fieldId]=sheet[`${columnName(c)}${r+2}`]?.v??null;
      }
    }
    const data=projectDingTalk(tables,native.year,native.images);data.hash=hash(buffer);
    return {data,assets:images.assets,buffer};
  }
  const data = { schemaVersion: 1, monthly: [], finance: [], purchases: [], labor: [], controls: [], images: [], sourceCells: [], issues: [] };
  data.sheetLayouts = workbook.SheetNames.filter(n => !n.startsWith('WpsReserved_')).map(name => ({ name, ref: workbook.Sheets[name]['!ref'], merges: workbook.Sheets[name]['!merges'] || [], cols: workbook.Sheets[name]['!cols'] || [], rows: workbook.Sheets[name]['!rows'] || [] }));
  for (const name of workbook.SheetNames.filter(n => !n.startsWith('WpsReserved_'))) {
    for (const [cell, value] of Object.entries(workbook.Sheets[name])) {
      if (cell.startsWith('!')) continue;
      data.sourceCells.push({ sheet: name, cell, value: value.v ?? null, formula: value.f || null, format: value.z || 'General', color: value.s?.fgColor?.rgb || null, type: value.t });
      if (value.f && !value.f.includes('DISPIMG') && (value.v == null || value.t === 'e')) data.issues.push({ message: `公式结果缺失或错误：${name}!${cell}`, source: `${name}!${cell}` });
    }
  }
  if (workbook.Sheets['看板说明']) {
    if (workbook.Sheets['看板说明'].B1?.v !== 'WUCHENG_BUSINESS_V1') throw new Error('不支持的看板模板版本');
    for (const [kind, [name, fields]] of Object.entries(schemas)) {
      if (!workbook.Sheets[name]) throw new Error(`模板缺少工作表：${name}`);
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: null });
      data[kind] = rows.map((row, index) => Object.fromEntries(Object.entries(fields).map(([key, label]) => {
        const v = row[label];
        if (v != null && !textFields.has(key) && typeof v !== 'number') throw new Error(`${name} 第 ${index + 2} 行的 ${label} 必须为数值`);
        return [key, v == null ? null : textFields.has(key) ? String(v) : number(v)];
      }))).filter(r => r.id || r.month || r.metric || r.amount != null);
      for (const [index, r] of data[kind].entries()) {
        if (!r.id) r.id = `${kind}:${index + 2}`;
        if (kind !== 'controls' && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(r.month || '')) throw new Error(`${name} 第 ${index + 2} 行月份应为 YYYY-MM`);
        if (kind === 'monthly' && !SHOPS.includes(r.shop)) throw new Error(`${name} 第 ${index + 2} 行店铺名称不支持`);
      }
    }
    const indexRows = XLSX.utils.sheet_to_json(workbook.Sheets['图片凭证'] || {}, { header: 1 });
    data.images = images.refs.map(ref => {
      const row = indexRows[XLSX.utils.decode_cell(ref.cell).r] || [];
      return { ...ref, id: String(row[0] || ref.id), kind: String(row[1] || 'source'), recordId: String(row[2] || ''), month: String(row[3] || ''), shop: String(row[4] || ''), sheet: String(row[5] || ref.sheet), cell: String(row[6] || ref.cell), label: String(row[7] || '图片凭证') };
    });
    if (workbook.Sheets['来源单元格']) data.sourceCells = XLSX.utils.sheet_to_json(workbook.Sheets['来源单元格'], { defval: null }).map(r => ({ sheet: r['工作表'], cell: r['单元格'], value: r['值JSON'] == null ? null : JSON.parse(r['值JSON']), formula: r['原公式'] || null }));
    if (workbook.Sheets['数据核对']) data.issues.push(...XLSX.utils.sheet_to_json(workbook.Sheets['数据核对']).map(r => ({ message: String(r['问题'] || ''), source: String(r['来源'] || '') })));
  } else {
    const name = '店铺的销售额具体内容月报', s = workbook.Sheets[name];
    if (!s || !workbook.Sheets['人力费用'] || !workbook.Sheets['2025采购信息'] || !workbook.Sheets['年度采购金额'] || !workbook.Sheets['结余']) throw new Error('格式不匹配，请使用原始五表工作簿或标准模板');
    const get = (sheet, col, row) => sheet[`${col}${row}`]?.v;
    const num = (sheet, col, row) => sheet[`${col}${row}`]?.t === 'e' ? null : number(get(sheet, col, row));
    const source = (sheet, row) => ({ sourceSheet: sheet, sourceRow: row });
    const mainRows = [], xishiRows = [];
    for (let r = 1; r <= XLSX.utils.decode_range(s['!ref']).e.r + 1; r++) {
      const month = date(get(s, 'A', r)).slice(0, 7);
      if (!month) continue;
      (r < 19 ? mainRows : xishiRows).push(r);
      const mappings = r < 19 ? [
        [SHOPS[0], { target: 'D', targetRate: 'E', paid: 'F', refund: 'G', returnRefund: 'H', net: 'I', deduction: 'K', visitors: 'L', quantity: 'M', conversion: 'N', average: 'O', stay: 'P', promotion: 'Q', profit: 'R' }],
        [SHOPS[1], { target: 'T', targetRate: 'U', paid: 'V', refund: 'W', net: 'X', returnOrders: 'Y', penalty: 'AA', service: 'AB', other: 'AC', deduction: 'AD', conversion: 'AE', quantity: 'AF', average: 'AG', returnRate: 'AH', followers: 'AI', buyers: 'AJ', oldBuyerRate: 'AK', profit: 'AL' }]
      ] : [[SHOPS[2], { target: 'D', targetRate: 'E', paid: 'F', refund: 'G', returnRefund: 'H', net: 'I', deduction: 'K', visitors: 'L', quantity: 'M', conversion: 'N', average: 'O', stay: 'P', promotion: 'Q' }]];
      for (const [shop, cols] of mappings) data.monthly.push({ id: `${shop}:${month}`, month, shop, ...Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, num(s, c, r)])), ...source(name, r) });
      if (r < 19) data.finance.push({ id: `finance:${month}`, month, postage: num(s, 'AU', r), warehousePostage: num(s, 'AQ', r), shippingPostage: num(s, 'AS', r), intercept: num(s, 'AT', r), purchase: num(s, 'AV', r), dropship: num(s, 'AW', r), dropshipCustomer: get(s, 'AX', r) ?? null, xishi: num(s, 'AY', r), earnings: num(s, 'AZ', r), ...source(name, r) });
    }
    const p = workbook.Sheets['2025采购信息']; let month = '';
    for (let r = 2; r <= XLSX.utils.decode_range(p['!ref']).e.r + 1; r++) {
      const heading = String(get(p, 'A', r) || '').match(/(20\d{2})年(\d{1,2})月采购清单/);
      if (heading) { month = `${heading[1]}-${heading[2].padStart(2, '0')}`; continue; }
      if (get(p, 'B', r) === '总金额' && num(p, 'C', r) != null) {
        data.controls.push({ id: `purchase-subtotal:${month}`, year: Number(month.slice(0, 4)), metric: `采购明细小计 ${month}`, amount: num(p, 'C', r), sourceSheet: '2025采购信息', sourceCell: `C${r}` }); continue;
      }
      if (month && num(p, 'C', r) != null) data.purchases.push({ id: `purchase:${r}`, month, date: date(get(p, 'A', r)) || String(get(p, 'A', r) || ''), item: String(get(p, 'B', r) || ''), amount: num(p, 'C', r), platform: String(get(p, 'D', r) || ''), note: [get(p, 'E', r), get(p, 'F', r)].filter(v => v != null).join(' '), ...source('2025采购信息', r) });
    }
    const l = workbook.Sheets['人力费用'];
    // The lower dated block is the canonical breakdown; the upper block is a
    // duplicate presentation with supporting screenshots, not additional pay.
    for (let r = 15; r <= XLSX.utils.decode_range(l['!ref']).e.r + 1; r++) {
      const d = date(get(l, 'A', r));
      if (!d) continue;
      for (const [amountCol, itemCol, personCol, label] of [['B', '', 'D', '工资'], ['G', 'F', 'H', '其他人力'], ['K', 'J', 'L', '代发货辛苦费']]) {
        const amount = num(l, amountCol, r);
        const itemDate = amountCol === 'K' ? date(get(l, 'I', r)) || d : amountCol === 'G' ? date(get(l, 'E', r)) || d : d;
        if (amount != null) data.labor.push({ id: `labor:${amountCol}${r}`, month: itemDate.slice(0, 7), date: itemDate, item: String(get(l, itemCol, r) || label), amount, person: String(get(l, personCol, r) || ''), ...source('人力费用', r) });
      }
    }
    const year = Number(data.finance[0]?.month.slice(0, 4));
    const controls = [['原表收益', '结余', 'A2'], ['原表人力费用', '结余', 'B2'], ['原表结余', '结余', 'C2'], ['年度采购汇总', '年度采购金额', 'B12']];
    data.controls.push(...controls.map(([metric, sheet, cell]) => ({ id: metric, year, metric, amount: number(workbook.Sheets[sheet][cell]?.v), sourceSheet: sheet, sourceCell: cell })));
    for (const ref of images.refs) {
      const { r, c } = XLSX.utils.decode_cell(ref.cell); const row = r + 1;
      let kind = 'labor', recordId = '', imageMonth = '', shop = '', label = '人力费用凭证';
      if (ref.sheet === name) {
        imageMonth = date(get(s, 'A', row)).slice(0, 7);
        shop = row >= 19 ? SHOPS[2] : c < 18 ? SHOPS[0] : c < 38 ? SHOPS[1] : '';
        kind = shop ? 'monthly' : 'finance'; recordId = shop ? `${shop}:${imageMonth}` : `finance:${imageMonth}`;
        label = `${shop || '邮费'} ${imageMonth} 凭证`;
      } else {
        label = String(get(l, 'A', row) || '人力费用凭证');
        const candidates = data.labor.filter(v => v.amount === num(l, 'B', row));
        if (candidates.length === 1) { recordId = candidates[0].id; imageMonth = candidates[0].month; }
      }
      data.images.push({ ...ref, kind, recordId, month: imageMonth, shop, label });
    }
    data.issues.push({ message: '原表“净利率”列为金额，按原表净收益金额展示；西施五金净支付被原表作为净收益计入，未另行扣除成本。', source: `${name}!R2、AL2、AY2` },
      { message: '原表收益未明确扣除推广费，不自动改账；公共费用不按店铺分摊。', source: `${name}!Q2、AZ2` },
      { message: '人力费用上、下两区为重复展示，仅采用下方日期明细；月份依下方日期，跨月说明保留在原表。', source: '人力费用!A14:M23' });
  }
  const years = [...new Set([...data.monthly, ...data.finance, ...data.purchases, ...data.labor].map(r => Number(r.month?.slice(0, 4))))];
  if (years.length !== 1 || !Number.isInteger(years[0]) || years[0] < 2000) throw new Error('每次请导入一个完整年度，且至少有一条业务记录');
  data.year = years[0];
  for (const [kind] of Object.entries(schemas)) {
    data[kind] = data[kind].map(r => Object.fromEntries(Object.keys(schemas[kind][1]).map(k => [k, r[k] ?? null])));
    const ids = data[kind].map(r => r.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${schemas[kind][0]}存在重复记录编号`);
  }
  const keys = data.monthly.map(r => `${r.shop}:${r.month}`);
  if (new Set(keys).size !== keys.length) throw new Error('同一店铺同一月份存在多条月报');
  if (new Set(data.finance.map(r => r.month)).size !== data.finance.length) throw new Error('同一月份存在多条收支记录');
  if (data.controls.some(r => r.year !== data.year)) throw new Error('原表汇总年份与业务年份不一致');
  const addIssue = (message, source) => { if (!data.issues.some(r => r.message === message)) data.issues.push({ message, source }); };
  const laborControl = data.controls.find(r => r.metric === '原表人力费用')?.amount;
  if (laborControl != null && total(data.labor, 'amount') != null && Math.abs(laborControl - total(data.labor, 'amount')) > 0.005) addIssue(`人力费用原表汇总 ${laborControl.toFixed(2)} 元，逐笔明细 ${total(data.labor, 'amount').toFixed(2)} 元，差额 ${(laborControl - total(data.labor, 'amount')).toFixed(2)} 元；原表汇总可能重复计入费用，不自动更改。`, '人力费用');
  for (const r of data.monthly) if (r.paid != null && r.refund != null && r.net != null && Math.abs(r.paid - r.refund - r.net) > 0.005) addIssue(`${r.shop} ${r.month}：支付减退款为 ${(r.paid - r.refund).toFixed(2)} 元，与原表净支付 ${r.net.toFixed(2)} 元不一致。`, `${r.sourceSheet}!${r.sourceRow}`);
  data.hash = hash(buffer);
  return { data, assets: images.assets, buffer };
}

export function selectBusinessData(data, filters = {}) {
  const month = String(filters.month || ''), shop = String(filters.shop || '');
  if (month && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份格式错误');
  if (shop && ![...SHOPS,...data.monthly.map(r=>r.shop)].includes(shop)) throw new Error('店铺不存在');
  const matches = r => !month || r.month === month;
  const result = { ...data, monthly: data.monthly.filter(r => matches(r) && (!shop || r.shop === shop)), finance: shop ? [] : data.finance.filter(matches), purchases: shop ? [] : data.purchases.filter(matches), labor: shop ? [] : data.labor.filter(matches), controls: month || shop ? [] : data.controls };
  result.images = data.images.filter(r => (!month || r.month === month) && (!shop || r.shop === shop));
  if (month || shop) {
    const sourceRows = new Set([...result.monthly, ...result.finance, ...result.purchases, ...result.labor].map(r => `${r.sourceSheet}!${r.sourceRow}`));
    const imageCells = new Set(result.images.map(r => `${r.sheet}!${r.cell}`));
    result.sourceCells = data.sourceCells.filter(r => sourceRows.has(`${r.sheet}!${r.cell.replace(/\D/g, '')}`) || imageCells.has(`${r.sheet}!${r.cell}`));
  }
  const control = metric => result.controls.find(r => r.metric === metric)?.amount ?? null;
  result.summary = { paid: total(result.monthly, 'paid'), refund: total(result.monthly, 'refund'), net: total(result.monthly, 'net'), purchase: total(result.finance, 'purchase'), labor: total(result.labor, 'amount'), originalLabor: control('原表人力费用'), earnings: total(result.finance, 'earnings'), balance: control('原表结余') };
  const metrics = [['月报采购合计', total(data.finance, 'purchase')], ['年度采购汇总', data.controls.find(r => r.metric === '年度采购汇总')?.amount ?? null], ['采购分月小计合计', total(data.controls.filter(r => r.metric.startsWith('采购明细小计')), 'amount')], ['采购逐笔明细合计', total(data.purchases, 'amount')], ['人力明细合计', total(data.labor, 'amount')], ['原表人力费用', data.controls.find(r => r.metric === '原表人力费用')?.amount ?? null]];
  result.reconciliation = metrics.map(([metric, amount]) => ({ metric, amount }));
  result.notices = [...data.issues, { message: '采购各来源汇总分别保留，差额不自动调整；空白值为未填报。', source: '采购核对' }];
  if(data.dingtalkTables) {
    result.reconciliation=[];
    result.notices=data.issues;
  }
  return result;
}

export async function exportBusinessWorkbook(data, assets = [], { template = false } = {}) {
  const book = new ExcelJS.Workbook(); book.creator = '五成电子商务集团';
  const guide = book.addWorksheet('看板说明');
  guide.addRows([['模板版本', 'WUCHENG_BUSINESS_V1'], ['使用说明', '月份填写 YYYY-MM；金额填数值，百分比填小数（如 0.05 表示 5%）。每次导入一个完整年度。'], ['更新说明', '记录编号保持稳定；同年度导入替换完整年度版本，旧版本可恢复。'], ['店铺名称', SHOPS.join('、')], ['收益口径', '保留原表收益与核对差异；不自动分摊公共成本。']]);
  for (const [kind, [name, fields]] of Object.entries(schemas)) {
    const sheet = book.addWorksheet(name);
    sheet.addRow(Object.values(fields));
    if (!template) for (const record of data[kind]) sheet.addRow(Object.keys(fields).map(k => record[k] ?? null));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(sheet.rowCount, 1), column: Object.keys(fields).length } };
    Object.keys(fields).forEach((key, i) => { if (!textFields.has(key) && !['year', 'sourceRow'].includes(key)) sheet.getColumn(i + 1).numFmt = /Rate|conversion/.test(key) ? '0.00%' : '#,##0.00'; });
  }
  const issues = book.addWorksheet('数据核对'); issues.addRow(['问题', '来源']);
  if (!template) for (const issue of data.issues) issues.addRow([issue.message, issue.source]);
  const source = book.addWorksheet('来源单元格'); source.addRow(['工作表', '单元格', '值JSON', '原公式']);
  if (!template) for (const c of data.sourceCells) source.addRow([c.sheet, c.cell, JSON.stringify(c.value), c.formula]);
  const imageSheet = book.addWorksheet('图片凭证');
  imageSheet.addRow(['图片编号', '业务类型', '记录编号', '月份', '店铺', '原工作表', '原单元格', '说明', '图片']);
  const byAsset = new Map(assets.map(a => [a.id, a])), excelIds = new Map();
  if (!template) for (const image of data.images) {
    const asset = byAsset.get(image.assetId);
    if (!asset) throw new Error(`导出缺少图片：${image.id}`);
    const row = imageSheet.addRow([image.id, image.kind, image.recordId, image.month, image.shop, image.sheet, image.cell, image.label]);
    if (!excelIds.has(asset.id)) excelIds.set(asset.id, book.addImage({ buffer: Buffer.from(asset.data), extension: asset.extension }));
    imageSheet.addImage(excelIds.get(asset.id), { tl: { col: 8, row: row.number - 1 }, ext: { width: 180, height: 110 }, editAs: 'oneCell' });
    row.height = 86;
  }
  for (const sheet of book.worksheets) {
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245A55' } };
    for (const col of sheet.columns) col.width = 22;
  }
  imageSheet.getColumn(9).width = 28;
  guide.getColumn(2).width = 100;
  return Buffer.from(await book.xlsx.writeBuffer());
}
