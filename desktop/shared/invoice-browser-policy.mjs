import { pddInvoiceAllowedUrl, PDD_INVOICE_URL } from './pdd-invoice.mjs';
export const INVOICE_PAGE_URL = 'https://qn.taobao.com/home.htm/merchant-invoice/#/invoice/agreed';
export function invoiceTargetUrl(platform = 'taobao') {
  if (platform === 'pdd') return PDD_INVOICE_URL;
  if (platform === 'taobao') return INVOICE_PAGE_URL;
  throw new Error('不支持的开票平台');
}
export function invoicePartition(id, platform = 'taobao') {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('开票店铺 ID 无效');
  if (!['taobao', 'pdd'].includes(platform)) throw new Error('不支持的开票平台');
  return platform === 'pdd' ? `persist:invoice-pdd-${id}` : `persist:invoice-${id}`;
}
export function invoiceAllowedUrl(url, platform = 'taobao') {
  if (platform === 'pdd') return pddInvoiceAllowedUrl(url);
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['taobao.com', 'tmall.com', 'alipay.com'].some(d => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`));
  } catch { return false; }
}
export function invoicePageStatus(url, text) {
  if (!String(url).startsWith('https://qn.taobao.com/') || !String(url).includes('merchant-invoice/')) return { ok: false, reason: '未到达千牛开票页，请先登录' };
  if (/滑块|验证码|安全验证|扫码登录|密码登录/.test(String(text || '').slice(0, 2000))) return { ok: false, reason: '需要登录或验证，请打开店铺登录窗口处理' };
  if (!String(text || '').includes('给买家开票') || !/待处理申请|待录入开票|开票数据概览/.test(String(text || ''))) return { ok: false, reason: '千牛开票内容尚未加载，不能确认登录' };
  return { ok: true };
}
