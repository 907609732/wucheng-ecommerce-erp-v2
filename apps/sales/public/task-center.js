const datasetNames = {operations:'经营数据',settlement:'平台结算',receipt:'实际收款',expense:'单店费用'};
const officialPlatforms = new Set(['淘宝','拼多多']);
const isMonth = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);

export function taskMonthShops(shops,closeInfo={}) {
  if (!closeInfo.locked || !Array.isArray(closeInfo.report?.operations) || !Array.isArray(closeInfo.report?.reconciliation)) return shops;
  const savedIds = new Set([...closeInfo.report.operations,...closeInfo.report.reconciliation].map(row => row.shop_id));
  return shops.filter(shop => savedIds.has(shop.id));
}

// Only saved coverage confirmations count as reviewed. A file or matching screenshot is separate evidence.
export function monthlyTaskModel({month,shops=[],sources=[],closeInfo={},jobs=[],pending=[],statements=[]}) {
  if (!isMonth(month)) throw Error('请选择有效月份');
  if (closeInfo.month && closeInfo.month !== month) throw Error('月份已变化，请重新读取任务');
  const snapshotCoverage = Array.isArray(closeInfo.coverage) ? closeInfo.coverage : null;
  const rows = taskMonthShops(shops,closeInfo).filter(shop => shop.platform !== '待归属').sort((a,b)=>(a.manual?2:officialPlatforms.has(a.platform)?0:1)-(b.manual?2:officialPlatforms.has(b.platform)?0:1)).map(shop => {
    const source = sources.find(item => item.id === shop.id);
    const datasets = Object.keys(datasetNames).filter(key => !(shop.manual && key === 'settlement')).map(dataset => {
      const saved = snapshotCoverage
        ? snapshotCoverage.find(item => item.shop_id === shop.id && item.dataset === dataset && (!item.month || item.month === month))
        : source?.datasets?.find(item => item.dataset === dataset);
      return {dataset,label:datasetNames[dataset],status:saved?.status || 'missing'};
    });
    const statement = statements.find(item => item.shop_id === shop.id)?.months?.find(item => item.month === month);
    const official = officialPlatforms.has(shop.platform);
    const imported = official && !!statement && (statement.income != null || statement.expense != null || statement.coverage?.sources?.length > 0);
    const moneyCoverage = datasets.filter(item => ['settlement','receipt'].includes(item.dataset));
    return {...shop,datasets,statement,official,imported,
      reviewed:datasets.filter(item => item.status === 'full').length,
      required:datasets.length,
      fundsReviewed:moneyCoverage.filter(item => item.status === 'full').length,
      fundsRequired:moneyCoverage.length,
      importedLabel:official ? imported ? '已取得账单' : '未取得本月账单' : shop.manual ? '手工登记' : '通用报表导入',
      statementLabel:official ? !imported ? '先取得本月原件' : statement.coverage?.status === 'full' ? '文件日期覆盖完整' : shop.platform === '淘宝' ? '已导入，完整性待核对' : '仅取得部分日期' : '按登记结果核对',
      comparisonLabel:!official || !imported ? '' : ({match:'平台参考相符',range_difference:'参考范围不同',amount_difference:'参考金额待核对',no_reference:'暂无平台参考'})[statement.comparison] || '暂无平台参考'
    };
  });
  const required = rows.reduce((sum,row) => sum + row.required,0);
  const reviewed = rows.reduce((sum,row) => sum + row.reviewed,0);
  const fundsRequired = rows.reduce((sum,row) => sum + row.fundsRequired,0);
  const fundsReviewed = rows.reduce((sum,row) => sum + row.fundsReviewed,0);
  const officialRows = rows.filter(row => row.official);
  const imported = officialRows.filter(row => row.imported).length;
  const monthlyPending = pending.filter(item => item.scope?.start && item.scope?.end && item.scope.start.slice(0,7) <= month && item.scope.end.slice(0,7) >= month);
  const matchingJobs = jobs.filter(job => job.period === month && ['complete','needs_action'].includes(job.state) && job.report_status !== 'before_attribution_correction').sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
  const latestJob = matchingJobs[0] || null;
  const locked = !!closeInfo.locked;
  const next = !rows.length ? 'import' : locked ? 'delivery' : monthlyPending.length || officialRows.some(row => !row.imported) ? 'import' : fundsReviewed < fundsRequired ? 'reconcile' : reviewed < required ? 'records' : !latestJob ? 'report' : 'delivery';
  return {month,rows,required,reviewed,fundsRequired,fundsReviewed,officialCount:officialRows.length,imported,pending:monthlyPending,latestJob,locked,next,
    gaps:required-reviewed,freight:closeInfo.freight || {count:0,total:null}};
}

export function taskFlowStages(model,{role}={}) {
  const stages=[
    {key:'import',number:1,label:'导入账单',title:'按店铺导入本月账单',note:'一次处理一家店，提交前先检查原件预览。',evidence:model.pending.length?model.pending.length+' 份归属待确认':model.officialCount?model.imported+' / '+model.officialCount+' 家已取得':'按实际来源登记',kind:model.officialCount&&model.imported===model.officialCount&&!model.pending.length?'ready':''},
    {key:'reconcile',number:2,label:'核对资金',title:'逐店核对本月资金',note:'核对日期范围、收支分类和真实到账。',evidence:model.fundsReviewed+' / '+model.fundsRequired+' 项已核对',kind:model.fundsRequired&&model.fundsReviewed===model.fundsRequired?'verified':''},
    {key:'records',number:3,label:'补齐记录',title:'补齐经营、收款和费用',note:'按缺口补记录，并保存整月核对依据。',evidence:model.reviewed+' / '+model.required+' 项已核对',kind:model.required&&!model.gaps?'verified':''},
    {key:'report',number:4,label:'检查月报',title:'生成月报，检查缺口',note:'用当前保存的数据生成草稿，查看异常。',evidence:model.latestJob?'已有生成记录':'待生成草稿',kind:model.latestJob?'ready':''},
    {key:'delivery',number:5,label:'锁定交付',title:'确认锁定，导出交付',note:'检查本月结果，保存 Excel 后再交付。',evidence:model.locked?'本月已锁定':'待确认本月',kind:model.locked?'verified':''}
  ];
  const allowed=role==='employee'?new Set(['import','records']):role==='boss'?new Set(['reconcile','report','delivery']):null;
  return allowed?stages.filter(stage=>allowed.has(stage.key)).map((stage,index)=>({...stage,number:index+1,...(role==='employee'&&stage.key==='records'?{title:'补齐经营和费用资料',note:'补齐自己负责的经营资料和单店费用，完成后提交给老板。'}:{})})):stages;
}

