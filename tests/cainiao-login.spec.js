import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const authFile = path.join(process.cwd(), 'tests', '.auth', 'cainiao.json');

/**
 * 手动完成登录并保存状态
 * 运行后会打开 Chrome，请在 5 分钟内扫码或输入密码完成登录
 *
 * npx playwright test tests/cainiao-login.spec.js --project=chromium
 */

test('菜鸟商家登录并保存状态', async ({ page, context }) => {
  const targetUrl = 'https://b.cainiao.com/business/dsc/oms/erp/osmain/ordermanage';

  await page.goto(targetUrl, { waitUntil: 'networkidle' });

  console.log('当前页面:', page.url());

  // 判断是否在登录页：URL 包含 login 或页面标题包含 Login/登录
  const isLoginPage =
    page.url().includes('login') ||
    (await page.title()).toLowerCase().includes('login');

  if (isLoginPage) {
    console.log('检测到登录页，请在弹出的 Chrome 窗口中手动完成登录（扫码或输入密码）...');

    // 真正的登录成功标志：URL 不再包含 login，且跳转到业务域名
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        return !url.includes('login') && url.includes('cainiao.com');
      },
      { timeout: 300_000 }
    );

    // 额外等待页面稳定
    await page.waitForLoadState('networkidle');

    console.log('登录成功，已跳转到:', page.url());
  } else {
    console.log('似乎已经处于登录状态');
  }

  // 保存登录状态
  const authDir = path.dirname(authFile);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  await context.storageState({ path: authFile });
  console.log('登录状态已保存到:', authFile);

  // 断言确认已离开登录页
  await expect(page).not.toHaveURL(/login/);
});
