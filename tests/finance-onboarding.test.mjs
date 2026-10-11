import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { FinanceShopOnboarding } from '../desktop/shared/finance-onboarding.mjs';
import { FinanceLedger } from '../desktop/shared/finance-ledger.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-onboarding-unit-'));
  const ledger = new FinanceLedger(directory);
  let identity = { name: '合成店铺', account: 'synthetic-seller', shopId: '900123', entity: '', taxId: '' };
  let state = 'needs_login';
  let revision = 0;
  const open = new Set(), calls = [];
  const browser = {
    open(shop) { calls.push(['open', shop]); open.add(shop.id); },
    isOpen: id => open.has(id),
    async readIdentity() { return { identity: { ...identity }, state, identityVersion: String(revision), text: 'synthetic page', accountCookies: [{ name: '_nk_', value: identity.account }, { name: 'secret', value: 'not-for-renderer' }] }; },
    assertIdentityVersion(id, version) {
      if (!open.has(id)) { const error = new Error('登录窗口已关闭'); error.code = 'FINANCE_WINDOW_CLOSED'; throw error; }
      if (version !== String(revision)) { const error = new Error('登录信息已变化'); error.code = 'FINANCE_IDENTITY_CHANGED'; throw error; }
    },
    async discardDraft(id) { calls.push(['discard', id]); open.delete(id); },
    attachShop(shop) { calls.push(['attach', shop]); },
    finalizeShop(id, { identityVersion }) { browser.assertIdentityVersion(id, identityVersion); calls.push(['finalize', id]); }
  };
  const onboarding = new FinanceShopOnboarding({ browser, call: async (method, ...args) => ledger[method](...args), analyze: snap => ({ state: snap.state, identity: snap.identity, message: '合成只读身份信息', sources: ['明确标签'], missing: ['taxId'] }) });
  return {
    onboarding, ledger, browser, calls, directory,
    login() { state = 'needs_confirmation'; }, change(next, invalidate = true) { identity = { ...identity, ...next }; if (invalidate) revision += 1; },
    close() { ledger.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

test('begin opens isolated login without saving a placeholder shop; cancel discards session', async () => {
  const f = fixture();
  try {
    const start = await f.onboarding.begin('2026-09');
    assert.equal(start.state, 'needs_login');
    assert.deepEqual(f.ledger.shops(), []);
    assert.equal(f.calls[0][1].id, start.token);
    await assert.rejects(f.onboarding.begin('2026-09'), /已有/);
    const inspection = await f.onboarding.inspect(start.token);
    assert.equal(inspection.state, 'needs_login');
    assert.doesNotMatch(JSON.stringify(inspection), /not-for-renderer|accountCookies|synthetic page/);
    await assert.rejects(f.onboarding.confirm(start.token, {}), /登录信息/);
    await f.onboarding.cancel(start.token);
    assert.equal(f.browser.isOpen(start.token), false);
    assert.deepEqual(f.ledger.shops(), []);
  } finally { f.close(); }
});

test('cancel keeps a failed cleanup retryable and pending until cleanup completes', async () => {
  const f = fixture();
  try {
    const { token } = await f.onboarding.begin('2026-09');
    let attempts = 0, finish;
    f.browser.discardDraft = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('cleanup failed');
      await new Promise(resolve => { finish = resolve; });
    };
    await assert.rejects(f.onboarding.cancel(token), /cleanup failed/);
    assert.equal(f.onboarding.pending.has(token), true);
    const retry = f.onboarding.cancel(token);
    await assert.rejects(f.onboarding.begin('2026-09'), /已有/);
    assert.equal(f.onboarding.pending.has(token), true);
    finish();
    assert.deepEqual(await retry, { cancelled: true });
    assert.equal(attempts, 2);
    assert.equal(f.onboarding.pending.has(token), false);
  } finally { f.close(); }
});

test('identity version remains guarded while shops lookup is delayed', async () => {
  const f = fixture();
  try {
    const { token } = await f.onboarding.begin('2026-09'); f.login();
    const view = await f.onboarding.inspect(token);
    let release, entered;
    const wait = new Promise(resolve => { entered = resolve; });
    const call = f.onboarding.call;
    f.onboarding.call = async (method, ...args) => {
      if (method === 'shops') { entered(); await new Promise(resolve => { release = resolve; }); }
      return call(method, ...args);
    };
    const save = f.onboarding.confirm(token, { fingerprint: view.fingerprint });
    await wait; f.change({ account: 'account-b' }); release();
    await assert.rejects(save, /变化/);
    assert.deepEqual(f.ledger.shops(), []);
    assert.equal(f.calls.some(([action]) => action === 'attach'), false);
  } finally { f.close(); }
});

test('主体和税号 belong to the confirmed snapshot, not unseen later values', async () => {
  for (const field of ['entity', 'taxId', 'entityType', 'taxpayer']) {
    const f = fixture();
    try {
      const { token } = await f.onboarding.begin('2026-09'); f.login();
      const view = await f.onboarding.inspect(token);
      // 主体/税号可由 DOM 异步刷新，不一定有导航或 Cookie 事件。
      f.change({ [field]: 'unseen-new-value' }, false);
      await assert.rejects(f.onboarding.confirm(token, { fingerprint: view.fingerprint }), /变化/);
      assert.deepEqual(f.ledger.shops(), []);
    } finally { f.close(); }
  }
});

for (const boundary of ['create', 'attach']) {
  for (const change of ['account', 'navigation', 'close']) {
    test(`identity ${change} during delayed ${boundary} aborts saving and rolls back only the new empty shop`, async () => {
      const f = fixture();
      try {
        const { token } = await f.onboarding.begin('2026-09'); f.login();
        const view = await f.onboarding.inspect(token);
        let entered, release;
        const wait = new Promise(resolve => { entered = resolve; });
        const gate = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
        if (boundary === 'create') {
          const call = f.onboarding.call;
          f.onboarding.call = async (method, ...args) => {
            const value = await call(method, ...args);
            if (method === 'createLoginShop') await gate();
            return value;
          };
        } else {
          f.browser.attachShop = async () => { await gate(); };
        }
        const save = f.onboarding.confirm(token, { fingerprint: view.fingerprint });
        await wait;
        const keptPending = f.onboarding.pending.has(token);
        if (change === 'close') await f.browser.discardDraft(token);
        else f.change(change === 'account' ? { account: 'account-b' } : {});
        release();
        await assert.rejects(save, /关闭|变化/);
        assert.equal(keptPending, true, 'pending must cover session binding too');
        assert.deepEqual(f.ledger.shops(), []);
        if (boundary === 'create') assert.equal(f.calls.some(([action]) => action === 'attach'), false);
      } finally { f.close(); }
    });
  }
}

test('rollback requires this creation capability and rejects existing shops or new shops with tasks', () => {
  const f = fixture();
  try {
    const existing = f.ledger.saveShop({ name: '既存店', account: 'old-account' });
    assert.equal(typeof f.ledger.rollbackLoginShop, 'function');
    assert.throws(() => f.ledger.rollbackLoginShop(existing.id, 'wrong-capability'), /本次|临时|权限/);
    assert.equal(f.ledger.shop(existing.id).name, '既存店');
    const key = crypto.randomUUID();
    const created = f.ledger.createLoginShop({ id: crypto.randomUUID(), name: 'new', account: 'new-account' }, key);
    assert.throws(() => f.ledger.rollbackLoginShop(created.id, crypto.randomUUID()), /本次|临时|权限/);
    assert.deepEqual(f.ledger.rollbackLoginShop(created.id, key), { rolledBack: true });
    const withTask = f.ledger.createLoginShop({ id: crypto.randomUUID(), name: 'with-task', account: 'new-account' }, key);
    f.ledger.newJob(withTask.id, '2026-09');
    assert.throws(() => f.ledger.rollbackLoginShop(withTask.id, key), /账单|任务/);
    assert.equal(f.ledger.shop(withTask.id).name, 'with-task');
    const edited = f.ledger.createLoginShop({ id: crypto.randomUUID(), name: 'before-edit', account: 'new-account' }, key);
    f.ledger.saveShop({ ...edited, name: 'after-edit' });
    assert.throws(() => f.ledger.rollbackLoginShop(edited.id, key), /已修改/);
    assert.equal(f.ledger.shop(edited.id).name, 'after-edit');
    const withBill = f.ledger.createLoginShop({ id: crypto.randomUUID(), name: 'with-bill', account: 'new-account' }, key);
    const file = path.join(f.directory, 'synthetic.csv');
    fs.writeFileSync(file, '日期,收入金额\n2026-09-01,10.00\n');
    f.ledger.stage(withBill.id, file);
    assert.throws(() => f.ledger.rollbackLoginShop(withBill.id, key), /账单|任务/);
    assert.equal(f.ledger.shop(withBill.id).name, 'with-bill');
  } finally { f.close(); }
});

test('worker dispatch creates and safely rolls back a login draft with its private capability', async () => {
  const f = fixture();
  const call = (operation, ...args) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../desktop/finance-worker.mjs', import.meta.url), { workerData: { directory: f.directory, operation, args } });
    worker.once('error', reject);
    worker.once('message', message => message.ok ? resolve(message.result) : reject(new Error(message.error)));
  });
  try {
    const id = crypto.randomUUID(), key = crypto.randomUUID();
    const shop = await call('createLoginShop', { id, name: 'synthetic-worker-shop', account: 'worker-account' }, key);
    assert.equal(shop.id, id);
    assert.equal(f.ledger.shops().length, 1);
    assert.deepEqual(await call('rollbackLoginShop', id, key), { rolledBack: true });
    assert.deepEqual(f.ledger.shops(), []);
    const existing = f.ledger.saveShop({ name: '保留的既存店', account: 'existing-account' });
    await assert.rejects(call('rollbackLoginShop', existing.id, key), /本次|权限/);
    assert.equal(f.ledger.shop(existing.id).name, '保留的既存店');
  } finally { f.close(); }
});

