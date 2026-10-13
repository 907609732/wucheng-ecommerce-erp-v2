import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import XLSX from 'xlsx';
import { sanitizeDiagnosticText } from './diagnostics.mjs';

export class PddActionRequired extends Error {
  constructor(message, state = 'needs_review') { super(message); this.state = state; }
}

export function pddRange(meta) {
  const month = String(meta?.month || '');
  const start = String(meta?.startDate || (month ? `${month}-01` : ''));
  const end = String(meta?.endDate || (month ? `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}` : ''));
  const valid = value => { const date = new Date(`${value}T00:00:00Z`); return /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
  if (!valid(start) || !valid(end) || start > end) throw new Error('请选择有效的起止日期，结束日期不能早于开始日期');
  return { start, end };
}

export function validatePddMeta(meta) {
  if (!['pdd'].includes(meta?.platform)) throw new Error('请选择采购平台');
  const account = String(meta.account || '').trim();
  if (account.length > 60) throw new Error('采购账号ID过长，请重新登录后识别');
  const range = pddRange(meta);
  return { platform: meta.platform, account, accountLabel: account, month: range.start.slice(0, 7), startDate: range.start, endDate: range.end };
}

const allowedHost = url => {
  try { const u = new URL(url); return u.protocol === 'https:' && ['yangkeduo.com', 'pinduoduo.com'].some(host => u.hostname === host || u.hostname.endsWith(`.${host}`)); } catch { return false; }
};
async function pageGuard(page, profile) {
  if (page.isClosed()) throw new PddActionRequired('采集窗口已关闭，请重新打开；无法判断登录是否过期', 'needs_review');
  const body = await page.locator('body').innerText({ timeout: 10000 });
  if (/拖动滑块|安全验证|请完成验证|请输入验证码|访问受限|操作频繁|请求过于频繁/.test(body)) throw new PddActionRequired('平台要求安全验证或限制访问，请在采集窗口处理后重新采集；这不等同于未登录', 'needs_verification');
  if ((profile.need_login_url_contains || []).some(part => page.url().includes(part)) || /扫码登录|请先登录|登录已失效|Session 过期|session 过期/.test(body)) throw new PddActionRequired('检测到登录页或登录失效提示，请在采集窗口登录，完成后返回软件点击“自动采集”', 'needs_login');
  return body;
}

// 拼多多独立月度导出：仅读取登录买家订单。
export async function collectViaPdd(page, meta, { destination, progress = () => {}, signal, allowEmpty = false } = {}) {
  const range = pddRange(meta);
  progress('正在通过平台接口采集订单明细（拼多多网页版接口）…');
  await pageGuard(page, { need_login_url_contains: ['/login'] });
  if (signal?.aborted) throw new Error('已停止采集');
  const payload = await page.evaluate(async () => {
    const cookie = String(document.cookie || '');
    const uidMatch = cookie.match(/(?:^|;\s*)pdd_user_id=([^;]+)/);
    const uid = uidMatch ? decodeURIComponent(uidMatch[1]) : '';
    if (!uid) return { error: '缺少拼多多买家登录账号，请先登录', state: 'needs_login' };
    const fetchPage = async offset => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body = { type: 'all', page: 1, page_from: 0, size: 50, origin_host_name: 'mobile.yangkeduo.com', scene: 'order_list_h5', front_env: 1, pay_front_supports: [], anti_content: '' };
          if (offset) body.offset = offset;
          const res = await fetch(`/proxy/api/api/aristotle/order_list_v4?pdduid=${uid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(`接口返回 ${res.status}`);
          return await res.json();
        } catch (error) {
          lastError = error;
          if (attempt >= 2) throw error;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      throw lastError;
    };
    const orders = [], seen = new Map();
    let offset = '', complete = false;
    const fail = message => ({ error: message, state: 'needs_review' });
    for (let i = 0; i < 60; i++) {
      const data = await fetchPage(offset);
      if (data?.success === false || data?.error_code != null && String(data.error_code) !== '0' || data?.error_msg) {
        return { error: '拼多多接口返回错误，未生成采集结果', state: /登录|login|session/i.test(String(data.error_msg || '')) ? 'needs_login' : 'needs_review' };
      }
      if (!Array.isArray(data?.orders)) return fail('拼多多接口缺少订单数组，不能判断无订单');
      const list = data.orders;
      if (!list.length) {
        if (data.has_more === true) return fail('分页返回空订单但仍有下一页');
        complete = true; break;
      }
      let hasNew = false;
      for (const order of list) {
        if (typeof order?.order_sn !== 'string' || !order.order_sn || order.order_sn.trim() !== order.order_sn) return fail('订单号缺失或不是完整文本');
        const sn = order.order_sn;
        if (seen.has(sn)) {
          const previous = seen.get(sn);
          if (JSON.stringify({ ...previous, offset: undefined }) !== JSON.stringify({ ...order, offset: undefined })) return fail('同一订单数据或整单付款冲突，已停止采集');
          continue;
        }
        seen.set(sn, order); hasNew = true; orders.push(order);
      }
      if (!hasNew) return fail('分页重复且没有进展，不能证明采集完整');
      if (data.has_more === false) { complete = true; break; }
      const next = list.at(-1)?.offset;
      if (next == null || next === '' || String(next) === String(offset)) return fail('分页缺少有效下一页游标');
      offset = next;
    }
    if (!complete) return fail('分页达到安全上限，不能证明采集完整');
    const currentUid = String(document.cookie || '').match(/(?:^|;\s*)pdd_user_id=([^;]+)/);
    if (!currentUid || decodeURIComponent(currentUid[1]) !== uid) return fail('采集过程中买家账号发生变化');
    return { orders, account: uid };
  });

  if (signal?.aborted) throw new Error('已停止采集');
  if (payload.error) throw new PddActionRequired(payload.error, payload.state);
  if (!payload.orders.length && !allowEmpty) throw new PddActionRequired(`该时间范围（${range.start} 至 ${range.end}）没有采购订单，请确认时间范围或登录状态`);

  const statusLabel = status => ({ 1: '待支付', 2: '待发货', 3: '待收货', 4: '交易成功', 5: '交易取消', 6: '退款成功', 7: '交易关闭' }[status] || '未知');
  const cents = value => {
    if (value == null || value === '') return null;
    if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new PddActionRequired('接口金额不是安全整数分，已停止采集');
    return Number(value);
  };
  const fenToYuan = value => { const n = cents(value); return n == null ? null : n / 100; };
  const formatTime = unix => {
    if (!/^\d+$/.test(String(unix)) || !Number.isSafeInteger(Number(unix)) || Number(unix) < 946684800 || Number(unix) >= 4102444800) throw new PddActionRequired('订单时间无效，不能确定归属月份');
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(Number(unix) * 1000));
  };

  const rows = [], orders = [], sourceOrders = [];
  for (const order of payload.orders) {
    const time = formatTime(order.order_time);
    const day = time.slice(0, 10);
    if (day < range.start || day > range.end) continue; // 按选定日期范围过滤
    const mall = String(order.mall?.mall_name || '');
    const status = statusLabel(order.status);
    if (!Array.isArray(order.order_goods) || !order.order_goods.length) throw new PddActionRequired('订单缺少商品规格，不能生成完整结果');
    const amountCents = cents(order.display_amount), refundCents = cents(order.refund_amount);
    const canonical = {
      id: createHash('sha256').update(`pdd\0${payload.account}\0${order.order_sn}`).digest('hex'),
      platform: 'pdd', account: payload.account, accountLabel: payload.account, orderId: order.order_sn,
      month: time.slice(0, 7), orderedAt: time, paidAt: order.pay_time == null || order.pay_time === '' ? '' : formatTime(order.pay_time),
      supplier: mall, status, amountCents, freightCents: cents(order.shipping_amount),
      discountCents: cents(order.discount_amount), refundCents,
      netCents: amountCents == null || refundCents == null ? null : amountCents - refundCents,
      note: '', revision: 1, issues: [], items: [],
      attributes: { trackingNumber: String(order.tracking_number || '') }, attachments: [],
    };
    orders.push(canonical); sourceOrders.push(order);
    if (canonical.netCents != null && !Number.isSafeInteger(canonical.netCents)) throw new PddActionRequired('订单净额超过安全整数范围');
    for (const goods of order.order_goods) {
      const unitPriceCents = cents(goods.goods_price);
      const quantity = Number(goods.goods_number);
      if (!/^\d+$/.test(String(goods.goods_number)) || !Number.isSafeInteger(quantity) || quantity <= 0) throw new PddActionRequired('商品数量无效，不能猜测为一件');
      const itemAmountCents = unitPriceCents == null ? null : unitPriceCents * quantity;
      if (itemAmountCents != null && !Number.isSafeInteger(itemAmountCents)) throw new PddActionRequired('商品金额超过安全整数范围');
      const price = unitPriceCents == null ? null : unitPriceCents / 100;
      const amount = itemAmountCents == null ? null : itemAmountCents / 100;
      canonical.items.push({ id: `${canonical.id}:${canonical.items.length}`, item: String(goods.goods_name || ''), sku: String(goods.spec || ''), quantity, unit: '', unitPriceCents, itemAmountCents, note: '', attributes: {} });
      rows.push({
        '订单号': String(order.order_sn || ''),
        '下单时间': time,
        '商品名称': String(goods.goods_name || ''),
        '规格': String(goods.spec || ''),
        '单价': price,
        '数量': quantity,
        '商品金额': amount,
        '运费': fenToYuan(order.shipping_amount),
        '优惠': fenToYuan(order.discount_amount),
        '实付款': fenToYuan(order.display_amount),
        '供应商': mall,
        '状态': status,
        '快递单号': String(order.tracking_number || ''),
      });
    }
  }
  if (!rows.length && !allowEmpty) throw new PddActionRequired(`该时间范围（${range.start} 至 ${range.end}）没有采购订单，请确认时间范围或登录状态`);

  progress(`接口采集完成：${orders.length} 笔订单、${rows.length} 行明细，正在写入采集文件…`);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '订单明细');
  const file = path.join(destination, `${randomUUID()}.xlsx`);
  fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return { file, originalName: `pdd_${range.start}_${range.end}.xlsx`, range, account: payload.account, orders, source: { orders: sourceOrders } };
}

export class PddBrowserSession {
  constructor({ directory, profiles, notify = () => {}, log = () => {}, launch, testOrigin = '' }) {
    this.directory = directory; this.profiles = profiles; this.notify = notify; this.launch = launch;
    this.testOrigin = testOrigin; this.contexts = new Map(); this.identities = {}; this.job = null;
    fs.mkdirSync(directory, { recursive: true });
    this.logDirectory = path.join(directory, 'logs'); fs.mkdirSync(this.logDirectory, { recursive: true });
    this.logs = []; this.onLog = log;
    const latest = fs.readdirSync(this.logDirectory).filter(name => /^pdd-monthly-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().at(-1);
    if (latest) {
      const file = path.join(this.logDirectory, latest), size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try { const buffer = Buffer.alloc(Math.min(size, 256 * 1024)); fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length); this.logs = buffer.toString('utf8').split('\n').flatMap(line => { try { const entry = JSON.parse(line); return typeof entry.message === 'string' && typeof entry.time === 'string' ? [entry] : []; } catch { return []; } }).slice(-300); } finally { fs.closeSync(fd); }
    }
  }
  safeMessage(message) { return sanitizeDiagnosticText(message, [this.job?.meta?.account, ...Object.values(this.identities).map(identity => identity.account)]).replace(/https?:\/\/[^\s"'<>]+/gi, '[平台地址已隐藏]').slice(0, 1800); }
  state() { return { ...(this.job ? { ...this.job, controller: undefined } : { state: 'idle', message: '先打开采集窗口登录，账号ID会自动识别；选择时间后点击自动采集。' }), identities: this.identities, logs: this.logs }; }
  setIdentity(platform, account) {
    if ((this.identities[platform]?.account || '') === account) return;
    if (account) this.identities[platform] = { platform, account, accountLabel: account };
    else delete this.identities[platform];
    this.log(account ? '已自动识别顶部登录账号ID，已回填到软件（日志隐藏ID）。' : '当前账号ID暂无法确认，已清空显示；具体原因见账号识别提示。');
  }
  log(message, level = 'info') {
    const entry = { time: new Date().toISOString(), level, jobId: this.job?.id || '', message: this.safeMessage(message) };
    this.stage = entry.message; this.logs = [...this.logs, entry].slice(-300);
    try { fs.appendFileSync(path.join(this.logDirectory, `pdd-monthly-${entry.time.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n'); }
    catch { this.logs.push({ time: entry.time, level: 'error', message: '日志文件写入失败，请检查磁盘空间和目录权限。' }); }
    this.onLog(entry); this.notify(this.state());
  }
  update(state, message, extra = {}) { this.job = { ...this.job, ...extra, state, message: this.safeMessage(message), updatedAt: new Date().toISOString() }; this.log(this.job.message, ['failed','needs_review','needs_login','needs_verification'].includes(state) ? 'error' : 'info'); }
  async open(input) {
    const meta = validatePddMeta(input), key = createHash('sha256').update(`${meta.platform}\0automatic-account-session`).digest('hex');
    let context = this.contexts.get(key);
    if (!context) {
      this.log('正在启动本机 Chrome 独立采集窗口（最多30秒）…');
      const options = { headless: false, channel: 'chrome', timeout: 30000, acceptDownloads: true, viewport: null, args: ['--start-maximized'] };
      const profileDir = path.join(this.directory, 'profiles', 'chrome', key);
      if (this.launch) context = await this.launch(profileDir, options);
      else {
        try { context = await chromium.launchPersistentContext(profileDir, options); }
        catch (error) { this.log(`Chrome 启动失败：${error.message}`, 'error'); throw new Error('未能打开 Chrome 采集窗口，请检查本机 Chrome 是否已安装，或关闭该账号重复打开的采集窗口后重试'); }
      }
      this.contexts.set(key, context);
      context.on('close', () => this.contexts.delete(key));
      await context.route('**/*', route => { const request = route.request(); if (request.isNavigationRequest() && !allowedHost(request.url()) && !(this.testOrigin && request.url().startsWith(this.testOrigin + '/'))) return route.abort(); return route.continue(); });
      this.log('采集浏览器已启动。');
      this.log('已请求启动最大化；网页已取消固定视口，随 Chrome 窗口尺寸调整。');
    } else this.log('正在复用该平台的采集窗口，稍后重新核对登录账号。');
    const page = context.pages().find(p => !p.isClosed()) || await context.newPage();
    const profile = this.profiles[meta.platform];
    const target = this.testOrigin || profile.order_url;
    const inLogin = (profile.need_login_url_contains || []).some(part => page.url().includes(part));
    if (!inLogin && !page.url().startsWith(target.split('?')[0])) { this.log('正在打开平台采购订单页（最多45秒）…'); await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    await page.bringToFront();
    this.log('采集窗口已就绪，接下来检查页面和日期控件。');
    await page.evaluate(() => window.scrollTo(0, 0));
    return { page, profile, meta, context };
  }
  start(input) {
    const meta = validatePddMeta(input);
    if (this.job?.state === 'running') throw new Error('已有采购任务在运行，请等待完成或停止后重试');
    const id = randomUUID(), controller = new AbortController();
    this.activeContext = null;
    this.job = { id, meta, controller, state: 'running', message: '正在打开采购采集窗口…', createdAt: new Date().toISOString() };
    this.log(`开始采购采集：${'拼多多'}，${meta.startDate} 至 ${meta.endDate}。`);
    const started = Date.now();
    const heartbeat = setInterval(() => { if (this.job?.id === id && this.job.state === 'running') { const stage = this.stage; this.log(`仍在等待（累计${Math.floor((Date.now() - started) / 1000)}秒）：${stage}`); this.stage = stage; } }, 10000);
    const task = this.run(meta, controller.signal).catch(error => { if (this.job?.id === id) this.update(controller.signal.aborted ? 'canceled' : error.state || 'failed', controller.signal.aborted ? '采集已停止，台账未变更。' : error.message); }).finally(() => clearInterval(heartbeat));
    this.task = task; return this.state();
  }
  async stop() { if (this.job?.state !== 'running') return this.state(); this.log('收到停止请求，正在关闭采集窗口…', 'warning'); this.job.controller.abort(); await this.activeContext?.close().catch(() => {}); await this.task; return this.state(); }
  closeAll() { this.job?.controller?.abort(); return Promise.allSettled([...this.contexts.values()].map(context => context.close())); }
}
