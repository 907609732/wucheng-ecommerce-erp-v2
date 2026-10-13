import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('invoice scan uses its own shop registry and browser, never finance shops or finance sessions', () => {
  const main = fs.readFileSync(path.resolve('desktop/main.mjs'), 'utf8');
  const scan = main.split('async function runInvoiceInspection(')[1].split('async function tickInvoiceInspection(')[0];
  assert.ok(scan, 'inspection function must exist');
  assert.match(scan, /invoiceShopStore\(\)\.list\(\)/);
  assert.match(scan, /getInvoiceBrowser\(\)\.inspect\(shop\)/);
  assert.doesNotMatch(scan, /localFinance|getFinanceBrowser/);
});
