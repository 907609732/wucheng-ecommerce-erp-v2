/** 登录后店铺身份的保守纯函数决策；不读取会话、不保存凭据。 */
import { looksLikeCaptcha, looksLikeLogin } from './finance-bills.mjs';

const stringOf = value => typeof value === 'string' ? value.trim() : '';
const visibleEntries = snapshot => (Array.isArray(snapshot?.entries) ? snapshot.entries : [])
  .filter(entry => entry && typeof entry === 'object' && entry.visible !== false && entry.hidden !== true
    && !['password', 'hidden'].includes(stringOf(entry.type).toLowerCase())
    && (!['input', 'textarea', 'select', 'option'].includes(stringOf(entry.tag).toLowerCase()) || entry.readOnly === true));
const visibleText = snapshot => [snapshot?.title, snapshot?.text,
  ...visibleEntries(snapshot).flatMap(entry => [entry.text, entry.aria, entry.title])]
  .map(stringOf).join('\n');
const isLoginUrl = value => {
  try {
    const url = new URL(stringOf(value));
    return /(^|\.)(?:login|passport)\./i.test(url.hostname) || /\/(?:login|signin)(?:[./]|$)/i.test(url.pathname);
  } catch { return false; }
};
const FIELDS = Object.freeze(['name', 'account', 'shopId', 'entity', 'taxId', 'entityType', 'taxpayer']);
const emptyIdentity = () => Object.fromEntries(FIELDS.map(field => [field, '']));
const resultOf = (state, message, identity = emptyIdentity(), sources = []) => ({
  state, message, identity, sources, missing: FIELDS.filter(field => !identity[field])
});

const ROLES = Object.freeze({ shopName: 'name', account: 'account', shopId: 'shopId', entity: 'entity', taxId: 'taxId' });
const LABELS = Object.freeze({
  name: /^(当前店铺名称|当前店铺|店铺名称|店铺名)/,
  account: /^(当前登录账号|当前账号|登录账号|店铺账号|账号)/,
  shopId: /^(店铺ID|店铺Id|店铺id|店铺编号)/,
  entity: /^(经营主体名称|经营主体|店铺主体名称|店铺主体|主体名称|主体)/,
  taxId: /^(纳税人识别号|统一社会信用代码|税号)/
});
function labeledValues(entry) {
  // 通用扫描中的表格行通常是订单/账单商家，不能拿来猜当前登录身份。
  if ((Number.isInteger(entry.row) && entry.row >= 0) || ['td', 'tr', 'th'].includes(stringOf(entry.tag).toLowerCase())) return [];
  const values = [];
  for (const text of [entry.text, entry.aria, entry.title].map(stringOf).filter(Boolean)) {
    for (const [field, pattern] of Object.entries(LABELS)) {
      const match = pattern.exec(text);
      if (!match) continue;
      const rest = text.slice(match[0].length);
      let value = '';
      if (/^[：:]?\s*$/.test(rest)) value = stringOf(entry.value);
      else if (/^(?:\s*[：:]\s*|\s+)/.test(rest)) value = rest.replace(/^(?:\s*[：:]\s*|\s+)/, '').trim();
      const aggregate = /[\r\n]/.test(value) || /\s+[^\s：:]{1,20}\s*[：:]/.test(value)
        || /\s+(?:店铺名称|店铺名|店铺ID|登录账号|店铺账号|经营主体|税号)(?:\s+|[：:])/.test(value);
      if (value && !aggregate) values.push({ field, value, source: 'visible-label', label: match[0] });
    }
  }
  return values;
}
// 与 finance-browser 的 FINANCE_URL 路径同源；不导入 Electron 模块。
const FINANCE_PATH = '/home.htm/whale-accountant/bill/summary';
const isBillPage = snapshot => {
  try {
    const url = new URL(stringOf(snapshot?.url));
    const renderedText = [snapshot?.text, ...visibleEntries(snapshot).map(entry => entry.text)].map(stringOf).join(' ');
    if (!/收支账单|收入账单/.test(renderedText)) return false;
    if (url.protocol === 'https:' && url.hostname === 'qn.taobao.com' && url.pathname === FINANCE_PATH) return true;
    // 仅浏览器的测试 origin guard 可提供此 flag；生产不设置。
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return snapshot?.trustedTestOrigin === true && local && ['http:', 'https:'].includes(url.protocol)
      && (url.pathname === FINANCE_PATH || /收支账单|收入账单/.test(visibleText(snapshot)));
  } catch { return false; }
};

