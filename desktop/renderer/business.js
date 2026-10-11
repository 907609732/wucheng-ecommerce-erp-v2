(() => {
  const api = window.inventoryApp, el = id => document.getElementById(id);
  const format = v => v == null ? '未填报' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percent = v => v == null ? '未填报' : `${(Number(v) * 100).toFixed(2)}%`;
  const count = v => v == null ? '未填报' : Number(v).toLocaleString('zh-CN');
  let report, preview, busy = false, request = 0, activeTab = 'overview', mode = 'standalone';
  const grids = new Map(), charts = new Map(), images = new Map();
  const filters = () => ({ year: el('businessYear').value, month: el('businessMonth').value, shop: el('businessShop').value });
  function status(message, error = false) { el('businessStatus').textContent = message; el('businessStatus').classList.toggle('error', error); }
  function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
  function setBusy(value) {
    busy = value;window.businessSheetEditor?.setBusy(value);
    for (const id of ['businessDingTalkSync','businessImport', 'businessExport', 'businessExportAll', 'businessOriginal', 'businessTemplate', 'businessHistory', 'businessCommitImport', 'businessCancelImport', 'businessYear', 'businessMonth', 'businessShop', 'businessRefresh']) el(id).disabled = value || window.businessSheetEditor?.dirty();
    el('businessDingTalkSync').disabled=value || mode==='client' || window.businessSheetEditor?.dirty();
    el('businessImport').disabled = value || mode === 'client' || window.businessSheetEditor?.dirty(); el('businessHistory').disabled = value || mode === 'client' || window.businessSheetEditor?.dirty();
    if (window.businessWorkspace?.hasEditor() && !window.businessSheetEditor.ready()) el('businessExport').disabled = true;
  }
  async function operation(message, action) {
    if (busy) return;
    setBusy(true); status(message);
    try { await action(); } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  }
  el('businessOpenDingTalk').addEventListener('click',()=>api.openBusinessDingTalk().catch(e=>status(e.message,true)));
  api.onBusinessProgress(message=>{if(busy) status(message);});
  el('businessDingTalkSync').addEventListener('click',()=>operation('正在同步钉钉，首次同步会保存图片凭证…',async()=>{
    const result=await api.syncBusinessDingTalk();
    el('businessYear').replaceChildren(new Option(String(Math.max(...result.years)),String(Math.max(...result.years))));el('businessMonth').value='';el('businessShop').value='';await load();
    status(`同步完成：${result.records} 条记录、${result.images} 张凭证${result.versions.every(v=>v.unchanged)?'，数据无变化':''}。`);
  }));
  function grid(id, columns, rows) {
    grids.get(id)?.destroy(); el(id).replaceChildren();
    const compare = (a, b) => {
      const numeric = v => v !== '' && v !== '未填报' && Number.isFinite(Number(String(v).replace(/[,％%]/g, '')));
      return numeric(a) && numeric(b) ? Number(String(a).replace(/[,％%]/g, '')) - Number(String(b).replace(/[,％%]/g, '')) : String(a ?? '').localeCompare(String(b ?? ''), 'zh-CN');
    };
    const table = new gridjs.Grid({ columns: columns.map(name => ({ name, sort: { compare } })), data: rows, search: id !== 'businessPurchaseMonthlyGrid', sort: true, pagination: { limit: 12 }, language: { search: { placeholder: '搜索明细…' }, pagination: { previous: '上一页', next: '下一页', showing: '显示', results: '条', of: '共', to: '至' }, noRecordsFound: '没有符合条件的记录' }, style: { table: { width: '100%' } } });
    table.render(el(id)); grids.set(id, table);
  }
  function chart(id, option) {
    const instance = charts.get(id) || echarts.init(el(id)); charts.set(id, instance);
    instance.setOption({ textStyle: { fontFamily: 'Microsoft YaHei UI' }, ...option }, true);
  }
  function sum(rows, key) { const values = rows.filter(r => r[key] != null); return values.length ? Math.round(values.reduce((a, b) => a + b[key], 0) * 100) / 100 : null; }
  function render() {
    el('businessEmpty').classList.toggle('hidden', report.available);
    el('businessContent').classList.toggle('hidden', !report.available);
    if (!report.available) { status(mode === 'client' ? '主服务器尚未导入经营数据。' : '尚未导入经营数据。'); return; }
    const summary = el('businessSummary'); summary.replaceChildren();
    const secondary = el('businessSecondarySummary'); secondary.replaceChildren();
    for (const [key, label] of [['paid', '支付金额'], ['refund', '退款金额'], ['net', '净支付金额'], ['purchase', '采购支出'], ['labor', '人力明细费用'], ['originalLabor', '原表年度人力费用'], ['earnings', '原表收益'], ['balance', '原表年度结余']]) {
      const card = element('article', null, 'summary-card'); card.append(element('span', report.cloudLabels?.[key] || label), element('strong', format(report.summary[key]))); (['net', 'purchase', 'earnings', 'balance'].includes(key) ? summary : secondary).append(card);
    }
    el('businessSourceInfo').textContent = `${report.year} 年 · ${report.filename} · ${report.images.length} 张图片凭证${filters().shop ? ' · 公共费用不按店铺分摊' : ''}`;
    status('');
    grid('businessFinanceGrid', ['月份', '采购金额', '总邮费', '代发金额', '西施净收益', '原表收益'], report.finance.map(r => [r.month, ...['purchase', 'postage', 'dropship', 'xishi', 'earnings'].map(k => format(r[k]))]));
    grid('businessShopGrid', ['月份', '店铺', '支付金额', '退款金额', '净支付金额', '销量', '目标销售额', '目标完成率', '访客数', '转化率', '客单价', '扣款', '推广费', '原表净收益金额', '退货退款金额', '退款订单数', '退货订单率', '罚款', '技术服务费', '其他费用', '关注用户数', '成交买家数', '老买家占比', '停留时长'], report.monthly.map(r => [r.month, r.shop, format(r.paid), format(r.refund), format(r.net), count(r.quantity), format(r.target), percent(r.targetRate), count(r.visitors), percent(r.conversion), format(r.average), format(r.deduction), format(r.promotion), format(r.profit), format(r.returnRefund), count(r.returnOrders), percent(r.returnRate), format(r.penalty), format(r.service), format(r.other), count(r.followers), count(r.buyers), percent(r.oldBuyerRate), format(r.stay)]));
    grid('businessPurchaseGrid', ['月份', '日期', '采购物品', '金额', '平台', '备注', '来源'], report.purchases.map(r => [r.month, r.date, r.item, format(r.amount), r.platform, r.note, `${r.sourceSheet}!${r.sourceRow}`]));
    grid('businessLaborGrid', ['月份', '日期', '项目', '金额', '人员', '来源'], report.labor.map(r => [r.month, r.date, r.item, format(r.amount), r.person, `${r.sourceSheet}!${r.sourceRow}`]));
    const base = report.reconciliation.find(r => r.metric === '月报采购合计')?.amount;
    grid('businessCheckGrid', ['核对项目', '金额', '与月报采购差额'], report.reconciliation.map(r => [r.metric, format(r.amount), r.metric.includes('采购') && r.amount != null && base != null ? format(r.amount - base) : '—']));
    el('businessNotices').replaceChildren(...report.notices.map(n => element('p', `${n.message}（${n.source}）`, 'business-note')));
    const months = [...new Set(report.monthly.map(r => r.month))].sort();
    const common = { tooltip: { trigger: 'axis' }, legend: { bottom: 0 }, grid: { left: 60, right: 20, top: 25, bottom: 65 }, xAxis: { type: 'category', data: months.map(m => m.slice(5) + '月') }, yAxis: { type: 'value', name: '元' } };
    chart('businessTrend', { ...common, series: [['净支付', report.monthly, 'net'], ['采购', report.finance, 'purchase'], ['原表收益', report.finance, 'earnings']].map(([name, rows, key]) => ({ name, type: 'line', connectNulls: false, data: months.map(m => sum(rows.filter(r => r.month === m), key)) })) });
    const shops = [...new Set(report.monthly.map(r => r.shop))];
    chart('businessComparison', { tooltip: { trigger: 'axis' }, grid: { left: 120, right: 25, top: 20, bottom: 35 }, xAxis: { type: 'value', name: '元' }, yAxis: { type: 'category', data: shops }, series: [{ type: 'bar', itemStyle: { color: '#2c7a58' }, data: shops.map(shop => sum(report.monthly.filter(r => r.shop === shop), 'net')) }] });
    const platforms = [...new Set(report.purchases.map(r => r.platform || '未填写'))];
    const purchaseMonths = filters().month ? [filters().month] : Array.from({ length: 12 }, (_, i) => `${report.year}-${String(i + 1).padStart(2, '0')}`);
    const purchaseAmount = (month, platform) => {
      const rows = report.purchases.filter(r => r.month === month);
      if (!rows.length) return null;
      const selected = rows.filter(r => (r.platform || '未填写') === platform);
      return selected.length ? sum(selected, 'amount') : 0;
    };
    chart('businessPurchaseChart', { tooltip: { trigger: 'axis', valueFormatter: value => value == null ? '未填报' : `${format(value)} 元` }, legend: { type: 'scroll', bottom: 0 }, grid: { left: 75, right: 25, top: 25, bottom: 70 }, xAxis: { type: 'category', data: purchaseMonths.map(m => `${Number(m.slice(5))}月`), axisLabel: { interval: 0 } }, yAxis: { type: 'value', name: '元' }, series: platforms.map(platform => ({ name: platform, type: 'bar', stack: '采购支出', data: purchaseMonths.map(month => purchaseAmount(month, platform)) })) });
    grid('businessPurchaseMonthlyGrid', ['月份', ...platforms, '当月合计'], purchaseMonths.map(month => [month, ...platforms.map(platform => format(purchaseAmount(month, platform))), format(sum(report.purchases.filter(r => r.month === month), 'amount'))]));
    if(report.source?.kind==='dingtalk' && !report.purchases.length) {
      const values=purchaseMonths.map(month=>sum(report.finance.filter(r=>r.month===month),'purchase'));
      chart('businessPurchaseChart',{tooltip:{trigger:'axis'},grid:{left:75,right:25,top:25,bottom:45},xAxis:{type:'category',data:purchaseMonths.map(m=>Number(m.slice(5))+'月')},yAxis:{type:'value',name:'元'},series:[{name:'原表采购金额',type:'bar',data:values}]});
      grid('businessPurchaseMonthlyGrid',['月份','采购金额（钉钉原表）'],purchaseMonths.map((m,i)=>[m,format(values[i])]));
    }
    el('businessPurchaseStats').querySelector('summary').textContent=report.source?.kind==='dingtalk'?'查看每月采购支出（原表未提供平台明细）':'查看每月平台支出';
    el('businessImages').replaceChildren();
    if (activeTab === 'images') renderImages();
    resize();
  }
  async function load() {
    const sequence = ++request; status('正在读取经营数据…');
    try {
      const current = filters(), data = await api.getBusiness(current);
      if (sequence !== request) return;
      report = data;
      const shops=[...new Set(data.monthly.map(r=>r.shop))], selectedShop=el('businessShop').value;el('businessShop').replaceChildren(new Option('全部店铺',''),...shops.map(s=>new Option(s,s)));el('businessShop').value=selectedShop;
      if(data.source?.kind==='dingtalk') {const labels={net:'净支付金额',purchase:'采购金额（钉钉原表）',earnings:'净利润（钉钉原表）',balance:'年度结余（未提供）'};report.cloudLabels=labels;}
      el('businessYear').replaceChildren(...data.years.map(year => { const o = element('option', `${year} 年`); o.value = year; return o; }));
      el('businessYear').value = data.year || current.year;
      const month = current.month;
      el('businessMonth').replaceChildren(element('option', '全年'), ...Array.from({ length: 12 }, (_, i) => { const o = element('option', `${i + 1} 月`); o.value = `${data.year || current.year}-${String(i + 1).padStart(2, '0')}`; return o; }));
      el('businessMonth').options[0].value = ''; el('businessMonth').value = month;
      if (el('businessMonth').selectedIndex < 0) el('businessMonth').value = '';
      render();
      if (report.available) await window.businessSheetEditor?.load(report.year, mode);
      window.businessWorkspace?.sync(report);
    } catch (error) { if (sequence === request) { el('businessContent').classList.add('hidden'); status(`经营数据读取失败：${error.message}`, true); } }
  }
  function resize() { requestAnimationFrame(() => charts.forEach(c => c.resize())); }
  async function getImage(id) {
    if (!images.has(id)) images.set(id, api.getBusinessImage(id).catch(error => { images.delete(id); throw error; }));
    return images.get(id);
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      getImage(entry.target.dataset.asset).then(src => { entry.target.src = src; }).catch(error => { entry.target.alt = error.message; });
    }
  }, { rootMargin: '200px' });
  function renderImages() {
    observer.disconnect();
    const container = el('businessImages'); container.replaceChildren();
    for (const image of report.images) {
      const card = element('article', null, 'business-image-card'), button = element('button'), img = element('img');
      img.alt = image.label; img.dataset.asset = image.assetId;
      button.append(img); button.addEventListener('click', async () => {
        el('businessImageCaption').textContent = `${image.label} · ${image.sheet}!${image.cell}`;
        el('businessFullImage').removeAttribute('src'); el('businessImageDialog').showModal();
        try { const src = await getImage(image.assetId); if (el('businessImageCaption').textContent.startsWith(image.label)) el('businessFullImage').src = src; }
        catch (error) { el('businessImageCaption').textContent = error.message; }
      });
      card.append(button, element('p', image.label), element('p', `${image.sheet}!${image.cell}`)); container.append(card); observer.observe(img);
    }
    if (!report.images.length) container.append(element('p', '当前筛选没有图片凭证。'));
  }
  el('businessImport').addEventListener('click', () => operation('正在读取工作簿和图片，请稍候…', async () => {
    if (preview?.token) await api.cancelBusinessImport(preview.token);
    preview = await api.previewBusinessImport();
    if (preview.canceled) { status('已取消选择文件。'); return; }
    if (preview.duplicate) { status(preview.message); return; }
    const body = el('businessPreviewBody'); body.replaceChildren(element('p', `${preview.year} 年 · ${preview.imageCount} 个图片引用 · ${preview.uniqueImages} 个不同图片文件`), element('p', preview.replacing ? '确认后将替换该年度完整数据，旧版本保留，可在历史版本中恢复。' : '确认后建立该年度数据。'));
    const table = element('table'), header = element('tr');
    ['数据', '原记录', '新记录', '新增', '变更', '移除'].forEach(label => header.append(element('th', label))); table.append(header);
    for (const [key, label] of [['monthly', '店铺月报'], ['finance', '月度收支'], ['purchases', '采购明细'], ['labor', '人力费用']]) {
      const row = element('tr'); [label, ...['before', 'after', 'added', 'changed', 'removed'].map(k => preview.diff[key][k])].forEach(v => row.append(element('td', String(v)))); table.append(row);
    }
    body.append(table, element('p', `原表收益 ${format(preview.summary.earnings)} 元；原表年度结余 ${format(preview.summary.balance)} 元。`));
    for (const item of preview.reconciliation) body.append(element('p', `${item.metric}：${format(item.amount)} 元`, 'business-note'));
    for (const item of preview.issues) body.append(element('p', item.message, 'business-note'));
    el('businessPreview').showModal(); status('请核对导入预览。');
  }));
  el('businessCommitImport').addEventListener('click', () => operation('正在保存年度数据…', async () => {
    const result = await api.commitBusinessImport({ token: preview.token, previousVersionId: preview.previousVersionId });
    preview = null; el('businessPreview').close(); el('businessYear').replaceChildren(new Option(String(result.year), String(result.year))); el('businessMonth').value = ''; el('businessShop').value = ''; await load();
  }));
  async function cancelPreview() {
    if (busy) return;
    await operation('正在取消导入…', async () => { if (preview?.token) await api.cancelBusinessImport(preview.token); preview = null; el('businessPreview').close(); status('已取消导入，原有数据未变更。'); });
  }
  el('businessCancelImport').addEventListener('click', cancelPreview);
  el('businessPreview').addEventListener('cancel', event => { event.preventDefault(); cancelPreview(); });
  for (const [id, type, all] of [['businessExport', 'data', false], ['businessExportAll', 'data', true], ['businessOriginal', 'original', true], ['businessTemplate', 'template', true]]) {
    el(id).addEventListener('click', () => operation('正在准备导出文件和图片，请稍候…', async () => {
      const actualType = id === 'businessExport' && window.businessWorkspace?.hasEditor() && (!filters().month || window.businessSheetEditor.isAnnualSheet()) ? 'sheet' : type;
      const result = await api.exportBusiness({ type: actualType, filters: all ? { year: el('businessYear').value } : filters() });
      status(result.canceled ? '已取消导出。' : `已保存：${result.filename}`); document.querySelector('.business-export-menu').open = false;
    }));
  }
  el('businessHistory').addEventListener('click', () => operation('正在读取历史版本…', async () => {
    const versions = await api.getBusinessVersions(), container = el('businessVersionList'); container.replaceChildren();
    for (const v of versions) {
      const row = element('div', null, 'business-version'), button = element('button', v.active ? '当前版本' : '恢复此版本'); button.disabled = Boolean(v.active);
      row.append(element('span', `${v.year} 年 · ${v.filename} · ${new Date(v.createdAt).toLocaleString('zh-CN')}`), button); container.append(row);
      button.addEventListener('click', () => operation('正在恢复年度版本…', async () => {
        if (!window.confirm(`将 ${v.year} 年数据切换为此版本？当前版本仍会保留。`)) return;
        button.disabled = true;
        try { await api.restoreBusinessVersion(v.id); el('businessHistoryDialog').close(); el('businessYear').replaceChildren(new Option(String(v.year), String(v.year))); el('businessMonth').value = ''; await load(); }
        finally { button.disabled = false; }
      }));
    }
    if (!versions.length) container.append(element('p', '尚无已导入版本。'));
    el('businessHistoryDialog').showModal(); status('历史版本只切换当前数据，不删除原文件。');
  }));
  el('businessCloseHistory').addEventListener('click', () => el('businessHistoryDialog').close());
  el('businessCloseImage').addEventListener('click', () => { el('businessImageDialog').close(); el('businessFullImage').removeAttribute('src'); });
  el('businessRefresh').addEventListener('click', load);
  window.addEventListener('business:saved', async () => { setBusy(false); await load(); });
  window.addEventListener('business:dirty', () => setBusy(busy));
  ['businessYear', 'businessMonth', 'businessShop'].forEach(id => el(id).addEventListener('change', () => { if (id === 'businessYear') el('businessMonth').value = ''; load(); }));
  document.querySelectorAll('[data-business-tab]').forEach(button => button.addEventListener('click', () => {
    activeTab = button.dataset.businessTab;
    document.querySelectorAll('[data-business-tab]').forEach(b => b.classList.toggle('active', b === button));
    document.querySelectorAll('[data-business-section]').forEach(section => section.classList.toggle('hidden', section.dataset.businessSection !== activeTab));
    if (activeTab === 'images' && report?.available) renderImages(); resize();
  }));
  window.addEventListener('erp:view', async event => {
    if (event.detail !== 'business') return;
    try {
      mode = (await api.getSettings()).runtimeMode; setBusy(busy);
      el('businessEmptyHelp').textContent = mode === 'client' ? '请在主服务器导入，客户端刷新后即可查看。' : '在右上角“数据管理”选择“导入 Excel”，预览后保存。';
      await load();
    } catch (error) { status(error.message, true); }
  });
  window.addEventListener('resize', resize);
})();