export function createLegacyTaskCenter(ctx) {
  const {$,esc,money,api,boot,state} = ctx;
  let sequence = 0;
  const route = (view,month,shop='all',extra={}) => '#' + view + '?' + new URLSearchParams({month,shop_id:shop,...extra});
  const badge = (text,kind='') => `<span class="task-status ${kind}">${esc(text)}</span>`;
  const status = item => `<span class="task-dataset ${item.status==='full'?'is-reviewed':''}">${esc(item.label)} · ${item.status==='full'?'已核对':item.status==='partial'?'待核对':'未取得'}</span>`;
  const iconPaths = {
    import:'M35 20h37l19 19v57H35z M72 20v20h19 M60 78V49 M48 61l12-12 12 12 M48 86h24',
    reconcile:'M29 19h51v77H29z M41 36h25 M41 49h20 M76 64a16 16 0 1 0 0 32 16 16 0 0 0 0-32 M87 91l13 13',
    records:'M30 23h60v76H30z M43 42l5 5 9-10 M43 63l5 5 9-10 M67 43h10 M67 64h10 M43 84h34',
    report:'M28 20h49l17 17v63H28z M77 20v18h17 M42 83V65 M59 83V53 M76 83V45 M40 89h41',
    delivery:'M24 38h30l10 10h35v45H24z M51 72l10 10 20-23 M35 28h48v20'
  };
  async function render(valid=()=>true) {
    const ticket = ++sequence,month = String(state.period).slice(0,7),selected = state.shop;
    if (!isMonth(month)) throw Error('请选择要处理的月份');
    const shops = boot.shops.filter(shop => shop.platform !== '待归属');
    const [closeInfo,sources,pending,jobs,statements] = await Promise.all([
      api('/api/close?month='+month),api('/api/sources?month='+month),api('/api/pdd/unassigned'),api('/api/jobs'),
      Promise.all(shops.filter(shop => officialPlatforms.has(shop.platform)).map(shop => api((shop.platform==='淘宝'?'/api/taobao':'/api/pdd')+'/statement?'+new URLSearchParams({shop_id:shop.id,year:month.slice(0,4)}))))
    ]);
    if (ticket !== sequence || !valid()) return;
    const model = monthlyTaskModel({month,shops,sources,closeInfo,pending,jobs,statements});
    const {rows,locked,gaps,next,latestJob} = model,stages=taskFlowStages(model);
    const focused = selected !== 'all' ? rows.find(row => row.id === selected) : null;
    const shown = focused ? [focused] : rows;
    const exportURL = '/api/export?' + new URLSearchParams({period:month,grain:'month',shop:'all'});
    const labelMonth = `${Number(month.slice(0,4))} 年 ${Number(month.slice(5,7))} 月`;
    const importNext = focused || rows.find(row=>row.official&&!row.imported) || rows.find(row=>row.official);
    const reconcileNext = focused || rows.find(row=>row.fundsReviewed<row.fundsRequired&&row.imported) || rows.find(row=>row.fundsReviewed<row.fundsRequired);
    const recordNext = focused || rows.find(row=>row.reviewed<row.required);
    const primary = (label,attributes,anchor=false) => `<${anchor?'a':'button'} class="button primary task-primary-action" ${attributes}><span>${esc(label)}</span><span aria-hidden="true">→</span></${anchor?'a':'button'}>`;
    const actions = {
      import:{title:model.pending.length?'先确认账单所属店铺':'导入本月账单',description:model.pending.length?'先把原件放回正确的店铺，再继续本月核对。':'一次只处理一家店，先取得原件，再检查预览并提交。',target:model.pending.length?'当前待处理':importNext?'当前店铺':'处理范围',shop:model.pending.length?model.pending.length+' 份账单待确认归属':importNext?.name||'本月店铺账单',meta:model.pending.length?month+' · 归属确认前不计入店铺':importNext?importNext.platform+' · '+month+(importNext.imported?' · 可补充原件':' · 待取得账单'):month,hint:'看到“导入成功”后，继续处理下一家店。',micro:model.pending.length?['核查原件来源','确认所属店铺','继续本月导入']:['取到官方原件','检查店铺与预览','确认导入，继续下一家'],html:model.pending.length||!importNext?primary('去确认账单归属',`href="${route('imports',month,focused?.id||'all')}"`,true):primary(importNext.manual?'去登记本月记录':importNext.imported?'选择账单，补充原件':'选择账单，开始导入',`data-task-import="${esc(importNext.id)}"`)},
      reconcile:{title:'核对这家店的资金',description:'先看本月收支和日期范围，再追溯差异与实际到账。',target:'当前店铺',shop:reconcileNext?.name||'本月全部店铺',meta:reconcileNext?reconcileNext.platform+' · '+month:month,hint:'核对后，在店铺与数据中保存整月核对依据。',micro:['查看本月收支','追溯差异和原件','登记核对依据'],html:primary('打开本店，开始核对',`href="${route('reconciliation',month,reconcileNext?.id||'all')}"`,true)},
      records:{title:'把本月缺少的记录补齐',description:'按缺口补齐经营、收款和费用，不漏掉任何一家店。',target:recordNext?'先处理这家店':'本月范围',shop:recordNext?.name||'全部店铺记录',meta:recordNext?recordNext.platform+' · '+month:month,hint:`本月还有 ${gaps} 项数据覆盖待确认，逐项核实后登记。`,micro:['查看缺少哪些记录','补齐收款和费用','确认整月数据覆盖'],html:primary('查看缺口，开始补齐',`href="${route('sources',month,recordNext?.id||'all')}"`,true)},
      report:{title:'生成一份月报，检查结果',description:'汇集当前已保存的数据，检查缺口和异常后再确认。',target:'本次生成范围',shop:'全部店铺 · 本月月报',meta:month+' · '+(latestJob?'已有历史生成记录':'待生成草稿'),hint:'账单变化后请重新生成；历史草稿不能证明当前数据完整。',micro:['生成月报草稿','检查缺口和异常','准备确认本月'],html:primary('生成月报，开始检查','data-action="job"')},
      delivery:{title:locked?'本月已锁定，导出交付':'确认本月结果，准备交付',description:locked?'保存全部店铺本月 Excel，检查文件后再交付。':'最后核对月报和缺口，确认锁定后导出交付文件。',target:'交付范围',shop:'全部店铺 · 本月 Excel',meta:month+(locked?' · 已锁定':' · 待确认'),hint:gaps?`当前仍有 ${gaps} 项数据缺口，确认与交付时需保留说明。`:'点击导出后请检查下载文件，再完成交付。',micro:locked?['导出本月 Excel','检查文件内容','附缺口说明后交付']:['检查全部店铺结果','确认并锁定月份','导出 Excel 交付'],html:locked?primary('导出本月 Excel',`href="${exportURL}"`,true):primary('检查月报，确认本月',`href="${route('close',month)}"`,true)}
    };
    if(!rows.length)Object.assign(actions.import,{description:'暂无可处理店铺，请联系管理员在设置中维护店铺。',shop:'等待管理员配置店铺',hint:'配置完成后，从导入本月账单开始。',html:badge('等待管理员配置店铺')});
    const hero = key => {
      const stage=stages.find(item=>item.key===key),action=actions[key],isCurrent=key===next;
      return `<section class="task-next" data-current-task="${next}" data-view-task="${key}" aria-label="${isCurrent?'当前需要处理的任务':'查看流程任务'}"><div class="task-hero-top"><span class="task-current-label">${isCurrent?'现在做':'查看流程'} · 第 ${String(stage.number).padStart(2,'0')} 步</span><span class="task-stage-caption">${esc(stage.evidence)}</span>${isCurrent?'':'<button type="button" class="task-resume" data-task-resume>返回当前任务 ↗</button>'}</div><div class="task-hero-main"><div class="task-hero-copy"><h3>${esc(action.title)}</h3><p class="task-hero-description">${esc(action.description)}</p><div class="task-target"><span>${esc(action.target)}</span><strong>${esc(action.shop)}</strong><small>${esc(action.meta)}</small></div><div class="task-hero-actions">${action.html}</div><p class="task-hero-hint">${esc(action.hint)}</p></div><div class="task-hero-art" aria-hidden="true"><span>${String(stage.number).padStart(2,'0')}</span><svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPaths[key]}"/></svg></div></div><ol class="task-micro-steps">${action.micro.map((text,index)=>`<li><span>${index+1}</span><strong>${esc(text)}</strong></li>`).join('')}</ol></section>`;
    };
    const storeRows = mode => shown.length ? [...shown].sort((a,b)=>Number(b.id===(mode==='import'?importNext?.id:reconcileNext?.id))-Number(a.id===(mode==='import'?importNext?.id:reconcileNext?.id))).map(row => `<div class="task-shop-row${row.id===(mode==='import'?importNext?.id:reconcileNext?.id)?' is-focused':''}"><div class="task-shop-name"><strong>${esc(row.name)}</strong><small>${esc(row.platform)}</small></div><div class="task-shop-evidence">${mode==='import'?`<span>${esc(row.importedLabel)}</span><small>${esc(row.statementLabel)}</small>`:`<span>${row.fundsReviewed} / ${row.fundsRequired} 项资金覆盖已核对</span><small>${esc(row.statementLabel)}${row.comparisonLabel?' · '+esc(row.comparisonLabel):''}</small>`}</div>${mode==='import'?`<button class="button small" data-task-import="${esc(row.id)}">${row.manual?'去登记':row.imported?'补充账单':'导入账单'}</button>`:`<a class="button small" href="${route('reconciliation',month,row.id)}">核对这家店 →</a>`}</div>`).join(''):'<p class="task-empty">暂无可处理店铺，请联系管理员在设置中维护店铺。</p>';
    const step = (key,title,body) => `<details id="task-panel-${key}" class="task-step" data-task-step="${key}" ${next===key?'open':'hidden'}><summary><span class="task-step-heading"><strong>${title}</strong></span><span class="task-step-chevron" aria-hidden="true">⌄</span></summary><div class="task-step-body">${body}</div></details>`;
    const root=$('#content');
    root.innerHTML = `<div class="task-center"><section class="task-month-heading"><div><h2>${labelMonth} · 月度工作</h2><p>按流程往下做，每次做好当前这一项。</p></div><div class="task-month-tools">${badge(locked?'本月已锁定':'草稿 · 待确认',locked?'success':'')}<div class="task-month-controls"><label>任务月份<input type="month" id="task-month" aria-label="任务月份" value="${month}" required></label><label>处理店铺<select id="task-shop" aria-label="处理店铺"><option value="all">全部店铺</option>${rows.map(row=>`<option value="${esc(row.id)}" ${row.id===selected?'selected':''}>${esc(row.platform+' · '+row.name)}</option>`).join('')}</select></label></div></div></section>${focused?`<div class="task-focus-note">正在聚焦 ${esc(focused.platform+' · '+focused.name)}。月报、锁定和最终导出仍包含全部店铺。<a href="${route('tasks',month)}">查看全部店铺任务</a></div>`:''}<div class="task-workspace"><aside class="task-flow" aria-label="本月工作流程"><div class="task-flow-heading"><strong>本月处理流程</strong><span>共 ${stages.length} 步 · 逐项往下做</span></div><ol class="task-flow-list">${stages.map(stage=>`<li class="task-flow-item${stage.key===next?' is-current is-selected':''}${stage.kind?' is-'+stage.kind:''}"><button type="button" class="task-flow-button" data-task-stage="${stage.key}" aria-controls="task-panel-${stage.key}" aria-expanded="${stage.key===next}" ${stage.key===next?'aria-current="step"':''}><span class="task-flow-number">${String(stage.number).padStart(2,'0')}</span><span class="task-flow-copy"><strong>${stage.label}</strong><small>${esc(stage.evidence)}</small></span><span class="task-flow-state">${stage.key===next?'现在做':stage.kind==='verified'?'已核对':stage.kind==='ready'?'已准备':'待处理'}</span></button></li>`).join('')}</ol></aside><div class="task-stage-area"><div id="task-hero-host">${hero(next)}</div><section class="task-detail-area"><div class="task-detail-heading"><span>这一步的处理明细</span><h3 id="task-detail-title">${esc(stages.find(stage=>stage.key===next).title)}</h3></div><div class="task-list" aria-label="步骤处理明细">
      ${step('import','各店账单处理队列',`${model.pending.length?`<div class="task-inline-warning">${model.pending.length} 份本月账单所属店铺待确认。<a href="${route('imports',month)}">去处理归属 →</a></div>`:''}${storeRows('import')}<div class="task-step-actions"><a href="${route('imports',month,selected)}">查看导入历史与原件 →</a></div><p class="task-help">文件已取得与整月完整是两件事。线下、代发使用手工登记，其他平台可用通用报表导入。</p>`)}
      ${step('reconcile','各店资金核对队列',`${storeRows('reconcile')}<p class="task-help">日期覆盖完整、平台参考相符分别展示；完成人工核对后，在「店铺与数据」登记覆盖结果。</p><div class="task-step-actions"><a href="${route('sources',month,selected)}">登记核对结果 →</a></div>`)}
      ${step('records','本月待补数据',`${shown.map(row=>`<div class="task-coverage-row"><strong>${esc(row.name)}</strong><div>${row.datasets.map(status).join('')}</div><a href="${route('sources',month,row.id)}">登记结果 →</a></div>`).join('')}<div class="task-step-actions"><a class="button small" href="${route('sources',month,selected)}">查看待补项目</a><a href="${route('manual',month,selected)}">线下与代发记账 →</a><a href="${route('freight',month,selected)}">导入本月运费 →</a></div><p class="task-help">${model.freight.count?'运费已登记 '+model.freight.count+' 条，合计 ¥ '+money(model.freight.total)+'。':'本月尚未登记运费。'}已登记不表示费用完整，运费单独统计。</p>`)}
      ${step('report','月报生成与记录',`<p class="task-body-copy">${latestJob?'本月曾生成月报。账单或核对结果变化后，请重新生成并检查；历史生成记录不代表当前数据完整。':'生成一次月报并检查全部店铺。尚有缺口也可以生成草稿，缺失数据会保留标记。'}</p><div class="task-step-actions"><button class="button small" data-action="job">检查并重新生成月报</button>${latestJob?`<a href="/api/jobs/${esc(latestJob.id)}/report">下载上次生成的月报 ↗</a>`:''}</div>`)}
      ${step('delivery','本月确认与交付',`<p class="task-body-copy">${locked?gaps?'本月已锁定，快照中仍有 '+gaps+' 项数据未完整核对。请交付时保留缺口说明；需要修改时先按原流程明确解锁。':'本月已锁定，导出全部店铺本月 Excel，检查文件后再交付。':gaps?'还有 '+gaps+' 项数据未完整核对。请先检查缺口；若带缺口锁定，缺失标记也会保留。':'查看月报确认页，核对结果后确认锁定。'}</p><div class="task-step-actions"><a class="button small" href="${route('close',month)}">${locked?'查看锁定结果':'查看月报确认'}</a><a class="button small" href="${exportURL}">导出${locked?'本月':'草稿'} Excel ↗</a></div><p class="task-help">导出后检查下载文件；点击导出不会自动标记为已交付。</p>`)}
    </div></section></div></div><p class="task-bottom-note">任务状态来自当前月份保存的账单、覆盖核对与锁定记录。缺失数据保留为空。</p></div>`;
    const showStage = key => {
      const stage=stages.find(item=>item.key===key);if(!stage)return;
      $('#task-hero-host').innerHTML=hero(key);$('#task-detail-title').textContent=stage.title;
      root.querySelectorAll?.('[data-task-step]').forEach(panel=>{panel.hidden=panel.dataset.taskStep!==key;panel.open=panel.dataset.taskStep===key;});
      root.querySelectorAll?.('[data-task-stage]').forEach(button=>{const active=button.dataset.taskStage===key;button.setAttribute('aria-expanded',String(active));button.closest('.task-flow-item').classList.toggle('is-selected',active);});
    };
    root.onclick=e=>{const button=e.target.closest?.('[data-task-stage],[data-task-resume]');if(button)showStage(button.hasAttribute('data-task-resume')?next:button.dataset.taskStage);};
    const monthInput=$('#task-month'),shopInput=$('#task-shop');
    const changeScope=()=>{
      const nextMonth=monthInput.value;
      if(!isMonth(nextMonth)){ctx.toast?.('请选择有效的任务月份');monthInput.value=month;return;}
      const nextShop=rows.some(row=>row.id===shopInput.value)?shopInput.value:'all';
      location.hash=route('tasks',nextMonth,nextShop);
    };
    monthInput.onchange=changeScope;shopInput.onchange=changeScope;
  }
  return {render,destroy:()=>{sequence++;}};
}

