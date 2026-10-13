import fs from 'node:fs';
import path from 'node:path';
import { PddBrowserSession, collectViaPdd, validatePddMeta, PddActionRequired } from './pdd-buyer.mjs';
import { exportPddOrders } from './pdd-order-export.mjs';

function monthlyMeta(input) {
  if (input?.platform != null && input.platform !== 'pdd') throw new Error('独立导出仅支持拼多多买家订单');
  if (typeof input?.month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(input.month)) throw new Error('请选择有效月份 YYYY-MM');
  return validatePddMeta({ platform: 'pdd', month: input.month });
}

// No collector, preview, commit or database dependency: browser lifecycle only.
export class PddMonthlyExport extends PddBrowserSession {
  constructor({ directory, profile = { order_url: 'https://mobile.yangkeduo.com/orders.html' }, notify = () => {}, launch, testOrigin = '' }) {
    super({ directory, profiles: { pdd: profile }, notify, launch, testOrigin });
    this.result = null;
  }
  state() { return { ...super.state(), result: this.job?.state === 'completed' && this.result ? structuredClone(this.result) : null }; }
  open(input) { return super.open(monthlyMeta(input)); }
  start(input) {
    const meta = monthlyMeta(input);
    if (this.job?.state === 'running') throw new Error('已有拼多多采集任务在运行');
    this.result = null;
    return super.start(meta);
  }
  async run(meta, signal) {
    const { page, context } = await this.open(meta);
    this.activeContext = context;
    if (signal.aborted) { await context.close().catch(() => {}); throw new Error('已停止采集'); }
    const incoming = path.join(this.directory, 'incoming'); fs.mkdirSync(incoming, { recursive: true });
    const capture = await collectViaPdd(page, meta, { destination: incoming, allowEmpty: true, signal, progress: message => this.update('running', message) });
    if (signal.aborted) throw new Error('已停止采集');
    const orders = capture.orders;
    let totalAmountCents = 0;
    for (const order of orders) {
      if (!Number.isSafeInteger(order.amountCents)) throw new PddActionRequired('整单实付款缺失，不能计算月度合计');
      totalAmountCents += order.amountCents;
      if (!Number.isSafeInteger(totalAmountCents)) throw new PddActionRequired('月度金额超过安全整数范围');
    }
    const result = { id: this.job.id, month: meta.month, account: capture.account, orderCount: orders.length, itemCount: orders.reduce((sum, order) => sum + order.items.length, 0), totalAmountCents, orders, collectedAt: new Date().toISOString() };
    this.job.meta = { ...meta, account: capture.account, accountLabel: capture.account };
    this.setIdentity('pdd', capture.account);
    if (signal.aborted) throw new Error('已停止采集');
    const archives = path.join(this.directory, 'archives'); fs.mkdirSync(archives, { recursive: true });
    const file = path.join(archives, `${meta.month}-${result.id}.json`), temporary = `${file}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, result, source: capture.source }, null, 2), { flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
    this.result = result;
    this.update('completed', `拼多多月度采集完成：${result.orderCount} 笔订单、${result.itemCount} 条规格（全部状态，整单付款仅计一次）。未写入采购台账。`);
  }
  async exportResult({ id } = {}, destination) {
    if (!this.result || this.job?.state !== 'completed' || id !== this.result.id) throw new Error('采集结果不存在或已失效，请重新采集');
    return exportPddOrders(structuredClone(this.result.orders), destination, { includeTrackingNumber: true });
  }
}
