(() => {
  const frame = document.getElementById('purchaseSheetFrame'), channel = 'erp-purchase-sheet';
  const collectTab = document.getElementById('purchaseCollectTab'), dataTab = document.getElementById('purchaseDataTab');
  let dirty = false;
  window.purchaseSheetEditor = { dirty: () => dirty };
  function select(data) {
    document.getElementById('purchaseCollection').classList.toggle('hidden', data);
    document.getElementById('purchaseDataPage').classList.toggle('hidden', !data);
    document.body.classList.toggle('purchase-data-open', data);
    for (const [tab, selected] of [[collectTab, !data], [dataTab, data]]) {
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; tab.classList.toggle('primary', selected);
    }
    if (data && !frame.getAttribute('src')) frame.src = 'purchase-sheet.html';
    else if (frame.getAttribute('src')) frame.contentWindow.postMessage({ channel, action: 'activate', payload: data }, '*');
  }
  collectTab.addEventListener('click', () => select(false)); dataTab.addEventListener('click', () => select(true));
  for (const tab of [collectTab, dataTab]) tab.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const data = event.key === 'End' || event.key !== 'Home' && tab === collectTab; select(data); (data ? dataTab : collectTab).focus(); }
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('message', async event => {
    if (event.source !== frame.contentWindow || event.data?.channel !== channel) return;
    const { id, action, payload } = event.data;
    if (action === 'dirty') { dirty = payload === true; void window.inventoryApp.setPurchaseWorkbookDirty(dirty).catch(error => console.error('采购表格状态同步失败：', error.message)); return; }
    const handlers = { load: () => window.inventoryApp.getPurchaseWorkbook(), save: () => window.inventoryApp.savePurchaseWorkbook(payload), export: () => window.inventoryApp.exportPurchaseWorkbook(payload), history: () => window.inventoryApp.listPurchaseWorkbookHistory(), diff: () => window.inventoryApp.diffPurchaseWorkbookRevision(payload) };
    if (!Object.hasOwn(handlers, action)) return;
    try { frame.contentWindow.postMessage({ channel, id, result: await handlers[action]() }, '*'); }
    catch (error) { frame.contentWindow.postMessage({ channel, id, error: error.message }, '*'); }
  });
  window.addEventListener('purchase:imported', () => { if (frame.getAttribute('src')) frame.contentWindow.postMessage({ channel, action: 'imported' }, '*'); });
})();
