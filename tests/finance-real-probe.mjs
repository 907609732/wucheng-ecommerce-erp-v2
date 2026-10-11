/**
 * 真机页面结构采集（只读）。
 *
 * 需要人工配合：在弹出的「店铺取账窗口」里完成淘宝/千牛登录（扫码或短信）。
 * 本脚本只读取页面上已经渲染出来的元素，不点击导出、不查询、不提交、不改任何设置。
 *
 * 安全边界：
 * - 登录态保存在 %LOCALAPPDATA%\wucheng-erp-finance-probe（不在仓库、不在安装包内）。
 * - 输出只含元素文案、控件类型与选择器，不含密码、Cookie、Token。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const profile = process.env.FINANCE_PROBE_PROFILE || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'wucheng-erp-finance-probe');
const outFile = process.env.FINANCE_PROBE_OUT || path.join(os.tmpdir(), 'finance-real-probe.json');
const shotFile = process.env.FINANCE_PROBE_SHOT || path.join(os.tmpdir(), 'finance-real-probe.png');
const shopFile = path.join(profile, 'probe-shop.json');
const seconds = Number(process.env.FINANCE_PROBE_SECONDS || 900);
const deadline = Date.now() + seconds * 1000;

const now = new Date();
const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const targetMonth = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, '0')}`;

const write = payload => { try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* 采集过程中的写入失败不影响主流程 */ } };
const log = message => { try { console.log(`[probe] ${new Date().toISOString()} ${message}`); } catch { /* ignore */ } };

write({ status: 'starting', targetMonth, profile, startedAt: new Date().toISOString() });

let application = null;
let shopId = '';
try {
  application = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: ['.', `--user-data-dir=${profile}`],
    cwd: process.cwd(),
    env: { ...process.env }
  });
  const main = await application.firstWindow();
  main.setDefaultTimeout(60000);
  await main.waitForLoadState('domcontentloaded');
  if (await main.locator('[data-setup-mode="standalone"]').count()) {
    await main.locator('[data-setup-mode="standalone"]').click();
    await main.locator('#finishFirstRun').click();
    await main.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  }
  log('主窗口就绪');

  // 复用上次的探针店铺，避免每次新建。
  if (fs.existsSync(shopFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(shopFile, 'utf8'));
      await main.evaluate(async ({ id, month }) => window.inventoryApp.getFinance(id, month), { id: saved.id, month: targetMonth });
      shopId = saved.id;
      log(`复用探针店铺 ${shopId}`);
    } catch { shopId = ''; }
  }
  if (!shopId) {
    const shop = await main.evaluate(async ({ month }) => window.inventoryApp.saveFinanceShop({
      name: '探针店铺（结构采集用）', account: '', entity: '探针主体', taxId: 'PROBE', entityType: 'enterprise',
      taxpayer: 'small', cycle: 'monthly', startMonth: month, schedule: false
    }), { month: targetMonth });
    shopId = shop.id;
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(shopFile, JSON.stringify({ id: shopId }), 'utf8');
    log(`新建探针店铺 ${shopId}`);
  }

  await main.evaluate(async ({ id, month }) => window.inventoryApp.openFinance(id, month), { id: shopId, month: targetMonth });
  log('取账窗口已打开，等待人工登录');

  let attempt = 0;
  let last = null;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      last = await main.evaluate(async ({ id, month }) => window.inventoryApp.probeFinance(id, month), { id: shopId, month: targetMonth });
    } catch (error) {
      last = { error: String((error && error.message) || error) };
    }
    write({ status: 'collecting', targetMonth, shopId, attempts: attempt, updatedAt: new Date().toISOString(), probe: last });
    log(`第 ${attempt} 次采集：state=${last?.state || last?.error || '?'}`);

    if (last && last.state && last.state !== 'needs_login' && last.state !== 'needs_captcha') {
      try {
        const financeWindow = application.windows().find(win => /qn\.taobao\.com|taobao\.com/.test(win.url()));
        if (financeWindow) { await financeWindow.screenshot({ path: shotFile }); log(`已截图 ${shotFile}`); }
      } catch (error) { log(`截图失败：${error.message}`); }
      write({ status: 'ready', targetMonth, shopId, attempts: attempt, finishedAt: new Date().toISOString(), screenshot: shotFile, probe: last });
      log('已进入账单页，采集完成');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!last || last.state === 'needs_login' || last.state === 'needs_captcha') {
    write({ status: 'timeout', message: `${seconds} 秒内未检测到已登录的账单页`, targetMonth, shopId, lastAttempt: new Date().toISOString(), probe: last });
    log('等待登录超时');
  }
} catch (error) {
  write({ status: 'failed', message: String((error && error.message) || error), targetMonth, shopId, failedAt: new Date().toISOString() });
  log(`失败：${error.message}`);
} finally {
  const pid = application?.process()?.pid;
  if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
  await application?.close().catch(() => {});
}
console.log(`[probe] 结果文件：${outFile}`);