test('cancel retries an unfinished creation rollback instead of reporting cleanup success', async () => {
  const f = fixture();
  try {
    const { token } = await f.onboarding.begin('2026-09'); f.login();
    const view = await f.onboarding.inspect(token);
    const call = f.onboarding.call; let rollbackAttempts = 0;
    f.onboarding.call = async (method, ...args) => {
      if (method === 'rollbackLoginShop' && ++rollbackAttempts === 1) throw new Error('rollback temporarily unavailable');
      return call(method, ...args);
    };
    f.browser.attachShop = async () => { f.change({ account: 'account-b' }); };
    await assert.rejects(f.onboarding.confirm(token, { fingerprint: view.fingerprint }), /清理未完成/);
    assert.equal(f.onboarding.pending.has(token), true);
    assert.equal(f.ledger.shops().length, 1);
    assert.deepEqual(await f.onboarding.cancel(token), { cancelled: true });
    assert.equal(rollbackAttempts, 2);
    assert.deepEqual(f.ledger.shops(), []);
  } finally { f.close(); }
});

test('an identity read closed in flight cancels the draft only after cleanup', async () => {
  const f = fixture();
  try {
    const { token } = await f.onboarding.begin('2026-09');
    f.browser.readIdentity = async () => {
      await f.browser.discardDraft(token);
      const error = new Error('登录窗口已关闭'); error.code = 'FINANCE_WINDOW_CLOSED'; throw error;
    };
    const view = await f.onboarding.inspect(token);
    assert.equal(view.state, 'cancelled');
    assert.equal(f.onboarding.pending.has(token), false);
    assert.equal(f.calls.filter(([action]) => action === 'open').length, 1);
  } finally { f.close(); }
});

