/**
 * 千牛「收支账单」分类定义、页面文案识别与完整性规则。
 *
 * 重要边界：
 * - 这里的“收入账单/支出账单/涉税信息报送账单”只是账本口径名称，不是对平台真实命名的声明。
 * - 平台真实的账单方向名、子类型名、导出中心入口名，一律由运行时从页面上发现并写入取账记录，
 *   适配器只做“发现 + 映射 + 无法映射时停止”，禁止把猜测的按钮、图标、坐标、字段写进代码。
 * - 未接通（未能发现且无法唯一确认）的类型明确标记为“未接通”，不按零处理。
 */

/** 账本口径的账单类型。页面上发现的实际名称会作为 label 保留。 */
export const BILL_KINDS = Object.freeze({
  income: '收入账单',
  expense: '支出账单',
  tax: '涉税信息报送账单'
});

/**
 * 把页面上实际发现的分类/子类型名称映射到账本口径。
 * 规则按 order 升序匹配，首个命中生效；命中多个不同类型视为歧义（返回 null，交由人工确认）。
 */
export const CATEGORY_RULES = Object.freeze([
  { kind: 'tax', order: 10, pattern: /涉税|报送|税务|纳税信息/ },
  { kind: 'tax', order: 20, pattern: /涉税信息报送账单|信息报送账单/ },
  { kind: 'expense', order: 30, pattern: /支出|费用|佣金|服务费|技术服务费|扣除|退款支出/ },
  { kind: 'income', order: 40, pattern: /收入|收款|结算|入账|货款/ }
]);

