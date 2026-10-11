/**
 * 页面适配器：把“看页面”和“做判断”分开。
 *
 * - 页面侧只做一件通用的事：把当前可见的控件、文本、表格表头导成结构化清单（snapshot）。
 * - 判断逻辑全部在本模块用纯函数完成，不依赖 DOM，可以离线单测。
 * - 所有动作只按“语义文本 + 唯一性”定位元素，绝不使用固定坐标或固定等待时间。
 * - 任何无法唯一确认的控件一律返回停止状态，交给人工处理，不猜测。
 */
import { classifyLabel, extractLimits, extractRecordCount, extractShardHints, looksLikeCaptcha, looksLikeEmpty, looksLikeError, looksLikeLogin } from './finance-bills.mjs';

/** 页面内执行的通用页面扫描脚本（字符串形式，注入到渲染进程）。 */
export const SNAPSHOT_SCRIPT = `(() => {
  const norm = value => String(value == null ? '' : value).replace(/[\\u200b-\\u200d\\ufeff\\u00a0]/g, '').replace(/\\s+/g, ' ').trim();
  const isVisible = el => {
    try {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
    } catch { return false; }
  };
  const escapeId = value => (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  const selectorFor = el => {
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id) && document.querySelectorAll('#' + escapeId(el.id)).length === 1) return '#' + escapeId(el.id);
    const parts = []; let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const cls = Array.from(node.classList || []).filter(c => /^[A-Za-z][\\w-]*$/.test(c)).slice(0, 3);
      if (cls.length) part += '.' + cls.map(escapeId).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const ownText = el => {
    let value = '';
    for (const child of el.childNodes) if (child.nodeType === 3) value += child.nodeValue;
    return norm(value);
  };
  // 未验收千牛 CSS：仅具名当前店铺 section 的直接明确文本字段；否则只读昵称、人工补名。
  const IDENTITY_HEADER = 'header,[role="banner"]';
  const IDENTITY_LABEL = /当前店铺名称|当前店铺|店铺名称|店铺名|当前登录账号|当前账号|登录账号|店铺账号|账号|店铺ID|店铺Id|店铺id|店铺编号|经营主体名称|经营主体|店铺主体名称|店铺主体|主体名称|主体|纳税人识别号|统一社会信用代码|税号/;
  const AGGREGATE_IDENTITY = new RegExp('(?:' + IDENTITY_LABEL.source + ')[：: ]');
  const NON_IDENTITY = 'main,article,aside,nav,table,[role="grid"],[role="row"],[role="list"],[role="listitem"],[role="navigation"],[role="menu"],[role="menuitem"],[role="dialog"]';
  // 页头必须属于文档，不能是嵌套语义页头或具名交易区域内的局部 banner。
  const identityHeaders = new Set(Array.from(document.querySelectorAll(IDENTITY_HEADER)).filter(header =>
    isVisible(header) && !header.getAttribute('aria-label') && !header.getAttribute('aria-labelledby')
      && !header.parentElement?.closest(IDENTITY_HEADER + ',section,[aria-label],[aria-labelledby],[role],' + NON_IDENTITY)
  ));
  const identityRegionOf = el => {
    if (el.closest?.(NON_IDENTITY)) return null;
    const header = el.closest?.(IDENTITY_HEADER);
    if (!identityHeaders.has(header)) return null;
    const section = el.parentElement;
    if (section?.tagName !== 'SECTION' || section.parentElement !== header
      || !['当前登录店铺', '当前店铺身份'].includes(norm(section.getAttribute('aria-label')))) return null;
    // 独立卡片/子区域/聚合文本不能继承当前店铺来源；也不混读 aria/title 中的另一字段。
    if (el.children?.length || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('role')) return null;
    const text = ownText(el);
    const label = IDENTITY_LABEL.exec(text);
    const value = label ? text.slice(label[0].length) : '';
    if (!label || label.index !== 0 || !/^\\s*[：:]\\s*\\S/.test(value)
      || (text.match(/[：:]/g) || []).length !== 1 || AGGREGATE_IDENTITY.test(value)) return null;
    return section;
  };
  const identityRegions = new Set();
  for (const header of identityHeaders) for (const node of header.querySelectorAll('*')) {
    const region = identityRegionOf(node);
    if (region && isVisible(node) && /^当前店铺(?:名称)?\\s*[：:]\\s*\\S/.test(ownText(node))) identityRegions.add(region);
  }
  // 同店名也不能证明多个区域属于同一主体；来源不唯一就全部保持未知。
  const identitySourceFor = el => identityRegions.size === 1 && identityRegions.has(identityRegionOf(el)) ? 'semantic-current-shop-header' : '';
  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,option,[role],[onclick],[tabindex]';
  const entries = [];
  let scanned = 0, truncated = false;
  const nodes = document.querySelectorAll('*');
  for (const el of nodes) {
    if (entries.length >= 3000) { truncated = true; break; }
    scanned += 1;
    if (scanned > 30000) { truncated = true; break; }
    const tag = el.tagName.toLowerCase();
    if (['script','style','noscript','meta','link','head','html','br'].includes(tag)) continue;
    const interactive = el.matches(INTERACTIVE);
    const label = ownText(el);
    if (!interactive && (!label || label.length > 120)) continue;
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    entries.push({
      i: entries.length, tag, identitySource: identitySourceFor(el),
      role: norm(el.getAttribute('role')),
      type: norm(el.getAttribute('type')),
      text: norm(el.innerText && (interactive || label.length > 60) ? el.innerText.slice(0, 200) : (label || el.innerText)) || label,
      aria: norm(el.getAttribute('aria-label')),
      title: norm(el.getAttribute('title')),
      placeholder: norm(el.getAttribute('placeholder')),
      name: norm(el.getAttribute('name')),
      id: norm(el.id),
      cls: Array.from(el.classList || []).slice(0, 6).join(' '),
      href: norm(el.getAttribute('href')).slice(0, 300),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      checked: el.checked === true,
      readOnly: el.readOnly === true,
      value: /^(password|hidden)$/i.test(el.getAttribute('type') || '') ? '' : norm(el.value).slice(0, 120),
      selector: selectorFor(el),
      // 所属表格行在文档里的序号：导出记录里同名下载链接的选择器往往完全一样，
      // 只有“第几行”才能把动作绑到具体那一条导出任务上。
      row: (() => { const tr = el.closest && el.closest('tr'); if (!tr) return -1; return Array.prototype.indexOf.call(document.querySelectorAll('tr'), tr); })(),
      x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)
    });
  }
  const tables = Array.from(document.querySelectorAll('table')).slice(0, 20).map(table => ({
    headers: Array.from(table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')).slice(0, 40).map(cell => norm(cell.innerText).slice(0, 60)).filter(Boolean),
    rows: table.querySelectorAll('tbody tr').length
  })).filter(t => t.headers.length);
  // 遮挡层：公告弹窗、消息浮层会挡住点击，必须先识别出来再决定是否关闭。
  const OVERLAY_SELECTOR = '[class*=dialog],[class*=modal],[class*=popup],[class*=notice],[class*=layer],[class*=overlay],[class*=drawer],[role=dialog]';
  const overlays = [];
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (overlays.length >= 8) break;
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 40) continue;
    const overlayText = norm(el.innerText).slice(0, 240);
    if (!overlayText) continue;
    const closers = [];
    for (const node of el.querySelectorAll('a,button,[role=button],[tabindex],[class*=close],[class*=icon]')) {
      if (closers.length >= 6) break;
      if (!isVisible(node)) continue;
      const label = norm(node.innerText || node.getAttribute('aria-label') || node.getAttribute('title')).slice(0, 20);
      const cls = Array.from(node.classList || []).slice(0, 3).join(' ');
      if (!label && !/close|guanbi|icon-close/i.test(cls)) continue;
      closers.push({ label, selector: selectorFor(node), cls });
    }
    overlays.push({ text: overlayText, selector: selectorFor(el), closers });
  }
  let text = '';
  try { text = norm(document.body ? document.body.innerText : '').slice(0, 240000); } catch { text = ''; }
  return { url: String(location.href), title: norm(document.title), text, entries, tables, truncated, overlays, readyState: String(document.readyState) };
})()`;