/**
 * @param {{url?:string,title?:string,text?:string,entries?:Array<object>,
 *   accountCookies?:Array<{name:string,value:string}>,trustedTestOrigin?:boolean}} snapshot
 * @returns {{state:'needs_login'|'needs_captcha'|'waiting'|'needs_confirmation',message:string,
 *   identity:{name:string,account:string,shopId:string,entity:string,taxId:string,entityType:string,taxpayer:string},
 *   sources:Array<{field:string,source:string,label?:string}>,missing:Array<string>}}
 * sources 只返回字段与证据类别/明确标签，不复制 entry、URL 或原始 cookie。
 * missing 包含所有尚未读到的字段；entityType/taxpayer 不从其他资料推断。
 */
export function analyzeFinanceIdentity(snapshot) {
  const text = visibleText(snapshot);
  if (looksLikeCaptcha(text)) return resultOf('needs_captcha', '页面要求安全验证，请在千牛窗口人工完成验证。');
  if (looksLikeLogin(text) || /登录已失效|会话过期|未登录|请重新登录/.test(text) || isLoginUrl(snapshot?.url)) {
    return resultOf('needs_login', '请在千牛窗口人工登录后继续识别店铺。');
  }
  const identity = emptyIdentity();
  const sources = [];
  const values = new Map();
  const sourceKeys = new Set();
  const add = (field, rawValue, source) => {
    const value = stringOf(rawValue);
    if (!value || /^(?:[-—–]+|暂无|未设置|未提供|null|undefined|\*+)$/i.test(value)) return;
    if (!values.has(field)) values.set(field, new Set());
    values.get(field).add(value);
    const key = JSON.stringify([field, source.source, source.label]);
    if (!sourceKeys.has(key)) {
      sourceKeys.add(key);
      sources.push({ field, ...source });
    }
  };
  for (const entry of visibleEntries(snapshot)) {
    // 来源由页面扫描器限定为文档级语义页头且带「当前店铺」标签。
    // trusted/identityRole、任意独立标签或 CSS 名称本身都不证明归属。
    if (entry.identitySource !== 'semantic-current-shop-header' || entry.frameIndex > 0) continue;
    const candidates = labeledValues(entry);
    const field = Object.hasOwn(ROLES, entry.identityRole) ? ROLES[entry.identityRole] : '';
    if (entry.trusted === true && field) {
      const textValue = stringOf(entry.text);
      const labeled = candidates.find(candidate => candidate.field === field);
      const value = stringOf(entry.value) || labeled?.value || (LABELS[field].test(textValue) ? '' : textValue);
      if (value) candidates.push({ field, value, source: 'trusted-entry' });
    }
    for (const { field: key, value, ...source } of candidates) add(key, value, source);
  }
  for (const cookie of Array.isArray(snapshot?.accountCookies) ? snapshot.accountCookies : []) {
    if (!cookie || cookie.name !== '_nk_') continue;
    try {
      const value = decodeURIComponent(stringOf(cookie.value));
      if (!value) continue;
      add('account', value, { source: 'account-cookie', label: cookie.name });
    } catch { /* 非法编码不猜账号。 */ }
  }
  if ([...values.values()].some(candidates => candidates.size > 1)) {
    return resultOf('waiting', '当前页面存在多个不一致的身份候选，信息冲突；请人工核对，不能保存。');
  }
  for (const [field, candidates] of values) identity[field] = [...candidates][0];
  if (isBillPage(snapshot) && (identity.account || identity.shopId)) {
    const message = identity.name ? '已读取明确店铺身份，请核对确认后添加店铺。'
      : '已读取登录账号，请在确认卡片补充店铺名称后添加店铺。';
    return resultOf('needs_confirmation', message, identity, sources);
  }
  return resultOf('waiting', '正在等待当前页面提供明确的店铺身份，请勿保存猜测信息。', identity, sources);
}
