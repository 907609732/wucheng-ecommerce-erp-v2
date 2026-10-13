export const PDD_INVOICE_URL = 'https://mms.pinduoduo.com/invoice/center';

export function pddInvoiceAllowedUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && ['mms.pinduoduo.com', 'passport.pinduoduo.com', 'mms.yangkeduo.com'].includes(hostname);
  } catch { return false; }
}

export function pddInvoicePageStatus(url, text) {
  let target;
  try { target = new URL(url); } catch { return { ok: false, reason: '未打开拼多多开票中心' }; }
  if (target.origin !== 'https://mms.pinduoduo.com' || !target.pathname.startsWith('/invoice/center')) return { ok: false, reason: '未到达拼多多开票中心，请在独立窗口登录' };
  const content = String(text || '');
  if (/扫码登录|密码登录|手机验证码登录|滑块验证|安全验证/.test(content.slice(0, 2000))) return { ok: false, reason: '拼多多需要登录或验证' };
  if (!content.includes('订单开票') || !content.includes('开票列表') || !content.includes('全部待开票')) return { ok: false, reason: '拼多多开票列表尚未完整加载' };
  return { ok: true };
}

export function parsePddInvoiceCounts(text) {
  const content = String(text || '').replace(/[\s\u3000]+/g, '');
  if (!content.includes('开票列表') || !content.includes('待开票')) return { ok: false, reason: '未找到拼多多待开票列表' };
  const chips = [...content.matchAll(/全部待开票(\d{1,7})(?!\d)/g)];
  const totals = [...content.matchAll(/共(?:有)?(\d{1,7})条/g)];
  if (chips.length !== 1 || totals.length !== 1) return { ok: false, reason: '待开票筛选数量或列表总数不唯一，不记为零' };
  const pending = Number(chips[0][1]);
  const tableTotal = Number(totals[0][1]);
  if (pending !== tableTotal || (pending > 0 && content.includes('暂无相关订单'))) return { ok: false, reason: '待开票筛选数量与列表不一致，请人工核对筛选条件' };
  if (pending === 0 && !content.includes('暂无相关订单')) return { ok: false, reason: '列表尚未确认无订单，不记为零' };
  return { ok: true, pending, unrecorded: null, coverage: 'visible_range' };
}