export function personnelTaskFlow(model,{role,employeeReady=false,submission={}}={}){
  if(role==='employee')return {steps:[{key:'import',title:'按店铺导入账单',description:'选择原件，检查预览后提交。'},{key:'records',title:'补齐经营和费用资料',description:'缺什么补什么，完成后提交给老板。'}],next:model.locked?'locked':submission.state==='submitted'?'submitted':!model.rows.length?'import':employeeReady?'handoff':model.pending.length||model.rows.some(row=>row.official&&!row.imported)?'import':'records'};
  if(role==='boss')return {steps:[{key:'reconcile',title:'逐店核对资金',description:'核对货款、平台结算与实际到账。'},{key:'report',title:'检查并生成月报',description:'检查当月缺口、异常和月报内容。'},{key:'delivery',title:'确认锁定并交付',description:'确认结果后锁定本月，再导出交付。'}],next:model.locked?'delivery':model.fundsReviewed<model.fundsRequired?'reconcile':!model.latestJob?'report':'delivery'};
  return {steps:[{key:'import'},{key:'reconcile'},{key:'records'},{key:'report'},{key:'delivery'}],next:model.next};
}

function createRoleTaskCenter(ctx){
  const {$,esc,money,api,boot,state}=ctx;let sequence=0;
  const route=(view,month,shop='all',extra={})=>'#'+view+'?'+new URLSearchParams({month,shop_id:shop,...extra});
  const badge=(text,kind='')=>`<span class="task-status ${kind}">${esc(text)}</span>`;
  async function render(valid=()=>true){
    const ticket=++sequence,month=String(state.period).slice(0,7);if(!isMonth(month))throw Error('请选择要处理的月份');
    const summary=await api('/api/task-center?month='+month);if(ticket!==sequence||!valid())return;
    if(summary.month!==month)throw Error('月份已变化，请重新读取任务');
    const personnel=summary.personnel||boot.personnel,role=personnel?.role;if(!['employee','boss','member'].includes(role))throw Error('请先选择工作身份');
    Object.assign(boot.personnel,personnel);
    const employee=role==='employee',submission=summary.submission||{state:'draft'},taskShops=summary.closeInfo?.locked?boot.shops.filter(shop=>(summary.sources||[]).some(source=>source.id===shop.id)):boot.shops,model=monthlyTaskModel({month,shops:taskShops,sources:summary.sources||[],closeInfo:summary.closeInfo||{month},pending:summary.pending||[],jobs:summary.jobs||[],statements:summary.statements||[]});
    const flow=personnelTaskFlow(model,{role,employeeReady:summary.employeeReady,submission}),focused=model.rows.find(row=>row.id===state.shop),shown=focused?[focused]:model.rows;
    const staffDatasets=model.rows.flatMap(row=>row.datasets.filter(dataset=>['operations','expense'].includes(dataset.dataset))),staffReviewed=staffDatasets.filter(dataset=>dataset.status==='full').length;
    const exportURL='/api/export?'+new URLSearchParams({period:month,grain:'month',shop:'all'});
    const submissionText=submission.state==='submitted'?'资料已提交，等待核对资金和检查月报':submission.state==='changed'?'提交后的资料有变动，请完成检查后重新提交':'资料尚未提交，请准备本月资料';
    const actions={
      import:{title:model.pending.length?'先确认账单所属店铺':'下一步：按店铺导入本月账单',note:model.pending.length?`${model.pending.length} 份本月账单所属店铺尚未确认。`:'从一家店开始，导入后继续下一家。',html:`<a class="button primary" href="${route('imports',month,focused?.id||'all')}">去导入账单</a>`},
      records:{title:'下一步：补齐自己的资料',note:`经营数据和单店费用已有 ${staffReviewed} / ${staffDatasets.length} 项确认完整。`,html:`<a class="button primary" href="${route('sources',month,focused?.id||'all')}">查看待补项目</a>`},
      handoff:{title:'我的部分已完成，提交给老板',note:submission.state==='changed'?'资料有变动，重新提交后老板会看到最新交接状态。':'提交本月资料，后续资金核对和月报由老板处理。',html:`<button class="button primary" id="task-handoff">${submission.state==='changed'?'重新提交给老板':'提交给老板'}</button>`},
      submitted:{title:'资料已提交，等待老板处理',note:'老板接下来会核对资金、检查月报并确认交付。',html:badge('已提交','success')},
      locked:{title:'本月已锁定，资料准备已结束',note:'如需补充本月资料，请联系老板按原流程处理。',html:badge('本月已锁定','success')},
      reconcile:{title:'下一步：逐店核对资金',note:'打开一家店，核对这家店本月的账单和真实到账。',html:`<a class="button primary" href="${route('reconciliation',month,focused?.id||'all')}">开始核对资金</a>`},
      report:{title:'下一步：检查本月月报',note:'根据已保存数据生成月报，并检查缺口和异常。',html:'<button class="button primary" data-action="job">检查并生成月报</button>'},
      delivery:{title:model.locked?'本月已锁定，可以导出交付':'最后一步：确认本月结果',note:model.locked?(model.gaps?`锁定结果中仍有 ${model.gaps} 项数据缺口。`:'导出全部店铺本月数据，检查文件后交付。'):'检查月报结果和缺口，再确认锁定。',html:model.locked?`<a class="button primary" href="${exportURL}">导出本月 Excel ↗</a>`:`<a class="button primary" href="${route('close',month)}">检查并确认本月</a>`}
    };
    const importNext=focused||model.rows.find(row=>row.official&&!row.imported)||model.rows.find(row=>row.official)||model.rows[0];
    const reconcileNext=focused||model.rows.find(row=>row.fundsReviewed<row.fundsRequired&&row.imported)||model.rows.find(row=>row.fundsReviewed<row.fundsRequired);
    const recordNext=focused||model.rows.find(row=>row.datasets.some(dataset=>['operations','expense'].includes(dataset.dataset)&&dataset.status!=='full'));
    const primary=(label,attributes,anchor=false)=>`<${anchor?'a':'button'} class="button primary task-primary-action" ${attributes}><span>${esc(label)}</span><span aria-hidden="true">→</span></${anchor?'a':'button'}>`;
    const workflowActions={
      import:{...actions.import,target:model.pending.length?'当前待处理':'当前店铺',shop:model.pending.length?model.pending.length+' 份账单待确认归属':importNext?.name||'本月店铺账单',meta:importNext?importNext.platform+' · '+month:month,hint:'看到导入成功后，继续处理下一家店。',micro:model.pending.length?['核查原件来源','确认所属店铺','继续本月导入']:['取到官方原件','检查店铺与预览','确认导入，继续下一家'],html:model.pending.length||!importNext?primary('去确认账单归属',`href="${route('imports',month,focused?.id||'all')}"`,true):primary(importNext.manual?'去登记本月记录':'选择账单，开始导入',`data-task-import="${esc(importNext.id)}"`)},
      records:{...actions.records,target:recordNext?'先处理这家店':'本月资料',shop:recordNext?.name||'全部店铺资料',meta:recordNext?recordNext.platform+' · '+month:month,hint:'完成经营资料和费用记录后，回到这里提交给老板。',micro:['查看缺少哪些资料','补齐经营与费用','提交资料给老板'],html:primary('查看缺口，开始补齐',`href="${route('sources',month,recordNext?.id||'all')}"`,true)},
      handoff:{...actions.handoff,target:'本次交接范围',shop:'全部店铺 · 本月准备资料',meta:month+(submission.state==='changed'?' · 资料已更新':' · 已准备好'),hint:'提交后，资金核对、月报检查与最终确认由老板处理。',micro:['确认资料已齐','提交本月资料','等待老板处理'],html:primary(submission.state==='changed'?'重新提交给老板':'提交给老板','id="task-handoff"')},
      submitted:{...actions.submitted,target:'已交接的资料',shop:'全部店铺 · 本月准备资料',meta:month+' · 已提交',hint:'如后续资料发生变化，这里会提示重新提交。',micro:['资料准备完成','已提交给老板','等待老板处理']},
      locked:{...actions.locked,target:'本月状态',shop:'本月资料已经锁定',meta:month+' · 已锁定',hint:'需要修订时，由老板按原流程处理。',micro:['资料准备结束','结果已经锁定','等待后续安排']},
      reconcile:{...actions.reconcile,target:'当前店铺',shop:reconcileNext?.name||'本月全部店铺',meta:reconcileNext?reconcileNext.platform+' · '+month:month,hint:'员工交接不等于资金已核对，核对后保存资金覆盖结果。',micro:['查看本月收支','追溯差异和原件','登记核对依据'],html:primary('打开本店，开始核对',`href="${route('reconciliation',month,reconcileNext?.id||'all')}"`,true)},
      report:{...actions.report,target:'本次检查范围',shop:'全部店铺 · 本月月报',meta:month+' · '+(model.latestJob?'已有历史生成记录':'待生成草稿'),hint:'资料变化后请重新生成；历史草稿不代表本月已经确认。',micro:['生成月报草稿','检查缺口和异常','准备确认本月'],html:primary('生成月报，开始检查','data-action="job"')},
      delivery:{...actions.delivery,target:'交付范围',shop:'全部店铺 · 本月 Excel',meta:month+(model.locked?' · 已锁定':' · 待确认'),hint:model.gaps?`当前保留 ${model.gaps} 项数据缺口，交付时请说明。`:'导出后检查文件内容，再完成交付。',micro:model.locked?['导出本月 Excel','检查文件内容','保存并交付']:['检查全部店铺结果','确认并锁定月份','导出 Excel 交付'],html:model.locked?primary('导出本月 Excel',`href="${exportURL}"`,true):primary('检查月报，确认本月',`href="${route('close',month)}"`,true)}
    };
    if(!model.rows.length)Object.assign(workflowActions.import,{note:'暂无可处理店铺，请联系管理员在设置中维护店铺。',shop:'等待管理员配置店铺',hint:'配置完成后，从导入本月账单开始。',html:badge('等待管理员配置店铺')});
    const importRows=shown.map(row=>`<div class="task-shop-row"><div class="task-shop-name"><strong>${esc(row.name)}</strong><small>${esc(row.platform)}</small></div><div class="task-shop-evidence"><span>${esc(row.importedLabel)}</span><small>${esc(row.statementLabel)}</small></div><button class="button small" data-task-import="${esc(row.id)}">${row.manual?'去登记':'导入账单'}</button></div>`).join('');
    const sourcesRows=shown.map(row=>`<div class="task-coverage-row"><strong>${esc(row.name)}</strong><div>${row.datasets.filter(dataset=>['operations','expense'].includes(dataset.dataset)).map(dataset=>`<span class="task-dataset ${dataset.status==='full'?'is-reviewed':''}">${esc(dataset.label)} · ${dataset.status==='full'?'已核对':dataset.status==='partial'?'待核对':'未取得'}</span>`).join('')}</div><a href="${route('sources',month,row.id)}">补齐资料 →</a></div>`).join('');
    const bodies={
      import:`${model.pending.length?`<div class="task-inline-warning">${model.pending.length} 份本月账单等待确认所属店铺。<a href="${route('imports',month,state.shop)}">去处理 →</a></div>`:''}${importRows||'<p class="task-empty">暂无可处理店铺，请联系管理员在设置中维护店铺。</p>'}<div class="task-step-actions"><a href="${route('imports',month,state.shop)}">查看导入记录 →</a></div>`,
      records:`${sourcesRows}<div class="task-step-actions"><a class="button small" href="${route('sources',month,state.shop)}">查看待补项目</a><a href="${route('manual',month,state.shop)}">线下与代发登记 →</a><a href="${route('freight',month,state.shop)}">导入本月运费 →</a></div><p class="task-help">补齐经营资料和单店费用，再按流程核对资金和月报。</p>`,
      reconcile:`${shown.map(row=>`<div class="task-shop-row"><div class="task-shop-name"><strong>${esc(row.name)}</strong><small>${esc(row.platform)}</small></div><div class="task-shop-evidence"><span>${row.fundsReviewed} / ${row.fundsRequired} 项资金覆盖已核对</span><small>${esc(row.statementLabel)}${row.comparisonLabel?' · '+esc(row.comparisonLabel):''}</small></div><a class="button small" href="${route('reconciliation',month,row.id)}">核对这家店 →</a></div>`).join('')}<div class="task-step-actions"><a href="${route('sources',month,state.shop)}">登记资金核对结果 →</a></div><p class="task-help">提交资料不代表资金已核对；文件范围与平台参考分别展示。</p>`,
      report:`<p class="task-body-copy">${model.latestJob?'本月已有月报生成记录。数据变化后，请重新生成并检查；历史生成记录不表示当前结果已确认。':'按当前已保存资料生成月报，逐项检查缺口和异常。'}</p><div class="task-step-actions"><button class="button small" data-action="job">检查并生成月报</button>${model.latestJob?`<a href="/api/jobs/${esc(model.latestJob.id)}/report">下载上次月报 ↗</a>`:''}<a href="${route('close',month)}">查看月报确认 →</a></div>`,
      delivery:`<p class="task-body-copy">${model.locked?model.gaps?'本月已锁定，结果保留 '+model.gaps+' 项数据缺口，请在交付时说明。':'本月已锁定，导出全部店铺本月 Excel，检查后交付。':model.gaps?'本月还有 '+model.gaps+' 项数据缺口，确认前请逐项检查。':'请检查月报结果，确认后锁定本月。'}</p><div class="task-step-actions"><a class="button small" href="${route('close',month)}">${model.locked?'查看锁定结果':'查看月报确认'}</a><a class="button small" href="${exportURL}">导出${model.locked?'本月':'草稿'} Excel ↗</a></div><p class="task-help">点击导出不会自动标记为已交付。</p>`
    };
    const statuses={import:model.officialCount?model.imported+' / '+model.officialCount+' 家已取得账单':'按实际来源登记',records:staffReviewed+' / '+staffDatasets.length+' 项资料已核对',reconcile:model.fundsReviewed+' / '+model.fundsRequired+' 项资金覆盖已核对',report:model.latestJob?'已有生成记录':'待检查',delivery:model.locked?'已锁定':'待确认'};
    const titleMonth=`${Number(month.slice(0,4))} 年 ${Number(month.slice(5,7))} 月`;
    const stages=taskFlowStages(model,{role}).map(stage=>({...stage,evidence:statuses[stage.key],kind:employee&&stage.key==='records'?staffDatasets.length&&staffReviewed===staffDatasets.length?'verified':'':stage.kind}));
    const currentStage=stages.some(stage=>stage.key===flow.next)?flow.next:employee?'records':'delivery';
    const iconPaths={import:'M35 20h37l19 19v57H35z M72 20v20h19 M60 78V49 M48 61l12-12 12 12 M48 86h24',records:'M30 23h60v76H30z M43 42l5 5 9-10 M43 63l5 5 9-10 M67 43h10 M67 64h10 M43 84h34',reconcile:'M29 19h51v77H29z M41 36h25 M41 49h20 M76 64a16 16 0 1 0 0 32 16 16 0 0 0 0-32 M87 91l13 13',report:'M28 20h49l17 17v63H28z M77 20v18h17 M42 83V65 M59 83V53 M76 83V45 M40 89h41',delivery:'M24 38h30l10 10h35v45H24z M51 72l10 10 20-23 M35 28h48v20'};
    const hero=key=>{
      const stage=stages.find(item=>item.key===key),isCurrent=key===currentStage,effective=employee&&model.locked?'locked':isCurrent&&!stages.some(item=>item.key===flow.next)?flow.next:key,action=workflowActions[effective],waiting=['submitted','locked'].includes(effective);
      return `<section class="task-next ${waiting?'is-waiting':''}" data-current-task="${currentStage}" data-view-task="${key}" aria-label="${isCurrent?'当前需要处理的任务':'查看流程任务'}"><div class="task-hero-top"><span class="task-current-label">${waiting?'工作状态':isCurrent?'现在做':'查看流程'} · 第 ${String(stage.number).padStart(2,'0')} 步</span><span class="task-stage-caption">${esc(stage.evidence)}</span>${isCurrent?'':'<button type="button" class="task-resume" data-task-resume>返回当前任务 ↗</button>'}</div><div class="task-hero-main"><div class="task-hero-copy"><h3>${esc(action.title)}</h3><p class="task-hero-description">${esc(action.note)}</p><div class="task-target"><span>${esc(action.target)}</span><strong>${esc(action.shop)}</strong><small>${esc(action.meta)}</small></div><div class="task-hero-actions">${action.html}</div><p class="task-hero-hint">${esc(action.hint)}</p></div><div class="task-hero-art" aria-hidden="true"><span>${String(stage.number).padStart(2,'0')}</span><svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPaths[key]}"/></svg></div></div><ol class="task-micro-steps">${action.micro.map((text,index)=>`<li><span>${index+1}</span><strong>${esc(text)}</strong></li>`).join('')}</ol></section>`;
    };
    const root=$('#content');
    root.innerHTML=`<div class="task-center" data-personnel="${role}">
      <section class="task-month-heading"><div><h2>${titleMonth} · ${role==='member'?'本月任务':employee?'员工任务':'老板任务'}</h2><p>${employee?'做好资料准备，完成后提交给老板。':'核对资金，检查月报，最后确认交付。'}</p></div><div class="task-month-tools">${badge(employee?model.locked?'本月已锁定':submission.state==='submitted'?'资料已提交':submission.state==='changed'?'资料有变动':'资料准备中':model.locked?'本月已锁定':'草稿 · 待确认',employee&&(submission.state==='submitted'||model.locked)||!employee&&model.locked?'success':'')}<div class="task-month-controls"><label>任务月份<input type="month" id="task-month" aria-label="任务月份" value="${month}" required></label><label>处理店铺<select id="task-shop" aria-label="处理店铺"><option value="all">全部店铺</option>${model.rows.map(row=>`<option value="${esc(row.id)}" ${row.id===state.shop?'selected':''}>${esc(row.platform+' · '+row.name)}</option>`).join('')}</select></label></div></div></section>
      ${!employee||!model.locked&&submission.state==='changed'?`<section class="task-handoff is-${esc(submission.state)}"><div><strong>${employee?'资料交接':'员工资料交接'}</strong><p>${esc(submissionText)}${submission.submittedAt?' · '+esc(new Date(submission.submittedAt).toLocaleString('zh-CN')):''}</p></div>${badge(submission.state==='submitted'?'员工已提交':submission.state==='changed'?'需要重新提交':'等待员工提交',submission.state==='submitted'?'success':'')}</section>`:''}
      ${focused?`<div class="task-focus-note">当前聚焦 ${esc(focused.name)}。<a href="${route('tasks',month)}">查看全部店铺任务</a></div>`:''}
      <div class="task-workspace"><aside class="task-flow" aria-label="我的本月工作流程"><div class="task-flow-heading"><strong>${employee?'员工资料准备流程':'老板核对确认流程'}</strong><span>共 ${stages.length} 步 · 每次做好当前一项</span></div><ol class="task-flow-list">${stages.map(stage=>`<li class="task-flow-item${stage.key===currentStage?' is-current is-selected':''}${stage.kind?' is-'+stage.kind:''}"><button type="button" class="task-flow-button" data-task-stage="${stage.key}" aria-controls="task-panel-${stage.key}" aria-expanded="${stage.key===currentStage}" ${stage.key===currentStage?'aria-current="step"':''}><span class="task-flow-number">${String(stage.number).padStart(2,'0')}</span><span class="task-flow-copy"><strong>${stage.label}</strong><small>${esc(stage.evidence)}</small></span><span class="task-flow-state">${stage.key===currentStage?flow.next==='submitted'?'等待老板':flow.next==='locked'?'已锁定':'现在做':stage.kind==='verified'?'已核对':stage.kind==='ready'?'已准备':'待处理'}</span></button></li>`).join('')}</ol></aside>
      <div class="task-stage-area"><div id="task-hero-host">${hero(currentStage)}</div><section class="task-detail-area"><div class="task-detail-heading"><span>这一步的处理明细</span><h3 id="task-detail-title">${esc(stages.find(stage=>stage.key===currentStage).title)}</h3></div><div class="task-list" aria-label="我的步骤处理明细">${stages.map(stage=>`<details id="task-panel-${stage.key}" class="task-step" data-task-step="${stage.key}" ${stage.key===currentStage?'open':'hidden'}><summary><span class="task-step-heading"><strong>${stage.title}</strong></span><span class="task-step-chevron" aria-hidden="true">⌄</span></summary><div class="task-step-body">${bodies[stage.key]}</div></details>`).join('')}</div></section></div></div>
      <p class="task-bottom-note">任务状态按所选月份保存，缺失资料保留为空。</p></div>`;
    const showStage=key=>{
      const stage=stages.find(item=>item.key===key);if(!stage)return;
      $('#task-hero-host').innerHTML=hero(key);$('#task-detail-title').textContent=stage.title;
      root.querySelectorAll?.('[data-task-step]').forEach(panel=>{panel.hidden=panel.dataset.taskStep!==key;panel.open=panel.dataset.taskStep===key;});
      root.querySelectorAll?.('[data-task-stage]').forEach(button=>{const selected=button.dataset.taskStage===key;button.setAttribute('aria-expanded',String(selected));button.closest('.task-flow-item').classList.toggle('is-selected',selected);});
      const handoffButton=$('#task-handoff');if(handoffButton)handoffButton.onclick=submitHandoff;
    };
    root.onclick=e=>{const button=e.target.closest?.('[data-task-stage],[data-task-resume]');if(button)showStage(button.hasAttribute('data-task-resume')?currentStage:button.dataset.taskStage);};
    const monthInput=$('#task-month'),shopInput=$('#task-shop');const changeScope=()=>{if(!isMonth(monthInput.value)){ctx.toast?.('请选择有效的任务月份');monthInput.value=month;return;}location.hash=route('tasks',monthInput.value,model.rows.some(row=>row.id===shopInput.value)?shopInput.value:'all');};monthInput.onchange=changeScope;shopInput.onchange=changeScope;
    const submitHandoff=async e=>{e.stopPropagation?.();const button=e.currentTarget;button.disabled=true;try{await api('/api/personnel/handoff',{month,revision:summary.staffRevision});ctx.toast?.('资料已提交给老板');if(ctx.render)await ctx.render();else await render(valid);}catch(error){ctx.toast?.(error.message);if(button.isConnected)button.disabled=false;}};
    const submitButton=$('#task-handoff'),bottomButton=$('#task-handoff-bottom');if(submitButton)submitButton.onclick=submitHandoff;if(bottomButton)bottomButton.onclick=submitHandoff;
  }
  return {render,destroy:()=>{sequence++;}};
}

export function createTaskCenter(ctx){return ctx.boot.personnel?.selected?createRoleTaskCenter(ctx):createLegacyTaskCenter(ctx);}
