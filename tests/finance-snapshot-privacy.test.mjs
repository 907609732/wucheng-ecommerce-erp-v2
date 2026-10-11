import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { SNAPSHOT_SCRIPT } from '../desktop/shared/finance-page.mjs';
import { analyzeFinanceIdentity } from '../desktop/shared/finance-identity.mjs';
import { FinanceShopOnboarding } from '../desktop/shared/finance-onboarding.mjs';
import { FinanceLedger } from '../desktop/shared/finance-ledger.mjs';

test('identity provenance requires a document header with an explicit current-shop label, not cards or grids', () => {
  const element = (tag, text, scope = null, excluded = false, region = null) => ({
    tagName: tag.toUpperCase(), id: '', classList: [], childNodes: [{ nodeType: 3, nodeValue: text }], innerText: text,
    matches: () => false, getAttribute: () => '', getBoundingClientRect: () => ({ width: 180, height: 30, x: 0, y: 0 }),
    closest: selector => selector.startsWith('header') ? scope : selector === 'tr' ? null : selector === 'section' ? region : excluded ? {} : selector.includes('section') ? region : null,
    parentElement: region, children: [], querySelectorAll: () => []
  });
  const good = element('header', '');
  const region = { tagName: 'SECTION', parentElement: good, getAttribute: name => name === 'aria-label' ? '当前登录店铺' : '' };
  const current = element('span', '当前店铺名称：合成当前店', good, false, region);
  const entity = element('span', '经营主体：当前主体', good, false, region);
  const grid = element('span', '店铺名称：其他商家', good, true);
  good.querySelectorAll = () => [current, entity, grid];
  const generic = element('header', '');
  const genericName = element('span', '店铺名称：无当前标签', generic);
  generic.querySelectorAll = () => [genericName];
  const card = element('div', '当前店铺名称：订单卡片');
  const outside = element('span', '税号：其他区域税号', good);
  const otherRegion = { getAttribute: () => '订单交易对方' };
  const other = element('span', '当前店铺名称：非当前店铺区', good, false, otherRegion);
  good.querySelectorAll = () => [current, entity, grid, outside, other];
  const result = vm.runInNewContext(SNAPSHOT_SCRIPT, {
    location: { href: 'https://qn.taobao.com/' }, window: {},
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    document: { title: '收支账单', readyState: 'complete', body: { innerText: '收支账单' },
      querySelectorAll: selector => selector === '*' ? [current, entity, grid, genericName, card, outside, other] : selector.startsWith('header') ? [good, generic] : [] }
  });
  assert.equal(result.entries[0].identitySource, 'semantic-current-shop-header');
  assert.equal(result.entries[1].identitySource, 'semantic-current-shop-header');
  for (const entry of result.entries.slice(2)) assert.equal(entry.identitySource || '', '', entry.text);
});

test('page snapshots do not read or expose password values', () => {
  let reads = 0;
  const element = {
    tagName: 'INPUT', id: 'testPassword', classList: [], childNodes: [], innerText: '', disabled: false, checked: false,
    matches: () => true, closest: () => null,
    getAttribute: name => name === 'type' ? 'password' : '',
    getBoundingClientRect: () => ({ width: 180, height: 30, x: 0, y: 0 }),
    get value() { reads += 1; return 'synthetic-password-never-read'; }
  };
  const context = {
    location: { href: 'https://login.taobao.com/' }, window: {},
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    document: {
      title: '登录', readyState: 'complete', body: { innerText: '请登录' },
      querySelectorAll: selector => ['*', '#testPassword'].includes(selector) ? [element] : []
    }
  };
  const result = vm.runInNewContext(SNAPSHOT_SCRIPT, context);
  assert.equal(reads, 0, '密码字段不得被访问');
  assert.equal(result.entries[0].value, '');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-password-never-read/);
});

