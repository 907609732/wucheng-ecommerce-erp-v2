import { BrowserWindow, session } from 'electron';
import { invoicePartition, invoiceAllowedUrl, invoicePageStatus, invoiceTargetUrl } from './invoice-browser-policy.mjs';
import { pddInvoicePageStatus, parsePddInvoiceCounts } from './pdd-invoice.mjs';

// 开票独有的登录分区，绝不访问/清理财务模块的 persist:finance-* 会话。
export function createInvoiceBrowser() {
  const windows = new Map();
  function accountSession(shop) { return session.fromPartition(invoicePartition(shop.id, shop.platform)); }
  function getWindow(shop, visible) {
    let win = windows.get(shop.id);
    if (win && !win.isDestroyed()) { if (visible) win.show(); return win; }
    const platform = shop.platform || 'taobao';
    win = new BrowserWindow({ width: 1200, height: 850, show: visible,
      title: `开票店铺登录 · ${platform === 'pdd' ? '拼多多' : '淘宝'} · ${shop.name}`,
      webPreferences: { partition: invoicePartition(shop.id, platform), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    windows.set(shop.id, win);
    win.on('closed', () => windows.delete(shop.id));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (invoiceAllowedUrl(url, platform)) void win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    for (const event of ['will-navigate', 'will-redirect']) win.webContents.on(event, (e, url) => { if (!invoiceAllowedUrl(url, platform)) e.preventDefault(); });
    return win;
  }
  async function accounts(shop) {
    if (shop.platform === 'pdd') return [];
    const cookies = await accountSession(shop).cookies.get({ name: '_nk_' });
    return [...new Set(cookies.filter(c => c.domain === 'taobao.com' || c.domain.endsWith('.taobao.com'))
      .map(c => { try { return decodeURIComponent(c.value); } catch { return c.value; } }).filter(Boolean))];
  }
  return {
    async open(shop) {
      const win = getWindow(shop, true);
      await win.loadURL(invoiceTargetUrl(shop.platform));
      return { opened: true };
    },
    accounts,
    async inspect(shop) {
      const win = getWindow(shop, false);
      await win.loadURL(invoiceTargetUrl(shop.platform));
      await new Promise(resolve => setTimeout(resolve, 4000));
      if (win.isDestroyed()) throw new Error('开票店铺窗口已关闭');
      const url = win.webContents.getURL();
      const text = await win.webContents.executeJavaScript('document.body?.innerText || ""', true);
      const status = shop.platform === 'pdd' ? pddInvoicePageStatus(url, text) : invoicePageStatus(url, text);
      const counts = shop.platform === 'pdd' && status.ok ? parsePddInvoiceCounts(text) : null;
      const expected = JSON.stringify(shop.name);
      const headerNames = status.ok ? await win.webContents.executeJavaScript(`(() => {
        const wanted = ${expected};
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walk.nextNode())) {
          if ((node.textContent || '').trim() !== wanted) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          if (box.top >= 0 && box.top < 90 && box.right >= innerWidth - 260 && box.left < innerWidth && box.width > 0) return [wanted];
        }
        return [];
      })()`, true).catch(() => []) : [];
      return { url, text, status, counts, accounts: await accounts(shop), headerNames };
    },
    async remove(shop) {
      const win = windows.get(shop.id);
      if (win && !win.isDestroyed()) { win.close(); if (!win.isDestroyed()) throw new Error('请先关闭该店铺开票登录窗口'); }
      await accountSession(shop).clearStorageData();
    }
  };
}
