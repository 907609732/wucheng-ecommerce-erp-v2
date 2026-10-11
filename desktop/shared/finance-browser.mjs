/**
 * 千牛账单取数窗口：每店一个独立会话分区，不复制千牛 / Chrome / 菜鸟的登录凭据。
 *
 * 本模块只提供“可验证的页面能力”：
 *   打开/关闭窗口、导出页面结构化清单（snapshot）、按语义唯一命中执行动作、接收并校验下载。
 * 判断“该点哪个按钮、该不该继续”全部由 finance-rpa.mjs 的纯函数决策完成。
 * 禁止把“浏览器打开”“点击了导出”当作取账成功；只有有效下载文件才算收到。
 */
import { BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SNAPSHOT_SCRIPT, actionScript } from './finance-page.mjs';

export const FINANCE_URL = 'https://qn.taobao.com/home.htm/whale-accountant/bill/summary?billDirection=income&billType=month';
const PRODUCTION_HOSTS = ['taobao.com', 'tmall.com', 'alipay.com', 'aliyun.com'];
const DOWNLOAD_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.zip'];

/** 允许的页面域名。测试来源只有在显式开启时才放行，默认关闭。 */
export function createUrlGuard({ allowTestOrigin = false, testOrigin = '' } = {}) {
  const extra = [];
  if (allowTestOrigin && testOrigin) {
    try { const url = new URL(testOrigin); extra.push(url.host); } catch { /* 忽略非法测试地址 */ }
  }
  return url => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && PRODUCTION_HOSTS.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return true;
      if (parsed.protocol === 'http:' && extra.includes(parsed.host)) return true;
      return false;
    } catch { return false; }
  };
}