const mixedHeaders = [
  { name: 'unnamed header sibling order div', html: '<header><span>当前店铺名称：不得信任宽泛页头</span><div aria-label="订单交易对方"><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></div></header>', shopName: '' },
  { name: 'named section nested aria order div', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><div aria-label="订单交易对方"><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></div></section></header>', shopName: '可信当前店' },
  { name: 'named section nested unnamed card', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><div><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></div></section></header>', shopName: '可信当前店' },
  { name: 'named section directly aria labeled counterparty field', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><div aria-label="订单交易对方">经营主体：订单对方企业</div><div aria-label="订单交易对方">税号：ORDER-TAX</div></section></header>', shopName: '可信当前店' },
  { name: 'aggregate and child text must not become identity', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><div tabindex="0">经营主体：订单对方企业<span>税号：ORDER-TAX</span></div><div>税号：ORDER-TAX 经营主体：订单对方企业</div></section></header>', shopName: '可信当前店' },
  { name: 'nested current shop label cannot authorize direct fields', html: '<header><section aria-label="当前登录店铺"><div><span>当前店铺名称：嵌套订单卡</span></div><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></section></header>', shopName: '' },
  { name: 'whitespace-separated aggregate explicit fields', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><div>经营主体：订单对方企业 纳税人识别号 ORDER-TAX</div><div>税号：ORDER-TAX 主体名称 订单对方企业</div></section></header>', shopName: '可信当前店' },
  { name: 'document header sibling order div contains nested header', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span></section><div aria-label="订单交易对方"><header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></section></header></div></header>', shopName: '可信当前店' },
  { name: 'document header sibling order div contains nested banner', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span></section><div aria-label="订单交易对方"><div role="banner"><section aria-label="当前店铺身份"><span>当前店铺：可信当前店</span><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></section></div></div></header>', shopName: '可信当前店' },
  { name: 'same shop name in two current sections cannot authorize cross-region fields', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><span>经营主体：区域甲主体</span></section><section aria-label="当前店铺身份"><span>当前店铺名称：可信当前店</span><span>税号：REGION-B-TAX</span></section></header>', shopName: '' },
  { name: 'same shop name in two document headers cannot authorize cross-region fields', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><span>经营主体：区域甲主体</span></section></header><div role="banner"><section aria-label="当前店铺身份"><span>当前店铺名称：可信当前店</span><span>税号：REGION-B-TAX</span></section></div>', shopName: '' },
  { name: 'header inside an aria counterparty ancestor is not a document identity', html: '<div aria-label="订单交易对方"><header><section aria-label="当前登录店铺"><span>当前店铺名称：订单同名店</span><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></section></header></div>', shopName: '' },
  { name: 'banner inside an aria-labelledby counterparty ancestor is not a document identity', html: '<div aria-labelledby="counterparty"><span id="counterparty">订单交易对方</span><div role="banner"><section aria-label="当前登录店铺"><span>当前店铺名称：订单同名店</span><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></section></div></div>', shopName: '' },
  { name: 'direct explicit fields in named current shop section', html: '<header><section aria-label="当前登录店铺"><span>当前店铺名称：可信当前店</span><span>经营主体：可信当前主体</span><span>税号：CURRENT-TAX</span></section><div aria-label="订单交易对方"><span>经营主体：订单对方企业</span><span>税号：ORDER-TAX</span></div></header>', shopName: '可信当前店', entity: '可信当前主体', taxId: 'CURRENT-TAX' }
];

// Only the Electron API boundary is substituted. All snapshot/identity/attach/finalize
// logic is the real browser manager; each partition has a real isolated Chromium context.
let currentChromiumBoundary;
const chromiumSessions = new Map();
class ChromiumWindowBoundary extends EventEmitter {
  constructor(options) {
    super(); this.destroyed = false;
    const { page } = currentChromiumBoundary;
    const wc = new EventEmitter();
    wc.session = options.webPreferences.session;
    wc.getURL = () => page.url(); wc.setWindowOpenHandler = () => {};
    wc.mainFrame = { get url() { return page.url(); }, framesInSubtree: [], executeJavaScript: async script => { await this.loading; return page.evaluate(script); } };
    this.webContents = wc; this.page = page;
  }
  isDestroyed() { return this.destroyed; }
  show() {} setTitle(title) { this.title = title; }
  loadURL(url) { this.loading = this.page.goto(url); return this.loading; }
  close() { this.destroy(); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
const chromiumSessionBoundary = { fromPartition(partition) {
  if (!chromiumSessions.has(partition)) {
    const { context } = currentChromiumBoundary;
    const ses = new EventEmitter(); ses.cookies = new EventEmitter();
    ses.cookies.get = async ({ name }) => (await context.cookies()).filter(cookie => cookie.name === name);
    ses.cookies.flushStore = async () => {}; // Playwright exposes no Electron flushStore API.
    ses.setPermissionRequestHandler = () => {};
    ses.clearStorageData = () => context.clearCookies(); ses.clearCache = async () => {};
    chromiumSessions.set(partition, ses);
  }
  return chromiumSessions.get(partition);
} };
globalThis.__financeChromiumBoundary = { BrowserWindow: ChromiumWindowBoundary, session: chromiumSessionBoundary };
const chromiumBrowserSource = fs.readFileSync(new URL('../desktop/shared/finance-browser.mjs', import.meta.url), 'utf8')
  .replace("import { BrowserWindow, session } from 'electron';", 'const { BrowserWindow, session } = globalThis.__financeChromiumBoundary;')
  .replace("'./finance-page.mjs'", JSON.stringify(new URL('../desktop/shared/finance-page.mjs', import.meta.url).href));
const { createFinanceBrowser } = await import(`data:text/javascript;base64,${Buffer.from(chromiumBrowserSource).toString('base64')}`);
delete globalThis.__financeChromiumBoundary;

test('Chromium mixed header identities remain safe through real browser confirm into a temporary FinanceLedger', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-second-dom-'));
  const ledger = new FinanceLedger(path.join(directory, 'ledger'));
  const server = http.createServer((req, res) => {
    const fixture = mixedHeaders[Number(new URL(req.url, 'http://localhost').pathname.slice(1))] || mixedHeaders[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>收支账单</title>${fixture.html}<main>收入账单 月汇总</main>`);
  });
  let runtime, context;
  const priorOrigin = process.env.FINANCE_TEST_ORIGIN;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Use an installed Chromium when this project's headless-shell revision is absent.
    const cache = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright');
    const installed = fs.existsSync(cache) ? fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse().map(name => path.join(cache, name, process.platform === 'win32' ? 'chrome-win64/chrome.exe' : 'chrome-linux/chrome')).find(file => fs.existsSync(file)) : '';
    const executablePath = process.env.FINANCE_TEST_CHROMIUM_EXECUTABLE || installed || chromium.executablePath();
    runtime = await chromium.launch({ headless: true, executablePath });
    process.env.FINANCE_TEST_ORIGIN = origin;
    console.log('CHROMIUM_RUNTIME', JSON.stringify({ executablePath, version: runtime.version() }));
    const mismatches = [];
    for (const [index, fixture] of mixedHeaders.entries()) {
      context = await runtime.newContext();
      const page = await context.newPage();
      await page.goto(`${origin}/${index}`);
      const account = `synthetic-nick-${index}`;
      await context.addCookies([{ url: origin, name: '_nk_', value: account }]);
      currentChromiumBoundary = { context, page };
      const browser = createFinanceBrowser({ directory: path.join(directory, `browser-${index}`), allowTestOrigin: true });
      const onboarding = new FinanceShopOnboarding({ browser, call: async (method, ...args) => ledger[method](...args), analyze: analyzeFinanceIdentity, onboardingUrl: `${origin}/${index}` });
      const { token } = await onboarding.begin('2026-09');
      const inspection = await onboarding.inspect(token);
      assert.equal(inspection.state, 'needs_confirmation', fixture.name);
      assert.equal(inspection.identity.account, account, 'nickname remains available for manual naming');
      const result = await onboarding.confirm(token, { fingerprint: inspection.fingerprint, name: `人工补名-${index}` });
      const stored = ledger.shops().find(shop => shop.id === result.shop.id);
      assert.ok(stored, 'read back the exact persisted shop');
      const actual = { name: stored.name, entity: stored.entity, taxId: stored.taxId, account: stored.account };
      const expected = { name: fixture.shopName || `人工补名-${index}`, entity: fixture.entity || '', taxId: fixture.taxId || '', account };
      console.log('CHROMIUM_LEDGER_EVIDENCE', JSON.stringify({ fixture: fixture.name, actual, expected, analyzed: inspection.identity }));
      try { assert.deepEqual(actual, expected, fixture.name); } catch (error) { mismatches.push(error.message); }
      assert.equal(browser.contextOf(token).draft, false, 'the real manager finalizes only after confirmation');
      browser.closeAll();
      await context.close(); context = null;
    }
    assert.deepEqual(mismatches, [], 'no counterparty fields may persist; unknown shop names require manual input');
  } finally {
    if (context) await context.close();
    if (runtime) await runtime.close();
    if (priorOrigin === undefined) delete process.env.FINANCE_TEST_ORIGIN; else process.env.FINANCE_TEST_ORIGIN = priorOrigin;
    chromiumSessions.clear();
    await new Promise(resolve => server.close(resolve));
    ledger.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
