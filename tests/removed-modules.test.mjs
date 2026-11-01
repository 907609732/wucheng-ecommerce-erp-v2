import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRemoteService } from '../desktop/shared/remote-service.mjs';

test('removed modules have no files, preload methods, IPC handlers or UI entries', () => {
  for (const directory of ['desktop', 'desktop/shared', 'desktop/renderer', 'desktop/renderer/vendor']) {
    const files = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    assert.equal(files.some(name => /^(business|finance|purchase|invoice|pdd)[-.]/.test(name)), false, directory);
  }
  const html = fs.readFileSync('desktop/renderer/index.html', 'utf8');
  assert.doesNotMatch(html, /data-(?:open-view|view-panel)="(?:business|finance|purchase|invoice|pdd-monthly)"/);
  for (const retained of ['dashboard', 'inventory', 'sales', 'settings']) assert.match(html, new RegExp(`data-view-panel="${retained}"`));
  assert.match(html, /class="view-tabs"/);
  const main = fs.readFileSync('desktop/main.mjs', 'utf8');
  assert.doesNotMatch(main, /ipcMain\.handle\(['"](?:business|finance|purchase|invoice|invoice-shops|invoice-inspection|pdd-monthly):|tickFinance|localFinance|localBusiness|localPurchase/);
  let api;
  vm.runInNewContext(fs.readFileSync('desktop/preload.cjs', 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { api = value; } }, ipcRenderer: {} }) });
  assert.equal(Object.keys(api).some(name => /Finance|Business|Purchase|Invoice|Pdd/.test(name)), false);
  for (const retained of ['getInventory', 'getMonthlySales', 'getSettings']) assert.equal(typeof api[retained], 'function');
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

test('schema and importers no longer implement other businesses', () => {
  const schema = fs.readFileSync('core/erp/db.js','utf8');
  assert.doesNotMatch(schema,/CREATE TABLE IF NOT EXISTS (orders|purchase_|business_|monthly_financials|competitors|unpack_)/);
  assert.doesNotMatch(fs.readFileSync('core/erp/importers.js','utf8'),/export function (importOrdersFile|importShippingFile)/);
  assert.doesNotMatch(fs.readFileSync('core/erp/reports.js','utf8'),/export function (getOrdersOverview|getMonthlySalesReport|getBusinessOverview)/);
});
