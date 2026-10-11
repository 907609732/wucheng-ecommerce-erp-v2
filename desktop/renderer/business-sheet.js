(() => {
  const api = window.inventoryApp, el = id => document.getElementById(id);
  let snapshot = null, currentSheet = '', currentView = '', renderedSheet = '', mode = 'standalone', tables = [], selected = null, loading = 0, saving = false, tableMode = true;
  const draft = new Map(), imageCache = new Map(), viewState = new Map();
  let scope = 'sales', filteredRows = null, activeMonth='',processing=false;
  const redrawTables = () => tables.filter(t => t.businessReady).forEach(t => t.redraw(true));
  const scopeNames = { sales: ['店铺的销售额具体内容月报', '店铺月报'], purchases: ['2025采购信息', '采购明细', '年度采购金额', '结余', '月度收支', '原表汇总'], labor: ['人力费用', '人力明细'] };
  const isAnnualSheet = () => ['年度采购金额', '结余', '月度收支', '原表汇总'].includes(currentSheet);
  const scopedSheets = () => {
    if (snapshot?.cloud) return sheets().filter(s => s.scope === scope).map(s=>({...s,viewId:s.name}));
    const result = sheets().filter(s => scope === 'all' ? !['看板说明', '数据核对'].includes(s.name) : scopeNames[scope]?.includes(s.name)).map(s=>({...s,viewId:s.name}));
    const source=sheets().find(s=>s.name==='店铺的销售额具体内容月报');
    if(source && scope==='sales') return ['店口五金店-淘宝','店口五金店-拼多多','西施五金-淘宝'].map((title,index)=>({...source,title,viewId:`sales-${index}`}));
    if(source && scope==='expenses') return ['邮费','客户代发收款记录'].map((title,index)=>({...source,title,viewId:`expenses-${index}`}));
    return result;
  };
  const key = (sheet, cell) => `${sheet}!${cell}`;
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const colName = i => { let name = ''; for (i++; i; i = Math.floor((i - 1) / 26)) name = String.fromCharCode(65 + (i - 1) % 26) + name; return name; };
  const colIndex = name => [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const getCell = (sheet, address) => sheet.cells.find(c => c.cell === address);
  const sheets = () => snapshot?.sheets || [];
  function state() {
    el('businessSaveCells').disabled = !draft.size || !snapshot || saving || (mode === 'client' || snapshot?.cloud);
    el('businessDiscardCells').disabled = !draft.size || saving;
    el('businessDirtyState').textContent = saving ? '正在保存…' : draft.size ? `${draft.size} 个单元格未保存` : (mode === 'client' || snapshot?.cloud) ? (snapshot?.cloud ? '钉钉来源 · 请在钉钉修改后同步' : '客户端只读，请在主服务器编辑') : '已保存';
    el('businessFormulaBar').disabled = !snapshot || saving || (mode === 'client' || snapshot?.cloud); el('businessApplyCell').disabled = !snapshot || saving || (mode === 'client' || snapshot?.cloud);
    el('businessExportSheet').disabled = !snapshot || saving || Boolean(draft.size);
    el('businessSheetHelp').textContent = snapshot?.cloud ? '钉钉数据 · 点击凭证放大' : '双击修改 · 点击凭证放大';
    el('businessDraftActions').classList.toggle('hidden', !draft.size && !saving);
    window.dispatchEvent(new CustomEvent('business:dirty'));
  }
  function display(c, input) {
    if (input !== undefined) return input;
    if (!c || c.value == null || c.formula?.includes('DISPIMG')) return '';
    if (typeof c.value === 'number' && (/[ymd]/i.test((c.format || '').replace(/"[^"]*"/g, '')) || /^A\d+$/.test(c.cell) && ['店铺的销售额具体内容月报', '年度采购金额'].includes(c.sheet) && c.value > 40000 && c.value < 70000)) return new Date(Date.UTC(1899, 11, 30) + c.value * 86400000).toISOString().slice(0, 10);
    if (typeof c.value === 'number' && c.format?.includes('%')) return `${(c.value * 100).toFixed(2)}%`;
    return String(c.value);
  }
  async function picture(image, img) {
    if (!imageCache.has(image.assetId)) imageCache.set(image.assetId, api.getBusinessImage(image.assetId).catch(e => { imageCache.delete(image.assetId); throw e; }));
    try { const src = await imageCache.get(image.assetId); img.src = src; }
    catch (error) { img.alt = error.message; }
  }
  const observer = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); picture(JSON.parse(e.target.dataset.image), e.target); }
  }, { rootMargin: '100px' });
  function imageCell(image) {
    const button = node('button', null, 'sheet-proof'), img = node('img');
    button.type = 'button'; button.title = `${image.label}（${image.sheet}!${image.cell}）`; img.alt = '数据凭证'; img.dataset.image = JSON.stringify(image); button.append(img);
    observer.observe(img);
    button.addEventListener('click', async event => {
      event.stopPropagation();
      el('businessImageCaption').textContent = `${image.label} · ${image.sheet}!${image.cell}`;
      el('businessFullImage').removeAttribute('src'); el('businessImageDialog').showModal();
      await picture(image, el('businessFullImage'));
    });
    return button;
  }
  function edit(cell, input) {
    if ((mode === 'client' || snapshot?.cloud) || saving || processing || !snapshot) return;
    const sheet = sheets().find(s => s.name === currentSheet), address = `${cell.getField()}${cell.getRow().getData()._row}`;
    const original = getCell(sheet, address), initial = original?.formula ? `=${original.formula}` : display(original);
    if (input === initial) draft.delete(key(currentSheet, address));
    else draft.set(key(currentSheet, address), { sheet: currentSheet, cell: address, input });
    cell.getElement().classList.toggle('sheet-dirty', draft.has(key(currentSheet, address)));
    if (selected?.address === address) el('businessFormulaBar').value = input;
    state();
  }
  function customEditor(cell, onRendered, success, cancel) {
    const sheet = sheets().find(s => s.name === currentSheet), address = `${cell.getField()}${cell.getRow().getData()._row}`, c = getCell(sheet, address);
    const input = node('input'); input.className = 'sheet-cell-editor'; input.value = draft.get(key(currentSheet, address))?.input ?? (c?.formula ? `=${c.formula}` : display(c));
    let ended = false;
    const done = () => { if (!ended) { ended = true; success(input.value); } };
    onRendered(() => { input.focus(); input.select(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(); } if (e.key === 'Escape') { ended = true; cancel(); } });
    input.addEventListener('blur', done); return input;
  }
  function specs(sheet) {
    if (sheet.name === '店铺的销售额具体内容月报') {
      if(scope==='expenses') return [{title:currentView==='expenses-0'?'邮费':'客户代发收款记录',header:2,start:3,end:15,groups:[['',currentView==='expenses-0'?['A','AP','AQ','AR','AS','AT','AU']:['A','AX','AW']]]}];
      return [
      { title:'店口五金店-淘宝',header:2,start:3,end:15,groups:[['',['A','B','D','F','E','J','K','G','H','I','L','M','N','O','P','Q','R']]] },
      { title:'店口五金店-拼多多',header:2,start:3,end:15,groups:[['',['A','S','T','V','U','W','X','Y','Z','AA','AB','AC','AD','AE','AF','AG','AH','AI','AJ','AK','AL','AM','AN']]] },
      { title:'西施五金-淘宝',header:20,start:21,end:33,groups:[['',['A','B','D','F','E','G','H','I','J','K','L','M','N','O','P','Q']]] }
      ].filter((_,index)=>currentView===`sales-${index}`);
    }
    if (sheet.name === '人力费用') return [
      { title: '原表工资说明与凭证（与下方日期明细为重复展示，不重复计费）', header: 1, start: 2, end: 12, groups: [['工资与凭证', ['A','C','B','D']], ['其他人力费用', ['E','F','G','H']]] },
      { title: '按日期记录的人力费用', header: 14, start: 15, end: 23, groups: [['工资', ['A','B','D']], ['小时工', ['E','F','G','H']], ['代发费用', ['I','J','K','L','M']]] }
    ];
    const used = [...sheet.cells.filter(c => c.value != null || c.formula), ...sheet.images].map(c => ({ row: Number(c.cell.replace(/\D/g, '')), col: c.cell.replace(/\d/g, '') }));
    const maxRow = Math.max(2, ...used.map(c => c.row)), maxCol = Math.max(0, ...used.map(c => colIndex(c.col)));
    return [{ title: sheet.name, header: 1, start: 2, end: maxRow, groups: [[sheet.name, Array.from({ length: maxCol + 1 }, (_, i) => colName(i))]] }];
  }
  function remember() {
    if (tables.length && tables.every(t => t.businessReady)) viewState.set(renderedSheet, tables.map(t => ({ sorters: t.getSorters().map(s => ({ column: s.field, dir: s.dir })), filters: t.getHeaderFilters() })));
  }
  function render() {
    remember(); observer.disconnect(); tables.forEach(t => { t.businessReady = false; t.destroy(); }); tables = []; selected = null;
    el('businessFormulaBar').value = ''; el('businessCellAddress').textContent = '请选择单元格';
    const sheet = scopedSheets().find(s => s.viewId === currentView) || scopedSheets()[0]; if (!sheet) {el('businessSheetTables').replaceChildren(node('p','该年度尚无此类数据','business-note'));el('businessSheetTabs').replaceChildren();return;}
    currentSheet=sheet.name;currentView=sheet.viewId;renderedSheet = currentView;
    const host = el('businessSheetTables'); host.replaceChildren();
    el('businessSheetTabs').classList.toggle('hidden', scopedSheets().length < 2);
    el('businessSheetTabs').replaceChildren(...scopedSheets().map(s => {
      const b = node('button', s.title || s.name, s.viewId === currentView ? 'active' : '');
      b.dataset.sheet = s.viewId; b.addEventListener('click', () => { remember(); currentSheet = s.name; currentView=s.viewId; el('businessSheetSearch').value = ''; render(); window.dispatchEvent(new Event('business:sheet')); }); return b;
    }));
    const lookup = new Map(sheet.cells.map(c => [c.cell, c])), imageLookup = new Map();
    for(const image of sheet.images) imageLookup.set(image.cell,[...(imageLookup.get(image.cell)||[]),image]);
    for (const [index, spec] of specs(sheet).entries()) {
      const isProof = sheet.name === '人力费用' && spec.header === 1;
      const wrapper = node(isProof ? 'details' : 'article', null, 'sheet-block'), label = node(isProof ? 'summary' : 'h3', isProof ? '凭证与原表说明（不重复计费）' : spec.title), container = node('div', null, 'sheet-grid');
      wrapper.append(label, container); host.append(wrapper);
      if (isProof) wrapper.addEventListener('toggle', redrawTables);
      const rows = Array.from({ length: spec.end - spec.start + 1 }, (_, offset) => {
        const r = spec.start + offset, row = { _row: r };
        for (const [, cols] of spec.groups) for (const col of cols) row[col] = display(lookup.get(`${col}${r}`), draft.get(key(sheet.name, `${col}${r}`))?.input);
        return row;
      }).filter(row => Object.entries(row).some(([k,v]) => k !== '_row' && v !== '') || sheet.images.some(i => Number(i.cell.replace(/\D/g,'')) === row._row));
      const column = col => {
        const header = lookup.get(`${col}${spec.header}`), field=sheet.fields?.[colIndex(col)], proof = field?.type === 'attachment' || sheet.images.some(i => i.cell.replace(/\d/g, '') === col);
        const title = (proof ? (header?.value && !String(header.value).includes('DISPIMG') ? String(header.value).replace('贴图','数据凭证') : '数据凭证') : String(header?.value || (col === 'E' && sheet.name === '2025采购信息' ? '备注' : col))).replace('净利率', '原表净收益金额');
        let width = proof ? 160 : col === 'A' ? (sheet.name === '人力费用' && spec.header === 1 ? 250 : 130) : sheet.name === '2025采购信息' && col === 'B' ? 430 : 145;
        width=sheet.widths?.[field?.fieldId] || width;if(proof) width=Math.max(170,width);
        const money=/金额|利润|净收益|扣款|费用|支出|客单价|邮费/.test(title), stat=/浏览|访客|买家|转化|退款率|订单/.test(title);
        return { cssClass:money?'sheet-money':stat?'sheet-stat':'',hozAlign:money?'right':'left',vertAlign:'middle',title: title.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), field: col, width, minWidth: 100, frozen: col === 'A', headerSort: !proof, headerFilter: proof ? false : 'input', headerFilterPlaceholder: '筛选…', editor: customEditor,
          editable: cell => mode !== 'client' && !snapshot?.cloud && !processing && !saving && Boolean(snapshot) && !imageLookup.has(`${col}${cell.getRow().getData()._row}`) && !(cell.getField() === 'A' && String(cell.getValue()).includes('采购清单')),
          variableHeight: true,
          sorter: (a,b) => { const n = v => String(v).replace(/[,%]/g,''); return a !== '' && b !== '' && Number.isFinite(Number(n(a))) && Number.isFinite(Number(n(b))) ? Number(n(a))-Number(n(b)) : String(a).localeCompare(String(b),'zh-CN'); },
          formatter: cell => {
            const address = `${col}${cell.getRow().getData()._row}`, image = imageLookup.get(address), c = lookup.get(address);
            cell.getElement().classList.toggle('sheet-dirty', draft.has(key(sheet.name, address)));
            cell.getElement().classList.toggle('sheet-formula', Boolean(c?.formula || c?.sourceFormula));
            if (!snapshot?.cloud && c?.color && /^[a-fA-F0-9]{6}$/.test(c.color)) cell.getElement().style.backgroundColor = '#' + c.color;
            if (image) {const gallery=node('div',null,'sheet-proof-list');gallery.append(...image.map(imageCell));return gallery;}
            if(proof) return node('span','—','sheet-missing');
            let value=cell.getValue();
            if(snapshot?.cloud && field?.type==='date' && value) value=String(value).slice(0,7).replace('-','年')+'月';
            if(snapshot?.cloud && !value) value='未填报';
            const text = node('span', value); text.title = c?.formula || c?.sourceFormula ? `=${c.formula || c.sourceFormula}` : `${sheet.name}!${address}`; return text;
          },
          cellClick: (event, cell) => {
            const address = `${col}${cell.getRow().getData()._row}`, c = lookup.get(address);
            if (imageLookup.has(address)) return;
            selected = { cell, address, sheet: sheet.name }; el('businessCellAddress').textContent = `${sheet.name}!${address}`;
            el('businessFormulaBar').value = draft.get(key(sheet.name, address))?.input ?? (c?.formula || c?.sourceFormula ? `=${c.formula || c.sourceFormula}` : display(c));
          }
        };
      };
      const groups = spec.groups.map(([title, cols]) => ({ title, columns: cols.map(column) }));
      const rowNumbers = { title: '行', field: '_row', width: 48, frozen: true, headerSort: false, hozAlign: 'center' };
      // Frozen fields must be top-level in Tabulator; keep the date beside the
      // fixed original row number, while groups cover the remaining columns.
      for (const group of groups) group.columns = group.columns.filter(c => c.field !== 'A');
      const columns = [rowNumbers,column('A'),...groups.flatMap(g=>g.columns)];
      const hasImages = sheet.images.some(i => { const r = Number(i.cell.replace(/\D/g, '')); return r >= spec.start && r <= spec.end; });
      const tableHeight = count => Math.max(150, Math.min(560, 100 + count * (hasImages ? 90 : 34)));
      const table = new Tabulator(container, { index: '_row', data: rows, columns, layout: 'fitData', height: tableHeight(rows.length), editTriggerEvent: 'dblclick', placeholder: '没有匹配的数据', clipboard: true, selectableRange: false, rowFormatter: row => {
        const d = row.getData(); row.getElement().dataset.sourceRow = d._row;
        if (Object.values(d).some(v => typeof v === 'string' && /^(合计|小计|总金额|20\d{2}年\d{1,2}月采购清单)$/.test(v))) row.getElement().classList.add('sheet-total-row');
      } });
      table.on('cellEdited', cell => edit(cell, String(cell.getValue() ?? '')));
      table.on('dataFiltered', (filters, visible) => { if (table.businessReady && tables.includes(table)) table.setHeight(tableHeight(visible.length)); });
      table.businessSourceHeader = spec.header;
      table.on('tableBuilt', () => {
        if (!tables.includes(table)) return;
        table.businessReady = true;
        const previous = viewState.get(currentView)?.[index];
        if (previous?.sorters.length) table.setSort(previous.sorters);
        for (const f of previous?.filters || []) table.setHeaderFilterValue(f.field, f.value);
        applyFilters();
        table.redraw(true);
      });
      tables.push(table);
    }
    state();
  }
  async function load(year, runtimeMode) {
    mode = runtimeMode;
    if (draft.size || saving) { state(); return; }
    const id = ++loading;
    const result = await api.getBusinessSheets(year);
    if (id !== loading) return;
    if (snapshot?.versionId === result.versionId) { state(); return; }
    snapshot = result; currentView = scopedSheets().some(s => s.viewId === currentView) ? currentView : scopedSheets()[0]?.viewId || ''; currentSheet=scopedSheets().find(s=>s.viewId===currentView)?.name||'';
    render();
  }
  el('businessApplyCell').addEventListener('click', () => {
    if (!selected || !snapshot || saving || (mode === 'client' || snapshot?.cloud)) return;
    selected.cell.setValue(el('businessFormulaBar').value); edit(selected.cell, el('businessFormulaBar').value);
  });
  el('businessFormulaBar').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el('businessApplyCell').click(); } });
  el('businessSaveCells').addEventListener('click', async () => {
    if (!draft.size || saving || (mode === 'client' || snapshot?.cloud)) return;
    document.activeElement?.blur(); saving = true; state();
    try {
      const result = await api.saveBusinessCells({ year: snapshot.year, versionId: snapshot.versionId, changes: [...draft.values()] });
      draft.clear(); snapshot = null; saving = false; state();
      el('businessStatus').textContent = `已保存 ${result.edited} 个修改，重算 ${result.recalculated} 个相关公式。原始凭证保留，请对修改后的数据再次核对。`;
      window.dispatchEvent(new CustomEvent('business:saved'));
    } catch (error) { el('businessStatus').textContent = `未保存：${error.message}。草稿仍保留。`; el('businessStatus').classList.add('error'); }
    finally { saving = false; state(); }
  });
  el('businessDiscardCells').addEventListener('click', () => { if (saving || !window.confirm('撤销所有未保存的单元格修改？')) return; draft.clear(); render(); });
  function applyFilters() {
    const value = el('businessSheetSearch').value.trim().toLowerCase();
    const sheet=sheets().find(s=>s.name===currentSheet);
    const dateField=sheet?.fields?.find(f=>f.type==='date'||f.fieldName==='日期');
    const dateColumn=dateField ? colName(sheet.fields.indexOf(dateField)) : null;
    for(const table of tables.filter(t=>t.businessReady)) table.setFilter(row=>{
      const cloudMonth=snapshot?.cloud && dateColumn && String(row[dateColumn]||'').replace('年','-').startsWith(activeMonth);
      const inMonth=!filteredRows || isAnnualSheet() || cloudMonth || currentSheet==='人力费用' && table.businessSourceHeader===1 || filteredRows?.has(`${currentSheet}!${row._row}`);
      return inMonth && (!value || Object.values(row).some(v=>String(v).toLowerCase().includes(value)));
    });
  }
  el('businessSheetSearch').addEventListener('input', applyFilters);
  el('businessSheetReset').addEventListener('click', () => { el('businessSheetSearch').value = ''; for (const t of tables) { t.clearHeaderFilter(); t.clearSort(); } applyFilters(); });
  el('businessSheetZoom').addEventListener('change', () => { el('businessSheetTables').style.zoom = `${el('businessSheetZoom').value}%`; tables.forEach(t => t.redraw(true)); });
  el('businessExportSheet').addEventListener('click', async () => {
    if (draft.size || saving || !snapshot) return;
    el('businessExportSheet').disabled = true;
    try { const r = await api.exportBusiness({ type: 'sheet', filters: { year: snapshot.year } }); el('businessStatus').textContent = r.canceled ? '已取消导出。' : `已导出表格与对应凭证：${r.filename}`; }
    catch (e) { el('businessStatus').textContent = e.message; } finally { state(); }
  });
  function setMode(value) {
    tableMode = value;
    el('businessSheetView').classList.toggle('hidden', !value); el('businessAnalysis').classList.toggle('hidden', value);
    el('businessTableMode').classList.toggle('active', value); el('businessAnalysisMode').classList.toggle('active', !value);
    el('businessMonth').closest('label').classList.toggle('hidden', value); el('businessShop').closest('label').classList.toggle('hidden', value);
    if (value) redrawTables(); else window.dispatchEvent(new Event('resize'));
  }
  el('businessTableMode').addEventListener('click', () => setMode(true)); el('businessAnalysisMode').addEventListener('click', () => setMode(false));
  window.addEventListener('beforeunload', e => { if (draft.size) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('erp:view', event => { if (event.detail === 'business') { setMode(tableMode); setTimeout(redrawTables, 0); } });
  window.businessSheetEditor = { load, isAnnualSheet, setBusy(value){processing=value;el('businessFormulaBar').disabled=value||!snapshot||mode==='client'||snapshot.cloud;el('businessApplyCell').disabled=el('businessFormulaBar').disabled;}, dirty: () => Boolean(draft.size), ready: () => Boolean(snapshot) && !saving, setScope(value) {
    if (scope === value) { redrawTables(); return; }
    remember(); scope = value; currentView=scopedSheets()[0]?.viewId||'';currentSheet = scopedSheets()[0]?.name || ''; el('businessSheetSearch').value = ''; if (snapshot) render();
  }, filterRecords(report, month) {
    activeMonth=month;
    filteredRows = month ? new Set(['monthly', 'finance', 'purchases', 'labor'].flatMap(k => report[k] || []).map(r => `${r.sourceSheet}!${r.sourceRow}`)) : null;
    if (filteredRows && snapshot && !snapshot.raw) {
      for (const [name, field] of [['店铺月报', 'monthly'], ['月度收支', 'finance'], ['采购明细', 'purchases'], ['人力明细', 'labor']]) {
        const ids = new Set((report[field] || []).map(r => r.id));
        for (const c of sheets().find(s => s.name === name)?.cells || []) if (/^A\d+$/.test(c.cell) && ids.has(c.value)) filteredRows.add(`${name}!${c.cell.slice(1)}`);
      }
    }
    applyFilters();
  } };
  setMode(true);
})();
