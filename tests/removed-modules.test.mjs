import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRemoteService } from '../desktop/shared/remote-service.mjs';

test('removed modules have no files, preload methods, IPC handlers or UI entries', () => {
  for (const directory of ['desktop', 'desktop/shared', 'desktop/renderer', 'desktop/renderer/vendor']) {
    assert.equal(fs.readdirSync(directory).some(name => /^(business|finance|purchase)[-.]/.test(name)), false, directory);
  }
  const html = fs.readFileSync('desktop/renderer/index.html', 'utf8');
  assert.doesNotMatch(html, /data-(?:open-view|view-panel)="(?:business|finance|purchase)"/);
  for (const retained of ['dashboard', 'inventory', 'sales', 'invoice', 'pdd-monthly', 'settings']) assert.match(html, new RegExp(`data-view-panel="${retained}"`));
  assert.match(html, /class="view-tabs hidden"/);
  const main = fs.readFileSync('desktop/main.mjs', 'utf8');
  assert.doesNotMatch(main, /ipcMain\.handle\(['"](?:business|finance|purchase):|tickFinance|localFinance|localBusiness|localPurchase/);
  let api;
  vm.runInNewContext(fs.readFileSync('desktop/preload.cjs', 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { api = value; } }, ipcRenderer: {} }) });
  assert.equal(Object.keys(api).some(name => /Finance|Business|Purchase/.test(name)), false);
  for (const retained of ['getInventory', 'getMonthlySales', 'listInvoiceShops', 'getPddMonthlyState']) assert.equal(typeof api[retained], 'function');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(Object.keys(pkg.devDependencies).some(name => name.startsWith('@univerjs/')), false);
});

test('removed remote business API returns 404 while inventory remains available', async () => {
  const service = createRemoteService({ requireAccessIdentity: false, getInventory: () => ({ preserved: true }) });
  try {
    for (const url of ['/api/v1/business', '/api/v1/business/sheets', '/api/v1/business/images/abc', '/api/v1/business/original/abc']) assert.equal((await service.app.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal((await service.app.inject({ method: 'GET', url: '/api/v1/inventory' })).json().data.preserved, true);
  } finally { await service.stop(); }
});

test('retained PDD dependency graph never imports removed modules', () => {
  for (const name of ['pdd-monthly-export.mjs', 'pdd-buyer.mjs', 'pdd-order-export.mjs']) {
    const source = fs.readFileSync(path.join('desktop/shared', name), 'utf8');
    assert.doesNotMatch(source, /from ['"].*\/(?:business|finance|purchase)[-.]/);
    assert.doesNotMatch(source, /collectViaTaobao|collectViaMtop|collectViaGoofish|commitPreview|runBackfill/);
  }
});
