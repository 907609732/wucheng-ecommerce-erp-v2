import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FinanceShopOnboarding } from '../desktop/shared/finance-onboarding.mjs';
import { analyzeFinanceIdentity } from '../desktop/shared/finance-identity.mjs';
import { FinanceLedger } from '../desktop/shared/finance-ledger.mjs';

// Electron boundary substitute: execute the real browser manager, never navigate a remote page.
const windows = [], sessions = new Map();
class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.destroyed = false; this.title = options.title;
    const wc = new EventEmitter();
    wc.session = options.webPreferences.session; wc.url = '';
    wc.getURL = () => wc.url;
    wc.setWindowOpenHandler = () => {};
    wc.mainFrame = { url: '', framesInSubtree: [], executeJavaScript: async () => this.snapshot() };
    this.snapshot = () => ({ url: wc.url, title: '收支账单', text: '收入账单 月汇总', entries: [] });
    this.webContents = wc; windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() {}
  setTitle(title) { this.title = title; }
  async loadURL(url) { this.webContents.url = url; this.webContents.mainFrame.url = url; }
  close() { this.destroyed = true; this.emit('closed'); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
function registerSafetyTests() {
test('ordinary close veto retains the live original window and allows a later close', () => {
  const f = fixture();
  try {
    const count = windows.length;
    f.win.close = () => {}; // Electron close.preventDefault / beforeunload veto.
    f.browser.close(f.id);
    assert.equal(f.win.isDestroyed(), false);
    assert.equal(f.browser.isOpen(f.id), true, 'manager must retain a vetoed live window');
    assert.equal(f.browser.open({ id: f.id, name: 'synthetic' }, '2026-09', ''), f.win);
    assert.equal(windows.length, count, 'a veto must not create an unmanaged duplicate window');
    f.win.close = FakeWindow.prototype.close;
    f.browser.close(f.id);
    assert.equal(f.browser.isOpen(f.id), false);
  } finally { f.win.close = FakeWindow.prototype.close; f.cleanup(); }
});

for (const failure of ['destroy throws', 'destroy stays alive', 'storage', 'cache']) {
  test(`cancel keeps ${failure} failure retryable without clearing any live window`, async () => {
    const f = fixture();
    try {
      // begin uses a new UUID; retain the fixture window as an unrelated saved shop.
      const onboarding = new FinanceShopOnboarding({ browser: f.browser, call: async () => {}, analyze: () => ({}) });
      const { token } = await onboarding.begin('2026-09');
      const win = windows.at(-1), context = f.browser.contextOf(token), ses = win.webContents.session;
      const draft = onboarding.pending.get(token);
      let storage = 0, cache = 0;
      win.close = () => {};
      ses.clearStorageData = async () => { assert.equal(win.isDestroyed(), true); storage += 1; if (failure === 'storage' && storage === 1) throw new Error('storage failed'); };
      ses.clearCache = async () => { assert.equal(win.isDestroyed(), true); cache += 1; if (failure === 'cache' && cache === 1) throw new Error('cache failed'); };
      if (failure === 'destroy throws') win.destroy = () => { throw new Error('destroy failed'); };
      if (failure === 'destroy stays alive') win.destroy = () => {};
      await assert.rejects(onboarding.cancel(token), /failed|未关闭/);
      assert.equal(onboarding.pending.get(token), draft);
      assert.equal(draft.cleaning, false);
      assert.equal(draft.cleanupOnly, true);
      assert.equal(f.browser.contextOf(token), context);
      if (failure.startsWith('destroy')) {
        assert.equal(f.browser.isOpen(token), true);
        assert.equal(storage, 0); assert.equal(cache, 0);
      }
      assert.equal(f.win.isDestroyed(), false);
      win.destroy = FakeWindow.prototype.destroy;
      assert.deepEqual(await onboarding.cancel(token), { cancelled: true });
      assert.equal(win.isDestroyed(), true);
      assert.equal(onboarding.pending.has(token), false);
      assert.equal(f.browser.isOpen(token), false);
      assert.equal(f.win.isDestroyed(), false);
      assert.ok(storage > 0 && cache > 0);
    } finally { for (const win of windows) if (!win.isDestroyed()) FakeWindow.prototype.destroy.call(win); f.cleanup(); }
  });
}

for (const savedKind of ['opened saved shop', 'finally committed shop']) {
  test(`discardDraft refuses an ${savedKind} without touching window or session`, async () => {
    const f = fixture();
    try {
      let id = f.id, win = f.win;
      if (savedKind === 'opened saved shop') {
        id = crypto.randomUUID();
        win = f.browser.open({ id, name: 'saved fixture' }, '2026-09', '');
      } else {
        const { identityVersion } = await f.browser.readIdentity(id);
        await f.browser.attachShop({ id, name: 'saved fixture' }, '2026-09', { identityVersion });
        assert.equal(f.browser.contextOf(id).draft, true, 'attach is provisional');
        f.browser.finalizeShop(id, { identityVersion });
      }
      let clears = 0;
      win.webContents.session.clearStorageData = async () => { clears += 1; };
      win.webContents.session.clearCache = async () => { clears += 1; };
      await assert.rejects(f.browser.discardDraft(id), /已绑定|非临时/);
      assert.equal(win.isDestroyed(), false);
      assert.equal(f.browser.isOpen(id), true);
      assert.equal(clears, 0);
    } finally { f.cleanup(); }
  });
}

}

const session = {
  fromPartition(partition) {
    if (!sessions.has(partition)) {
      const ses = new EventEmitter();
      ses.cookies = new EventEmitter();
      ses.cookies.get = async () => [{ name: '_nk_', value: 'account-a', domain: '.taobao.com' }];
      ses.cookies.flushStore = async () => {};
      ses.clearStorageData = async () => {}; ses.clearCache = async () => {};
      ses.setPermissionRequestHandler = () => {};
      sessions.set(partition, ses);
    }
    return sessions.get(partition);
  }
};
globalThis.__financeBrowserIdentityHarness = { BrowserWindow: FakeWindow, session };
const source = fs.readFileSync(new URL('../desktop/shared/finance-browser.mjs', import.meta.url), 'utf8')
  .replace("import { BrowserWindow, session } from 'electron';", 'const { BrowserWindow, session } = globalThis.__financeBrowserIdentityHarness;')
  .replace("'./finance-page.mjs'", JSON.stringify(new URL('../desktop/shared/finance-page.mjs', import.meta.url).href));
const { createFinanceBrowser } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
delete globalThis.__financeBrowserIdentityHarness;
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-identity-race-'));
  const browser = createFinanceBrowser({ directory });
  const id = crypto.randomUUID();
  const win = browser.open({ id, name: 'synthetic' }, '2026-09', '', { draft: true });
  return { browser, id, win, directory, cleanup() { browser.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

for (const change of ['close', 'navigation', 'nickname', 'session']) {
  test(`readIdentity rejects ${change} during snapshot without creating another window`, async () => {
    const f = fixture();
    try {
      const count = windows.length;
      f.win.snapshot = () => {
        if (change === 'close') f.win.close();
        if (change === 'navigation') f.win.webContents.emit('did-start-navigation', {}, 'https://qn.taobao.com/changed', false, true);
        if (change === 'nickname') f.win.webContents.session.cookies.emit('changed', {}, { name: '_nk_', value: 'account-b' }, 'explicit', false);
        if (change === 'session') f.win.webContents.session.cookies.emit('changed', {}, { name: 'cookie2', value: 'synthetic-auth-b' }, 'explicit', false);
        return { url: f.win.webContents.url, text: '收入账单 月汇总', entries: [] };
      };
      await assert.rejects(f.browser.readIdentity(f.id), /关闭|变化/);
      assert.equal(windows.length, count, 'identity reads must never reopen a closed draft');
    } finally { f.cleanup(); }
  });
}

for (const change of ['close', 'navigation', 'nickname', 'session']) {
  test(`attachShop does not bind a ${change}-invalidated session while flush is pending`, async () => {
    const f = fixture();
    try {
      const { identityVersion } = await f.browser.readIdentity(f.id);
      const initial = f.browser.contextOf(f.id).shop;
      let release, entered;
      const wait = new Promise(resolve => { entered = resolve; });
      f.win.webContents.session.cookies.flushStore = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
      const binding = f.browser.attachShop({ id: f.id, name: 'saved-shop' }, '2026-09', { identityVersion });
      await wait;
      const wasBoundEarly = f.browser.contextOf(f.id).shop !== initial;
      if (change === 'close') f.win.close();
      if (change === 'navigation') f.win.webContents.emit('did-start-navigation', {}, 'https://qn.taobao.com/changed', false, true);
      if (change === 'nickname') f.win.webContents.session.cookies.emit('changed', {}, { name: '_nk_', value: 'account-b' }, 'explicit', false);
      if (change === 'session') f.win.webContents.session.cookies.emit('changed', {}, { name: 'cookie2', value: 'synthetic-auth-b' }, 'explicit', false);
      release();
      await assert.rejects(binding, /关闭|变化/);
      assert.equal(wasBoundEarly, false, 'do not mutate shop context before guarded flush succeeds');
      assert.equal(f.browser.contextOf(f.id).shop, initial);
    } finally { f.cleanup(); }
  });
}

test('discardDraft retains cleanup context when storage clearing fails and retries the same partition', async () => {
  const f = fixture();
  try {
    const context = f.browser.contextOf(f.id);
    let attempts = 0;
    f.win.webContents.session.clearStorageData = async () => { if (++attempts === 1) throw new Error('storage clear failed'); };
    await assert.rejects(f.browser.discardDraft(f.id), /storage clear failed/);
    assert.equal(f.browser.contextOf(f.id), context, 'cleanup state must not be forgotten before credentials clear');
    const count = windows.length;
    await assert.rejects(f.browser.snapshot(f.id), /未打开/);
    assert.equal(windows.length, count);
    await f.browser.discardDraft(f.id);
    assert.equal(attempts, 2);
    assert.notEqual(f.browser.contextOf(f.id), context);
  } finally { f.cleanup(); }
});

test('readIdentity rejects a close while reading nickname cookies, without reopening', async () => {
  const f = fixture();
  try {
    const count = windows.length;
    f.win.webContents.session.cookies.get = async () => { f.win.close(); return []; };
    await assert.rejects(f.browser.readIdentity(f.id), /关闭/);
    assert.equal(windows.length, count);
  } finally { f.cleanup(); }
});

test('post-attach DOM identity failure rolls back and cleans only the temporary session', async () => {
  const f = fixture();
  const ledger = new FinanceLedger(path.join(f.directory, 'ledger'));
  try {
    const saved = ledger.saveShop({ name: '既存保留店', account: 'saved-account', taxId: 'KEEP-TAX', schedule: true });
    const savedWindow = f.browser.open(saved, '2026-09', '');
    const savedBefore = ledger.shop(saved.id);
    let savedClears = 0;
    savedWindow.webContents.session.clearStorageData = async () => { savedClears += 1; };
    const onboarding = new FinanceShopOnboarding({ browser: f.browser, analyze: analyzeFinanceIdentity, call: async (method, ...args) => ledger[method](...args) });
    const { token } = await onboarding.begin('2026-09');
    const win = windows.at(-1), ses = win.webContents.session;
    let bound = false, storage = 0, cache = 0;
    win.setTitle = title => { win.title = title; bound = true; };
    win.snapshot = () => ({ url: win.webContents.url, title: '收支账单', text: '收入账单 月汇总', entries: bound
      ? [{ tag: 'span', row: -1, identitySource: 'semantic-current-shop-header', text: '经营主体：异步变化主体' }] : [] });
    ses.clearStorageData = async () => { assert.equal(win.isDestroyed(), true); storage += 1; };
    ses.clearCache = async () => { assert.equal(win.isDestroyed(), true); cache += 1; };
    const view = await onboarding.inspect(token);
    await assert.rejects(onboarding.confirm(token, { fingerprint: view.fingerprint, name: '临时店' }), /变化/);
    assert.equal(bound, true, 'reach the real attachShop binding, not a mock');
    assert.equal(ledger.shops().some(shop => shop.id === token), false);
    const evidence = { destroyed: win.isDestroyed(), storage, cache, pending: onboarding.pending.has(token), savedClears };
    console.log('POST_ATTACH_MINIMAL_EVIDENCE', JSON.stringify(evidence));
    assert.equal(win.isDestroyed(), true, 'a rolled-back post-attach draft must remain eligible for cleanup');
    assert.equal(storage, 1); assert.equal(cache, 1);
    assert.equal(onboarding.pending.has(token), false);
    assert.deepEqual(await onboarding.cancel(token), { cancelled: true });
    assert.deepEqual(ledger.shop(saved.id), savedBefore);
    assert.equal(savedWindow.isDestroyed(), false); assert.equal(savedClears, 0);
  } finally {
    ledger.close(); f.cleanup();
  }
});

for (const flushFails of [false, true]) {
  for (const change of ['entity', 'taxId', 'nickname', 'session', 'navigation', 'close']) {
    test(`post-attach ${change} with flush ${flushFails ? 'failure' : 'success'} retains same-partition cancel retry`, async () => {
      const f = fixture(), ledger = new FinanceLedger(path.join(f.directory, 'ledger'));
      try {
        const saved = ledger.saveShop({ name: '既存保留店', account: 'saved-account', taxId: 'KEEP-TAX', schedule: true });
        const savedBefore = ledger.shop(saved.id), savedWindow = f.browser.open(saved, '2026-09', '');
        const savedSession = savedWindow.webContents.session;
        const savedCredentials = [{ name: 'authentication_fixture', value: 'keep-saved' }];
        savedSession.rows = [...savedCredentials];
        let savedClears = 0;
        savedSession.clearStorageData = async () => { savedClears += 1; savedSession.rows = []; };
        savedSession.clearCache = async () => { savedClears += 1; };
        const onboarding = new FinanceShopOnboarding({ browser: f.browser, analyze: analyzeFinanceIdentity, call: async (method, ...args) => ledger[method](...args) });
        const { token } = await onboarding.begin('2026-09');
        const win = windows.at(-1), ses = win.webContents.session, context = f.browser.contextOf(token);
        const originalWindowCount = windows.length;
        ses.rows = [{ name: '_nk_', value: 'draft-account', domain: '.taobao.com' }, { name: 'authentication_fixture', value: 'draft-secret', domain: '.taobao.com' }];
        ses.cookies.get = async ({ name }) => ses.rows.filter(row => row.name === name);
        let bound = false, storage = 0, cache = 0, flushes = 0;
        ses.cookies.flushStore = async () => { flushes += 1; if (flushFails) throw new Error('synthetic flush failure'); };
        win.setTitle = title => {
          win.title = title; bound = true;
          if (change === 'navigation') win.webContents.emit('did-start-navigation', {}, 'https://qn.taobao.com/changed', false, true);
          if (change === 'nickname' || change === 'session') ses.cookies.emit('changed', {}, { name: change === 'nickname' ? '_nk_' : 'authentication_fixture', value: 'changed' }, 'explicit', false);
          if (change === 'close') win.close();
        };
        win.snapshot = () => ({ url: win.webContents.url, title: '收支账单', text: '收入账单 月汇总', entries: bound && ['entity', 'taxId'].includes(change)
          ? [{ tag: 'span', row: -1, identitySource: 'semantic-current-shop-header', text: change === 'entity' ? '经营主体：异步变化主体' : '税号：CHANGED-TAX' }] : [] });
        ses.clearStorageData = async () => {
          assert.equal(win.isDestroyed(), true, 'never clear credentials under a live window');
          if (++storage === 1) throw new Error('storage temporarily unavailable');
          ses.rows = [];
        };
        ses.clearCache = async () => { assert.equal(win.isDestroyed(), true); cache += 1; };
        const view = await onboarding.inspect(token);
        await assert.rejects(onboarding.confirm(token, { fingerprint: view.fingerprint, name: '临时店' }), /清理未完成/);
        assert.equal(bound, true); assert.equal(flushes, 1);
        assert.equal(ledger.shops().some(shop => shop.id === token), false);
        assert.equal(onboarding.pending.has(token), true);
        assert.equal(f.browser.contextOf(token), context, 'retry must retain the original temporary partition');
        assert.equal(context.draft, true); assert.equal(context.discarding, true);
        assert.equal(win.isDestroyed(), true); assert.equal(storage, 1); assert.equal(cache, 0);
        assert.equal(ses.rows.length, 2, 'failed cleanup must not claim credentials were cleared');
        assert.deepEqual(await onboarding.cancel(token), { cancelled: true });
        assert.equal(onboarding.pending.has(token), false); assert.equal(f.browser.isOpen(token), false);
        assert.equal(storage, 2); assert.equal(cache, 1); assert.deepEqual(ses.rows, []);
        assert.equal(windows.length, originalWindowCount, 'post-attach close must never auto-reopen during identity reads');
        assert.deepEqual(ledger.shop(saved.id), savedBefore); assert.equal(savedWindow.isDestroyed(), false);
        assert.equal(savedClears, 0); assert.deepEqual(savedSession.rows, savedCredentials);
        console.log('POST_ATTACH_RETRY_EVIDENCE', JSON.stringify({ change, flushFails, rolledBack: true, destroyed: win.isDestroyed(), storage, cache, pending: onboarding.pending.has(token), savedClears }));
        const restarted = await onboarding.begin('2026-09');
        await onboarding.cancel(restarted.token);
      } finally { ledger.close(); f.cleanup(); }
    });
  }
  test(`stable flush ${flushFails ? 'failure' : 'success'} finalizes synchronously and never clears saved credentials`, async () => {
    const f = fixture(), ledger = new FinanceLedger(path.join(f.directory, 'ledger'));
    try {
      const onboarding = new FinanceShopOnboarding({ browser: f.browser, analyze: analyzeFinanceIdentity, call: async (method, ...args) => ledger[method](...args) });
      const { token } = await onboarding.begin('2026-09');
      const draft = onboarding.pending.get(token), win = windows.at(-1), ses = win.webContents.session;
      let bound = false, clears = 0;
      const provisionalReads = [];
      win.setTitle = () => { bound = true; };
      win.snapshot = () => {
        if (bound) provisionalReads.push(f.browser.contextOf(token).draft);
        return { url: win.webContents.url, title: '收支账单', text: '收入账单 月汇总', entries: [] };
      };
      ses.cookies.flushStore = async () => { if (flushFails) throw new Error('synthetic flush failure'); };
      ses.clearStorageData = async () => { clears += 1; }; ses.clearCache = async () => { clears += 1; };
      const view = await onboarding.inspect(token);
      const result = await onboarding.confirm(token, { fingerprint: view.fingerprint, name: '已最终保存店' });
      assert.equal(result.sessionPersisted, !flushFails);
      assert.ok(provisionalReads.length > 0); assert.ok(provisionalReads.every(value => value === true));
      assert.equal(f.browser.contextOf(token).draft, false);
      assert.equal(draft.createdShop, null); assert.equal(draft.rollbackKey, undefined);
      assert.equal(onboarding.pending.has(token), false);
      assert.equal(ledger.shop(token).name, '已最终保存店'); assert.equal(ledger.shop(token).schedule, false);
      assert.deepEqual(await onboarding.cancel(token), { cancelled: true });
      await assert.rejects(f.browser.discardDraft(token), /已绑定|非临时/);
      f.browser.open(result.shop, '2026-09', '', { draft: true });
      assert.equal(f.browser.contextOf(token).draft, false, 'a saved session cannot be downgraded');
      await assert.rejects(f.browser.discardDraft(token), /已绑定|非临时/);
      assert.equal(win.isDestroyed(), false); assert.equal(clears, 0);
      console.log('FINALIZE_EVIDENCE', JSON.stringify({ flushFails, provisionalReads, committedDraft: false, clears, rollbackCapabilityRemoved: true }));
    } finally { ledger.close(); f.cleanup(); }
  });
}

test('finalize refuses unattached drafts and opened saved sessions', async () => {
  const f = fixture();
  try {
    const { identityVersion } = await f.browser.readIdentity(f.id);
    assert.throws(() => f.browser.finalizeShop(f.id, { identityVersion }), /非本次/);
    assert.equal(f.browser.contextOf(f.id).draft, true);
    const saved = f.browser.open({ id: crypto.randomUUID(), name: 'already saved' }, '2026-09', '', { draft: false });
    const savedId = [...sessions.keys()].at(-1).replace('persist:finance-', '');
    const savedVersion = (await f.browser.readIdentity(savedId)).identityVersion;
    await f.browser.attachShop({ id: savedId, name: 'already saved' }, '2026-09', { identityVersion: savedVersion });
    assert.throws(() => f.browser.finalizeShop(savedId, { identityVersion: savedVersion }), /非本次/);
    f.browser.open({ id: savedId, name: 'already saved' }, '2026-09', '', { draft: true });
    assert.equal(f.browser.contextOf(savedId).draft, false);
    await assert.rejects(f.browser.discardDraft(savedId), /非临时/);
    assert.equal(saved.isDestroyed(), false);
  } finally { f.cleanup(); }
});

registerSafetyTests();
