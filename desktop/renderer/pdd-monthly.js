(() => {
  const api = window.inventoryApp, el = id => document.getElementById(id);
  let state = { state: 'idle', result: null }, grid, gridReady = false, opening = false, submitting = false, exporting = false, renderVersion = 0;
  const previous = new Date(); previous.setDate(1); previous.setMonth(previous.getMonth() - 1);
  el('pddMonthlyMonth').value = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = String(text); if (className) element.className = className; return element; };
  const money = value => Number.isSafeInteger(value) ? `${value < 0 ? '-' : ''}${Math.floor(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, '0')}` : '未提供';
  const month = () => { const value = el('pddMonthlyMonth').value; if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) throw Error('请选择有效的年份和月份'); return value; };
  const result = () => ['completed', 'idle'].includes(state.state) && state.result?.month === el('pddMonthlyMonth').value ? state.result : null;
  function message(text, error = false) { el('pddMonthlyStatus').textContent = text; el('pddMonthlyStatus').classList.toggle('error', error); }
  function controls() {
    const running = state.state === 'running', locked = running || opening || submitting || exporting, readOnly = state.readOnly === true;
    el('pddMonthlyMonth').disabled = locked;
    for (const id of ['pddMonthlyLogin', 'pddMonthlyStart']) el(id).disabled = locked || readOnly;
    el('pddMonthlyStop').disabled = !running;
    el('pddMonthlyExport').disabled = locked || readOnly || !result()?.id;
  }
  async function renderTable() {
    if (!gridReady) return;
    const version = ++renderVersion, snapshot = result();
    await grid.replaceData(snapshot?.orders || []);
    if (version !== renderVersion) return;
    if (!snapshot) {
      el('pddMonthlySummary').textContent = '当前月份没有已完成的采集结果；请点击读取，未读取不能当作零订单。';
      el('pddMonthlyResultInfo').textContent = '采集结果按整单展示，每笔订单下保留全部商品规格，金额不按规格重复累计。';
      return;
    }
    el('pddMonthlySummary').textContent = `${snapshot.month} · ${snapshot.orderCount} 笔订单 · ${snapshot.itemCount} 个商品分项 · 平台金额合计 ¥${money(snapshot.totalAmountCents)}（全部返回状态）`;
    el('pddMonthlyResultInfo').textContent = `买家账号：${snapshot.account} · 采集时间：${snapshot.collectedAt || '已完成'} · ${snapshot.orderCount === 0 ? '平台明确返回该月份无订单，可导出空表。' : '下方为本次采集结果；导出包含采购订单与商品规格两张表。'} 不写入 ERP 采购账本。`;
  }
  function apply(value) {
    state = value || { state: 'idle' }; controls();
    message(state.readOnly ? '客户端模式不执行本机采集；请在单机或主服务器使用此模块。' : state.message || '请选择月份并读取拼多多订单。', state.readOnly || ['failed', 'needs_login', 'needs_verification', 'needs_review'].includes(state.state));
    el('pddMonthlyLogs').textContent = (state.logs || []).map(entry => `[${entry.time}] ${entry.message}`).join('\n') || '等待操作…';
    void renderTable().catch(error => message(`表格显示失败：${error.message}`, true));
  }
  function mount() {
    if (grid) return;
    grid = new window.Tabulator('#pddMonthlyGrid', { index: 'id', height: 480, layout: 'fitColumns', placeholder: '请选择月份并读取订单', columnDefaults: { vertAlign: 'middle', resizable: true }, columns: [
      { title: '订单号 / 状态', field: 'orderId', minWidth: 220, width: 235, formatter: cell => { const order = cell.getData(), box = node('div', order.orderId); box.append(node('div', order.status || '状态未提供', 'pdd-secondary')); return box; } },
      { title: '北京时间 / 供应商', field: 'orderedAt', minWidth: 160, width: 185, formatter: cell => { const order = cell.getData(), box = node('div', order.orderedAt || '时间未提供'); box.append(node('div', order.supplier || '供应商未提供', 'pdd-secondary')); return box; } },
      { title: '商品 / 规格 · 数量 · 单价 · 商品金额', field: 'items', minWidth: 310, widthGrow: 2, variableHeight: true, headerSort: false, formatter: cell => { const box = node('div'); for (const item of cell.getValue() || []) { const line = node('div', `${item.item || '商品未提供'}${item.sku ? ' · ' + item.sku : ''}`, 'pdd-item'); line.append(node('div', `数量 ${item.quantity ?? '未提供'} ${item.unit || ''} · 单价 ¥${money(item.unitPriceCents)} · 商品金额 ¥${money(item.itemAmountCents)}`, 'pdd-secondary')); box.append(line); } return box; } },
      { title: '整单平台金额（元）', field: 'amountCents', minWidth: 150, width: 170, hozAlign: 'right', formatter: cell => node('strong', money(cell.getValue())) },
      { title: '运费 / 优惠（元）', field: 'freightCents', minWidth: 145, width: 150, formatter: cell => { const order = cell.getData(); return node('div', `运费 ${money(order.freightCents)} / 优惠 ${money(order.discountCents)}`); } },
      { title: '快递单号 / 待核对事项', field: 'note', minWidth: 200, widthGrow: 1, formatter: cell => { const order = cell.getData(), box = node('div', order.attributes?.trackingNumber || order.trackingNumber || '物流单号未提供'); if (order.note) box.append(node('div', order.note, 'pdd-secondary')); if (order.issues?.length) box.append(node('div', order.issues.join('；'), 'error')); return box; } }
    ] });
    grid.on('tableBuilt', () => { gridReady = true; void renderTable(); });
  }
  api.onPddMonthlyProgress?.(apply);
  el('pddMonthlyMonth').addEventListener('change', () => { controls(); void renderTable(); });
  el('pddMonthlyLogin').addEventListener('click', async () => {
    try { const input = { month: month() }; opening = true; controls(); message('正在打开独立拼多多采集窗口…'); await api.openPddMonthly(input); message('请在拼多多买家页面完成登录，再返回点击读取所选月份订单。'); }
    catch (error) { message(error.message, true); }
    finally { opening = false; controls(); }
  });
  el('pddMonthlyStart').addEventListener('click', async () => {
    try { const input = { month: month() }; submitting = true; state = { ...state, state: 'running', result: null }; controls(); await renderTable(); message('正在读取所选月份订单…'); apply(await api.startPddMonthly(input)); }
    catch (error) { state = { ...state, state: 'failed', result: null }; message(error.message, true); }
    finally { submitting = false; controls(); }
  });
  el('pddMonthlyStop').addEventListener('click', async () => { try { el('pddMonthlyStop').disabled = true; message('正在停止读取，请稍候…'); apply(await api.stopPddMonthly()); } catch (error) { message(error.message, true); } finally { controls(); } });
  el('pddMonthlyExport').addEventListener('click', async () => {
    try { const snapshot = result(); if (!snapshot?.id) throw Error('请先完成当前月份的采集'); exporting = true; controls(); const output = await api.exportPddMonthly({ id: snapshot.id }); message(output.canceled ? '已取消导出，采集结果仍保留。' : `已导出 ${snapshot.month}：${output.orderCount} 笔订单、${output.itemCount} 个商品分项。文件：${output.file}`); }
    catch (error) { message(error.message, true); }
    finally { exporting = false; controls(); }
  });
  window.addEventListener('erp:view', async event => {
    if (event.detail !== 'pdd-monthly') return;
    mount();
    try { apply(await api.getPddMonthlyState()); }
    catch (error) { message(`读取模块状态失败：${error.message}`, true); }
  });
})();
