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
  assert.equal(await page.locator('#firstRunSetup,#runtimeSettingsForm').count(),0);
  assert.equal(await page.locator('#featureManualButton').count(), 1, '使用说明入口仅保留一处');
  assert.equal(await page.locator('.hero-actions #featureManualButton').count(), 0, '右上角不再显示使用说明');
  assert.equal(await page.locator('[data-view-panel="settings"] #featureManualButton').count(), 1, '使用说明位于云仓设置');
  assert.equal(await page.locator('#featureManualButton').isVisible(), false, '运行概览隐藏设置中的帮助入口');
  assert.equal(await page.locator('#featureManualButton').textContent(), '使用说明');
  const dialog = page.locator('#featureHelpDialog');
  const modes = [['manual', '说明书'], ['principle', '技术原理']];
  const views = [
    ['dashboard', '云仓同步'],
    ['inventory', '云仓同步 · 库存明细'], ['sales', '云仓同步 · 月度销量'],
    ['settings', '云仓设置'],['attendance','云仓同步 · 签到管理']
  ];
  for (const [view, title] of views) {
    await page.locator(`.view-tab[data-view="${view}"]`).click();
    await page.locator('.view-tab[data-view="settings"]').click();
    await page.locator('#featureHelpTopic').selectOption(view);
    for (const [mode, label] of modes) {
      await page.locator('#featureManualButton').click();
      if (mode === 'principle') await page.locator('[data-feature-help-mode="principle"]').click();
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await dialog.getAttribute('data-view'), view);
      assert.equal(await dialog.getAttribute('data-mode'), mode);
      assert.equal(await page.locator('#featureHelpTitle').textContent(), `${title} · ${label}`);
      assert.ok((await page.locator('#featureHelpBody').textContent()).length > 150, `${view} 应有具体内容`);
      await page.locator('#featureHelpClose').click();
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await page.locator('#featureManualButton').evaluate(el => el === document.activeElement), true);
      checked.push(`${view}:${mode}`);
    }
    await page.locator('#featureManualButton').click();
    await page.locator('[data-feature-help-mode="principle"]').click();
    assert.equal(await dialog.getAttribute('data-mode'), 'principle');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
  }
  await page.locator('.view-tab[data-view="settings"]').click();
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.locator('#featureManualButton').isVisible(), true);
    const layout = await page.evaluate(() => {
      const hero = document.querySelector('#featureHelpSettings').getBoundingClientRect();
      const a = document.querySelector('#featureManualButton').getBoundingClientRect();
      return { heroRight: hero.right, heroLeft: hero.left, left: a.left, right: a.right, scroll: document.documentElement.scrollWidth, width: innerWidth };
    });
    assert.ok(layout.left >= layout.heroLeft && layout.right <= layout.heroRight + 1);
    assert.ok(layout.scroll <= layout.width + 1, '说明入口不应造成水平溢出');
    await page.screenshot({path:path.join(output,`settings-${width}.png`)});
    await page.locator('#featureManualButton').click();
    assert.ok(await page.locator('#featureHelpBody').evaluate(el => el.scrollHeight > 0));
    await page.locator('#featureHelpClose').click();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checked, modeSwitch: true, escapeAndFocus: true, responsiveWidths: [1280, 760], screenshots: output }));
} finally {
  const pid = application?.process()?.pid;
  if (pid) try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  await application?.close().catch(() => {});
}
