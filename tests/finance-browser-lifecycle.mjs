// Run with the project's Electron executable. No remote pages or real data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { createFinanceBrowser } from '../desktop/shared/finance-browser.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-browser-lifecycle-'));
const watchdog = setTimeout(() => { console.error('Lifecycle test did not settle'); app.exit(1); }, 10000);
try {
  const browser = createFinanceBrowser({ directory });
  await assert.rejects(browser.expectDownload('test-a', {}, { timeoutMs: 20 }), /期间没有收到任何下载事件/);
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const late = browser.expectDownload('test-late', {}, { timeoutMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 60));
  await assert.rejects(late, /超时/);
  assert.deepEqual(unhandled, [], 'Slow page actions must not cause an unhandled download rejection');
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(browser.contextOf('test-a').intent, null);
  browser.contextOf('test-b').downloadLog.push({ at: Date.now() + 1, name: 'invalid.html', reason: '文件类型不支持' });
  await assert.rejects(browser.expectDownload('test-b', {}, { timeoutMs: 20 }), /invalid.html.*文件类型不支持/);
  const pending = browser.expectDownload('test-a', {}, { timeoutMs: 5000 });
  const cancelled = assert.rejects(pending, /已取消/);
  assert.throws(() => browser.expectDownload('test-a', {}), /已有一个下载意图/);
  browser.cancelIntent('test-a');
  await cancelled;
  assert.equal(browser.contextOf('test-a').intent, null);
  await assert.rejects(browser.expectDownload('test-a', {}, { timeoutMs: 20 }), /期间没有收到任何下载事件/);
  console.log('Finance download lifecycle: timeout, diagnostics, cancellation, reuse and isolation passed');
  clearTimeout(watchdog);
  app.exit(0);
} catch (error) {
  console.error(error);
  clearTimeout(watchdog);
  app.exit(1);
}
