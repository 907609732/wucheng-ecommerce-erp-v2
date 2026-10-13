import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import { collectViaPdd } from '../desktop/shared/pdd-buyer.mjs';

const order = (extra = {}) => ({ order_sn: '0000123-0000456', order_time: Date.parse('2026-08-31T16:00:00Z') / 1000, display_amount: '1234', status: 4, tracking_number: '000-TRACKING', mall: { mall_name: '测试供应商' }, offset: 'cursor1', order_goods: [{ goods_name: '商品', spec: '规格一', goods_price: '617', goods_number: 1 }, { goods_name: '商品', spec: '规格二', goods_price: '617', goods_number: 1 }], ...extra });
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-monthly-isolated-'));
  let respond = () => ({ orders: [order()], has_more: false });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('<main>买家订单</main>'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await respond(JSON.parse(body))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext(path.join(directory, 'browser'), { channel: 'chrome', headless: true });
  await context.addCookies([{ name: 'pdd_user_id', value: '001234', url: origin }]);
  const page = context.pages()[0]; await page.goto(origin);
  t.after(async () => { await context.close().catch(() => {}); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  return { directory, origin, context, page, requests, set: fn => { respond = fn; } };
}

test('standalone monthly capture archives and exports one payment per order without touching ledger', async t => {
  const module = await import('../desktop/shared/pdd-monthly-export.mjs').catch(() => ({}));
  assert.equal(typeof module.PddMonthlyExport, 'function', 'standalone backend must exist');
  const f = await fixture(t);
  const ledger = path.join(f.directory, 'erp.sqlite'); fs.writeFileSync(ledger, 'DO NOT TOUCH LEDGER');
  const hash = () => createHash('sha256').update(fs.readFileSync(ledger)).digest('hex'); const before = hash();
  const notices = [];
  const backend = new module.PddMonthlyExport({ directory: path.join(f.directory, 'monthly'), profile: { order_url: f.origin }, testOrigin: f.origin, launch: async () => f.context, notify: status => notices.push(status) });
  t.after(() => backend.closeAll());
  const status = backend.start({ month: '2026-09' });
  assert.equal(status.state, 'running'); assert.equal(status.result, null);
  await backend.task;
  const { result, state } = backend.state(); assert.equal(state, 'completed', backend.state().message);
  assert.equal(result.month, '2026-09'); assert.equal(result.account, '001234');
  assert.ok(!backend.state().logs.some(entry => entry.message.includes('淘宝')), 'PDD job must not be logged as Taobao');
  assert.ok(notices.filter(status => status.state !== 'completed').every(status => status.result === null), 'result must not leak before completion');
  assert.equal(result.orderCount, 1); assert.equal(result.itemCount, 2); assert.equal(result.totalAmountCents, 1234);
  const file = path.join(f.directory, 'result.xlsx');
  const exported = await backend.exportResult({ id: result.id }, file); assert.equal(exported.orderCount, 1);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  assert.equal(wb.getWorksheet('采购订单').rowCount, 2); assert.equal(wb.getWorksheet('商品规格').rowCount, 3);
  assert.equal(wb.getWorksheet('采购订单').getCell('D2').value, '0000123-0000456');
  assert.equal(wb.getWorksheet('采购订单').getCell('D2').numFmt, '@');
  assert.equal(wb.getWorksheet('采购订单').getCell('H2').value, 12.34);
  assert.equal(wb.getWorksheet('采购订单').getCell('I2').value, '未提供');
  assert.equal(hash(), before);
  const archives = fs.readdirSync(path.join(f.directory, 'monthly', 'archives'));
  assert.equal(archives.length, 1);
  const archive = JSON.parse(fs.readFileSync(path.join(f.directory, 'monthly', 'archives', archives[0])));
  assert.equal(archive.result.id, result.id);
  assert.equal(archive.source.orders[0].display_amount, '1234');
});

test('standalone validates months and blocks ledger backfill; failure clears old snapshots', async t => {
  const { PddMonthlyExport } = await import('../desktop/shared/pdd-monthly-export.mjs');
  const f = await fixture(t);
  const backend = new PddMonthlyExport({ directory: path.join(f.directory, 'monthly'), profile: { order_url: f.origin }, testOrigin: f.origin, launch: async () => f.context });
  for (const month of ['', '2026-1', '2026-00', '2026-13', ' 2026-09', '2026-09\n', '1999-09', '2026-09-01']) {
    assert.throws(() => backend.start({ month })); assert.throws(() => backend.open({ month }));
  }
  assert.throws(() => backend.start({ month: '2026-09', platform: 'taobao' }));
  assert.equal(typeof backend.backfill, 'undefined');
  await assert.rejects(backend.exportResult({ id: 'missing' }, path.join(f.directory, 'missing.xlsx')));
  backend.start({ month: '2026-09' }); await backend.task; const previous = backend.state().result;
  const detached = backend.state().result; detached.orders[0].amountCents = 999;
  assert.equal(backend.state().result.totalAmountCents, 1234);
  f.set(() => ({ error_code: 500, orders: [] }));
  backend.start({ month: '2026-09' }); assert.equal(backend.state().result, null);
  await backend.task; assert.equal(backend.state().state, 'needs_review'); assert.equal(backend.state().result, null);
  await assert.rejects(backend.exportResult({ id: previous.id }, path.join(f.directory, 'stale.xlsx')));
  f.set(() => ({ orders: [] }));
  backend.start({ month: '2026-09' }); await backend.task;
  assert.equal(backend.state().state, 'completed');
  const result = backend.state().result;
  assert.deepEqual([result.orderCount, result.itemCount, result.totalAmountCents], [0, 0, 0]);
  const file = path.join(f.directory, 'empty.xlsx'); await backend.exportResult({ id: result.id }, file);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  assert.equal(wb.getWorksheet('采购订单').rowCount, 1); assert.equal(wb.getWorksheet('商品规格').rowCount, 1);
  assert.equal(fs.existsSync(path.join(f.directory, 'stale.xlsx')), false);
});

test('PDD visible login wall cannot become a validated empty month', async t => {
  const f = await fixture(t); f.set(() => ({ orders: [] })); await f.page.setContent('<main>请先登录</main>');
  await assert.rejects(() => collectViaPdd(f.page, { platform: 'pdd', month: '2026-09' }, { destination: f.directory, allowEmpty: true }), error => error.state === 'needs_login');
});

test('PDD rejects incomplete, unauthenticated, conflicting or malformed API evidence', async t => {
  const f = await fixture(t);
  const capture = () => collectViaPdd(f.page, { platform: 'pdd', month: '2026-09' }, { destination: f.directory, allowEmpty: true });
  for (const response of [
    { error_code: 500, error_msg: '失败', orders: [] }, {},
    { orders: [order()], has_more: true },
    { orders: [order({ offset: '' })], has_more: true },
    { orders: [order(), order({ display_amount: '999' })], has_more: false },
    { orders: [order({ order_time: '' })], has_more: false },
    { orders: [order({ pay_time: 0 })], has_more: false },
    { orders: [order({ display_amount: '12.34' })], has_more: false },
    { orders: [order({ shipping_amount: '¥1.23' })], has_more: false },
    { orders: [order({ display_amount: '9007199254740992' })], has_more: false },
    { orders: [order({ order_goods: [] })], has_more: false },
  ]) {
    f.set(() => response);
    await assert.rejects(capture, error => error.state === 'needs_review');
  }
  f.set(() => ({ orders: [], has_more: false }));
  await f.context.clearCookies();
  await assert.rejects(capture, error => error.state === 'needs_login');
  await f.context.addCookies([{ name: 'pdd_user_id', value: '001234', url: f.origin }]);
  f.set(() => ({ error_code: 40001, error_msg: '请先登录' }));
  await assert.rejects(capture, error => error.state === 'needs_login');
});

test('standalone cancellation and double-start never publish a result or archive', async t => {
  const { PddMonthlyExport } = await import('../desktop/shared/pdd-monthly-export.mjs');
  const f = await fixture(t);
  let release, arrived;
  const incoming = new Promise(resolve => { arrived = resolve; });
  f.set(async () => { arrived(); await new Promise(resolve => { release = resolve; }); return { orders: [order()], has_more: false }; });
  const backend = new PddMonthlyExport({ directory: path.join(f.directory, 'monthly'), profile: { order_url: f.origin }, testOrigin: f.origin, launch: async () => f.context });
  const first = backend.start({ month: '2026-09' });
  assert.throws(() => backend.start({ month: '2026-10' }), /运行/);
  assert.equal(backend.state().id, first.id);
  await incoming;
  const stopped = backend.stop(); release(); await stopped;
  assert.equal(backend.state().state, 'canceled'); assert.equal(backend.state().result, null);
  assert.equal(fs.existsSync(path.join(f.directory, 'monthly', 'archives')), false);
});

test('PDD cursor traversal retains all statuses, completes only on terminal evidence and rejects safety cap', async t => {
  const f = await fixture(t);
  const capture = () => collectViaPdd(f.page, { platform: 'pdd', month: '2026-09' }, { destination: f.directory, allowEmpty: true });
  f.set(body => !body.offset ? { orders: [order()], has_more: true } : body.offset === 'cursor1' ? { orders: [order({ order_sn: '0000000-0000002', status: 6, offset: 'cursor2' })] } : { orders: [] });
  const result = await capture();
  assert.deepEqual(result.orders.map(order => order.status), ['交易成功', '退款成功']);
  assert.deepEqual(f.requests.map(body => body.offset), [undefined, 'cursor1', 'cursor2']);
  let page = 0;
  f.set(() => ({ orders: [order({ order_sn: `id-${++page}`, offset: `cursor-${page}` })], has_more: true }));
  await assert.rejects(capture, error => error.state === 'needs_review' && /上限/.test(error.message));
  assert.equal(page, 60);
  f.set(() => ({ orders: [order({ order_time: Date.parse('2026-09-30T16:00:00Z') / 1000 })], has_more: false }));
  assert.equal((await capture()).orders.length, 0, 'Shanghai October boundary excluded');
});

test('standalone cancel from identity notification cannot race completion', async t => {
  const { PddMonthlyExport } = await import('../desktop/shared/pdd-monthly-export.mjs');
  const f = await fixture(t); let stopped;
  const backend = new PddMonthlyExport({ directory: path.join(f.directory, 'monthly'), profile: { order_url: f.origin }, testOrigin: f.origin, launch: async () => f.context, notify: state => {
    if (!stopped && state.state === 'running' && state.identities.pdd) { stopped = true; stopped = backend.stop(); }
  } });
  backend.start({ month: '2026-09' }); await backend.task; await stopped;
  assert.equal(backend.state().state, 'canceled'); assert.equal(backend.state().result, null);
  assert.equal(fs.existsSync(path.join(f.directory, 'monthly', 'archives')), false);
});

test('PDD unknown optional item money stays unknown in canonical and raw Excel', async t => {
  const f = await fixture(t);
  f.set(() => ({ orders: [order({ display_amount: null, refund_amount: '100', order_goods: [{ goods_name: '价格未知', goods_number: 1 }] })], has_more: false }));
  const capture = await collectViaPdd(f.page, { platform: 'pdd', month: '2026-09' }, { destination: f.directory, allowEmpty: true });
  assert.equal(capture.orders[0].netCents, null);
  assert.equal(capture.orders[0].items[0].unitPriceCents, null);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(capture.file);
  assert.equal(wb.getWorksheet('订单明细').getCell('E2').value, null);
  assert.equal(wb.getWorksheet('订单明细').getCell('G2').value, null);
});

test('PDD account switch during fetch rejects captured rows', async t => {
  const f = await fixture(t);
  f.set(async () => {
    await f.context.addCookies([{ name: 'pdd_user_id', value: 'OTHER-BUYER', url: f.origin }]);
    return { orders: [order()], has_more: false };
  });
  await assert.rejects(() => collectViaPdd(f.page, { platform: 'pdd', month: '2026-09' }, { destination: f.directory, allowEmpty: true }), error => error.state === 'needs_review' && /账号/.test(error.message));
});

test('PDD rejects fabricated quantities and unsafe item totals', async t => {
  const f = await fixture(t);
  for (const goods of [ { goods_price: '100', goods_number: 0 }, { goods_price: '100', goods_number: '' }, { goods_price: '100', goods_number: 1.5 }, { goods_price: '9007199254740991', goods_number: 2 } ]) {
    f.set(() => ({ orders: [order({ order_goods: [goods] })], has_more: false }));
    await assert.rejects(() => collectViaPdd(f.page, { platform: 'pdd', month: '2026-09' }, { destination: f.directory, allowEmpty: true }), error => error.state === 'needs_review');
  }
});

test('PDD actual fetch captures Shanghai month boundary and optional cents without fabricating zeros', async t => {
  const f = await fixture(t);
  const capture = await collectViaPdd(f.page, { platform: 'pdd', month: '2026-09' }, { destination: f.directory, allowEmpty: true });
  assert.equal(capture.orders?.length, 1);
  assert.equal(capture.orders[0].orderedAt, '2026-09-01 00:00:00');
  assert.equal(capture.orders[0].amountCents, 1234);
  assert.equal(capture.orders[0].freightCents, null);
  assert.equal(capture.orders[0].items.length, 2);
  assert.equal(capture.orders[0].orderId, '0000123-0000456');
  assert.equal(capture.orders[0].attributes.trackingNumber, '000-TRACKING');
});
