import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import coreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import filterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';

const channel = 'erp-purchase-sheet', pending = new Map(), el = id => document.getElementById(id);
let requestId = 0, workbook, state, subscription, busy = false, dirty = false, changes = 0, mounting = false;
let active = true, refreshVersion = 0, loadedVersion = 0;
// Facade events can arrive after mounting ends; consume only the mutations
// scheduled by our default filter, while keeping later user filter edits dirty.
const defaultFilterMutations = new Map();
const { univerAPI } = createUniver({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: mergeLocales(coreZhCN, filterZhCN) }, presets: [UniverSheetsCorePreset({ container: 'sheet', header: true, toolbar: true, formulaBar: true }), UniverSheetsFilterPreset()] });
const message = (text, error = false) => { el('status').textContent = text; el('status').classList.toggle('error', error); };
function controls() {
  el('save').disabled = busy || !workbook || state.readOnly || !dirty;
  for (const id of ['reload', 'export', 'history']) el(id).disabled = busy || !workbook;
  el('filter').disabled = busy || !workbook || state.readOnly;
}
function setDirty(value) { dirty = value; parent.postMessage({ channel, action: 'dirty', payload: value }, '*'); controls(); }
function changed() {
  if (mounting || state?.readOnly) return;
  changes++; setDirty(true); message(refreshVersion > loadedVersion ? '当前编辑已保留；保存表格后自动检查并补入新采集数据。' : '有未保存修改 · 点击「保存表格」或按 Ctrl+S');
}
function refreshIfSafe() {
  if (!active || busy || refreshVersion <= loadedVersion) return;
  // Newly appended source rows need saving, but are not an edited user draft.
  if (dirty && changes > 0) { message('有新采集数据，当前编辑已保留；保存表格后将自动补入。'); return; }
  void load({ automatic: true });
}
function request(action, payload) {
  return new Promise((resolve, reject) => {
    const id = ++requestId, timeout = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请检查软件运行状态；当前编辑仍保留')); }, 180000);
    pending.set(id, { resolve, reject, timeout }); parent.postMessage({ channel, id, action, payload }, '*');
  });
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.channel !== channel) return;
  if (event.data.action === 'imported') { refreshVersion++; refreshIfSafe(); return; }
  if (event.data.action === 'activate') {
    active = event.data.payload === true;
    // Recheck on returning to the data page, including imports while it was hidden.
    if (active) { refreshVersion++; refreshIfSafe(); }
    return;
  }
  const task = pending.get(event.data.id); if (!task) return;
  clearTimeout(task.timeout); pending.delete(event.data.id);
  if (event.data.error) task.reject(new Error(event.data.error)); else task.resolve(event.data.result);
});
function applyDefaultFilter() {
  if (!workbook || state.readOnly) return;
  try {
    const sheet = workbook.getActiveSheet();
    if (sheet.getFilter()) return;
    const data = workbook.save().sheets[sheet.getSheetId()];
    const rows = Math.max(1, ...Object.keys(data.cellData).map(Number)) + 1;
    const columns = Object.values(data.cellData).reduce((maximum, row) => Math.max(maximum, ...Object.keys(row || {}).map(Number)), 0) + 1;
    defaultFilterMutations.set('sheet.mutation.set-filter-range', (defaultFilterMutations.get('sheet.mutation.set-filter-range') || 0) + 1);
    const filter = sheet.getRange(0, 0, rows, columns).createFilter();
    if (!filter) return;
    const headerRow = data.cellData[0] || {};
    let statusCol = -1;
    for (const [col, cell] of Object.entries(headerRow)) if (String(cell?.v ?? '') === '订单状态') { statusCol = Number(col); break; }
    if (statusCol < 0) return;
    const values = new Set();
    for (const [rowIndex, row] of Object.entries(data.cellData)) {
      if (Number(rowIndex) === 0) continue;
      const cell = row?.[statusCol];
      if (cell && cell.v != null && cell.v !== '') values.add(String(cell.v));
    }
    // 默认只保留成功/进行中的订单状态，排除关闭、取消、退款、失败等。
    const keep = [...values].filter(value => !/关闭|取消|退款|失败|作废/.test(value));
    if (!keep.length) return;
    defaultFilterMutations.set('sheet.mutation.set-filter-criteria', (defaultFilterMutations.get('sheet.mutation.set-filter-criteria') || 0) + 1);
    filter.setColumnFilterCriteria(statusCol, { colId: statusCol, filters: { filters: keep } });
  } catch { /* 自动筛选失败不阻塞表格加载 */ }
}
async function load({ automatic = false } = {}) {
  if (busy) return;
  if (dirty && changes > 0 && (automatic || !window.confirm('刷新会放弃未保存的修改，并补入最新采集数据。建议先保存表格；是否继续刷新？'))) {
    if (!automatic) message('已取消刷新；请先保存表格，或确认放弃修改后再点刷新。');
    return;
  }
  const generation = changes, version = refreshVersion;
  busy = true; controls(); message('正在读取表格并补入新采集记录…');
  try {
    const next = await request('load');
    // A user can still type into the grid while IPC is in flight. Never replace
    // those newer edits with the response that was requested before they existed.
    if (generation !== changes) { refreshVersion = Math.max(refreshVersion, loadedVersion + 1); message('读取期间有新编辑，已保留；保存表格后将自动补入新数据。'); return; }
    loadedVersion = version;
    if (automatic && state && next.revision === state.revision && next.sourceKeys.length === state.sourceKeys.length && next.sourceKeys.every((key, index) => key === state.sourceKeys[index])) {
      message(`已载入 · 来源记录 ${state.sourceCount} 条${dirty ? ' · 请保存表格' : ''}`);
      return;
    }
    mounting = true; subscription?.dispose();
    if (workbook) univerAPI.disposeUnit(workbook.getId());
    state = next; workbook = univerAPI.createWorkbook(next.snapshot);
    if (next.readOnly) workbook.setEditable(false);
    // The workbook convenience listener omits execution options in this version.
    // Use the public global event so formula-engine cache updates are not user edits.
    subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, command => {
      if (command.params?.unitId !== workbook.getId() || command.options?.applyFormulaCalculationResult || command.options?.fromFormula) return;
      const expected = defaultFilterMutations.get(command.id) || 0;
      if (expected) { defaultFilterMutations.set(command.id, expected - 1); return; }
      if (command.id.startsWith('formula.mutation.') || ['sheet.mutation.re-calc-filter', 'sheet.mutation.mark-dirty-filter-change'].includes(command.id)) return;
      if (command.id.includes('.mutation.') && !/set-permission/.test(command.id)) changed();
    });
    // Snapshots can contain cached formula values from before source rows were
    // appended. Recalculate through the public facade after replacing the unit.
    univerAPI.getFormula().executeCalculation();
    applyDefaultFilter();
    changes = 0; setDirty(false); mounting = false;
    if (next.added && !next.readOnly) { setDirty(true); message(`已补入 ${next.added} 条新采集记录，共 ${next.sourceCount} 条来源记录；请保存表格。`); }
    else message(next.readOnly ? '客户端只读 · 请在主服务器编辑保存' : `已载入 · 来源记录 ${next.sourceCount} 条 · ${next.savedAt ? `版本 ${next.revision}` : '尚未保存'}`);
  } catch (error) { message(`载入失败：${error.message}`, true); }
  finally { mounting = false; busy = false; controls(); if (refreshVersion > version) refreshIfSafe(); }
}
async function save() {
  if (busy || !workbook || state.readOnly) return;
  busy = true; controls(); let savedSuccessfully = false;
  try {
    await workbook.endEditingAsync(true);
    const snapshot = workbook.save(), generation = changes;
    message('正在保存采购表格…');
    const saved = await request('save', { snapshot, sourceKeys: state.sourceKeys, revision: state.revision });
    Object.assign(state, saved);
    if (generation === changes) setDirty(false);
    savedSuccessfully = true;
    message(`已保存 · 版本 ${saved.revision} · ${new Date(saved.savedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}${dirty ? ' · 保存期间有新修改，请再次保存' : ''}`);
  } catch (error) { message(`保存失败：${error.message}`, true); }
  finally { busy = false; controls(); if (savedSuccessfully) refreshIfSafe(); }
}
el('save').addEventListener('click', save); el('reload').addEventListener('click', () => void load());
el('filter').addEventListener('click', async () => {
  try {
    await workbook.endEditingAsync(true);
    const sheet = workbook.getActiveSheet(), filter = sheet.getFilter();
    if (filter) filter.remove();
    else {
      const data = workbook.save().sheets[sheet.getSheetId()], rows = Math.max(1, ...Object.keys(data.cellData).map(Number)) + 1;
      const columns = Object.values(data.cellData).reduce((maximum, row) => Math.max(maximum, ...Object.keys(row || {}).map(Number)), 0) + 1;
      if (!sheet.getRange(0, 0, rows, columns).createFilter()) throw new Error('无法建立筛选，请先选择有表头的数据区域');
    }
  } catch (error) { message(`筛选失败：${error.message}`, true); }
});
el('export').addEventListener('click', async () => {
  if (busy || !workbook) return; busy = true; controls();
  try {
    await workbook.endEditingAsync(true); const result = await request('export', workbook.save());
    message(result.canceled ? '已取消导出；当前编辑仍保留' : `已导出 Excel${dirty ? '（含未保存编辑；请另行保存表格）' : ''}`);
  } catch (error) { message(`导出失败：${error.message}`, true); }
  finally { busy = false; controls(); refreshIfSafe(); }
});

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const savedAtText = iso => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '';
function renderDiff(container, result) {
  if (!result.changes.length) { container.innerHTML = `<p class="history-hint">版本 v${result.revision}（相对 v${result.previousRevision}）没有单元格修改。</p>`; return; }
  const rows = result.changes.map(c => {
    if (c.type === 'sheet-added' || c.type === 'sheet-removed') return `<tr><td>${escapeHtml(c.sheet)}</td><td colspan="4" class="history-sheet-change">${c.type === 'sheet-added' ? '新增工作表' : '删除工作表'}</td></tr>`;
    return `<tr><td>${escapeHtml(c.sheet)}</td><td>第 ${c.row} 行</td><td>${escapeHtml(c.column)}</td><td class="history-old">${escapeHtml(c.oldValue) || '<em>空</em>'}</td><td class="history-new">${escapeHtml(c.newValue) || '<em>空</em>'}</td></tr>`;
  }).join('');
  container.innerHTML = `<p class="history-diff-summary">版本 v${result.revision}（相对 v${result.previousRevision}）共修改 ${result.changes.length} 处：</p><div class="history-diff-scroll"><table class="history-diff-table"><thead><tr><th>工作表</th><th>位置</th><th>列</th><th>旧值</th><th>新值</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function showHistoryDialog(list) {
  document.getElementById('purchaseHistoryDialog')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'purchaseHistoryDialog';
  overlay.className = 'history-overlay';
  overlay.innerHTML = `<div class="history-dialog" role="dialog" aria-label="表格修改历史记录"><header class="history-dialog-header"><h3>表格修改历史记录</h3><button type="button" class="history-dialog-close" aria-label="关闭">×</button></header><div class="history-dialog-body"><aside class="history-versions"></aside><section class="history-diff"><p class="history-hint">选择左侧版本，查看该版本相对上一版本的修改。</p></section></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.history-dialog-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
  const versionsEl = overlay.querySelector('.history-versions');
  const diffEl = overlay.querySelector('.history-diff');
  for (const version of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'history-version' + (version.current ? ' current' : '');
    item.innerHTML = `<span class="history-version-label">${version.current ? '当前版本' : '版本'} v${version.revision}</span><span class="history-version-meta">${savedAtText(version.savedAt)} · ${version.changeCount} 处修改</span>`;
    item.addEventListener('click', async () => {
      versionsEl.querySelectorAll('.history-version').forEach(button => button.classList.remove('active'));
      item.classList.add('active');
      diffEl.innerHTML = '<p class="history-hint">正在加载差异…</p>';
      try { renderDiff(diffEl, await request('diff', version.revision)); }
      catch (error) { diffEl.innerHTML = `<p class="history-error">加载失败：${error.message}</p>`; }
    });
    versionsEl.appendChild(item);
  }
  if (!list.length) versionsEl.innerHTML = '<p class="history-hint">还没有保存记录。每次点击「保存表格」都会记录一个历史版本。</p>';
}
async function openHistory() {
  if (busy) return;
  busy = true; controls();
  try { showHistoryDialog(await request('history')); }
  catch (error) { message(`历史记录加载失败：${error.message}`, true); }
  finally { busy = false; controls(); }
}
el('history').addEventListener('click', openHistory);

document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); void save(); } }, true);
el('sheet').addEventListener('input', changed, true);
// Local integration-test/diagnostic facade, with no Node or IPC privileges.
window.purchaseSheet = { api: univerAPI, snapshot: () => workbook?.save(), dirty: () => dirty };
void load();
