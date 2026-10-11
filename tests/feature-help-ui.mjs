import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-feature-help-'));
const output = path.resolve('dist/feature-help-verification');
fs.mkdirSync(output, { recursive: true });
let application;
const errors = [];
const checked = [];
try {
  application = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: ['.', `--user-data-dir=${directory}`], cwd: process.cwd()
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-setup-mode="standalone"]').click();
  await page.locator('#finishFirstRun').click();
  await page.locator('#firstRunSetup').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#featureManualButton').count(), 1, '页面右上角应有说明书入口');
  assert.equal(await page.locator('#featurePrincipleButton').count(), 1, '页面右上角应有技术原理入口');
  const dialog = page.locator('#featureHelpDialog');
  const modes = [['manual', '说明书'], ['principle', '技术原理']];
  const views = [
    ['home', '功能主页'], ['dashboard', '云仓库存同步'],
    ['inventory', '云仓库存同步 · 库存明细'], ['sales', '云仓库存同步 · 月度销量'],
    ['business', '运营看板'], ['finance', '店铺销售额采集'],
    ['purchase', '采购数据采集'], ['invoice', '自动开发票'], ['settings', '公共设置']
  ];
  for (const [view, title] of views) {
    if (view !== 'home') {
      if (['inventory', 'sales'].includes(view)) {
        await page.locator('#backHome').click();
        await page.locator('[data-open-view="dashboard"]').click();
        await page.locator(`[data-view="${view}"]`).click();
      } else {
        if (await page.locator('#backHome').isVisible()) await page.locator('#backHome').click();
        await page.locator(`[data-open-view="${view}"]`).click();
      }
    }
    for (const [mode, label] of modes) {
      await page.locator(mode === 'manual' ? '#featureManualButton' : '#featurePrincipleButton').click();
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await dialog.getAttribute('data-view'), view);
      assert.equal(await dialog.getAttribute('data-mode'), mode);
      assert.equal(await page.locator('#featureHelpTitle').textContent(), `${title} · ${label}`);
      assert.ok((await page.locator('#featureHelpBody').textContent()).length > 150, `${view} 应有具体内容`);
      if (view === 'finance' && mode === 'manual') {
        const onboarding = await page.locator('#featureHelpBody section').filter({ hasText: '添加店铺：先登录，再读取信息' }).locator('ol').textContent();
        assert.match(onboarding, /添加店铺.*直接.*千牛.*登录/);
        assert.match(onboarding, /登录后.*读取/);
        const steps = await page.locator('#featureHelpBody section').filter({ hasText: '淘宝销售额下载流程（按框选位置）' }).locator('ol').textContent();
        assert.match(steps, /财务[\s\S]*收支账单[\s\S]*收入账单[\s\S]*月汇总[\s\S]*月份[\s\S]*查询[\s\S]*导出 Excel/);
        assert.match(steps, /货款收入/);
        assert.match(await page.locator('#featureHelpBody').textContent(), /历史下载记录/);
        assert.match(await page.locator('#featureHelpBody').textContent(), /不能.*成交额/);
        await page.screenshot({ path: path.join(output, 'taobao-sales-manual.png'), fullPage: true });
      }
      if (view === 'finance' && mode === 'principle') {
        const text = await page.locator('#featureHelpBody').textContent();
        assert.match(text, /整数分/);
        assert.match(text, /SHA-256/);
        assert.match(text, /真实千牛.*未.*验证/);
      }
      await page.locator('#featureHelpClose').click();
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await page.locator(mode === 'manual' ? '#featureManualButton' : '#featurePrincipleButton').evaluate(el => el === document.activeElement), true);
      checked.push(`${view}:${mode}`);
    }
    await page.locator('#featureManualButton').click();
    await page.locator('[data-feature-help-mode="principle"]').click();
    assert.equal(await dialog.getAttribute('data-mode'), 'principle');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
  }
  await page.locator('#backHome').click();
  await page.locator('[data-open-view="finance"]').click();
  await page.locator('#financeHelpButton').click();
  assert.equal(await dialog.getAttribute('data-view'), 'finance');
  assert.equal(await dialog.getAttribute('data-mode'), 'manual');
  await page.locator('#featureHelpClose').click();
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.locator('#featureManualButton').isVisible(), true);
    assert.equal(await page.locator('#featurePrincipleButton').isVisible(), true);
    const layout = await page.evaluate(() => {
      const hero = document.querySelector('.hero').getBoundingClientRect();
      const a = document.querySelector('#featureManualButton').getBoundingClientRect();
      const b = document.querySelector('#featurePrincipleButton').getBoundingClientRect();
      return { heroRight: hero.right, heroLeft: hero.left, left: a.left, right: b.right, overlap: a.right > b.left, scroll: document.documentElement.scrollWidth, width: innerWidth };
    });
    assert.ok(layout.left >= layout.heroLeft && layout.right <= layout.heroRight + 1);
    assert.equal(layout.overlap, false);
    assert.ok(layout.scroll <= layout.width + 1, '说明入口不应造成水平溢出');
    await page.locator('#featureManualButton').click();
    assert.ok(await page.locator('#featureHelpBody').evaluate(el => el.scrollHeight > 0));
    await page.locator('#featureHelpClose').click();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checked, legacyFinanceHelp: true, modeSwitch: true, escapeAndFocus: true, responsiveWidths: [1280, 760], screenshots: output }));
} finally {
  const pid = application?.process()?.pid;
  if (pid) try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  await application?.close().catch(() => {});
}