/** 页面内执行动作的通用脚本构造器；动作只按语义 + 唯一性定位，坐标不参与。 */
export function actionScript(action) {
  const payload = JSON.stringify(action);
  return `(() => {
    const action = ${payload};
    const norm = value => String(value == null ? '' : value).replace(/[\\u200b-\\u200d\\ufeff\\u00a0]/g, '').replace(/\\s+/g, ' ').trim();
    const isVisible = el => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05; } catch { return false; } };
    const describe = el => ({ tag: el.tagName.toLowerCase(), text: norm(el.innerText).slice(0, 80), id: norm(el.id), cls: Array.from(el.classList || []).slice(0, 4).join(' ') });
    const resolve = (spec) => {
      // 不传 spec 时沿用顶层动作的 selector/expect；否则 click 会退化成“匹配所有候选”。
      const source = spec || action;
      const expect = source.expect || {};
      const selector = source.selector;
      let candidates = [];
      // 指定了行号时只在那一行里找：否则多条导出记录会共用同一个选择器而无法区分。
      const scopeRow = Number.isInteger(source.row) && source.row >= 0 ? (document.querySelectorAll('tr')[source.row] || null) : null;
      if (scopeRow) {
        try { candidates = Array.from(scopeRow.querySelectorAll(selector || 'a,button,[role=button],td,span')); } catch { candidates = []; }
      } else if (selector) { try { candidates = Array.from(document.querySelectorAll(selector)); } catch { candidates = []; } }
      candidates = candidates.filter(isVisible);
      if (!candidates.length) { try { candidates = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[role],[tabindex]')).filter(isVisible); } catch { candidates = []; } }
      const matchText = el => { const t = norm(el.innerText) || norm(el.value) || norm(el.getAttribute('aria-label')); return expect.text ? (t === expect.text || t.startsWith(expect.text)) : true; };
      let hits = candidates.filter(matchText);
      if (expect.id) { const byId = hits.filter(el => el.id === expect.id); if (byId.length) hits = byId; }
      // 行内容在点击前必须仍然匹配：导出记录会异步刷新，行号可能已经指向另一条任务。
      const rowTextMismatch = Boolean(scopeRow && source.rowText && !norm(scopeRow.innerText).includes(norm(source.rowText)));
      return { hits, total: candidates.length, rowTextMismatch };
    };
    try {
      if (action.op === 'click') {
        const { hits, total, rowTextMismatch } = resolve();
        if (rowTextMismatch) return { ok: false, reason: 'row_changed', message: '导出记录行内容在点击前已变化，已停止以避免误下载旧任务', samples: [] };
        if (hits.length !== 1) return { ok: false, reason: hits.length === 0 ? 'not_found' : 'ambiguous', total, samples: hits.slice(0, 8).map(describe) };
        const el = hits[0];
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled', samples: [describe(el)] };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, samples: [describe(el)] };
      }
      if (action.op === 'setMonth' || action.op === 'setValue') {
        // 账期控件可能是“起止两个输入框”的日期区间组件，需要一次性把区间两端都写好。
        const specs = Array.isArray(action.targets) && action.targets.length
          ? action.targets
          : [{ selector: action.selector, value: action.value, expect: action.expect }];
        let changed = 0; let total = 0; let found = 0;
        const samples = [];
        for (const spec of specs) {
          const hit = resolve(spec);
          total += hit.total;
          if (!hit.hits.length) { samples.push({ selector: spec.selector, hits: 0 }); continue; }
          found += 1;
          for (const el of hit.hits) {
            const current = norm(el.value);
            if (current === norm(spec.value)) continue;
            const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : (el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : null);
            try {
              const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
              if (setter && setter.set) setter.set.call(el, spec.value); else el.value = spec.value;
            } catch { el.value = spec.value; }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            changed += 1;
          }
          samples.push(...hit.hits.slice(0, 2).map(describe));
        }
        return { ok: found === specs.length, changed, total, missed: specs.length - found, samples };
      }
      if (action.op === 'press') {
        const { hits } = resolve();
        if (hits.length !== 1) return { ok: false, reason: 'ambiguous' };
        const el = hits[0];
        el.focus();
        const key = action.key || 'Enter';
        for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: key === 'Enter' ? 13 : 0, which: key === 'Enter' ? 13 : 0, bubbles: true }));
        return { ok: true };
      }
      if (action.op === 'readText') {
        return { ok: true, text: norm(document.body ? document.body.innerText : '').slice(0, 240000) };
      }
      return { ok: false, reason: 'unsupported_op' };
    } catch (error) { return { ok: false, reason: 'exception', message: String(error && error.message || error) }; }
  })()`;
}

