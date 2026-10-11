import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

// 全部账号、会话与店铺信息均为本地合成夹具，不访问真实平台。
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-finance-login-ui-'));
const output = path.resolve('dist/finance-login-verification');
fs.mkdirSync(output, { recursive: true });
const identities = {
  'synthetic-first': { name: '测试店铺（合成数据）', account: 'test-seller', id: 'TEST-SHOP-1' },
  'synthetic-second': { name: '第二测试店铺（合成数据）', account: 'test-seller-2', id: 'TEST-SHOP-2' },
  'synthetic-other': { name: '另一个测试店铺', account: 'different-seller', id: 'TEST-SHOP-OTHER' },
  'synthetic-fallback': { name: '', account: 'test-fallback-account', id: '' }
};
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const route = new URL(req.url, 'http://localhost').pathname;
  const redirect = location => { res.writeHead(302, { Location: location }); res.end(); };
  const signIn = key => {
    const identity = identities[key];
    res.setHeader('Set-Cookie', [
      `_nk_=${identity.account}; Path=/; SameSite=Lax; Max-Age=3600`,
      `erp_fixture_session=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`
    ]);
    redirect(key === 'synthetic-fallback' ? '/bill-cookie-only' : '/bill');
  };
  if (route === '/login') {
    res.end('<!doctype html><html><body><h1>扫码登录</h1><a id="testLogin" href="/signed-in">模拟本人登录第一店铺</a><br><a id="testLoginSecond" href="/signed-in-second">模拟本人登录第二店铺</a><br><a id="testLoginFallback" href="/signed-in-fallback">模拟只提供账号的店铺</a></body></html>');
  } else if (route === '/signed-in') { signIn('synthetic-first');
  } else if (route === '/signed-in-second') { signIn('synthetic-second');
  } else if (route === '/other') { signIn('synthetic-other');
  } else if (route === '/signed-in-fallback') { signIn('synthetic-fallback');
  } else if (route === '/bill-cookie-only') {
    if (!(req.headers.cookie || '').includes('erp_fixture_session=synthetic-fallback')) { redirect('/login'); return; }
    res.end('<!doctype html><html><body><main><h1>收支账单</h1><p>收入账单 月汇总</p><article><span>店铺名称：订单交易对方（不得回填）</span></article></main></body></html>');
  } else if (route === '/bill') {
    const key = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('erp_fixture_session='))?.slice('erp_fixture_session='.length);
    const identity = identities[key];
    if (!identity) { redirect('/login'); return; }
    res.end(`<!doctype html><html><head><title>千牛账单测试页面</title></head><body><header role="banner"><section aria-label="当前登录店铺"><span>当前店铺名称：${identity.name}</span><span>当前登录账号：${identity.account}</span><span>店铺ID：${identity.id}</span><span>经营主体名称：测试主体（合成数据）</span></section></header><main><h1>收支账单</h1><p>收入账单 月汇总 货款收入</p><div role="grid"><div role="row"><span>店铺名称：订单交易对方（不得识别）</span><span>税号：SYNTHETIC-COUNTERPARTY-TAX</span></div></div></main></body></html>`);
  } else { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let application;
const errors = [];
async function launch() {
  application = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: ['.', `--user-data-dir=${directory}`], cwd: process.cwd(),
    env: { ...process.env, FINANCE_ALLOW_TEST_ORIGIN: '1', FINANCE_TEST_ORIGIN: origin, FINANCE_TEST_ONBOARD_URL: `${origin}/login` }
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  return page;
}
async function draftToken(page) {
  const win = await application.browserWindow(page);
  const storage = await win.evaluate(window => window.webContents.session.getStoragePath());
  const token = path.basename(storage).replace(/^finance-/, '');
  assert.match(token, /^[0-9a-f-]{36}$/);
  return token;
}
async function cookies(token, name) {
  return application.evaluate(async ({ session }, { token, name }) => {
    const rows = await session.fromPartition(`persist:finance-${token}`).cookies.get({ name });
    return rows.map(row => row.value);
  }, { token, name });
}
async function stop() {
  const pid = application?.process()?.pid;
  if (pid) try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  await application?.close().catch(() => {}); application = null;
}
async function addWindow(page, button = '#financeAdd') {
  const next = application.waitForEvent('window');
  await page.locator(button).click();
  const seller = await next;
  await seller.waitForLoadState('domcontentloaded');
  return seller;
}
async function confirm(page) {
  await page.waitForFunction(() => !document.getElementById('financeShopLoginConfirm').disabled);
  await page.locator('#financeShopLoginConfirm').click();
  await page.locator('#financeShopLoginDialog').waitFor({ state: 'hidden' });
  await page.locator('#financeContent').waitFor({ state: 'visible' });
}
const getReport = (page, token = '') => page.evaluate(token => window.inventoryApp.getFinance(token, '2026-09'), token);
try {
  let page = await launch();
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  await page.locator('[data-open-view="finance"]').click();
  assert.equal(await page.locator('#financeShopLoginDialog').count(), 1);
  const seller = await addWindow(page, '#financeFirstShop');
  assert.equal(await page.locator('#financeShopDialog').isVisible(), false, '不应先弹出税务设置大表');
  assert.equal(await page.locator('#financeShopLoginDialog').isVisible(), true);
  assert.equal(await page.locator('#financeShopLoginConfirm').isDisabled(), true);
  assert.equal((await getReport(page)).shops.length, 0, '确认前不保存占位店铺');
  await seller.locator('#testLogin').click();
  await page.waitForFunction(() => document.getElementById('finLoginName').value === '测试店铺（合成数据）');
  assert.equal(await page.locator('#finLoginAccount').textContent(), 'test-seller');
  assert.match(await page.locator('#financeShopLoginInfo').textContent(), /测试主体/);
  assert.match(await page.locator('#financeShopLoginInfo').textContent(), /后台未提供/);
  assert.doesNotMatch(await page.locator('#financeShopLoginInfo').textContent(), /订单交易对方|COUNTERPARTY/);
  await page.screenshot({ path: path.join(output, 'login-detected.png'), fullPage: true });
  const token = await draftToken(seller);
  await confirm(page);
  let report = await getReport(page, token);
  assert.equal(report.shops.length, 1);
  assert.equal(report.shop.id, token, '沿用登录分区的 UUID');
  assert.equal(report.shop.name, '测试店铺（合成数据）');
  assert.equal(report.shop.account, 'test-seller');
  assert.equal(report.shop.entity, '测试主体（合成数据）');
  for (const key of ['taxId', 'taxpayer', 'entityType', 'cycle']) assert.equal(report.shop[key], '');
  assert.equal(report.shop.schedule, false);
  assert.equal(report.jobs.length, 0, '添加不启动取账');
  assert.equal(report.rows.length, 0, '添加不读取账单金额');
  // 主体/高级设置可以稍后修改；仅为此夹具设定本地账单 URL。
  await page.locator('#financeSettings').click();
  assert.equal(await page.locator('#finName').inputValue(), '测试店铺（合成数据）');
  await page.locator('#finTaxId').fill('SYNTHETIC-TAX-ONLY');
  await page.locator('#financeShopDialog details summary').click();
  await page.locator('#finBillUrl').fill(`${origin}/bill`);
  await page.locator('#financeShopForm [type="submit"]').click();
  await page.locator('#financeShopDialog').waitFor({ state: 'hidden' });
  await seller.goto(`${origin}/bill`);
  assert.equal(new URL(seller.url()).pathname, '/bill', '添加后仍可用本人会话访问受保护页面');

  const second = await addWindow(page);
  const secondToken = await draftToken(second);
  assert.deepEqual(await cookies(secondToken, 'erp_fixture_session'), [], '新店登录分区没有第一店铺认证');
  await second.locator('#testLoginSecond').click();
  await page.waitForFunction(() => document.getElementById('finLoginName').value === '第二测试店铺（合成数据）');
  await confirm(page);
  report = await getReport(page, secondToken);
  assert.equal(report.shops.length, 2);
  assert.equal(report.shop.account, 'test-seller-2');
  assert.deepEqual(await cookies(token, 'erp_fixture_session'), ['synthetic-first']);
  assert.deepEqual(await cookies(secondToken, 'erp_fixture_session'), ['synthetic-second']);

  const fallback = await addWindow(page);
  await fallback.locator('#testLoginFallback').click();
  await page.waitForFunction(() => document.getElementById('finLoginAccount').textContent === 'test-fallback-account');
  assert.equal(await page.locator('#finLoginName').inputValue(), '');
  assert.equal(await page.locator('#financeShopLoginConfirm').isDisabled(), true);
  await page.locator('#finLoginName').fill('手工补充的合成店铺');
  const fallbackToken = await draftToken(fallback);
  await confirm(page);
  const fallbackReport = await getReport(page, fallbackToken);
  assert.equal(fallbackReport.shop.name, '手工补充的合成店铺');
  assert.equal(fallbackReport.shop.account, 'test-fallback-account');
  assert.equal(fallbackReport.shop.platformShopId, '');
  assert.equal(fallbackReport.shop.entity, '');
  assert.equal(fallbackReport.shops.length, 3);

  const cancelledSeller = await addWindow(page);
  const cancelledToken = await draftToken(cancelledSeller);
  await cancelledSeller.locator('#testLoginSecond').click();
  await page.waitForFunction(() => document.getElementById('finLoginAccount').textContent === 'test-seller-2');
  await page.locator('#financeShopLoginCancel').click();
  await page.locator('#financeShopLoginDialog').waitFor({ state: 'hidden' });
  assert.equal((await getReport(page)).shops.length, 3);
  assert.equal(cancelledSeller.isClosed(), true);
  assert.deepEqual(await cookies(cancelledToken, 'erp_fixture_session'), [], '取消清理已登录的临时会话');

  const duplicate = await addWindow(page);
  await duplicate.locator('#testLogin').click();
  await page.waitForFunction(() => document.getElementById('finLoginAccount').textContent === 'test-seller');
  await confirm(page);
  report = await getReport(page, token);
  assert.equal(report.shops.length, 3);
  assert.equal(report.shop.taxId, 'SYNTHETIC-TAX-ONLY', '重复添加不覆盖稍后填写的税号');
  assert.equal(await page.locator('#financeShop').inputValue(), token);

  const switchedSeller = await addWindow(page);
  await switchedSeller.locator('#testLogin').click();
  await page.waitForFunction(() => document.getElementById('finLoginAccount').textContent === 'test-seller');
  const switchedToken = await draftToken(switchedSeller);
  const { fingerprint } = await page.evaluate(token => window.inventoryApp.inspectFinanceShopLogin(token), switchedToken);
  await switchedSeller.goto(`${origin}/other`);
  const changeResult = await page.evaluate(async ({ token, fingerprint }) => {
    try { await window.inventoryApp.confirmFinanceShopLogin(token, { fingerprint, name: '测试店铺（合成数据）' }); return 'unexpected saved'; }
    catch (error) { return error.message; }
  }, { token: switchedToken, fingerprint });
  assert.match(changeResult, /变化|切换|重新/);
  assert.equal((await getReport(page)).shops.length, 3);
  await page.locator('#financeShopLoginCancel').click();
  await page.locator('#financeShopLoginDialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await cookies(token, 'erp_fixture_session'), ['synthetic-first']);
  await stop();

  page = await launch();
  await page.locator('[data-open-view="finance"]').click();
  await page.locator('#financeContent').waitFor({ state: 'visible' });
  report = await getReport(page, token);
  assert.equal(report.shop.name, '测试店铺（合成数据）');
  assert.deepEqual(await cookies(token, '_nk_'), ['test-seller']);
  assert.deepEqual(await cookies(token, 'erp_fixture_session'), ['synthetic-first']);
  assert.deepEqual(await cookies(secondToken, 'erp_fixture_session'), ['synthetic-second']);
  const reopened = application.waitForEvent('window');
  await page.evaluate(token => window.inventoryApp.openFinance(token, '2026-09'), token);
  const authenticated = await reopened;
  await authenticated.waitForURL(url => url.origin === origin && url.pathname === '/bill');
  await authenticated.waitForLoadState('domcontentloaded');
  assert.equal(new URL(authenticated.url()).pathname, '/bill', '重启后受保护页不再要求登录');
  assert.match(await authenticated.locator('header').textContent(), /当前登录账号：test-seller/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, syntheticOnly: true, checks: ['login-first', 'no-placeholder', 'scoped-identity-not-order-card', 'unknown-tax-empty', 'explicit-confirmation', 'authenticated-session-reuse', 'two-shop-isolation', 'one-name-field-fallback', 'logged-in-draft-cancel-and-cookie-cleanup', 'duplicate-no-overwrite', 'account-change-blocked', 'settings-later', 'authenticated-session-restart'], screenshots: output }));
} finally {
  await stop(); await new Promise(resolve => server.close(resolve));
}
