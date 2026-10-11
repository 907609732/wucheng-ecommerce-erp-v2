(() => {
  const api = window.inventoryApp, $ = id => document.getElementById(id);
  const kinds = { income:'收入账单', expense:'支出账单', tax:'涉税信息报送账单' };
  const fields = { taxable:'应税销售额（不含税，待确认）', exempt:'免税销售额（待确认）', specialInvoice:'专票销售额（不含税）', ordinaryInvoice:'普票销售额（不含税）', uninvoiced:'未开票销售额（不含税）', adjustment:'其他调整金额' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => n === null || n === undefined ? '待确认' : (n / 100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const jobLabels = { running:'执行中', received:'已收到待核对文件', needs_review:'待人工处理', needs_login:'待登录', needs_captcha:'待验证', needs_shop_review:'店铺待核对', needs_manual:'需人工确认', query_failed:'页面异常', failed:'失败', interrupted:'已中断', cancelled:'已取消', empty:'平台无账单' };
  const batchLabels = { running:'取账中', complete:'已收齐（待核对）', partial:'分片不完整', incomplete:'未收到文件', empty:'平台明确无账单', interrupted:'已中断' };
  const MANUAL = new Set(['needs_review','needs_login','needs_captcha','needs_shop_review','needs_manual','query_failed','failed','interrupted']);
  const previous = new Date(); previous.setDate(1); previous.setMonth(previous.getMonth()-1); const initialMonth = `${previous.getFullYear()}-${String(previous.getMonth()+1).padStart(2,'0')}`;
  $('financeMonth').value = initialMonth;
  let report = null, grid = null, staged = null, preview = null, busy = false, draftDirty = false, activeShop = '', activeMonth = initialMonth;
  const status = message => { $('financeStatus').textContent = message; };
  async function action(fn, errorId = 'financeStatus') {
    if (busy) return; busy = true;
    const buttons = [...document.querySelectorAll('#financePanel button,#financePanel input,#financePanel select,#financePanel textarea')]; const states = buttons.map(b=>b.disabled); buttons.forEach(b=>b.disabled=true);
    try { await fn(); } catch(e) { $(errorId).textContent = e.message; } finally { busy = false; buttons.forEach((b,i)=>b.disabled=states[i]); $('financeCommit').disabled = !preview; $('financeSettings').disabled = !report?.shop; }
  }
  function selectOptions(items, value='') { return items.map(([id,name])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(name)}</option>`).join(''); }
  function dirtyGuard() { return !draftDirty || window.confirm('填表草稿尚未保存，放弃这些修改并继续？'); }
  function tab(name) { document.querySelectorAll('[data-finance-tab]').forEach(b=>b.classList.toggle('active',b.dataset.financeTab===name)); document.querySelectorAll('[data-finance-section]').forEach(s=>s.classList.toggle('hidden',s.dataset.financeSection!==name)); grid?.redraw(); }
  async function load() {
    const selected = $('financeShop').value;
    report = await api.getFinance(selected,$('financeMonth').value);
    $('financeShop').innerHTML = selectOptions(report.shops.map(s=>[s.id,s.name]),selected);
    if (!selected && report.shops.length) { $('financeShop').value=report.shops[0].id; report=await api.getFinance(report.shops[0].id,$('financeMonth').value); }
    activeShop=$('financeShop').value; activeMonth=$('financeMonth').value;
    const exists=!!report.shop; $('financeEmpty').classList.toggle('hidden',exists); $('financeContent').classList.toggle('hidden',!exists);
    $('financeSettings').disabled=!exists;
    if (!exists) { status('还未添加店铺，点击“添加店铺”直接登录千牛。'); return; }
    render();
  }
  /** 取账进度：分类型状态、平台限制、待人工处理与继续入口。 */
  function renderRun() {
    const box = $('financeRun'); const job = (report.jobs || [])[0];
    if (!job) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const batches = (report.batches || []).filter(batch => batch.job === job.id);
    const note = job.note || {};
    const rows = Object.keys(kinds).map(kind => {
      const batch = batches.find(item => item.kind === kind);
      const plan = batch?.plan || {};
      const detail = !batch ? '本次未开始' : `${(batch.parts||[]).length} 个文件${plan.missing?.length ? ` · 缺少 ${plan.missing.join('、')}` : (batch.state === 'complete' ? ' · 已收齐' : (batch.state === 'empty' ? ' · 平台明确无账单' : ''))}`;
      return `<li><span>${kinds[kind]}</span><small>${esc(batch ? (batchLabels[batch.state]||batch.state) : '未开始')} · ${esc(detail)}</small></li>`;
    }).join('');
    const limits = (note.limits || []).map(item => item.raw).join('；');
    const extras = [note.recordCount !== undefined && note.recordCount !== null ? `页面自述条数 ${note.recordCount}` : '', limits ? `平台限制：${limits}` : '', note.shard?.needsManual ? `需人工拆分：${note.shard.reason}` : ''].filter(Boolean).join(' · ');
    const manual = MANUAL.has(job.state);
    box.classList.remove('hidden');
    box.innerHTML = `<div class="finance-run-head"><strong>${esc(job.month)} 取账进度</strong><span>${esc(jobLabels[job.state]||job.state)}</span></div>
      <ul class="finance-run-kinds">${rows}</ul>
      <small>${esc(job.message||'')}${extras?`<br>${esc(extras)}`:''}</small>
      <div class="finance-run-actions">${manual?'<button data-finance-resume class="primary">继续处理</button>':''}<button data-finance-retry>重试失败项</button><button data-finance-cancel>停止本次</button></div>`;
  }
  /** 待核对文件：同一批次的多个分片合并展示，避免后一个文件覆盖前一个。 */
  function pendingBlocks() {
    const groups = new Map();
    for (const item of report.pending || []) { const key = item.batch || `single:${item.id}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
    return [...groups.entries()].map(([key, items]) => {
      const batch = (report.batches || []).find(item => item.id === key);
      const head = batch ? `<div class="finance-list-row"><span>${esc(kinds[batch.kind]||batch.kind)} · 分片批次（${items.length} 个文件）<br><small>${esc(batchLabels[batch.state]||batch.state)}${batch.plan?.missing?.length?` · 缺少 ${esc(batch.plan.missing.join('、'))}`:''}</small></span><button data-finance-batch="${esc(batch.id)}">整批核对入账</button></div>` : '';
      const rows = items.map(item => `<div class="finance-list-row"><span>${esc(item.name)}<br><small>${esc(item.month||'')} ${esc(item.subtype || kinds[item.kind] || '')}</small></span><button data-finance-pending="${esc(item.id)}">核对入账</button></div>`).join('');
      return head + rows;
    }).join('');
  }
  function render() {
    const r=report;
    $('financeSchedule').textContent=r.shop.schedule ? `每月 15 日 09:00 取上月账单 · 起始 ${r.shop.startMonth} · 自动取账开发中，真实千牛未验收` : '定时取账未开启 · 自动取账开发中，真实千牛未验收；可导入原始账单核对';
    renderRun();
    $('financePending').innerHTML=(r.pending||[]).length ? `<details class="finance-checks" open><summary>待核对文件（${r.pending.length}）</summary>${pendingBlocks()}</details>` : '';
    $('financeBillSummary').innerHTML=Object.entries(kinds).map(([kind,name])=>{const parts=r.bills.filter(b=>b.kind===kind);return `<article><span>${name}</span><strong>${parts.length ? money(r.kindTotals[kind][kind==='expense'?'expense':'net']) : '待导入'}</strong><small>${parts.length ? `${parts.reduce((sum,b)=>sum+b.records,0)} 条 · ${parts.length} 个原文件` : '缺少原始账单'}</small>${parts.map(b=>`<button data-finance-original="${b.id}">下载：${esc(b.name)}</button>`).join('')}</article>`;}).join('');
    $('financeIssues').innerHTML=r.issues.map(i=>`<li>${esc(i)}</li>`).join('') || '<li>当前账单字段未发现自动核对差异，仍需人工复核。</li>';
    grid?.destroy();
    grid=new Tabulator($('financeGrid'),{data:r.rows,layout:'fitDataStretch',height:410,placeholder:'当前账期没有已入账数据',columns:[
      {title:'账单',field:'kind',formatter:c=>kinds[c.getValue()],width:165,frozen:true},{title:'来源文件',field:'filename',width:210,formatter:'plaintext'},
      {title:'工作表',field:'sheet',formatter:'plaintext'},{title:'源行',field:'row',sorter:'number'},
      ...[['gross','收入总额'],['refund','退款'],['net','收入净额'],['expense','支出']].map(([field,title])=>({title,field,hozAlign:'right',sorter:'number',formatter:c=>money(c.getValue()),width:125})),
      {title:'参考单号',field:'reference',formatter:'plaintext'},{title:'说明',field:'note',formatter:'plaintext',width:230} ]});
    filter();
    $('financeJobs').innerHTML=(r.jobs||[]).map(j=>`<div class="finance-list-row"><span>${esc(j.month)} · ${esc(new Date(j.created).toLocaleString('zh-CN'))}<br>${esc(j.message)}${(j.items||[]).length?`<br><small>${j.items.map(i=>`${esc(i.subtype||kinds[i.kind]||'')}：${esc(i.state)}`).join(' · ')}</small>`:''}</span><small>${esc(jobLabels[j.state]||j.state)}</small></div>`).join('') || '<p class="finance-note">暂无取账记录。</p>';
    $('financeVersions').innerHTML=r.history.map(b=>`<div class="finance-list-row"><span>${esc(kinds[b.kind])} · ${esc(b.name)}${b.parts?.length>1?`<br><small>${b.parts.length} 个分片：${b.parts.map(p=>esc(p.subtype||p.name)).join('、')}</small>`:''}<br><small>${esc(new Date(b.created).toLocaleString('zh-CN'))}</small></span><button data-finance-restore="${b.id}" ${b.active?'disabled':''}>${b.active?'当前版本':'恢复此版本'}</button></div>`).join('') || '<p class="finance-note">暂无账单版本。</p>';
    if (!draftDirty) renderDraft();
    status(`${r.shop.name} · ${r.month} · ${r.rows.length} 条已入账记录`);
  }
  function renderDraft() {
    const r=report;
    $('financeDraftPeriod').textContent=`${r.shop.name} · ${r.period.key} 填表工作底稿`;
    $('financeDraftIssues').innerHTML=r.draftIssues.map(i=>`<li>${esc(i)}</li>`).join('');
    $('financePlatformReference').textContent=`平台报送参考（含税）：收入总额 ${money(r.platformTotals.gross)} · 退款 ${money(r.platformTotals.refund)} · 收入净额 ${money(r.platformTotals.net)}`;
    $('financeDraftFields').innerHTML='<div class="finance-draft-row finance-note"><span>申报项目</span><span>金额（元）</span><span>来源 / 计算依据</span></div>'+Object.entries(fields).map(([key,label])=>{const v=r.draft.values[key];return `<div class="finance-draft-row"><label for="finDraft-${key}">${label}</label><input id="finDraft-${key}" data-finance-draft="${key}" inputmode="decimal" placeholder="待确认" value="${v?.cents==null?'':v.cents/100}"><input id="finBasis-${key}" aria-label="${label}的依据" placeholder="发票、账单行号或计算说明" value="${esc(v?.basis||'')}"></div>`;}).join('');
    $('financeDraftNote').value=r.draft.note||'';
  }
  function filter() { const kind=$('financeKind').value, search=$('financeSearch').value.trim().toLowerCase(); grid?.setFilter(row=>(!kind||row.kind===kind)&&(!search||JSON.stringify(row).toLowerCase().includes(search))); }
  function shopDialog(shop={}) {
    if (!dirtyGuard()) return;
    $('financeShopForm').reset(); $('financeShopId').value=shop.id||''; $('financeShopDialogTitle').textContent=shop.id?'店铺财务设置':'添加财务店铺';
    for(const [id,key] of [['finName','name'],['finAccount','account'],['finEntity','entity'],['finTaxId','taxId'],['finEntityType','entityType'],['finTaxpayer','taxpayer'],['finCycle','cycle'],['finBillUrl','billUrl']]) $(id).value=shop[key]||'';
    $('finExclude').value=(shop.excludeSubtypes||[]).join('、');
    $('finCategoryMap').value=Object.entries(shop.categoryMap||{}).map(([k,v])=>`${k}=${v}`).join('\n');
    $('finStart').value=shop.startMonth||initialMonth; $('finSchedule').checked=!!shop.schedule; $('financeShopError').textContent=''; $('financeShopDialog').showModal();
  }
  function applyMapping() {
    const sheet=staged.sheets.find(s=>s.name===$('finImportSheet').value); $('finFirstRow').value=2; $('finLastRow').value=sheet.lastRow;
    $('finSample').innerHTML='<table><thead><tr><th>行</th>'+sheet.columns.map(c=>`<th>${c}</th>`).join('')+'</tr></thead><tbody>'+sheet.sample.map((row,i)=>`<tr><td>${i+1}</td>${sheet.columns.map((_,c)=>`<td>${esc(row[c])}</td>`).join('')}</tr>`).join('')+'</tbody></table>';
    $('finMapping').innerHTML=Object.entries({date:'账期 / 日期',gross:'收入总额',refund:'退款金额',net:'收入净额',expense:'支出金额',reference:'参考单号'}).map(([key,label])=>`<label>${label}<select data-finance-map="${key}">${selectOptions([['','未提供'],...sheet.columns.map((col,i)=>[col,`${col} · ${String(sheet.sample[0]?.[i]??'').slice(0,25)}`])])}</select></label>`).join('');
    preview=null;
  }
  function importDialog(file) {
    staged=file; preview=null; $('financeCommit').disabled=true;
    $('finLedgerViewField').hidden=true; $('finLedgerView').innerHTML='<option value="">自动识别</option>';
    $('financeImportName').textContent=file.batch ? `${file.name}（分片批次，将按同一字段映射整批入账）` : file.name;
    $('finImportSheet').innerHTML=selectOptions(file.sheets.map(s=>[s.name,s.name])); $('finImportMonth').value=file.month || $('financeMonth').value;
    if (file.kind && kinds[file.kind]) $('finImportKind').value=file.kind;
    $('financeImportError').textContent=''; $('finPreviewResult').textContent=''; $('finScope').checked=false; applyMapping(); $('financeImportDialog').showModal();
  }
  async function batchDialog(batchId) {
    const batch = await api.getFinanceBatch(batchId);
    const first = (batch.parts||[]).find(p => p.state === 'staged' || p.state === 'preview') || (batch.parts||[])[0];
    if (!first) throw new Error('该批次没有待核对的原始文件');
    const file = await api.inspectFinance(first.id);
    importDialog({ ...file, batch: batch.id, month: batch.month, kind: batch.kind });
    const labels=[...new Set((batch.parts||[]).map(p=>p.subtype).filter(Boolean))];
    $('finLedgerViewField').hidden=false;
    $('finLedgerView').innerHTML='<option value="">自动识别（汇总视图优先月汇总）</option>'+selectOptions(labels.map(label=>[label,label]));
    $('finLedgerView').value='';
    $('financeImportName').textContent = `${kinds[batch.kind]||batch.kind} · ${batch.month} · ${batch.parts.length} 个分片整批入账`;
  }
  function batchOptions() {
    const mapping=Object.fromEntries([...document.querySelectorAll('[data-finance-map]')].map(s=>[s.dataset.financeMap,s.value]));
    return { sheet:$('finImportSheet').value,kind:$('finImportKind').value,month:$('finImportMonth').value,firstRow:Number($('finFirstRow').value),lastRow:Number($('finLastRow').value),mapping,confirmScope:$('finScope').checked, ...(staged?.batch && $('finLedgerView').value ? {ledgerView:$('finLedgerView').value} : {}) };
  }
  document.querySelectorAll('[data-finance-tab]').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.financeTab)));
  document.querySelectorAll('[data-finance-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.financeClose).close()));
  const shopLogin = window.createFinanceShopLogin({
    api, getMonth: () => $('financeMonth').value, onStatus: status,
    onSaved: async result => {
      const saved = result.shop;
      if (![...$('financeShop').options].some(option => option.value === saved.id)) $('financeShop').add(new Option(saved.name, saved.id));
      $('financeShop').value = saved.id; draftDirty = false;
      await load(); status(result.message);
    }
  });
  $('financeAdd').onclick = $('financeFirstShop').onclick = () => {
    if (!dirtyGuard()) return;
    draftDirty = false; void action(() => shopLogin.open());
  };
  $('financeSettings').onclick = () => shopDialog(report?.shop);
  $('financeHelpButton').onclick=()=>window.erpFeatureHelp.open('manual', 'finance');
  $('financeShopForm').onsubmit=e=>{e.preventDefault();void action(async()=>{
    const categoryMap={}; for(const line of $('finCategoryMap').value.split('\n')){const [label,kind]=line.split('=').map(v=>(v||'').trim());if(label&&['income','expense','tax'].includes(kind))categoryMap[label]=kind;}
    const data={id:$('financeShopId').value,name:$('finName').value,account:$('finAccount').value,entity:$('finEntity').value,taxId:$('finTaxId').value,entityType:$('finEntityType').value,taxpayer:$('finTaxpayer').value,cycle:$('finCycle').value,startMonth:$('finStart').value,schedule:$('finSchedule').checked,billUrl:$('finBillUrl').value,categoryMap,excludeSubtypes:$('finExclude').value.split(/[,，、\s]+/).filter(Boolean)};
    const saved=await api.saveFinanceShop(data); $('financeShopDialog').close(); $('financeShop').add(new Option(saved.name,saved.id)); $('financeShop').value=saved.id; draftDirty=false; await load();
  },'financeShopError');};
  $('financeShop').onchange=$('financeMonth').onchange=()=>{if(!dirtyGuard()){$('financeShop').value=activeShop;$('financeMonth').value=activeMonth;return;}draftDirty=false;void action(load);};
  $('financeRefresh').onclick=()=>{if(dirtyGuard()){draftDirty=false;void action(load);}};
  const runCollect = options => void action(async()=>{const result=await api.collectFinance(activeShop,activeMonth,options);await load();status(result.message||'取账完成');});
  $('financeCollect').onclick=()=>runCollect({});
  $('financeRetry').onclick=()=>runCollect({retry:true});
  $('financeOpen').onclick=()=>void action(async()=>{await api.openFinance(activeShop,activeMonth);status('已打开该店铺的独立千牛窗口');});
  $('financeProbe').onclick=()=>void action(async()=>{
    $('financeProbeError').textContent=''; $('financeProbeResult').textContent='正在读取当前店铺窗口…'; $('financeProbeDialog').showModal();
    const result=await api.probeFinance(activeShop,activeMonth);
    $('financeProbeResult').textContent=JSON.stringify(result,null,2);
  },'financeProbeError');
  $('financeProbeRun').onclick=()=>$('financeProbe').click();
  $('financeFolder').onclick=()=>void action(()=>api.openFinanceFolder());
  $('financeImport').onclick=()=>void action(async()=>{const file=await api.importFinance(activeShop);if(file)importDialog(file);});
  $('finImportSheet').onchange=applyMapping;
  $('financeImportDialog').addEventListener('change',()=>{preview=null;$('financeCommit').disabled=true;$('finPreviewResult').textContent='';});
  $('financePreview').onclick=()=>void action(async()=>{
    const options=batchOptions();
    preview = staged.batch ? await api.previewFinanceBatch(staged.batch, options) : await api.previewFinance(staged.token, options);
    const parts = preview.parts ? `<ul>${preview.parts.map(p=>`<li>${esc(p.subtype||p.name)}：${p.role==='voucher'?'核对凭证，不计金额':'入账文件'} · ${p.records} 条 · 净额 ${money(p.totals.net)}${p.issues.length?` · 待核对 ${p.issues.length} 项`:''}</li>`).join('')}</ul>` : '';
    $('finPreviewResult').innerHTML=`<p><b>${preview.records} 条记录</b> · ${esc(preview.month)} · ${kinds[preview.kind]}${preview.parts?` · ${preview.parts.length} 个分片`:''}</p><p>收入 ${money(preview.totals.gross)} / 退款 ${money(preview.totals.refund)} / 净额 ${money(preview.totals.net)} / 支出 ${money(preview.totals.expense)}</p>${parts}${preview.previousId?'<p>保存后将替换本月同类型账单，旧版本保留。</p>':''}<ul>${preview.issues.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>`;
    $('financeImportError').textContent='';
  },'financeImportError');
  $('financeCommit').onclick=()=>void action(async()=>{
    const saved = staged.batch ? await api.commitFinanceBatch(staged.batch,true) : await api.commitFinance(staged.token,true);
    $('financeImportDialog').close();await load();status(saved.duplicate?'相同文件和字段已入账，无需重复保存':'账单已入账，原文件与旧版本已保留');preview=null;
  },'financeImportError');
  $('financeSearch').oninput=filter; $('financeKind').onchange=filter;
  $('financeDraftFields').addEventListener('input',()=>{draftDirty=true;}); $('financeDraftNote').oninput=()=>{draftDirty=true;};
  $('financeSaveDraft').onclick=()=>void action(async()=>{const values=Object.fromEntries(Object.keys(fields).map(k=>[k,{amount:$(`finDraft-${k}`).value,basis:$(`finBasis-${k}`).value}]));await api.saveFinanceDraft(activeShop,activeMonth,{values,note:$('financeDraftNote').value,signature:report.signature});draftDirty=false;await load();status('填表草稿已保存');});
  const exportDraft=()=>void action(async()=>{if(draftDirty)throw new Error('请先保存填表草稿，再导出');if(await api.exportFinance(activeShop,activeMonth))status('填表工作底稿已导出，请核对后用于申报');});
  $('financeExport').onclick=$('financeDraftExport').onclick=exportDraft;
  $('financePanel').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.financePending)void action(async()=>importDialog(await api.inspectFinance(b.dataset.financePending)));
    if(b.dataset.financeBatch)void action(()=>batchDialog(b.dataset.financeBatch),'financeImportError');
    if(b.dataset.financeOriginal)void action(()=>api.exportFinance(activeShop,activeMonth,b.dataset.financeOriginal));
    if(b.dataset.financeResume)void action(async()=>{const result=await api.collectFinance(activeShop,activeMonth,{resume:true});await load();status(result.message||'已继续处理');});
    if(b.dataset.financeRetry)void action(async()=>{const result=await api.retryFinance(activeShop,activeMonth);await load();status(result.message||'已重试失败项');});
    if(b.dataset.financeCancel)void action(async()=>{await api.cancelFinance(activeShop);status('已请求停止本次取账');});
    if(b.dataset.financeRestore && window.confirm('恢复此账单版本？现有版本仍保留，相关草稿需要重新核对。'))void action(async()=>{await api.restoreFinance(b.dataset.financeRestore);await load();});
  });
  window.addEventListener('erp:view',e=>{if(e.detail==='finance'&&!draftDirty)void action(load);});
  api.onFinanceChanged(message=>{status(message);if(!busy&&!draftDirty&&!$('financePanel').classList.contains('hidden')&&!$('financeImportDialog').open&&!$('financeShopDialog').open&&!$('financeShopLoginDialog').open)void action(async()=>{await load();status(message);});});
})();