const normText = value => String(value ?? '').replace(/[\u200b-\u200d\ufeff\u00a0]/g, '').replace(/\s+/g, ' ').trim();
const labelOf = entry => normText(entry?.text || entry?.aria || entry?.title || entry?.placeholder || entry?.value);

const CLICKABLE_TAGS = new Set(['a', 'button', 'summary', 'option', 'input', 'select', 'textarea']);
const CLICKABLE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'radio', 'checkbox', 'switch']);

export function isClickable(entry) {
  if (!entry) return false;
  if (CLICKABLE_TAGS.has(entry.tag)) return true;
  if (entry.role && CLICKABLE_ROLES.has(entry.role.toLowerCase())) return true;
  return false;
}

/** 表格式（tab/分段/筛选）候选：结构提示 + 标签可映射到账本口径。 */
function isTabLike(entry) {
  if (!entry) return false;
  if ((entry.role || '').toLowerCase() === 'tab') return true;
  if (entry.type === 'radio') return true;
  return /\b(tab|tabs|segment|segmented|nav|menu|filter|category|billtype|bill-type|radio)\b/i.test(entry.cls || '');
}

function matchPatterns(entries, patterns) {
  const list = [];
  for (const entry of entries) {
    const label = labelOf(entry);
    if (!label) continue;
    if (patterns.some(pattern => pattern.test(label))) list.push(entry);
  }
  return list;
}

