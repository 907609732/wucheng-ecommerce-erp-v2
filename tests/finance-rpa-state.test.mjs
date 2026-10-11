// Offline orchestration only: no Electron, network, real account or file writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceRpa, overallState } from '../desktop/shared/finance-rpa.mjs';

const shop = { id: 'synthetic-shop', name: '合成店铺', account: 'test-shop' };
const control = (text, extra = {}) => ({ tag: 'button', text, selector: `#${text}`, disabled: false, x: 0, y: 0, w: 80, h: 24, ...extra });
const ready = {
  url: 'http://127.0.0.1/bill', entries: [control('收入账单'), control('查询'), control('导出Excel'), control('', { tag: 'input', type: 'month', value: '2026-09', selector: '#month' })],
  text: `店铺账号 test-shop 收入账单 ${'本地合成账单信息 '.repeat(10)}`
};
function harness({ snapshot = async () => ready, ensure = () => false, failStorage = false } = {}) {
  const calls = [];
  const browser = { open() {}, targetUrl: () => ready.url, snapshot, ensure, act: async () => ({ ok: true }),
    expectDownload: () => Promise.resolve({ file: 'synthetic.xlsx', name: 'synthetic.xlsx' }), cancelIntent() {} };
  const rpa = new FinanceRpa({ browser, call: async (operation, ...args) => {
    calls.push([operation, ...args]);
    if (operation === 'newJob') return 'synthetic-job';
    if (operation === 'openBatch') return 'synthetic-batch';
    if (operation === 'addPart' && failStorage) throw new Error('合成磁盘写入失败');
    return {};
  }});
  return { rpa, calls };
}

test('empty, mixed, cancellation and unstarted results remain distinct', () => {
  assert.equal(overallState([]), 'partial');
  assert.equal(overallState([{ state: 'empty' }]), 'empty');
  assert.equal(overallState([{ state: 'received' }, { state: 'empty' }]), 'received');
  assert.equal(overallState([{ state: 'received' }, { state: 'cancelled' }]), 'cancelled');
});

test('navigation failure finalizes the persistent job instead of leaving it running', async () => {
  let reads = 0;
  const { rpa, calls } = harness({ ensure: () => true, snapshot: async () => ++reads === 1 ? ready : { ...ready, text: '请扫码登录后继续' } });
  const result = await rpa.run({ shop, month: '2026-09', kinds: ['income'] });
  assert.equal(result.state, 'needs_review');
  assert.equal(calls.filter(c => c[0] === 'finishJob').length, 1);
  assert.equal(calls.find(c => c[0] === 'finishJob')[2], 'needs_login');
  assert.equal(rpa.isRunning(shop.id), false);
});

test('explicit empty and user cancellation persist their own terminal states', async () => {
  let reads = 0;
  const empty = harness({ snapshot: async () => ++reads === 1 ? ready : { ...ready, text: `${ready.text} 当前查询条件下数据为空` } });
  assert.equal((await empty.rpa.run({ shop, month: '2026-09', kinds: ['income'] })).state, 'empty');
  assert.equal(empty.calls.find(c => c[0] === 'finishJob')[2], 'empty');
  const cancelled = harness({ snapshot: async () => { cancelled.rpa.cancel(shop.id); return ready; } });
  assert.equal((await cancelled.rpa.run({ shop, month: '2026-09', kinds: ['income'] })).state, 'cancelled');
  assert.equal(cancelled.calls.find(c => c[0] === 'finishJob')[2], 'cancelled');
  assert.equal(cancelled.rpa.isRunning(shop.id), false);
});

test('a downloaded file that fails storage cannot produce received or complete', async () => {
  const { rpa, calls } = harness({ failStorage: true });
  const result = await rpa.run({ shop, month: '2026-09', kinds: ['income'] });
  assert.ok(calls.some(c => c[0] === 'addPart'), 'Must exercise the storage failure');
  assert.equal(result.state, 'failed');
  assert.equal(result.kinds[0].received, 0);
  assert.match(result.message, /磁盘写入失败/);
  const closed = calls.find(c => c[0] === 'closeBatch')[2];
  assert.equal(closed.state, 'incomplete');
  assert.ok(closed.missing.length > 0);
  assert.equal(calls.find(c => c[0] === 'finishJob')[2], 'failed');
});

test('queued shop is reserved immediately and duplicate clicks do not create another job', async () => {
  const { rpa, calls } = harness({ snapshot: async () => ({ ...ready, text: '请扫码登录后继续' }) });
  let release;
  const blocker = rpa.serialize(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const first = rpa.run({ shop, month: '2026-09', kinds: ['income'] });
  try {
    assert.equal(rpa.isRunning(shop.id), true, 'Queued shops must already count as running');
    const duplicate = await rpa.run({ shop, month: '2026-09', kinds: ['income'] });
    assert.equal(duplicate.state, 'running');
  } finally { release(); await blocker; await first; }
  assert.equal(calls.filter(c => c[0] === 'newJob').length, 1);
  assert.equal(rpa.isRunning(shop.id), false);
});

test('cancelling a queued shop prevents opening its window or creating its job', async () => {
  const { rpa, calls } = harness({ snapshot: async () => ({ ...ready, text: '请扫码登录后继续' }) });
  let opened = 0, release;
  rpa.browser.open = () => { opened++; };
  const blocker = rpa.serialize(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const pending = rpa.run({ shop, month: '2026-09', kinds: ['income'] });
  rpa.cancel(shop.id);
  release(); await blocker;
  assert.equal((await pending).state, 'cancelled');
  assert.equal(opened, 0);
  assert.equal(calls.filter(c => c[0] === 'newJob').length, 0);
  assert.equal(rpa.isRunning(shop.id), false);
});

test('job creation failure releases reservation and does not block a later request', async () => {
  const { rpa } = harness({ snapshot: async () => ({ ...ready, text: '请扫码登录后继续' }) });
  const original = rpa.call;
  let fail = true;
  rpa.call = async (...args) => {
    if (args[0] === 'newJob' && fail) { fail = false; throw new Error('合成数据库不可写'); }
    return original(...args);
  };
  const result = await rpa.run({ shop, month: '2026-09', kinds: ['income'] });
  assert.equal(result.state, 'failed');
  assert.match(result.message, /数据库不可写/);
  assert.equal(rpa.isRunning(shop.id), false);
  assert.equal((await rpa.run({ shop, month: '2026-09', kinds: ['income'] })).state, 'needs_review');
});

test('cancellation during job creation finalizes it without opening a window and can be retried', async () => {
  const { rpa, calls } = harness({ snapshot: async () => ({ ...ready, text: '请扫码登录后继续' }) });
  const original = rpa.call;
  let release, opened = 0;
  rpa.browser.open = () => { opened++; };
  rpa.call = async (...args) => args[0] === 'newJob' ? new Promise(resolve => { release = () => resolve('synthetic-job'); }) : original(...args);
  const pending = rpa.run({ shop, month: '2026-09', kinds: ['income'] });
  await Promise.resolve();
  rpa.cancel(shop.id); release();
  assert.equal((await pending).state, 'cancelled');
  assert.equal(opened, 0);
  assert.equal(calls.find(c => c[0] === 'finishJob')[2], 'cancelled');
  rpa.call = original;
  assert.equal((await rpa.run({ shop, month: '2026-09', kinds: ['income'] })).state, 'needs_review');
  assert.equal(opened, 1);
});