test('failed begin cleanup retains a retryable draft instead of forgetting its persistent partition', async () => {
  const f = fixture();
  try {
    const open = f.browser.open;
    f.browser.open = shop => { open(shop); throw new Error('open failed'); };
    f.browser.discardDraft = async () => { throw new Error('clear failed'); };
    await assert.rejects(f.onboarding.begin('2026-09'), /open failed/);
    assert.equal(f.onboarding.pending.size, 1);
    const [token] = f.onboarding.pending.keys();
    f.browser.discardDraft = async () => {};
    f.browser.open = open;
    // begin threw before returning a token; a new begin must be able to retry its orphan cleanup.
    const restarted = await f.onboarding.begin('2026-09');
    assert.notEqual(restarted.token, token);
    assert.equal(f.onboarding.pending.has(token), false);
    assert.deepEqual(await f.onboarding.cancel(restarted.token), { cancelled: true });
    assert.equal(f.onboarding.pending.size, 0);
  } finally { f.close(); }
});

test('confirmed login preserves the partition ID and leaves unavailable tax values unknown', async () => {
  const f = fixture();
  try {
    const start = await f.onboarding.begin('2026-09'); f.login();
    const view = await f.onboarding.inspect(start.token);
    const result = await f.onboarding.confirm(start.token, { fingerprint: view.fingerprint });
    assert.equal(result.shop.id, start.token);
    assert.equal(result.shop.platformShopId, '900123');
    assert.equal(result.shop.schedule, false);
    for (const key of ['taxId', 'entity', 'entityType', 'taxpayer', 'cycle']) assert.equal(result.shop[key], '');
    assert.deepEqual(f.calls.slice(-2).map(([action]) => action), ['attach', 'finalize']);
    assert.equal(f.browser.isOpen(start.token), true);
    await assert.rejects(f.onboarding.confirm(start.token, { fingerprint: view.fingerprint }), /会话已结束/);
    assert.equal(f.ledger.shops().length, 1);
  } finally { f.close(); }
});

