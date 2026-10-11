(() => {
  const api = window.inventoryApp, el = id => document.getElementById(id);
  let preview = null, loading = false, autoState = null, autoCommitHandled = false;
  let backendLogs = [], localLogs = [];
  function renderLogs() {
    const panel = el('purchaseLogs'), follow = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 50;
    panel.textContent = [...backendLogs, ...localLogs].sort((a,b) => a.time.localeCompare(b.time)).slice(-350).map(entry => `[${new Date(entry.time).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}] [${entry.level === 'error' ? '错误' : entry.level === 'warning' ? '提醒' : '进度'}] ${entry.message}`).join('\n') || '等待操作…';
    if (follow) panel.scrollTop = panel.scrollHeight;
  }
  function localLog(message, level = 'info') { localLogs = [...localLogs, { time: new Date().toISOString(), level, message }].slice(-50); renderLogs(); }
  const previous = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  el('purchaseMonth').value = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
  function syncDates() {
    const month = el('purchaseMonth').value;
    if (!month) return;
    el('purchaseStart').value = `${month}-01`;
    el('purchaseEnd').value = `${month}-${new Date(Number(month.slice(0,4)), Number(month.slice(5)), 0).getDate()}`;
  }
  syncDates();
  const money = value => value == null ? '—' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const status = (message, error = false) => { el('purchaseStatus').textContent = message; el('purchaseStatus').classList.toggle('error', error); if (error) localLog(message, 'error'); };
  const selectedMonth = () => el('purchaseMonth').value;
  async function load() {
    if (loading) return; loading = true;
    try {
      const report = await api.getPurchaseCollection({ month: selectedMonth(), startDate: el('purchaseStart').value, endDate: el('purchaseEnd').value });
      el('purchaseCollectionSummary').textContent = report.count ? `已入库 ${report.count} 条采购明细，实付合计 ¥${money(report.total)}；平台：${report.platforms.join('、')}。` : '当前筛选尚无平台采购导出数据。';
    } catch (error) { status(`读取采购数据失败：${error.message}`, true); }
    finally { loading = false; }
  }
  function currentMeta(requireAccount = false) {
    const account = autoState?.identities?.[el('purchasePlatform').value]?.account || '';
    if (requireAccount && !account) throw new Error('请先打开采集窗口登录，自动识别账号ID后再导入文件。');
    const startDate = el('purchaseStart').value, endDate = el('purchaseEnd').value;
    if (!startDate || !endDate || startDate > endDate) throw new Error('请选择有效的起止日期');
    return { month: startDate.slice(0,7), startDate, endDate, platform: el('purchasePlatform').value, account, accountLabel: account };
  }
  el('purchaseOpenPlatform').addEventListener('click', async () => { try { await api.openPurchasePlatform(el('purchasePlatform').value); status('已打开平台后台。请自行扫码登录、筛选一个自然月并导出订单文件；完成后返回此处导入。'); } catch (error) { status(error.message, true); } });
  function showPreview(result) {
      if (result.canceled) return;
      if (result.duplicate) { status(result.message); return; }
      preview = result; const body = el('purchasePreviewBody'); body.replaceChildren();
      body.append(Object.assign(document.createElement('p'), { textContent: `${result.platform} · ${result.account} · ${result.month}` }), Object.assign(document.createElement('p'), { textContent: `有效明细 ${result.rows} 条，实付合计 ¥${money(result.total)}；其中与已入库数据重复 ${result.duplicates} 条，确认后将自动跳过。` }));
      if (result.ignored) body.append(Object.assign(document.createElement('p'), { className: 'business-note', textContent: `另有 ${result.ignored} 行缺少订单号、商品或实付款，未纳入本次入库。` }));
      if (result.excluded) body.append(Object.assign(document.createElement('p'), { className: 'business-note', textContent: `另有 ${result.excluded} 行不在所选时间内，已排除。` }));
      const table = document.createElement('table'), head = document.createElement('tr'); ['订单号', '下单时间', '商品', '供应商', '实付款', '状态'].forEach(text => { const th = document.createElement('th'); th.textContent = text; head.append(th); }); table.append(head);
      for (const row of result.sample) { const tr = document.createElement('tr'); [row.orderId, row.orderedAt, row.item, row.supplier, money(row.paidAmount), row.status].forEach(value => { const td = document.createElement('td'); td.textContent = value || '—'; tr.append(td); }); table.append(tr); } body.append(table); el('purchasePreview').showModal(); status('请核对导入预览；确认后才会写入本地采购台账。');
  }
  el('purchaseImport').addEventListener('click', async () => { try { if (preview?.token) { el('purchasePreview').showModal(); return; } showPreview(await api.previewPurchaseImport(currentMeta(true))); } catch (error) { status(error.message, true); } });
  // —— 手动添加散单 ——
  function recomputeManual() {
    const quantity = Number(el('manualQuantity').value) || 0;
    const price = Number(el('manualUnitPrice').value) || 0;
    const freight = Number(el('manualFreight').value) || 0;
    const discount = Number(el('manualDiscount').value) || 0;
    if (!el('manualItemAmount').dataset.manual) el('manualItemAmount').value = quantity && price ? (quantity * price).toFixed(2) : '';
    if (!el('manualPaid').dataset.manual) el('manualPaid').value = ((Number(el('manualItemAmount').value) || 0) + freight - discount).toFixed(2);
  }
  for (const id of ['manualQuantity', 'manualUnitPrice', 'manualFreight', 'manualDiscount']) el(id).addEventListener('input', recomputeManual);
  for (const id of ['manualItemAmount', 'manualPaid']) el(id).addEventListener('input', () => { el(id).dataset.manual = '1'; });
  el('purchaseManualAdd').addEventListener('click', () => { if (preview?.token) { el('purchasePreview').showModal(); status('上一份预览尚未处理，请先确认或取消。', true); return; } if (!el('manualDate').value) el('manualDate').value = (el('purchaseMonth').value || '') ? `${el('purchaseMonth').value}-01` : new Date().toISOString().slice(0, 10); el('purchaseManualDialog').showModal(); });
  el('manualCancel').addEventListener('click', () => el('purchaseManualDialog').close());
  el('purchaseManualForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const date = el('manualDate').value, platform = el('manualPlatform').value.trim();
      if (!date || !platform) { status('请填写采购日期和来源平台。', true); return; }
      const account = el('manualAccount').value.trim() || platform;
      const row = {
        '订单号': `线下-${date.replace(/-/g, '')}-${String(Date.now()).slice(-6)}`,
        '下单时间': `${date} 00:00:00`,
        '商品名称': el('manualItem').value.trim(),
        '规格': el('manualSku').value.trim(),
        '数量': Number(el('manualQuantity').value) || 1,
        '单价': Number(el('manualUnitPrice').value) || 0,
        '商品金额': Number(el('manualItemAmount').value) || 0,
        '运费': Number(el('manualFreight').value) || 0,
        '优惠': Number(el('manualDiscount').value) || 0,
        '实付款': Number(el('manualPaid').value) || 0,
        '供应商': el('manualSupplier').value.trim(),
        '订单状态': el('manualStatus').value,
        '快递单号': el('manualTracking').value.trim(),
        '备注': el('manualRemark').value.trim(),
      };
      const result = await api.manualPreviewPurchase([row], { platform, account, accountLabel: account, month: date.slice(0, 7), startDate: date, endDate: date });
      el('purchaseManualDialog').close();
      showPreview(result);
    } catch (error) { status(error.message, true); }
  });
  function renderAuto(state) {
    autoState = state;
    el('purchaseAccount').value = state.identities?.[el('purchasePlatform').value]?.account || '';
    backendLogs = state.logs || []; renderLogs();
    const notice = state.accountNotices?.[el('purchasePlatform').value];
    el('purchaseAutoStatus').textContent = state.state === 'idle' && notice ? notice.message : state.message;
    el('purchaseAutoStatus').classList.toggle('error', ['failed', 'needs_review', 'needs_login', 'needs_verification'].includes(state.state) || state.state === 'idle' && notice && notice.state !== 'ready');
    const running = state.state === 'running';
    if (running) autoCommitHandled = false;
    if (state.state === 'completed' && state.autoCommitted && !autoCommitHandled) { autoCommitHandled = true; window.dispatchEvent(new Event('purchase:imported')); load(); }
    for (const id of ['purchaseAuto','purchaseBackfill','purchaseLogin','purchaseImport','purchasePlatform','purchaseAccount','purchaseMonth','purchaseStart','purchaseEnd','purchaseBackfillYear']) el(id).disabled = running;
    el('purchaseStop').disabled = !running;
    if (state.state === 'preview' && state.preview?.token && !el('purchasePanel').classList.contains('hidden') && preview?.token !== state.preview.token) showPreview(state.preview);
  }
  api.onPurchaseProgress(renderAuto);
  el('purchaseLogin').addEventListener('click', async () => { el('purchaseLogin').disabled = true; localLog('已点击打开采集窗口，正在检查参数并提交请求…'); try { await api.openPurchaseAuto(currentMeta()); status('请在采集窗口核对当前账号并完成登录，然后返回点击自动采集。'); } catch (error) { status(error.message,true); } finally { el('purchaseLogin').disabled = autoState?.state === 'running'; } });
  el('purchaseAuto').addEventListener('click', async () => { localLog('已点击自动采集，正在检查日期…'); try { if (preview?.token) { el('purchasePreview').showModal(); localLog('上一份预览尚未处理，请先确认或取消。', 'warning'); return; } const meta = currentMeta(); el('purchaseAuto').disabled = true; el('purchaseAutoStatus').textContent = '正在提交采集请求…'; renderAuto(await api.startPurchaseAuto(meta)); } catch (error) { status(error.message,true); } finally { el('purchaseAuto').disabled = autoState?.state === 'running'; } });
  el('purchaseBackfill').addEventListener('click', async () => { localLog('已点击补齐缺失月份，正在检查年份…'); try { if (preview?.token) { el('purchasePreview').showModal(); localLog('上一份预览尚未处理，请先确认或取消。', 'warning'); return; } const year = Number(el('purchaseBackfillYear').value) || new Date().getFullYear(); const platform = el('purchasePlatform').value; el('purchaseBackfill').disabled = true; el('purchaseAutoStatus').textContent = '正在补齐缺失月份…'; renderAuto(await api.backfillPurchaseMonths({ year, platform })); } catch (error) { status(error.message, true); } finally { el('purchaseBackfill').disabled = autoState?.state === 'running'; } });
  el('purchaseExportYearly').addEventListener('click', async () => { try { const year = Number(el('purchaseBackfillYear').value) || new Date().getFullYear(); const result = await api.exportYearlyPurchase(year); status(result.canceled ? '已取消导出。' : `已导出 ${year} 年采购明细：${result.months?.length || 0} 个月、${result.rows} 条。`); } catch (error) { status(error.message, true); } });
  async function loadOperations() {
    try {
      const ops = await api.getPurchaseOperations(100);
      el('purchaseOperations').textContent = ops.length ? ops.map(op => `[${new Date(op.createdAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}] [${op.opType === 'import' ? '导入' : op.opType === 'rollback' ? '撤回' : op.opType}] ${op.detail}`).join('\n') : '暂无操作记录';
    } catch (error) { el('purchaseOperations').textContent = `读取失败：${error.message}`; }
  }
  el('purchaseRollback').addEventListener('click', async () => {
    if (!window.confirm('确认撤回最近一次入库？该批次对应的采购明细将从台账中移除（操作会记录，可再次采集恢复）。')) return;
    try { const result = await api.rollbackLastPurchase(); status(`已撤回：移除 ${result.removed} 条（${result.month}）。`); window.dispatchEvent(new Event('purchase:imported')); await load(); await loadOperations(); } catch (error) { status(error.message, true); }
  });
  el('purchaseRefreshOps').addEventListener('click', () => loadOperations().catch(error => status(error.message, true)));
  el('purchaseCopyLogs').addEventListener('click', async () => { try { await navigator.clipboard.writeText(el('purchaseLogs').textContent); status('日志已复制，可以粘贴给我排查。'); } catch (error) { status(`复制失败：${error.message}`, true); } });
  el('purchaseOpenLogs').addEventListener('click', async () => { try { await api.openPurchaseLogs(); } catch (error) { status(error.message, true); } });
  el('purchaseStop').addEventListener('click', async () => { try { renderAuto(await api.stopPurchaseAuto()); } catch (error) { status(error.message,true); } });
  async function cancel() { if (preview?.token) await api.cancelPurchaseImport(preview.token); preview = null; el('purchasePreview').close(); status('已取消，本地采购台账未改动。'); }
  el('purchaseCancelImport').addEventListener('click', () => cancel().catch(error => status(error.message, true)));
  el('purchasePreview').addEventListener('cancel', event => { event.preventDefault(); cancel().catch(error => status(error.message, true)); });
  el('purchaseCommitImport').addEventListener('click', async () => { try { const result = await api.commitPurchaseImport(preview?.token); preview = null; el('purchasePreview').close(); status(`已入库 ${result.inserted} 条，跳过重复 ${result.skipped} 条；可切换到「数据查看 / 表格」查看。`); window.dispatchEvent(new Event('purchase:imported')); await load(); await loadOperations(); } catch (error) { status(error.message, true); } });
  el('purchaseMonth').addEventListener('change', () => { syncDates(); load(); });
  el('purchasePlatform').addEventListener('change', () => { el('purchaseAccount').value = autoState?.identities?.[el('purchasePlatform').value]?.account || ''; });
  for (const id of ['purchaseStart', 'purchaseEnd']) el(id).addEventListener('change', load);
  window.addEventListener('erp:view', async event => { if (event.detail === 'purchase') { load(); loadOperations().catch(() => {}); try { renderAuto(await api.getPurchaseAutoState()); } catch (error) { status(error.message,true); } } });
  loadOperations().catch(() => {});
})();
