import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { FinanceLedger } from '../desktop/shared/finance-ledger.mjs';
import { receiveLocalBills } from '../desktop/shared/finance-local-receipt.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-receipt-'));
  const directory = path.join(root, 'finance');
  const store = new FinanceLedger(directory);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const shop = store.saveShop({ name: '接收测试店', account: 'fixture-only', entity: '测试主体', taxId: 'TEST', entityType: 'enterprise', taxpayer: 'small', cycle: 'monthly', startMonth: '2026-01' });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '收入金额'], ['2026-09-01', 123.45]]), '测试');
  XLSX.writeFile(book, path.join(root, 'income.xlsx'));
  const manifest = { schemaVersion: 1, shopId: shop.id, month: '2026-09', files: [{ path: 'income.xlsx', kind: 'income', subtype: '货款' }] };
  return { root, store, manifest, directory };
}

test('receipt preserves original, remains pending, and is idempotent after reopen', t => {
  const { root, store, manifest, directory } = setup(t);
  const first = receiveLocalBills(store, manifest, root);
  assert.equal(first.state, 'awaiting_review');
  assert.equal(first.platformDownloadVerified, false);
  assert.deepEqual(first.missingKinds, ['expense', 'tax']);
  const bill = store.bill(first.batches[0].tokens[0]);
  assert.deepEqual(fs.readFileSync(bill.file), fs.readFileSync(path.join(root, 'income.xlsx')));
  assert.equal(store.report(manifest.shopId, manifest.month).rows.length, 0);
  const reopened = new FinanceLedger(directory);
  try {
    assert.equal(receiveLocalBills(reopened, manifest, root).duplicate, true);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
  } finally { reopened.close(); }
});

test('missing, partial, wrong period and duplicate inputs create no jobs', t => {
  const { root, store, manifest } = setup(t);
  for (const bad of [
    { ...manifest, month: '2026-13' },
    { ...manifest, files: [{ ...manifest.files[0], path: 'missing.xlsx' }] },
    { ...manifest, files: [...manifest.files, ...manifest.files] },
    { ...manifest, files: [{ ...manifest.files[0], path: 'income.xlsx.crdownload' }] },
    { ...manifest, files: [{ ...manifest.files[0], path: '../outside.xlsx' }] },
  ]) assert.throws(() => receiveLocalBills(store, bad, root));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
});

test('corrupt workbook rolls back all staged database records', t => {
  const { root, store, manifest } = setup(t);
  fs.writeFileSync(path.join(root, 'bad.xlsx'), Buffer.from([0, 1, 2, 3]));
  const bad = { ...manifest, files: [...manifest.files, { path: 'bad.xlsx', kind: 'tax', subtype: '涉税' }] };
  assert.throws(() => receiveLocalBills(store, bad, root));
  for (const table of ['jobs', 'batches', 'bills', 'local_bill_receipts']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
});
