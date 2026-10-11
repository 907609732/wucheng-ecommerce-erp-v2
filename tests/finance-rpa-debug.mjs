import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { startQianniuFixture } from './fixtures/qianniu-server.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-finance-debug-'));
const fixture = await startQianniuFixture();
let application = null;
try {
  application = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${directory}`], cwd: process.cwd(), env: { ...process.env, FINANCE_ALLOW_TEST_ORIGIN: '1', FINANCE_TEST_ORIGIN: fixture.origin, FINANCE_EXPORT_TIMEOUT_MS: '3000', FINANCE_POLL_INTERVAL_MS: '400' } });
  const page = await application.firstWindow();
  page.setDefaultTimeout(60000);
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  const shop = await page.evaluate(async origin => window.inventoryApp.saveFinanceShop({ name: '调试店铺', account: 'test-shop-001', entity: '测试主体', taxId: 'T', entityType: 'enterprise', taxpayer: 'small', cycle: 'monthly', startMonth: '2026-01', billUrl: `${origin}/bill?account=test-shop-001` }), fixture.origin);
  console.log('SHOP', JSON.stringify(shop));
  const result = await page.evaluate(async ({ shopId }) => {
    try { return { ok: true, value: await window.inventoryApp.collectFinance(shopId, '2026-09', {}) }; }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }, { shopId: shop.id });
  console.log('COLLECT', JSON.stringify(result, null, 2));
  const report = await page.evaluate(async ({ shopId }) => window.inventoryApp.getFinance(shopId, '2026-09'), { shopId: shop.id });
  console.log('JOBS', JSON.stringify(report.jobs, null, 2));
  console.log('BATCHES', JSON.stringify(report.batches, null, 2).slice(0, 2000));
  console.log('PENDING', JSON.stringify(report.pending, null, 2));

  // 第二轮：模拟“重复运行”，这是排查“新批次没有待核对文件”的关键场景。
  const result2 = await page.evaluate(async ({ shopId }) => {
    try { return { ok: true, value: await window.inventoryApp.collectFinance(shopId, '2026-09', {}) }; }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }, { shopId: shop.id });
  console.log('COLLECT2', JSON.stringify(result2, null, 2).slice(0, 3000));
  const report2 = await page.evaluate(async ({ shopId }) => window.inventoryApp.getFinance(shopId, '2026-09'), { shopId: shop.id });
  console.log('RUN2-JOB', JSON.stringify((report2.jobs || [])[0], null, 2).slice(0, 2500));
  console.log('RUN2-BATCHES', JSON.stringify((report2.batches || []).map(batch => ({ id: batch.id, job: batch.job, kind: batch.kind, state: batch.state, message: batch.message, parts: (batch.parts || []).map(part => `${part.subtype}:${part.state}`) })), null, 2));
  console.log('RUN2-PENDING', JSON.stringify((report2.pending || []).map(item => `${item.kind}:${item.subtype}:${item.state}`)));
} finally {
  const pid = application?.process()?.pid;
  if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
  await application?.close().catch(() => {});
  await fixture.close();
}
