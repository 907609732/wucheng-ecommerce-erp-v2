// Local Electron regression only: isolated userData, HTTP fixtures, no ERP main or accounts.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const browserModule = new URL('../desktop/shared/finance-browser.mjs', import.meta.url).href;
const onboardingModule = new URL('../desktop/shared/finance-onboarding.mjs', import.meta.url).href;
const identityModule = new URL('../desktop/shared/finance-identity.mjs', import.meta.url).href;
const ledgerModule = new URL('../desktop/shared/finance-ledger.mjs', import.meta.url).href;

async function localElectron(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-second-safety-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>收支账单</title><header><section aria-label="当前登录店铺"><span>当前店铺名称：本地合成店</span><span id="fixtureEntity">经营主体：原始合成主体</span></section></header><main>收入账单 月汇总</main><script>window.onbeforeunload = () => false; window.fixtureReady = true;</script>');
  });
  let application;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const main = path.join(directory, 'main.mjs');
    fs.writeFileSync(main, `import { app } from 'electron';
      import { createFinanceBrowser } from ${JSON.stringify(browserModule)};
      import { FinanceShopOnboarding } from ${JSON.stringify(onboardingModule)};
      import { analyzeFinanceIdentity } from ${JSON.stringify(identityModule)};
      import { FinanceLedger } from ${JSON.stringify(ledgerModule)};
      app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
      app.on('window-all-closed', () => {});
      app.whenReady().then(async () => {
        globalThis.browser = createFinanceBrowser({ directory: ${JSON.stringify(path.join(directory, 'data'))}, allowTestOrigin: true });
        globalThis.onboarding = new FinanceShopOnboarding({ browser, call: async () => { throw new Error('No business writes allowed'); }, analyze: analyzeFinanceIdentity, onboardingUrl: ${JSON.stringify(origin)} });
        globalThis.fixtureOrigin = ${JSON.stringify(origin)};
        globalThis.createFixtureLedger = () => new FinanceLedger(${JSON.stringify(path.join(directory, 'ledger'))});
        const started = await onboarding.begin('2026-09');
        globalThis.draftToken = started.token;
      });
    `, { flag: 'wx' });
    application = await electron.launch({ executablePath: require('electron'), args: [main], env: { ...process.env, FINANCE_TEST_ORIGIN: origin }, timeout: 20000 });
    const page = await application.firstWindow();
    // Electron handles beforeunload through will-prevent-unload, not a CDP dialog.
    page.on('dialog', () => {});
    await page.waitForFunction(() => window.fixtureReady === true);
    return await run(application, page);
  } finally {
    if (application) {
      await application.evaluate(() => { globalThis.fixtureLedger?.close(); }).catch(() => {});
      await application.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => {});
      await application.close();
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const veto of ['beforeunload', 'close.preventDefault']) {
test(`Electron cancel destroys only the draft before clearing its ${veto}-vetoed session`, { timeout: 30000 }, async () => {
  await localElectron(async (application, page) => {
    await page.evaluate(() => { document.cookie = 'draftFixture=before; path=/'; });
    const evidence = await application.evaluate(async ({ BrowserWindow, session }, veto) => {
      const draftWindow = BrowserWindow.getAllWindows()[0];
      const savedWindow = browser.open({ id: 'synthetic-saved', name: 'Saved fixture', billUrl: fixtureOrigin }, '2026-09', '');
      await savedWindow.webContents.session.cookies.set({ url: fixtureOrigin, name: 'savedFixture', value: 'keep' });
      let willPrevent = 0;
      draftWindow.webContents.on('will-prevent-unload', () => { willPrevent += 1; });
      if (veto === 'close.preventDefault') draftWindow.on('close', event => { willPrevent += 1; event.preventDefault(); });
      browser.close(draftToken);
      await new Promise(resolve => setTimeout(resolve, 100));
      const vetoProven = !draftWindow.isDestroyed() && willPrevent > 0;
      const managerOpenAfterVeto = browser.isOpen(draftToken);
      const cleanupObserved = [];
      const draftSession = draftWindow.webContents.session;
      for (const method of ['clearStorageData', 'clearCache']) {
        const original = draftSession[method].bind(draftSession);
        draftSession[method] = async (...args) => {
          cleanupObserved.push({ method, destroyedBeforeCleanup: draftWindow.isDestroyed() });
          return original(...args);
        };
      }
      const cancellation = await onboarding.cancel(draftToken);
      await new Promise(resolve => setTimeout(resolve, 100));
      const nativeWindowAlive = !draftWindow.isDestroyed();
      if (nativeWindowAlive) await draftWindow.webContents.executeJavaScript("document.cookie = 'draftFixture=after-cancel; path=/'");
      return {
        vetoProven, managerOpenAfterVeto, cleanupObserved, cancellation, nativeWindowAlive,
        pending: onboarding.pending.has(draftToken), managerOpen: browser.isOpen(draftToken),
        draftCookies: (await session.fromPartition(`persist:finance-${draftToken}`).cookies.get({})).map(({ name, value }) => ({ name, value })),
        savedWindowAlive: !savedWindow.isDestroyed(), savedManagerOpen: browser.isOpen('synthetic-saved'),
        savedCookie: (await savedWindow.webContents.session.cookies.get({ name: 'savedFixture' })).map(({ value }) => value)
      };
    }, veto);
    console.log('ELECTRON_CANCEL_EVIDENCE', JSON.stringify(evidence));
    assert.equal(evidence.vetoProven, true, 'real beforeunload must veto ordinary native close');
    assert.equal(evidence.managerOpenAfterVeto, true, 'ordinary close must not forget the live native window');
    assert.deepEqual(evidence.cleanupObserved, [
      { method: 'clearStorageData', destroyedBeforeCleanup: true },
      { method: 'clearCache', destroyedBeforeCleanup: true }
    ]);
    assert.equal(evidence.nativeWindowAlive, false, 'cancel must not report success with a live draft able to rewrite cookies');
    assert.deepEqual(evidence.cancellation, { cancelled: true });
    assert.equal(evidence.pending, false);
    assert.equal(evidence.managerOpen, false);
    assert.deepEqual(evidence.draftCookies, []);
    assert.equal(evidence.savedWindowAlive, true);
    assert.equal(evidence.savedManagerOpen, true);
    assert.deepEqual(evidence.savedCookie, ['keep']);
  });
});
}

