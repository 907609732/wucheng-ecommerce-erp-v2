(() => {
  const el = id => document.getElementById(id);
  const pages = {
    overview: ['经营总览', '年度经营情况'],
    sales: ['销售月报', '双击单元格修改，点击凭证核对'],
    purchases: ['采购管理', '采购记录与每月平台支出'],
    labor: ['人力费用', '日期明细与对应凭证'],
    expenses: ['邮费与代发','按原始记录查看截图凭证和金额'],
    checks: ['数据核对', '保留原表差异，核对后再修改'],
    images: ['全部凭证', '点击图片查看原图；业务表内也可直接核对']
  };
  let current = 'overview', report = null, overviewShop = '', month = '';
  const hasEditor = () => ['sales', 'purchases', 'labor','expenses'].includes(current);
  function show() {
    const editor = el('businessSheetView');
    const recordOnly = ['sales', 'labor','expenses'].includes(current);
    const destination = current === 'purchases' ? el('businessPurchaseEditorSlot') : el('businessContent');
    if (editor.parentElement !== destination) destination.append(editor);
    el(recordOnly ? 'businessTableMode' : 'businessAnalysisMode').click();
    if (current === 'purchases') {
      document.querySelector('[data-business-tab="purchases"]').click();
      editor.classList.remove('hidden');
    } else if (!recordOnly) document.querySelector(`[data-business-tab="${current}"]`).click();
    if (hasEditor()) window.businessSheetEditor.setScope(current);
    const annualSheet = current === 'purchases' && window.businessSheetEditor.isAnnualSheet();
    el('businessMonth').closest('label').classList.toggle('hidden', annualSheet || ['checks', 'images'].includes(current));
    el('businessShop').closest('label').classList.toggle('hidden', current !== 'overview');
    el('businessPageTitle').textContent = pages[current][0];
    el('businessPageHint').textContent = annualSheet ? '年度采购金额与结余按全年显示' : report?.source?.kind==='dingtalk' && hasEditor() ? '钉钉原表 · 截图凭证与数据逐行对应，修改后点击同步钉钉' : pages[current][1];
    document.querySelectorAll('[data-business-page]').forEach(b => {
      b.classList.toggle('active', b.dataset.businessPage === current);
      b.setAttribute('aria-current', b.dataset.businessPage === current ? 'page' : 'false');
    });
    el('businessExport').textContent = el('businessMonth').value && !annualSheet && !['checks', 'images'].includes(current) ? '导出本月' : '导出 Excel';
    if (report) window.businessSheetEditor.filterRecords(report, ['checks', 'images'].includes(current) ? '' : el('businessMonth').value);
    window.dispatchEvent(new Event('resize'));
  }
  function navigate(page) {
    const previous = current;
    if (previous === 'overview') overviewShop = el('businessShop').value;
    if (!['checks', 'images'].includes(previous)) month = el('businessMonth').value;
    current = page;
    const shop = current === 'overview' ? overviewShop : '';
    const nextMonth = ['checks', 'images'].includes(current) ? '' : month;
    const changed = el('businessShop').value !== shop || el('businessMonth').value !== nextMonth;
    el('businessShop').value = shop;
    el('businessMonth').value = nextMonth;
    show();
    document.querySelector('.business-export-menu').open = false;
    if (changed) el('businessRefresh').click();
  }
  document.querySelectorAll('[data-business-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.businessPage)));
  el('businessAllImages').addEventListener('click', () => navigate('images'));
  el('businessPurchaseStats').addEventListener('toggle', () => window.dispatchEvent(new Event('resize')));
  window.addEventListener('business:sheet', show);
  window.addEventListener('erp:view', event => { if (event.detail === 'business') show(); });
  window.businessWorkspace = { hasEditor, sync(value) { report = value; show(); } };
  show();
})();