function uniqueByText(entries) {
  const seen = new Set();
  return entries.filter(entry => { const key = labelOf(entry); if (seen.has(key)) return false; seen.add(key); return true; });
}

function groupKey(entry) {
  const parts = String(entry.selector || '').split(' > ');
  return parts.length > 1 ? parts.slice(0, -1).join(' > ') : (parts[0] || 'root');
}

/**
 * 发现页面上的账单分类。按“结构提示优先、语义兜底”的顺序，并把无法唯一归属的名称保留下来。
 * 页面通常有两级 tab（账单类型 + 子类型），这里只把“能覆盖最多不同账本口径”的那一组当作账单类型，
 * 其余 tab 组留给 discoverSubtypes 作为子类型，避免把子类型误当成账单类型。
 * @param {object} snapshot
 * @param {Record<string,string>} overrides 人工映射：页面文字 -> 账本口径
 */
export function discoverCategories(snapshot, overrides = {}) {
  const entries = (snapshot?.entries || []).filter(isClickable);
  const structural = uniqueByText(entries.filter(isTabLike).filter(entry => labelOf(entry) && labelOf(entry).length <= 30));
  let candidates = structural;
  let source = 'structure';
  let categoryGroup = '';
  if (structural.length >= 2) {
    const groups = new Map();
    for (const entry of structural) { const key = groupKey(entry); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); }
    let best = null;
    for (const [key, list] of groups) {
      const kinds = new Set(list.map(entry => normText(overrides[normText(labelOf(entry))]) || classifyLabel(labelOf(entry)).kind).filter(Boolean));
      const score = kinds.size * 1000 + list.length;
      if (!best || score > best.score) best = { score, list, key };
    }
    if (best && best.list.length >= 2) { candidates = best.list; categoryGroup = best.key; }
  } else {
    candidates = uniqueByText(entries.filter(entry => classifyLabel(labelOf(entry)).kind));
    source = 'text';
  }
  const discovered = [];
  const unmapped = [];
  const ambiguous = [];
  for (const entry of candidates) {
    const label = labelOf(entry);
    if (!label || label.length > 30) continue;
    const override = normText(overrides[label]);
    if (override) { discovered.push({ label, kind: override, entry, source: 'override' }); continue; }
    const mapped = classifyLabel(label);
    if (mapped.kind) discovered.push({ label, kind: mapped.kind, entry, source });
    else if (mapped.ambiguous) ambiguous.push({ label, entry });
    else unmapped.push({ label, entry });
  }
  const kinds = new Set(discovered.map(item => item.kind));
  const missing = ['income', 'expense', 'tax'].filter(kind => !kinds.has(kind));
  const xs = candidates.map(entry => Number(entry.x)).filter(value => Number.isFinite(value));
  return {
    discovered, unmapped, ambiguous, missing, source, categoryGroup,
    categoryMinX: xs.length ? Math.min(...xs) : null,
    structural: structural.map(labelOf).slice(0, 30)
  };
}

/** 左侧导航/菜单/面包屑的容器语义，这些不是账单子类型。 */
const NAV_TOKEN = /(^|[^a-z])(menu|nav|navbar|sidebar|aside|sider|tree|breadcrumb|subnav|left-?nav)([^a-z]|$)/i;

