import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import './config.js';
import { rootDir } from './config.js';

const authFile = path.join(rootDir, 'tests', '.auth', 'cainiao.json');
const targetUrl = 'https://b.cainiao.com/business/dsc/oms/erp/osmain/ordermanage';
const recoveryMode = process.env.CAINIAO_LOGIN_RECOVERY === '1';
const requestedTimeout = Number(process.env.CAINIAO_LOGIN_TIMEOUT_MS || (recoveryMode ? 45_000 : 180_000));
const loginTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
  ? requestedTimeout
  : 180_000;

async function waitForAuthenticatedPage(page, timeoutMs) {
  if (!page.url().includes('login')) return true;
  try {
    await page.waitForURL((url) => !url.href.includes('login'), { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('🚀 准备启动菜鸟登录浏览器…');

  const tempUserDataDir = path.join(os.tmpdir(), `cainiao-chrome-${Date.now()}`);
  console.log('⚡ 使用已保存登录态，不复制 Chrome 用户数据');
  fs.mkdirSync(tempUserDataDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launchPersistentContext(tempUserDataDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const pages = browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

  // 加载已有登录态
    if (fs.existsSync(authFile)) {
      console.log('📝 加载已有登录态...');
      const storage = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      await browser.addCookies(storage.cookies || []);
      const targetOrigin = new URL(targetUrl).origin;
      const localStorageEntries = storage.origins
        ?.find((origin) => origin.origin === targetOrigin)
        ?.localStorage || [];
      if (localStorageEntries.length) {
        await page.addInitScript((entries) => {
          for (const { name, value } of entries) localStorage.setItem(name, value);
        }, localStorageEntries);
      }
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    console.log('📍 当前页面:', page.url());

    if (await waitForAuthenticatedPage(page, 5_000)) {
      console.log('✅ 已复用保存的登录态');
    } else {

  // 自动填写账号密码
      const username = process.env.CAINIAO_USERNAME;
      const password = process.env.CAINIAO_PASSWORD;
      if (username && password) {
        console.log('🔐 自动填写账号密码...');
        try {
          const usernameInput = page.locator('input[name="loginId"], input[name="username"], input[name="account"], input[type="tel"], input[type="text"]').first();
          const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
          const submitBtn = page.locator('button:has-text("登录"), button:has-text("登 录"), input[type="submit"], button[type="submit"]').first();

          if (await usernameInput.count() > 0) {
            await usernameInput.fill(username);
            console.log('  ✓ 填写账号');
          }
          if (await passwordInput.count() > 0) {
            await passwordInput.fill(password);
            console.log('  ✓ 填写密码');
          }
          if (await submitBtn.count() > 0) {
            await submitBtn.click();
            console.log('  ✓ 点击登录');
          }
        } catch (e) {
          console.log('⚠️ 自动填写失败:', e.message);
        }
      } else {
        console.log('⚠️ 未配置 CAINIAO_USERNAME / CAINIAO_PASSWORD，请手动输入');
      }

      console.log(`⏳ 等待登录成功（最多 ${Math.ceil(loginTimeoutMs / 1000)} 秒）...`);

      if (!await waitForAuthenticatedPage(page, loginTimeoutMs)) {
        throw new Error('登录未完成；如出现验证码、滑块或短信验证，请人工完成后重试');
      }

      console.log('✅ 登录成功:', page.url());
      await page.waitForLoadState('domcontentloaded');
    }

  // 保存登录态
    const authDir = path.dirname(authFile);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const storageState = await browser.storageState();
    fs.writeFileSync(authFile, JSON.stringify(storageState, null, 2));
    console.log('💾 登录状态已刷新');

    await page.waitForTimeout(1000);
  } finally {
    if (browser) await browser.close().catch(() => null);
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch {}
  }

  console.log('🎉 完成');
}

main().catch((err) => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