for (const flushFails of [false, true]) {
test(`Electron post-attach DOM change after flush ${flushFails ? 'failure' : 'success'} rolls back and retries native cleanup`, { timeout: 30000 }, async () => {
  await localElectron(async (application, page) => {
    await page.evaluate(() => { document.cookie = '_nk_=draft-nickname; path=/'; document.cookie = 'authentication_fixture=draft-only; path=/'; });
    const evidence = await application.evaluate(async ({ BrowserWindow, session }, flushFails) => {
      const ledger = globalThis.fixtureLedger = createFixtureLedger();
      onboarding.call = async (method, ...args) => ledger[method](...args);
      const saved = ledger.saveShop({ name: '既存保留店', account: 'saved-nickname', taxId: 'KEEP-TAX', schedule: true });
      const savedBefore = ledger.shop(saved.id), savedWindow = browser.open({ ...saved, billUrl: fixtureOrigin }, '2026-09', '');
      await savedWindow.webContents.session.cookies.set({ url: fixtureOrigin, name: 'savedAuthenticationFixture', value: 'keep' });
      const draftWindow = BrowserWindow.getAllWindows().find(win => win.webContents.session === session.fromPartition(`persist:finance-${draftToken}`));
      const draftSession = draftWindow.webContents.session, frame = draftWindow.webContents.mainFrame;
      const execute = frame.executeJavaScript.bind(frame), nativeTitle = draftWindow.setTitle.bind(draftWindow);
      let mutation = Promise.resolve(), bound = false, storageAttempts = 0;
      frame.executeJavaScript = async (...args) => { await mutation; return execute(...args); };
      draftWindow.setTitle = title => {
        nativeTitle(title); bound = true;
        mutation = execute("document.getElementById('fixtureEntity').textContent = '经营主体：绑定后异步变化主体'");
      };
      const nativeFlush = draftSession.cookies.flushStore.bind(draftSession.cookies);
      draftSession.cookies.flushStore = async () => { await nativeFlush(); if (flushFails) throw new Error('synthetic flush failure'); };
      const cleanupObserved = [];
      const nativeStorage = draftSession.clearStorageData.bind(draftSession);
      draftSession.clearStorageData = async (...args) => {
        cleanupObserved.push({ method: 'clearStorageData', destroyedBeforeCleanup: draftWindow.isDestroyed() });
        if (++storageAttempts === 1) throw new Error('synthetic temporary storage failure');
        return nativeStorage(...args);
      };
      const nativeCache = draftSession.clearCache.bind(draftSession);
      draftSession.clearCache = async (...args) => {
        cleanupObserved.push({ method: 'clearCache', destroyedBeforeCleanup: draftWindow.isDestroyed() });
        return nativeCache(...args);
      };
      const view = await onboarding.inspect(draftToken);
      let error = '';
      try { await onboarding.confirm(draftToken, { fingerprint: view.fingerprint }); } catch (caught) { error = caught.message; }
      const retryPending = onboarding.pending.has(draftToken), destroyedAfterFailure = draftWindow.isDestroyed();
      const cancellation = await onboarding.cancel(draftToken);
      return {
        flushFails, bound, originalEntity: view.identity.entity, error, retryPending, destroyedAfterFailure, cancellation, cleanupObserved,
        pendingAfterRetry: onboarding.pending.has(draftToken), newShopExists: ledger.shops().some(shop => shop.id === draftToken),
        draftCookies: (await draftSession.cookies.get({})).map(({ name, value }) => ({ name, value })),
        savedShopUnchanged: JSON.stringify(ledger.shop(saved.id)) === JSON.stringify(savedBefore), savedWindowAlive: !savedWindow.isDestroyed(),
        savedCookie: (await savedWindow.webContents.session.cookies.get({ name: 'savedAuthenticationFixture' })).map(({ value }) => value)
      };
    }, flushFails);
    console.log('ELECTRON_POST_ATTACH_EVIDENCE', JSON.stringify(evidence));
    assert.equal(evidence.bound, true); assert.equal(evidence.originalEntity, '原始合成主体');
    assert.match(evidence.error, /变化.*清理未完成/);
    assert.equal(evidence.retryPending, true); assert.equal(evidence.destroyedAfterFailure, true);
    assert.deepEqual(evidence.cancellation, { cancelled: true }); assert.equal(evidence.pendingAfterRetry, false);
    assert.equal(evidence.newShopExists, false); assert.deepEqual(evidence.draftCookies, []);
    assert.deepEqual(evidence.cleanupObserved, [
      { method: 'clearStorageData', destroyedBeforeCleanup: true },
      { method: 'clearStorageData', destroyedBeforeCleanup: true },
      { method: 'clearCache', destroyedBeforeCleanup: true }
    ]);
    assert.equal(evidence.savedShopUnchanged, true); assert.equal(evidence.savedWindowAlive, true);
    assert.deepEqual(evidence.savedCookie, ['keep']);
  });
});
}