/**
 * 发现子类型（账单视图 tab，例如真机上的「月汇总 / 日汇总 / 收入明细」）。
 *
 * 真机页面上左侧还有一整列业务导航（资金管理、对账管理、发票管理、保证金…），
 * 它们同样是 tab 式控件，必须排除，否则取账会点到「保证金」「申请发票」上。
 * 排除依据：容器语义（menu/nav/aside）、真实路由链接 href、以及与账单分类不在同一横向区域。
 * 逐级放宽，保证不会因为过严而漏掉真正的子类型。
 */
export function discoverSubtypes(snapshot, kindLabels = [], excludeLabels = [], options = {}) {
  const excluded = new Set([...kindLabels, ...excludeLabels].map(normText).filter(Boolean));
  const categoryGroup = options.categoryGroup || '';
  const categoryMinX = Number.isFinite(options.categoryMinX) ? options.categoryMinX : null;
  const entries = uniqueByText((snapshot?.entries || []).filter(isClickable).filter(isTabLike).filter(entry => labelOf(entry)));
  const usable = entries
    .filter(entry => !excluded.has(labelOf(entry)))
    .filter(entry => { const label = labelOf(entry); return label.length > 0 && label.length <= 30; });
  const notNav = entry => !NAV_TOKEN.test(`${entry.selector || ''} ${entry.cls || ''}`) && !(entry.tag === 'a' && entry.href && /[\/#]/.test(entry.href));
  const sameRegion = entry => categoryMinX === null || !Number.isFinite(Number(entry.x)) || Number(entry.x) >= categoryMinX - 12;
  const tier1 = usable.filter(entry => notNav(entry) && sameRegion(entry) && (!categoryGroup || groupKey(entry) !== categoryGroup));
  const tier2 = usable.filter(entry => notNav(entry) && sameRegion(entry));
  const tier3 = usable.filter(sameRegion);
  const chosen = tier1.length ? tier1 : (tier2.length ? tier2 : tier3);
  return chosen.map(entry => ({ label: labelOf(entry), entry }));
}

/** 月份/账期控件分组：真机上是「起止两个输入框」的日期区间组件，必须整体处理。 */
export function findMonthGroups(snapshot) {
  const entries = (snapshot?.entries || []).filter(entry => entry.tag === 'input' && !entry.disabled);
  const months = entries.filter(entry => entry.type === 'month' || /^\d{4}-\d{2}(-\d{2})?$/.test(normText(entry.value)) || /月份|账期|账单月/.test(normText(entry.placeholder)));
  const groups = new Map();
  for (const entry of months) {
    const key = (entry.selector || '').split(' > ').slice(0, -1).join(' > ') || entry.id || 'root';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].map(([key, list]) => ({
    key, entries: list, range: list.length >= 2,
    start: list[0], end: list[list.length - 1],
    values: list.map(item => normText(item.value))
  }));
}

/** 兼容旧调用：返回所有账期输入框。 */
export function findMonthControls(snapshot) {
  return findMonthGroups(snapshot).flatMap(group => group.entries.map(entry => ({ entry, value: normText(entry.value), label: labelOf(entry) })));
}

const padDay = value => String(value).padStart(2, '0');

/**
 * 按页面当前显示的格式推导要填写的账期值。
 * 真机显示的是 `2026-09`（月粒度），若页面用完整日期则自动补齐当月首末日。
 */
export function monthValuesFor(month, observedValue = '') {
  const matched = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!matched) return null;
  const year = Number(matched[1]); const monthIndex = Number(matched[2]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normText(observedValue))) {
    const lastDay = new Date(year, monthIndex, 0).getDate();
    return { start: `${year}-${padDay(monthIndex)}-01`, end: `${year}-${padDay(monthIndex)}-${padDay(lastDay)}`, format: 'date' };
  }
  return { start: month, end: month, format: 'month' };
}

/** 店铺身份核对：页面文本里是否出现设置的可见账号。 */
export function verifyShopIdentity(snapshot, account) {
  const wanted = normText(account);
  if (!wanted) return { matched: null, reason: '未设置后台可见账号，无法核对店铺身份，已停止自动化' };
  const haystack = `${snapshot?.text || ''}\n${(snapshot?.entries || []).map(labelOf).join('\n')}`;
  if (!haystack.includes(wanted)) return { matched: false, reason: `当前页面未出现店铺账号「${wanted}」，无法确认店铺身份，已停止以避免串店` };
  return { matched: true, reason: '' };
}

/** 唯一性检查辅助：返回 {entry, candidates}。 */
export function pickUnique(snapshot, patterns, predicate = isClickable) {
  const candidates = matchPatterns((snapshot?.entries || []).filter(predicate), patterns);
  return candidates.length === 1 ? { entry: candidates[0], candidates } : { entry: null, candidates };
}

