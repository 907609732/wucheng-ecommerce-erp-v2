import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import './config.js';
import { rootDir } from './config.js';

const authFile = path.join(rootDir, 'tests', '.auth', 'cainiao.json');
const targetUrl = 'https://b.cainiao.com/business/dsc/oms/erp/osmain/ordermanage';
const requestedTimeout = Number(process.env.CAINIAO_LOGIN_TIMEOUT_MS || 180_000);
const loginTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
  ? requestedTimeout
  : 180_000;

function getChromeUserDataDir() {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return path.join(home, '.config', 'google-chrome');
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {
        // 跳过被锁定的文件
      }
    }
  }
}

async function main() {
  console.log('🚀 准备启动 Chrome（复制用户数据避免冲突）...');

  const realUserDataDir = getChromeUserDataDir();
  const tempUserDataDir = path.join(os.tmpdir(), `cainiao-chrome-${Date.now()}`);

  if (fs.existsSync(realUserDataDir)) {
    console.log('📂 复制用户数据到临时目录...');
    copyDirSync(realUserDataDir, tempUserDataDir);
  } else {
    console.log('⚠️ 未找到现有 Chrome 数据，使用全新环境');
    fs.mkdirSync(tempUserDataDir, { recursive: true });
  }

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
    }

    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    console.log('📍 当前页面:', page.url());

    if (!page.url().includes('login')) {
      console.log('✅ 已经处于登录状态');
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

      try {
        await page.waitForURL(
          (url) => !url.href.includes('login'),
          { timeout: loginTimeoutMs }
        );
      } catch (e) {
        throw new Error('登录未完成；如出现验证码、滑块或短信验证，请人工完成后重试');
      }

      console.log('✅ 登录成功:', page.url());
      await page.waitForLoadState('networkidle');
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
