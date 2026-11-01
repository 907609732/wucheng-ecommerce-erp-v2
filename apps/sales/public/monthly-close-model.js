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