/**
 * 导出入口。真机上同时存在「导出PDF」和「导出Excel」两个按钮，
 * 而账单取数只能吃 Excel，所以必须显式锁定 Excel，绝不把 PDF 当作账单数据。
 */
export function findExportEntry(snapshot) {
  const entries = (snapshot?.entries || []).filter(isClickable).filter(entry => labelOf(entry));
  const excel = uniqueByText(entries.filter(entry => /excel|xls/i.test(labelOf(entry)) && /导出|下载/.test(labelOf(entry))));
  if (excel.length === 1) return { entry: excel[0], candidates: excel, ok: true, format: 'excel' };
  if (excel.length > 1) return { entry: null, candidates: excel, ok: false, format: 'excel', reason: '页面有多个 Excel 导出入口，无法唯一确认' };

  const { entry, candidates } = pickUnique(snapshot, [
    /^导出账单$/, /^导出全部$/, /^导\s*出$/, /^批量导出$/, /^导出明细$/, /^下载账单$/, /^导出清单$/, /^导出当前$/
  ]);
  if (entry) return { entry, candidates, ok: true, format: 'generic' };
  // 兜底不做去重：同名但有多个入口时必须判为歧义，不能随手挑一个。
  // 同时排除 PDF 等非账单数据产物，否则只剩「导出PDF」时会被误当成可以取账单。
  const fuzzy = entries.filter(item => /导出|下载账单/.test(labelOf(item)) && !/pdf/i.test(labelOf(item)));
  if (fuzzy.length === 1) return { entry: fuzzy[0], candidates: fuzzy, ok: true, fuzzy: true, format: 'generic' };
  return { entry: null, candidates: fuzzy.length ? fuzzy : candidates, ok: false, format: 'generic' };
}

/** 异步导出记录页；真机上的入口文案是「历史下载记录」。 */
export function findExportCenterEntry(snapshot) {
  const { entry, candidates } = pickUnique(snapshot, [
    /^历史下载记录$/, /^下载记录$/, /^导出中心$/, /^下载中心$/, /^导出记录$/, /^导出任务$/, /^我的导出$/, /^历史导出$/
  ]);
  if (entry) return { entry, candidates, ok: true };
  const fuzzy = (snapshot?.entries || []).filter(isClickable).filter(item => /导出中心|下载中心|导出记录|导出任务|下载记录|历史下载/.test(labelOf(item)));
  return { entry: fuzzy.length === 1 ? fuzzy[0] : null, candidates: fuzzy, ok: fuzzy.length === 1 };
}

/** 只允许关闭明确无害的提示层按钮，避免误关正式弹窗。 */
const SAFE_DISMISS_LABEL = /^(关闭|关闭弹窗|知道了|我知道了|知道了，谢谢|不再提示|我已知晓|稍后再说|知道了谢谢)$/;

/**
 * 遮挡层关闭入口。真机页面上有「收支账单更新了～」公告弹窗和「重要消息/预警通知」浮层，
 * 不清掉就会挡住后续点击。只关闭文案明确无害、且位于弹层内部的按钮。
 */
export function findDismissEntries(snapshot, alreadyDismissed = []) {
  const done = new Set((alreadyDismissed || []).map(normText));
  const found = [];
  for (const overlay of snapshot?.overlays || []) {
    for (const closer of overlay.closers || []) {
      const label = normText(closer.label);
      const keyName = label || `icon:${normText(closer.cls)}`;
      if (done.has(keyName)) continue;
      const safeLabel = label && SAFE_DISMISS_LABEL.test(label);
      const safeIcon = !label && /close|guanbi/i.test(closer.cls || '');
      if (!safeLabel && !safeIcon) continue;
      found.push({ key: keyName, overlay: String(overlay.text || '').slice(0, 60), selector: closer.selector, label, entry: null });
    }
  }
  return found;
}

export function findQueryEntry(snapshot) {
  const { entry, candidates } = pickUnique(snapshot, [/^查询$/, /^查\s*询$/, /^搜索$/, /^立即查询$/, /^筛\s*选$/]);
  return { entry, candidates, ok: Boolean(entry) };
}

