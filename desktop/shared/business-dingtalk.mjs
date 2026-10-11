import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
export const DINGTALK_BASE = 'R4GpnMqJzGBGbAvgHaZPYl4M8Ke0xjE3';
const digest = value => createHash('sha256').update(value).digest('hex');
export function scalar(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(scalar).filter(v => v != null).join('、');
  if (typeof value === 'object') return scalar(value.value ?? value.text ?? value.name);
  return value;
}
export function numeric(value) {
  const v = scalar(value);
  if (v == null || String(v).trim() === '') return null;
  const text = String(v).trim().replace(/[,，￥¥元\s]/g, '');
  return /^[-+]?\d+(\.\d+)?%?$/.test(text) ? Number(text.replace('%', '')) / (text.endsWith('%') ? 100 : 1) : null;
}
export function recordMonth(record, fields) {
  const field = fields.find(f => f.type === 'date') || fields.find(f => f.fieldName === '日期');
  const match = String(scalar(record.cells[field?.fieldId]) || '').match(/(20\d{2})[-年/.](\d{1,2})/);
  return match && Number(match[2]) >= 1 && Number(match[2]) <= 12 ? `${match[1]}-${match[2].padStart(2, '0')}` : '';
}
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/url|token|signature|authorization|secret/i.test(k)).map(([k,v]) => [k, clean(v)]));
  return value;
}
export async function dws(args) {
  const executable = process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm/node_modules/dingtalk-workspace-cli/vendor/dws.exe') : 'dws';
  if (process.platform === 'win32' && !fs.existsSync(executable)) throw new Error('未安装钉钉连接工具，请在系统安装 dingtalk-workspace-cli 并登录');
  let stdout;
  try { ({ stdout } = await execute(executable, [...args, '--format', 'json'], { windowsHide: true, timeout: 90000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })); }
  catch { throw new Error('钉钉读取失败，请检查钉钉连接工具的登录状态、表格权限和网络；原有数据已保留'); }
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('钉钉返回格式无效，未更新已有数据'); }
  if (result.success === false || result.ok === false || /error|partial/i.test(result.status || result.outcome || '') || result.error?.message) throw new Error('钉钉未完整返回数据，请检查登录和权限后重试；原有数据已保留');
  return result;
}
async function attachmentBytes(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('凭证下载地址无效，未更新数据'); }
  if (parsed.protocol !== 'https:' || !/^alidocs\d*\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(parsed.hostname)) throw new Error('凭证下载来源无法验证，未更新数据');
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('凭证下载失败，未更新数据，请稍后重新同步');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 30 * 1024 * 1024) throw new Error('单个凭证超过 30 MB，未更新数据'); parts.push(part); }
  const bytes = Buffer.concat(parts);
  const extension = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 ? 'jpeg' : bytes.subarray(0,3).toString() === 'GIF' ? 'gif' : '';
  if (!extension) throw new Error('存在非图片附件，暂不能完整同步，请保留原表并将附件转换为 PNG/JPEG/GIF');
  return { id: digest(bytes), extension, data: bytes };
}
export function projectDingTalk(tables, year, images) {
  const data = { schemaVersion: 1, year, monthly: [], finance: [], purchases: [], labor: [], controls: [], images, sourceCells: [], issues: [], dingtalkTables: tables, source: { kind: 'dingtalk', baseId: DINGTALK_BASE } };
  for (const table of tables) for (const [index, record] of table.records.entries()) {
    const month = recordMonth(record, table.fields), value = name => record.cells[table.fields.find(f => f.fieldName === name)?.fieldId], num = name => numeric(value(name));
    if (!month) { data.issues.push({ message: '记录缺少有效月份，已保留在原始数据表，未计入汇总', source: `${table.name} / ${record.recordId}` }); continue; }
    const source = { id: `${table.tableId}:${record.recordId}`, month, sourceSheet: table.name, sourceRow: index + 2 };
    for(const field of table.fields.filter(f=>f.type==='formula'||f.type==='filterUp')) {
      const cached=scalar(record.cells[field.fieldId]);
      if(cached == null || cached === '' || /^#/.test(String(cached))) data.issues.push({message:`${month} ${field.fieldName}：${cached == null || cached === '' ? '缺少公式或引用结果' : String(cached)}，未当作零处理`,source:`${table.name} / ${record.recordId}`});
    }
    if (table.scope === 'sales') {
      const paid = num('支付金额') ?? num('成交金额'), refund = num('退款金额'), net = num('净支付金额');
      data.monthly.push({ ...source, shop: table.name, paid, refund, net, deduction: num('扣款合计') ?? num('扣款'), profit: num('毛利润'), quantity: num('成交订单数'), visitors: num('访客数'), buyers: num('支付买家数') ?? num('成交买家数'), average: num('客单价'), conversion: num('支付转化率') ?? num('成交转化率') });
      if(paid!=null && refund!=null && net!=null && Math.abs(paid-refund-net)>.005) data.issues.push({message:`${month}：支付减退款为 ${(paid-refund).toFixed(2)} 元，与钉钉净支付 ${net.toFixed(2)} 元不一致，请核对截图与统计口径，未自动修改`,source:`${table.name} / ${record.recordId}`});
    } else if (table.name === '利润表') {
      data.finance.push({ ...source, purchase: num('采购金额-人工填'), postage: num('邮费'), dropship: num('客户代发'), earnings: num('净利润') });
    } else if (table.scope === 'labor') {
      for (const suffix of ['', ' 1']) if (num(`工资金额${suffix}`) != null) data.labor.push({ ...source, id: source.id + suffix, date: scalar(value('日期')), item: scalar(value(`备注信息${suffix}`)) || '工资', amount: num(`工资金额${suffix}`), person: scalar(value(suffix ? '姓名2' : '姓名')), note: '按原记录日期归属，不分摊跨月工资' });
    }
  }
  data.issues.push({ message: '钉钉 AI 识别值与公式结果按原样保留；公式零值不代表已填报。工资、代发及邮费不擅自并入或修正原表净利润。', source: '钉钉数据口径' });
  return data;
}
export async function collectDingTalk(store, progress = () => {}, { call = dws, download = attachmentBytes } = {}) {
  progress('正在读取钉钉表格结构…');
  const info = await call(['drive','info','--node',DINGTALK_BASE]);
  if (info.result?.extension !== 'able') throw new Error('钉钉来源不是 AI 表格，未更新数据');
  const listing = await call(['aitable','+list-tables','--base',DINGTALK_BASE]);
  const tables = [], requests = [], assets = new Map();
  for (const item of listing.tables || []) {
    progress(`正在读取 ${item.tableName}…`);
    const fieldResult = await call(['aitable','+field-get','--base-id',DINGTALK_BASE,'--table-id',item.tableId]);
    const fields = (fieldResult.data?.fields || []).map(({fieldId,fieldName,type,config}) => ({fieldId,fieldName,type,config}));
    if (!fields.length) throw new Error('钉钉字段为空，未更新数据');
    const result = await call(['aitable','record','query','--base-id',DINGTALK_BASE,'--table-id',item.tableId,'--field-ids',fields.map(f=>f.fieldId).join(','),'--all','--page-limit','0']);
    if (!Array.isArray(result.data?.records) || result.data.nextCursor || result.data.hasMore) throw new Error('钉钉分页未完成，未更新数据');
    const scope = /淘宝|拼多多|京东/.test(item.tableName) ? 'sales' : item.tableName === '工资发放记录' ? 'labor' : item.tableName === '利润表' ? 'purchases' : 'expenses';
    const views = await call(['aitable','+view-get','--base-id',DINGTALK_BASE,'--table-id',item.tableId]);
    const view = views.views?.find(v=>v.viewType === 'Grid');
    if (!view) throw new Error('钉钉数据表缺少表格视图，未更新数据');
    const order = view.columns || fields.map(f=>f.fieldId);
    const table = { tableId: item.tableId, name: item.tableName, scope, fields: [...fields].sort((a,b)=>order.indexOf(a.fieldId)-order.indexOf(b.fieldId)), widths: view.custom?.widthMap || {}, records: [] };
    for (const record of result.data.records) {
      const sanitized = clean(record);
      for (const field of fields.filter(f=>f.type === 'attachment')) for (const [position, attachment] of (record.cells[field.fieldId] || []).entries()) {
        if (!attachment.resourceId || !attachment.url) throw new Error('钉钉凭证缺少标识或下载地址，未更新数据');
        requests.push({ key: `${item.tableId}:${record.recordId}:${field.fieldId}:${position}`, attachment, table, record: sanitized, fieldId: field.fieldId, position });
      }
      table.records.push(sanitized);
    }
    table.records.sort((a,b)=>recordMonth(a,fields).localeCompare(recordMonth(b,fields)) || a.recordId.localeCompare(b.recordId));
    tables.push(table);
  }
  if (!tables.length) throw new Error('钉钉没有返回数据表，未更新数据');
  let completed = 0;
  for (let i=0;i<requests.length;i+=4) await Promise.all(requests.slice(i,i+4).map(async request => {
    const cached = store.db.prepare('SELECT asset_id FROM business_dingtalk_assets WHERE resource_id=?').get(request.attachment.resourceId);
    const asset = cached ? store.asset(cached.asset_id) : await download(request.attachment.url);
    assets.set(asset.id, asset);
    request.record.cells[request.fieldId][request.position].assetId = asset.id;
    request.assetId = asset.id;
    completed++; progress(`正在保存图片凭证 ${completed}/${requests.length}…`);
  }));
  const years = [...new Set(tables.flatMap(t=>t.records.map(r=>recordMonth(r,t.fields).slice(0,4))).filter(Boolean))].map(Number);
  if (!years.length) throw new Error('钉钉记录中没有有效年份，未更新数据');
  const versions = [];
  for (const year of years) {
    const selected = tables.map(t=>({...t,records:t.records.filter(r=>!recordMonth(r,t.fields) || recordMonth(r,t.fields).startsWith(`${year}-`))}));
    const images = requests.filter(r=>!recordMonth(r.record,r.table.fields) || recordMonth(r.record,r.table.fields).startsWith(`${year}-`)).map(r=>{
      const table = selected.find(t=>t.tableId === r.table.tableId), index = table.records.findIndex(v=>v.recordId === r.record.recordId), month=recordMonth(r.record,r.table.fields);
      return { id:r.key, assetId:r.assetId, sheet:table.name, cell:`${columnName(table.fields.findIndex(f=>f.fieldId===r.fieldId))}${index+2}`, month, shop:table.scope==='sales'?table.name:null, label:r.table.fields.find(f=>f.fieldId===r.fieldId).fieldName, recordId:r.record.recordId, fieldId:r.fieldId, position:r.position };
    });
    const data = projectDingTalk(selected,year,images); data.hash=digest(JSON.stringify(data));
    versions.push(await store.commitDingTalk(data,[...assets.values()],requests.map(r=>({resourceId:r.attachment.resourceId,assetId:r.assetId}))));
  }
  return { years, versions, records:tables.reduce((n,t)=>n+t.records.length,0), images:requests.length };
}
export function columnName(index) { let name=''; for(index++;index;index=Math.floor((index-1)/26)) name=String.fromCharCode(65+(index-1)%26)+name; return name; }