const norm = value => String(value ?? '')
  .replace(/[\u200b-\u200d\ufeff\u00a0]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * 将页面上发现的一个可见文本映射到账本口径。
 * @returns {{kind: string|null, ambiguous: boolean}}
 */
export function classifyLabel(label) {
  const text = norm(label);
  if (!text) return { kind: null, ambiguous: false };
  const hits = new Set();
  for (const rule of [...CATEGORY_RULES].sort((a, b) => a.order - b.order)) {
    if (rule.pattern.test(text)) hits.add(rule.kind);
  }
  if (hits.size === 1) return { kind: [...hits][0], ambiguous: false };
  if (hits.size > 1) return { kind: null, ambiguous: true };
  return { kind: null, ambiguous: false };
}

/** 登录墙文案。命中即停止自动化并转人工。 */
export const LOGIN_PATTERNS = Object.freeze([
  /扫码登录/, /密码登录/, /短信登录/, /请登录/, /登录后/, /欢迎登录/, /账号登录/,
  /安全验证/, /身份验证/, /请先登录/
]);

/** 必须人工接管的验证文案（不破解、不绕过）。 */
export const CAPTCHA_PATTERNS = Object.freeze([
  /验证码/, /滑块/, /拖动/, /图形验证/, /短信验证/, /人脸/, /实人认证/
]);

/** 明确“该账期没有账单”的页面文案。与“查询失败/未生成”区分。 */
export const EMPTY_PATTERNS = Object.freeze([
  /当前查询条件下数据为空/, /暂无数据/, /暂无账单/, /没有符合条件/, /无符合条件/,
  /没有查询到/, /未查询到数据/, /无数据/
]);

/** 查询失败/服务异常文案。不能当作零账单。 */
export const ERROR_PATTERNS = Object.freeze([
  /查询失败/, /系统繁忙/, /服务异常/, /加载失败/, /请求失败/, /网络异常/, /请稍后重试/,
  /数据加载中.*失败/
]);

/** 导出条数 / 时间范围限制文案；提取到的数字进入取账记录，用来说明是否需要分片。 */
export const LIMIT_PATTERNS = Object.freeze([
  { key: 'rows', pattern: /(?:最多|上限|不超过|限制|单次)[^0-9]{0,12}([\d,]{3,})\s*(?:条|行)/ },
  { key: 'rows', pattern: /([\d,]{3,})\s*(?:条|行)[^0-9]{0,8}(?:上限|限制|以内|以内为|封顶)/ },
  { key: 'rows', pattern: /导出[^0-9]{0,12}([\d,]{3,})\s*(?:条|行)/ },
  { key: 'days', pattern: /(?:时间范围|账期|查询范围)[^0-9]{0,12}(\d{1,3})\s*(?:天|日)/ },
  { key: 'months', pattern: /(?:时间范围|账期|查询范围)[^0-9]{0,12}(\d{1,2})\s*(?:个月|月)/ },
  { key: 'size', pattern: /(?:文件|导出)[^0-9]{0,12}(\d{1,4})\s*(?:MB|M)/ }
]);

/** 异步导出中心相关入口文案。 */
export const EXPORT_CENTER_PATTERNS = Object.freeze([
  /导出中心/, /下载中心/, /导出记录/, /导出任务/, /我的导出/, /报表中心/
]);

/** 导出按钮文案（仅语义匹配，命中必须唯一，否则停止）。 */
export const EXPORT_PATTERNS = Object.freeze([
  /^导出账单$/, /^导出全部$/, /^导\s*出$/, /^批量导出$/, /^导出明细$/, /^下载账单$/, /^导出清单$/
]);

/** 导出中心里“已完成、可下载”的状态文案。 */
export const EXPORT_READY_PATTERNS = Object.freeze([
  /已完成/, /可下载/, /生成成功/, /导出成功/, /下载/
]);

/** 导出中心里“仍在生成”的状态文案。 */
export const EXPORT_PENDING_PATTERNS = Object.freeze([
  /生成中/, /排队中/, /处理中/, /等待中/, /导出中/, /正在生成/
]);

/** 导出中心里“失败”的状态文案。 */
export const EXPORT_FAILED_PATTERNS = Object.freeze([
  /失败/, /已取消/, /异常/, /过期/, /已失效/
]);

const firstMatch = (patterns, text) => patterns.some(p => p.test(text));

export function looksLikeLogin(text) { return firstMatch(LOGIN_PATTERNS, norm(text)); }
export function looksLikeCaptcha(text) { return firstMatch(CAPTCHA_PATTERNS, norm(text)); }
export function looksLikeEmpty(text) { return firstMatch(EMPTY_PATTERNS, norm(text)); }
export function looksLikeError(text) { return firstMatch(ERROR_PATTERNS, norm(text)); }
export function looksLikeExportCenter(text) { return firstMatch(EXPORT_CENTER_PATTERNS, norm(text)); }

/** 从页面文案中提取平台自述的限制（不推导、不改写，只转述）。 */
export function extractLimits(text) {
  const source = norm(text);
  const limits = [];
  for (const { key, pattern } of LIMIT_PATTERNS) {
    const match = source.match(pattern);
    if (!match) continue;
    const raw = match[1];
    const value = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    limits.push({ key, value, raw: norm(match[0]).slice(0, 120) });
  }
  const seen = new Set();
  return limits.filter(item => { const id = `${item.key}:${item.value}`; if (seen.has(id)) return false; seen.add(id); return true; });
}

/** 页面自述的总条数。 */
export function extractRecordCount(text) {
  const match = norm(text).match(/(?:共|合计|总计)\s*([\d,]{1,9})\s*(?:条|笔|行|项)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * 分片计划。只有在页面确实申报了条数上限、且能发现可用拆分维度时才生成；
 * 否则返回 needsManual，提示人工在后台按平台支持的方式拆分。
 */
/**
 * 平台自述的拆分维度提示。真机页面上出现过「建议缩小查询时间范围后，再进行导出」，
 * 这是平台自己给出的超限处理方式，必须先认出来再用，不能自己发明拆分维度。
 */
export function extractShardHints(text) {
  const value = String(text || '');
  const hints = [];
  if (/缩小[^。；;\n]{0,14}(时间范围|日期范围|查询范围)|按(天|日|周|月)(拆分|分别|分批)|分批导出|分次导出|分段导出/.test(value)) {
    hints.push({ key: 'time-range', raw: '平台提示：建议缩小查询时间范围后再导出' });
  }
  if (/按(账单类型|业务大类|币种)(拆分|分别|分批)/.test(value)) hints.push({ key: 'category', raw: '平台提示：按账单类型/业务大类/币种拆分' });
  return hints;
}

const pad2 = value => String(value).padStart(2, '0');

/** 把账期按天切成连续、无重叠的区间；用于超限时的分片清单。 */
export function dayRanges(month) {
  const matched = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!matched) return [];
  const year = Number(matched[1]); const monthIndex = Number(matched[2]);
  const last = new Date(year, monthIndex, 0).getDate();
  return Array.from({ length: last }, (_, i) => {
    const day = pad2(i + 1);
    return { index: i + 1, total: last, from: `${year}-${pad2(monthIndex)}-${day}`, to: `${year}-${pad2(monthIndex)}-${day}` };
  });
}

export function planShards({ recordCount, limits, dimensions, hints, month }) {
  const rowLimit = (limits || []).filter(l => l.key === 'rows').reduce((min, l) => (min === null || l.value < min ? l.value : min), null);
  if (!rowLimit || recordCount === null || recordCount <= rowLimit) {
    return { shards: [], rowLimit, dimension: null, needsManual: false, reason: '' };
  }
  const declared = (hints || []).filter(h => h && h.key);
  const usable = (dimensions || []).filter(d => d && d.key);
  const timeRange = declared.find(h => h.key === 'time-range') || usable.find(d => d.key === 'time-range');
  if (timeRange) {
    // 平台只支持“缩小时间范围”这一种维度时，按天给出连续且不重叠的分片清单。
    const shards = dayRanges(month);
    return {
      shards, rowLimit, dimension: 'time-range', needsManual: true,
      reason: `本账期约 ${recordCount} 条，超过页面自述上限 ${rowLimit} 条。平台提示按时间范围拆分，已按天生成 ${shards.length} 个连续区间清单；按天自动分片取账尚未通过真机验证，请人工按清单分次导出后导入（分片清单已记录，保证不重叠、不遗漏）`
    };
  }
  if (!usable.length && !declared.length) {
    return { shards: [], rowLimit, dimension: null, needsManual: true, reason: `本账期约 ${recordCount} 条，超过页面自述上限 ${rowLimit} 条，但页面上未发现任何平台支持的拆分维度提示；请在后台自行拆分后导入，不自动猜测拆分方式` };
  }
  const count = Math.ceil(recordCount / rowLimit);
  return { shards: Array.from({ length: count }, (_, i) => ({ index: i + 1, total: count })), rowLimit, dimension: (declared[0] || usable[0]).key, needsManual: false, reason: `本账期约 ${recordCount} 条，超过上限 ${rowLimit} 条，已按 ${count} 片拆取` };
}

/**
 * 完整性判定：一个账单类型只有在“所有已发现的子类型都收到文件”时才算完成。
 * 没发现子类型时，类型自身就是唯一单元。
 */
export function completeness({ kind, discoveredSubtypes, receivedSubtypes }) {
  const expected = (discoveredSubtypes && discoveredSubtypes.length ? discoveredSubtypes : [kind]).slice().sort();
  const received = new Set((receivedSubtypes || []).filter(Boolean));
  const missing = expected.filter(item => !received.has(item));
  return { expected, missing, complete: expected.length > 0 && missing.length === 0, unsupported: expected.length === 0 };
}