/** 页面整体状态判定。 */
export function detectState(snapshot) {
  const text = snapshot?.text || '';
  const limits = extractLimits(text);
  const recordCount = extractRecordCount(text);
  const base = { limits, recordCount, url: snapshot?.url || '', title: snapshot?.title || '' };
  if (looksLikeCaptcha(text)) return { ...base, state: 'needs_captcha', message: '页面出现验证码或安全验证，需要人工完成验证后在店铺窗口继续' };
  if (looksLikeLogin(text)) return { ...base, state: 'needs_login', message: '需要在店铺窗口完成登录（扫码/短信/密码）后再继续' };
  if (looksLikeError(text)) return { ...base, state: 'query_failed', message: '页面提示查询失败或服务异常，本次不记为零账单，可稍后重试' };
  if (looksLikeEmpty(text)) return { ...base, state: 'empty', message: '页面明确提示该查询条件下没有账单数据' };
  return { ...base, state: 'ok', message: '' };
}

/**
 * 单步决策：观察一次 snapshot，给出下一步该做什么。
 * 纯函数，不触碰 DOM，可离线单测。
 */
export function planStep(snapshot, ctx = {}) {
  const { month, account = '', kind = 'income', doneSubtypes = [], requestedExport = false, overrides = {},
    selectedCategory = '', selectedSubtype = '', excludeSubtypes = [], dismissedPopups = [] } = ctx;
  const detected = detectState(snapshot);
  if (detected.state !== 'ok') return { state: detected.state, message: detected.message, evidence: detected, action: null };

  // 每一次决策前都重新核对店铺身份：不能确认就停止，绝不继续操作。
  const shop = verifyShopIdentity(snapshot, account);
  if (shop.matched !== true) return { state: 'needs_shop_review', message: shop.reason, evidence: { ...detected, account }, action: null };

  // 真机页面上有公告弹窗与「重要消息」浮层，会挡住后续点击；先清掉再继续。
  const dismiss = findDismissEntries(snapshot, dismissedPopups);
  if (dismiss.length) {
    return {
      state: 'dismiss_popup', message: `正在关闭页面提示层「${dismiss[0].overlay || dismiss[0].key}」`,
      evidence: { overlays: (snapshot?.overlays || []).length, dismissKey: dismiss[0].key },
      action: { op: 'click', selector: dismiss[0].selector, expect: {} }
    };
  }

  const groups = findMonthGroups(snapshot);
  if (!groups.length) {
    return { state: 'needs_manual', message: '未发现月份/账期控件，页面结构可能与适配器不一致，请人工核对后继续', evidence: { ...detected, months: [] }, action: null };
  }
  const mismatched = [];
  for (const group of groups) {
    if (group.values.every(value => value === month)) continue;
    const values = monthValuesFor(month, group.values[0]);
    if (!values) return { state: 'needs_manual', message: `账期 ${month} 的格式无法识别，请人工设置账期后继续`, evidence: { months: group.values }, action: null };
    mismatched.push({ group, values });
  }
  if (mismatched.length) {
    const first = mismatched[0];
    const shared = first.group.entries.every(entry => entry.selector === first.group.entries[0].selector);
    // 起止两个输入框若共用同一选择器且是月粒度，一次写入即可，避免把起止互相覆盖。
    const targets = shared && first.values.format === 'month'
      ? [{ selector: first.group.entries[0].selector, value: month, expect: { text: labelOf(first.group.entries[0]) } }]
      : first.group.entries.map((entry, index) => ({ selector: entry.selector, value: index === 0 ? first.values.start : first.values.end, expect: { text: labelOf(entry), id: entry.id } }));
    return {
      state: 'set_month',
      message: `正在把账期设置为 ${month}${first.group.range ? '（起止日期）' : ''}`,
      evidence: { months: first.group.values, format: first.values.format, range: first.group.range },
      action: { op: 'setMonth', targets }
    };
  }

  const categories = discoverCategories(snapshot, overrides);
  if (!categories.discovered.some(item => item.kind === kind)) {
    const detail = categories.unmapped.concat(categories.ambiguous).map(item => item.label).join('、');
    return {
      state: 'needs_manual',
      message: `未能在页面上唯一确认「${kind}」账单入口${detail ? `（发现的其它名称：${detail}）` : ''}；请在店铺设置中补充分类映射，或人工核对后继续`,
      evidence: { ...detected, categories }, action: null
    };
  }

  const target = categories.discovered.find(item => item.kind === kind);
  const subtypes = discoverSubtypes(snapshot, categories.discovered.map(item => item.label), excludeSubtypes,
    { categoryGroup: categories.categoryGroup, categoryMinX: categories.categoryMinX });
  const pendingSubtype = subtypes.find(item => !doneSubtypes.includes(item.label));

  if (!requestedExport) {
    // 分类与子类型分别跟踪，避免选中子类型后被误判成“不在该账单类型上”而反复来回点击。
    if (normText(selectedCategory) !== normText(target.label)) {
      return {
        state: 'pick_category', message: `正在切换到「${target.label}」`,
        evidence: { categories, subtypes: subtypes.map(s => s.label) },
        action: { op: 'click', selector: target.entry.selector, expect: { text: labelOf(target.entry), id: target.entry.id } }
      };
    }
    if (pendingSubtype && normText(selectedSubtype) !== normText(pendingSubtype.label)) {
      return {
        state: 'pick_subtype', message: `正在切换到子类型「${pendingSubtype.label}」`,
        evidence: { categories, subtypes: subtypes.map(s => s.label) },
        action: { op: 'click', selector: pendingSubtype.entry.selector, expect: { text: labelOf(pendingSubtype.entry), id: pendingSubtype.entry.id } }
      };
    }
    const query = findQueryEntry(snapshot);
    if (query.ok && ctx.queryRequested !== true) {
      return { state: 'query', message: '正在执行查询', evidence: { categories }, action: { op: 'click', selector: query.entry.selector, expect: { text: labelOf(query.entry), id: query.entry.id } } };
    }
    const exporter = findExportEntry(snapshot);
    if (!exporter.ok) {
      return {
        state: 'needs_manual',
        message: exporter.reason || (exporter.candidates.length > 1
          ? `页面有多个疑似导出入口（${exporter.candidates.map(labelOf).join('、')}），无法唯一确认，请在店铺设置中指定要用的导出按钮`
          : '未发现唯一的 Excel 导出入口，请在店铺窗口人工导出，或补充分类映射后重试'),
        evidence: { ...detected, exporters: exporter.candidates.map(labelOf) }, action: null
      };
    }
    return {
      state: 'request_export',
      message: `正在请求导出「${target.label}」（${labelOf(exporter.entry)}）`,
      evidence: { ...detected, categories, shardHints: extractShardHints(snapshot?.text), exportFormat: exporter.format, subtypes: subtypes.map(item => item.label) },
      action: { op: 'click', selector: exporter.entry.selector, expect: { text: labelOf(exporter.entry), id: exporter.entry.id } }
    };
  }

  return { state: 'awaiting_export', message: `已请求导出「${target.label}」，等待平台生成文件`, evidence: { ...detected, categories, subtypes: subtypes.map(s => s.label) }, action: null };
}