/** 文件内容嗅探：HTML 登录页、损坏文件、错误 JSON 都不算成功下载。 */
export function sniffDownload(file, originalName = '') {
  const stat = fs.statSync(file);
  if (!stat.size) return { ok: false, reason: '文件大小为 0，下载未完成' };
  const head = Buffer.alloc(Math.min(1024, stat.size));
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const text = head.toString('utf8').replace(/^\uFEFF/, '');
  const lower = text.toLowerCase();
  if (/^\s*<(!doctype|html|\?xml[^>]*>\s*<html)/.test(lower)) return { ok: false, reason: '下载到的是网页（可能是登录页或错误页），不是账单文件' };
  if (/^\s*\{/.test(text) || /^\s*\[/.test(text)) {
    if (/"?(error|code|success)"?\s*[:=]/.test(lower) && !/"日期"|"账单"|"income"/.test(text)) return { ok: false, reason: '下载到的是接口报错内容，不是账单文件' };
  }
  if (/登录已失效|请重新登录|会话过期|系统繁忙|access denied/i.test(text)) return { ok: false, reason: '下载内容提示登录失效或被拒绝，不是账单文件' };
  const ext = path.extname(originalName).toLowerCase() || path.extname(file).toLowerCase();
  const isZipMagic = head[0] === 0x50 && head[1] === 0x4b;
  const isOleMagic = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  if (ext === '.xlsx' && !isZipMagic) return { ok: false, reason: 'xlsx 文件头不正确，文件可能损坏' };
  if (ext === '.zip' && !isZipMagic) return { ok: false, reason: 'zip 文件头不正确，文件可能损坏' };
  if (ext === '.xls' && !(isOleMagic || isZipMagic)) return { ok: false, reason: 'xls 文件头不正确，文件可能损坏' };
  if (ext === '.csv' && head.includes(0x00)) return { ok: false, reason: 'csv 内容含二进制数据，文件可能损坏' };
  return { ok: true, reason: '', bytes: stat.size };
}

export function hashFile(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read = 0;
    do { read = fs.readSync(fd, buffer, 0, buffer.length, null); if (read > 0) hash.update(buffer.subarray(0, read)); } while (read > 0);
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** 安全的 ZIP 解压：阻止路径穿越与解压炸弹。默认不自动解压。 */
export function extractZipSafe(zipFile, targetDir, { maxEntries = 200, maxTotalBytes = 300 * 1024 * 1024 } = {}) {
  const AdmZip = globalThis.__financeAdmZip;
  if (!AdmZip) throw new Error('未启用 ZIP 解压能力');
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries();
  if (entries.length > maxEntries) throw new Error(`压缩包条目过多（${entries.length}），已停止解压`);
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.header?.size || 0), 0);
  if (totalBytes > maxTotalBytes) throw new Error('压缩包解压后过大，已停止解压');
  const root = path.resolve(targetDir);
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const target = path.resolve(root, entry.entryName);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`压缩包内路径越界：${entry.entryName}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    written.push(target);
  }
  return written;
}

/**
 * 创建取账窗口管理器。
 * @param {object} options
 * @param {string} options.directory 财务数据目录
 * @param {(payload:object)=>Promise<void>} options.onStatus 状态回调
 * @param {boolean} [options.allowTestOrigin] 是否允许本地测试来源（仅用于开发验证）
 */
export function createFinanceBrowser({ directory, onStatus = async () => {}, allowTestOrigin = false }) {
  const windows = new Map();
  const contexts = new Map();
  const frames = new Map();
  const downloads = new Map();
  const identityStates = new WeakMap();
  const allowed = createUrlGuard({ allowTestOrigin, testOrigin: process.env.FINANCE_TEST_ORIGIN || '' });
  const incomingDir = path.join(directory, 'incoming');
  const quarantineDir = path.join(directory, 'unmatched');
  fs.mkdirSync(incomingDir, { recursive: true });

  function contextOf(shopId) {
    if (!contexts.has(shopId)) contexts.set(shopId, { shopId, shop: null, month: '', jobId: '', intent: null, lastDownload: null, downloadLog: [] });
    return contexts.get(shopId);
  }

  function record(shopId, download) {
    const context = contextOf(shopId);
    const intent = context.intent;
    if (!intent) {
      fs.mkdirSync(quarantineDir, { recursive: true });
      const target = path.join(quarantineDir, `${randomUUID()}${path.extname(download.name) || '.bin'}`);
      try { fs.renameSync(download.file, target); } catch { /* 保留原位置 */ }
      download.unmatched = true;
      context.lastDownload = { ...download, file: target };
      return;
    }
    const { resolve, reject, ...metadata } = intent;
    context.lastDownload = { ...download, intent: metadata };
    context.intent = null;
    if (intent.resolve) intent.resolve(context.lastDownload);
  }

  function open(shop, month, jobId, { draft = false } = {}) {
    const context = contextOf(shop.id);
    if (context.discarding) throw new Error('临时会话清理未完成，请重试取消');
    // 临时资格由添加流程显式授予；已打开/绑定的店铺不能重新降为临时店。
    if (!context.shop) context.draft = draft === true;
    context.shop = shop; context.month = month; context.jobId = jobId;
    // 只有通过允许清单的地址才会被打开：自定义地址不能绕过域名限制。
    const target = targetUrl(shop);
    const existing = windows.get(shop.id);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      // 上次取账可能停在了导出中心等子页面，重新取账必须回到账单页，否则会误判店铺身份。
      if (existing.webContents.getURL() !== target) void existing.loadURL(target).catch(() => {});
      return existing;
    }
    const partition = `persist:finance-${shop.id}`;
    const ses = session.fromPartition(partition);
    const win = new BrowserWindow({
      width: 1280, height: 880, show: true,
      title: `财务取账 · ${shop.name}`,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, partition }
    });
    windows.set(shop.id, win);
    const identityState = { id: randomUUID(), revision: 0 };
    identityStates.set(win, identityState);
    const invalidateIdentity = () => { identityState.revision += 1; };
    for (const event of ['will-navigate', 'will-redirect', 'did-start-navigation', 'did-navigate-in-page']) win.webContents.on(event, invalidateIdentity);
    // 仅记录版本，不读取任何会话令牌；昵称或认证会话变化都使当前确认失效。
    const onSessionChanged = () => invalidateIdentity();
    ses.cookies.on('changed', onSessionChanged);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.setWindowOpenHandler(({ url }) => { if (allowed(url)) void win.loadURL(url); return { action: 'deny' }; });
    const blockNavigation = (event, url) => { if (!allowed(url)) event.preventDefault(); };
    win.webContents.on('will-navigate', blockNavigation);
    win.webContents.on('will-redirect', blockNavigation);
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      void onStatus({ type: 'load-failed', shopId: shop.id, jobId: context.jobId, message: `页面加载失败（${description}）：${String(url).slice(0, 120)}` });
    });
    // 记录本窗口会话里出现过的下载事件：等待超时时用来区分
    // “页面根本没发起下载”和“下载到了但被我们拦下”，否则两种情况现象完全一样。
    const downloadLog = context.downloadLog;
    const onWillDownload = (_event, item, contents) => {
      if (contents !== win.webContents) return;
      const name = item.getFilename();
      const ext = path.extname(name).toLowerCase();
      if (!DOWNLOAD_EXTENSIONS.includes(ext)) {
        item.cancel();
        downloadLog.push({ shopId: shop.id, at: Date.now(), name, reason: `文件类型不支持（实际取到：${name || '空文件名'}）` });
        void onStatus({ type: 'download-rejected', shopId: shop.id, jobId: context.jobId, message: `已忽略不支持的文件类型：${name}` });
        return;
      }
      downloadLog.push({ shopId: shop.id, at: Date.now(), name, reason: '已接收，进入校验' });
      fs.mkdirSync(incomingDir, { recursive: true });
      const temp = path.join(incomingDir, `${randomUUID()}${ext}.part`);
      item.setSavePath(temp);
      let bytes = 0;
      item.on('updated', (_event, state) => {
        bytes = item.getReceivedBytes();
        if (state === 'progressing' && bytes > 120 * 1024 * 1024) item.cancel();
      });
      item.once('done', (_event, state) => {
        if (state !== 'completed') {
          try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
          void onStatus({ type: 'download-failed', shopId: shop.id, jobId: context.jobId, message: `下载未完成（${state}），未写入账本` });
          const intent = context.intent;
          context.intent = null;
          if (intent && intent.reject) intent.reject(new Error(`下载未完成（${state}）`));
          return;
        }
        const verdict = sniffDownload(temp, name);
        if (!verdict.ok) {
          const context2 = contextOf(shop.id);
          const intent = context2.intent;
          context2.intent = null;
          if (intent && intent.reject) intent.reject(new Error(verdict.reason));
          void onStatus({ type: 'download-invalid', shopId: shop.id, jobId: context.jobId, message: `${name}：${verdict.reason}` });
          return;
        }
        const finalFile = path.join(incomingDir, `${randomUUID()}${ext}`);
        try { fs.renameSync(temp, finalFile); } catch { /* 保持原路径 */ }
        record(shop.id, {
          file: fs.existsSync(finalFile) ? finalFile : temp,
          name, bytes: verdict.bytes,
          sha256: hashFile(fs.existsSync(finalFile) ? finalFile : temp),
          receivedAt: new Date().toISOString()
        });
      });
    };
    ses.on('will-download', onWillDownload);
    win.on('closed', () => {
      invalidateIdentity();
      ses.cookies.removeListener('changed', onSessionChanged);
      ses.removeListener('will-download', onWillDownload);
      windows.delete(shop.id); frames.delete(shop.id);
      void onStatus({ type: 'window-closed', shopId: shop.id, message: '店铺取账窗口已关闭' });
    });
    void win.loadURL(target).catch(() => onStatus({ type: 'load-failed', shopId: shop.id, jobId: context.jobId, message: '千牛页面打开失败，请检查网络后重试' }));
    return win;
  }

  /** 确保窗口停留在账单页（取账过程中可能跳到导出中心等子页面）。返回是否真的重新加载了页面。 */
  function ensure(shop, month, jobId) {
    const context = contextOf(shop.id);
    context.shop = shop; context.month = month; context.jobId = jobId;
    const target = targetUrl(shop);
    const win = windowOf(shop.id);
    if (win.webContents.getURL() === target) return false;
    void win.loadURL(target).catch(() => {});
    return true;
  }

  /** 取店铺窗口；窗口被意外关闭时（用户关了窗口、系统回收）自动重开，取账流程不中断。 */
  /** 该店铺账单页的最终地址：只有通过允许清单的自定义地址才会被使用。 */
  function targetUrl(shop) { return shop.billUrl && allowed(shop.billUrl) ? shop.billUrl : FINANCE_URL; }

  function windowOf(shopId) {
    const win = windows.get(shopId);
    if (win && !win.isDestroyed()) return win;
    const context = contexts.get(shopId);
    if (context?.shop && !context.discarding) {
      const shop = context.shop;
      void onStatus({ type: 'window-reopen', shopId, message: '店铺窗口已关闭，正在重新打开' });
      return open(shop, context.month, context.jobId);
    }
    throw new Error('店铺窗口未打开，请先打开店铺后台');
  }

  function frameList(shopId, win = windowOf(shopId)) {
    const main = win.webContents.mainFrame;
    // framesInSubtree 已包含主框架，必须去重：否则同一个控件会在两个“范围”里命中而被判为歧义。
    const list = [];
    for (const frame of [main, ...main.framesInSubtree]) if (!list.includes(frame)) list.push(frame);
    frames.set(shopId, list);
    return list.map((frame, index) => ({ frame, index })).filter(item => allowed(item.frame.url));
  }

  async function snapshot(shopId, { timeoutMs = 15000, fixedWindow = null, identityVersion = '' } = {}) {
    const win = fixedWindow || windowOf(shopId);
    const frameItems = frameList(shopId, win);
    const collected = [];
    const overlays = [];
    let mergedText = '';
    let title = '';
    let url = '';
    for (const { frame, index } of frameItems) {
      const result = await Promise.race([
        frame.executeJavaScript(SNAPSHOT_SCRIPT).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
      ]);
      if (identityVersion) assertIdentityVersion(shopId, identityVersion);
      if (!result) continue;
      if (index === 0) { title = result.title; url = result.url; }
      mergedText += `\n[frame${index}]\n${result.text || ''}`;
      for (const entry of result.entries || []) collected.push({ ...entry, frameIndex: index });
      for (const overlay of result.overlays || []) overlays.push({ ...overlay, frameIndex: index });
      collected.tables = collected.tables || [];
    }
    return {
      url, title, text: mergedText.slice(0, 240000),
      entries: collected.map((entry, index) => ({ ...entry, i: index })),
      tables: (collected.tables || []),
      overlays,
      frames: frameItems.length
    };
  }

  async function act(shopId, action) {
    const results = [];
    const failures = [];
    for (const { frame, index } of frameList(shopId)) {
      if (action.frameIndex !== undefined && index !== action.frameIndex) continue;
      const result = await frame.executeJavaScript(actionScript(action)).catch(error => ({ ok: false, reason: 'exception', message: String(error?.message || error) }));
      if (result?.ok) results.push({ ...result, frameIndex: index, frame });
      else if (result) failures.push({ ...result, frameIndex: index });
    }
    if (results.length === 1) return results[0];
    const attempted = frameList(shopId).length;
    if (results.length > 1) return { ok: false, reason: 'ambiguous_across_frames', message: `动作在 ${results.length} 个页面范围内都命中，已停止以避免误操作（共尝试 ${attempted} 个范围）` };
    // 没有任何命中时，把页面侧最具体的原因带回来，避免只报“找不到”而丢失真实原因。
    const detail = failures.find(item => item.reason && item.reason !== 'unsupported_op') || null;
    const samples = failures.flatMap(item => item.samples || []).slice(0, 6).map(item => `${item.tag || '?'}:${item.text || item.id || item.cls || ''}`).join(' | ');
    return {
      ok: false,
      reason: detail?.reason || 'not_found',
      message: `${detail?.message ? `${detail.message}；` : ''}未找到唯一匹配的控件（页面范围 ${attempted} 个，候选样例：${samples || '无'}）`,
      failures
    };
  }

  async function navigate(shopId, url) {
    if (!allowed(url)) throw new Error('目标地址不在允许范围内');
    const win = windowOf(shopId);
    await win.loadURL(url).catch(() => {});
  }

  /** 声明一次下载意图；同一时刻只允许一个，避免串店或误配旧任务。 */
  function expectDownload(shopId, meta, { timeoutMs = 60000 } = {}) {
    const context = contextOf(shopId);
    if (context.intent) throw new Error('已有一个下载意图在进行中，取账任务必须串行执行');
    const pending = new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        if (context.intent === intent) context.intent = null;
        const seen = context.downloadLog.filter(entry => entry.at >= startedAt);
        const detail = seen.length ? seen.map(entry => `${entry.name || '(空文件名)'} → ${entry.reason}`).join('；') : '期间没有收到任何下载事件';
        reject(new Error(`等待平台生成文件超时（${detail}）`));
      }, timeoutMs);
      const intent = {
        ...meta, shopId,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      };
      context.intent = intent;
    });
    // 调用方会先等待页面动作，再 await 下载；动作慢于超时时不应触发未处理拒绝。
    // 保留原 Promise 的失败结果，让后续 await 仍能收到具体错误。
    pending.catch(() => {});
    return pending;
  }

  function cancelIntent(shopId) {
    const context = contexts.get(shopId);
    if (!context?.intent) return;
    const intent = context.intent;
    context.intent = null;
    if (intent.reject) intent.reject(new Error('已取消'));
  }

  function close(shopId) {
    cancelIntent(shopId);
    const win = windows.get(shopId);
    if (win && !win.isDestroyed()) win.close();
    // close / beforeunload 可以否决关闭；活窗口仍归本管理器持有。
    if (!win || win.isDestroyed()) { windows.delete(shopId); frames.delete(shopId); }
  }

  /** 添加店铺只读身份信息：不执行点击、导出或账单写入。 */
  function identityVersionOf(shopId) {
    const win = windows.get(shopId);
    if (!win || win.isDestroyed()) {
      const error = new Error('登录窗口已关闭，请重新添加店铺');
      error.code = 'FINANCE_WINDOW_CLOSED'; throw error;
    }
    const state = identityStates.get(win);
    return JSON.stringify([state.id, state.revision, win.webContents.getURL()]);
  }

  function assertIdentityVersion(shopId, version) {
    if (!version || identityVersionOf(shopId) !== version) {
      const error = new Error('登录账号或页面已变化，请重新核对后确认');
      error.code = 'FINANCE_IDENTITY_CHANGED'; throw error;
    }
  }

  async function readIdentity(shopId) {
    const identityVersion = identityVersionOf(shopId);
    const win = windows.get(shopId);
    const result = await snapshot(shopId, { timeoutMs: 3000, fixedWindow: win, identityVersion });
    assertIdentityVersion(shopId, identityVersion);
    const trustedTestOrigin = allowTestOrigin && Boolean(process.env.FINANCE_TEST_ORIGIN) && (() => {
      try { return new URL(result.url).origin === new URL(process.env.FINANCE_TEST_ORIGIN).origin; } catch { return false; }
    })();
    const candidates = await win.webContents.session.cookies.get({ name: '_nk_' });
    assertIdentityVersion(shopId, identityVersion);
    // 仅取账号昵称 Cookie；不返回登录令牌、密码或完整会话。
    const accountCookies = candidates.filter(cookie => trustedTestOrigin || /(^|\.)taobao\.com$/i.test(cookie.domain.replace(/^\./, ''))).map(({ name, value }) => ({ name, value }));
    return { ...result, accountCookies, trustedTestOrigin, identityVersion };
  }

  async function attachShop(shop, month, { identityVersion = '', validateIdentity = async () => {} } = {}) {
    assertIdentityVersion(shop.id, identityVersion);
    const win = windows.get(shop.id);
    await validateIdentity();
    assertIdentityVersion(shop.id, identityVersion);
    let flushError;
    // 绑定只能发生在原窗口、原身份版本的写盘及重核完成之后。
    try { await win.webContents.session.cookies.flushStore(); }
    catch (error) { flushError = error; }
    assertIdentityVersion(shop.id, identityVersion);
    await validateIdentity();
    assertIdentityVersion(shop.id, identityVersion);
    const context = contextOf(shop.id);
    context.shop = shop; context.month = month; context.jobId = '';
    // 暂时绑定不是最终提交；后续异步重核失败仍须清理本次私有草稿。
    if (context.draft === true) context.attachedIdentityVersion = identityVersion;
    win.setTitle(`店铺销售额采集 · ${shop.name}`);
    if (flushError) throw flushError;
  }

  /** 最后重核之后同步提交，不在撤销清理资格与 pending 结束之间引入异步窗口。 */
  function finalizeShop(shopId, { identityVersion = '' } = {}) {
    assertIdentityVersion(shopId, identityVersion);
    const context = contexts.get(shopId);
    if (context?.draft !== true || context.attachedIdentityVersion !== identityVersion || context.discarding) throw new Error('非本次暂时绑定的登录会话，不可提交');
    context.draft = false;
    delete context.attachedIdentityVersion;
  }

  async function discardDraft(shopId) {
    const context = contexts.get(shopId);
    if (!context) return; // 已清理或未曾打开：不碰未知分区。
    if (context.draft !== true) throw new Error('店铺已绑定或非临时登录会话，不可清理');
    context.discarding = true;
    cancelIntent(shopId);
    const win = windows.get(shopId);
    // 取消临时登录不可被页面否决；仅销毁本次窗口，确认终止后才清凭据。
    if (win && !win.isDestroyed()) win.destroy();
    if (win && !win.isDestroyed()) throw new Error('临时登录窗口未关闭，请重试取消');
    windows.delete(shopId); frames.delete(shopId);
    const ses = session.fromPartition(`persist:finance-${shopId}`);
    await ses.clearStorageData();
    await ses.clearCache();
    contexts.delete(shopId);
  }

  function closeAll() { for (const shopId of [...windows.keys()]) close(shopId); }

  return { open, ensure, targetUrl, close, closeAll, snapshot, readIdentity, assertIdentityVersion, attachShop, finalizeShop, discardDraft, act, navigate, expectDownload, cancelIntent, contextOf, isOpen: shopId => windows.has(shopId) && !windows.get(shopId).isDestroyed() };
}
