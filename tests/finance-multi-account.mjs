/**
 * 多账号并发登录验证：确认“一个浏览器只能登一个账号”不是本方案的限制。
 *
 * 做法：为两家店铺各开一个取账窗口（每店独立 session 分区），分别写入同名会话 Cookie，
 * 再各自读取。若两个窗口读到各自的账号，说明多店铺登录态互不覆盖，可以同时在线取账。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { startQianniuFixture } from './fixtures/qianniu-server.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-finance-multi-'));
const fixture = await startQianniuFixture();
let application = null;
try {
  application = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: ['.', `--user-data-dir=${directory}`], cwd: process.cwd(),
    env: { ...process.env, FINANCE_ALLOW_TEST_ORIGIN: '1', FINANCE_TEST_ORIGIN: fixture.origin }
  });
  const main = await application.firstWindow();
  main.setDefaultTimeout(60000);
  await main.waitForLoadState('domcontentloaded');
  await main.locator('[data-setup-mode="standalone"]').click();
  await main.locator('#finishFirstRun').click();
  await main.locator('#firstRunSetup').waitFor({ state: 'hidden' });

  const shops = await main.evaluate(async origin => {
    const api = window.inventoryApp;
    const base = { entity: '测试主体', taxId: 'T', entityType: 'enterprise', taxpayer: 'small', cycle: 'monthly', startMonth: '2026-01' };
    return [
      await api.saveFinanceShop({ ...base, name: '并发店铺A', account: 'acct-A', billUrl: `${origin}/bill?account=acct-A` }),
      await api.saveFinanceShop({ ...base, name: '并发店铺B', account: 'acct-B', billUrl: `${origin}/bill?account=acct-B` })
    ];
  }, fixture.origin);

  // 同时为两家店铺打开取账窗口（模拟两个账号同时在线）。
  const opened = [];
  for (const shop of shops) {
    const wait = application.waitForEvent('window');
    await main.evaluate(async ({ id, origin }) => window.inventoryApp.openFinance(id, '2026-09'), { id: shop.id, origin: fixture.origin });
    opened.push(await wait);
  }
  assert.equal(opened.length, 2);
  for (const [index, win] of opened.entries()) {
    await win.waitForLoadState('domcontentloaded');
    await win.goto(`${fixture.origin}/set-cookie?account=${shops[index].account}`);
    await win.goto(`${fixture.origin}/whoami`);
    const who = (await win.locator('body').innerText()).trim();
    assert.equal(who, shops[index].account, `窗口 ${index + 1} 应保持自己的登录态，实际读到 ${who}`);
  }
  // 再回头确认先登录的窗口没有被后一个覆盖。
  await opened[0].goto(`${fixture.origin}/whoami`);
  assert.equal((await opened[0].locator('body').innerText()).trim(), shops[0].account);

  console.log(JSON.stringify({
    ok: true,
    conclusion: '每店独立会话分区：两个账号可以同时登录、同时导出，互不覆盖',
    isolated: { [shops[0].name]: shops[0].account, [shops[1].name]: shops[1].account }
  }, null, 2));
} finally {
  const pid = application?.process()?.pid;
  if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
  await application?.close().catch(() => {});
  await fixture.close();
}