test('account or shop switches after preview are rechecked before insertion', async () => {
  const f = fixture();
  try {
    const start = await f.onboarding.begin('2026-09'); f.login();
    const view = await f.onboarding.inspect(start.token);
    f.change({ account: 'different-account' });
    await assert.rejects(f.onboarding.confirm(start.token, { fingerprint: view.fingerprint }), /已变化/);
    assert.deepEqual(f.ledger.shops(), []);
    await f.onboarding.cancel(start.token);
  } finally { f.close(); }
});

test('missing shop name can be supplied, but missing account and shop ID cannot be bypassed', async () => {
  const f = fixture();
  try {
    const start = await f.onboarding.begin('2026-09'); f.login(); f.change({ name: '' });
    let view = await f.onboarding.inspect(start.token);
    await assert.rejects(f.onboarding.confirm(start.token, { fingerprint: view.fingerprint }), /补充店铺名称/);
    f.change({ account: '', shopId: '' }); view = await f.onboarding.inspect(start.token);
    await assert.rejects(f.onboarding.confirm(start.token, { fingerprint: view.fingerprint, name: '手动店名' }), /尚未读取到/);
    f.change({ account: 'synthetic-seller' }); view = await f.onboarding.inspect(start.token);
    const result = await f.onboarding.confirm(start.token, { fingerprint: view.fingerprint, name: '手动店名' });
    assert.equal(result.shop.name, '手动店名');
  } finally { f.close(); }
});

test('duplicate shops select the existing record without overwriting tax or schedules', async () => {
  const f = fixture();
  try {
    const existing = f.ledger.saveShop({ name: '合成店铺', account: 'synthetic-seller', entity: '保留的主体', taxId: 'TEST-ONLY', schedule: true, startMonth: '2026-01' });
    const start = await f.onboarding.begin('2026-09'); f.login();
    const view = await f.onboarding.inspect(start.token);
    const result = await f.onboarding.confirm(start.token, { fingerprint: view.fingerprint });
    assert.equal(result.existing, true); assert.equal(result.shop.id, existing.id);
    assert.equal(f.ledger.shops().length, 1); assert.equal(f.ledger.shop(existing.id).taxId, 'TEST-ONLY');
    assert.equal(f.ledger.shop(existing.id).schedule, true);
    assert.equal(f.calls.at(-1)[0], 'discard');
  } finally { f.close(); }
});

test('closed login window is cancelled rather than reopened or saved', async () => {
  const f = fixture();
  try {
    const start = await f.onboarding.begin('2026-09'); await f.browser.discardDraft(start.token);
    const view = await f.onboarding.inspect(start.token);
    assert.equal(view.state, 'cancelled'); assert.deepEqual(f.ledger.shops(), []);
    assert.equal(f.calls.filter(([action]) => action === 'open').length, 1);
  } finally { f.close(); }
});

test('a session flush failure reports the saved record accurately rather than prompting duplicate insertion', async () => {
  const f = fixture();
  try {
    f.browser.attachShop = async () => { throw new Error('synthetic flush failure'); };
    const start = await f.onboarding.begin('2026-09'); f.login();
    const view = await f.onboarding.inspect(start.token);
    const result = await f.onboarding.confirm(start.token, { fingerprint: view.fingerprint });
    assert.equal(result.shop.id, start.token);
    assert.equal(result.sessionPersisted, false);
    assert.match(result.message, /已添加.*重新登录/);
    assert.equal(f.ledger.shops().length, 1);
  } finally { f.close(); }
});

test('createLoginShop rejects forged identifiers and edits keep the platform shop ID', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.ledger.createLoginShop({ id: '../bad', name: '测试', account: 'synthetic' }), /标识无效/);
    const start = await f.onboarding.begin('2026-09'); f.login();
    const view = await f.onboarding.inspect(start.token);
    const result = await f.onboarding.confirm(start.token, { fingerprint: view.fingerprint });
    const updated = f.ledger.saveShop({ id: result.shop.id, name: result.shop.name, account: result.shop.account });
    assert.equal(updated.platformShopId, '900123');
    assert.throws(() => f.ledger.createLoginShop({ id: result.shop.id, name: 'duplicate', account: 'synthetic' }), /已保存/);
  } finally { f.close(); }
});
