import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { PurchaseAutomation } from '../desktop/shared/purchase-auto.mjs';

test('本机Chrome启动最大化，实际网页尺寸跟随原生窗口缩放（仅本地页面）', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-window-'));
  const artifacts = path.resolve('.codex-artifacts', `purchase-window-${Date.now()}`); fs.mkdirSync(artifacts, { recursive: true });
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body><header>手机阿里 <span>tb12345678</span> 消息</header><h1>本地窗口尺寸测试</h1><p>不连接真实平台，不读取真实账号。</p></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const automation = new PurchaseAutomation({ directory, profiles: { alibaba_1688: { order_url: origin } }, testOrigin: origin, preview: () => {},
    launch: (profile, options) => chromium.launchPersistentContext(profile, options) });
  try {
    const { page, context } = await automation.open({ platform: 'alibaba_1688', month: '2026-09' });
    assert.equal(page.viewportSize(), null, '没有固定网页视口');
    // CDP只操作本测试自己创建的 localhost 窗口，不连接现有Chrome或真实站点。
    const session = await context.newCDPSession(page), initial = await session.send('Browser.getWindowForTarget');
    assert.equal(initial.bounds.windowState, 'maximized');
    const large = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.screenshot({ path: path.join(artifacts, 'maximized.png') });
    await session.send('Browser.setWindowBounds', { windowId: initial.windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId: initial.windowId, bounds: { width: 1000, height: 720 } });
    await page.waitForFunction(previous => innerWidth < previous.width && innerHeight < previous.height, large);
    const small = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.equal(page.viewportSize(), null);
    await page.screenshot({ path: path.join(artifacts, 'resized.png') });
    console.log(JSON.stringify({ windowState: initial.bounds.windowState, large, small, artifacts }));
  } finally { await automation.closeAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