/**
 * 导出中心行解析：把可见行按“账期 / 类型 / 状态 / 下载”结构化。
 * 行归组用纵向范围重叠判断，而不是用 y 完全相等：单元格里的链接通常有内边距，
 * 与同一行文本的 y 并不相等，用相等判断会把下载按钮漏到另一行。
 */
export function parseExportRows(snapshot) {
  const items = (snapshot?.entries || [])
    .map(entry => ({ entry, label: labelOf(entry) }))
    .filter(item => item.label && item.entry.h >= 0);
  const sorted = [...items].sort((a, b) => (a.entry.y - b.entry.y) || (a.entry.x - b.entry.x));
  const clusters = [];
  for (const item of sorted) {
    const top = item.entry.y;
    const bottom = item.entry.y + Math.max(item.entry.h, 1);
    const cluster = clusters.find(candidate => top < candidate.bottom - 2 && bottom > candidate.top + 2);
    if (cluster) { cluster.cells.push(item); cluster.top = Math.min(cluster.top, top); cluster.bottom = Math.max(cluster.bottom, bottom); }
    else clusters.push({ top, bottom, cells: [item] });
  }
  const parsed = [];
  for (const cluster of clusters) {
    if (cluster.cells.length < 2) continue;
    const text = cluster.cells.map(cell => cell.label).filter(Boolean).join(' ');
    if (!/\d{4}-\d{2}|\d{4}年\d{1,2}月/.test(text)) continue;
    const month = (text.match(/(\d{4})[-年\/.](\d{1,2})/) || []).slice(1);
    const months = month.length === 2 ? `${month[0]}-${month[1].padStart(2, '0')}` : '';
    const download = cluster.cells.find(cell => isClickable(cell.entry) && /下载|导出|获取文件/.test(cell.label));
    parsed.push({ rowText: text, months, download: download ? download.entry : null, cells: cluster.cells.map(cell => cell.label) });
  }
  return parsed;
}
