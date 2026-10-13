import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendInvoiceLog, readInvoiceLogs, invoiceLogDirectory } from '../desktop/shared/invoice-runtime-log.mjs';

test('invoice log persists across day boundary, filters files and redacts secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-log-'));
  try {
    assert.deepEqual(readInvoiceLogs(root), []);
    const a = new Date('2026-10-11T12:00:00Z');
    const b = new Date('2026-10-12T12:00:00Z');
    appendInvoiceLog(root, { source: 'inspection', message: '开始巡检' }, a);
    appendInvoiceLog(root, { level: 'error', source: 'watch', message: 'url?token=abc123&sign=xyz789 password=foobar' }, b);
    fs.writeFileSync(path.join(invoiceLogDirectory(root), '2026-10-13.jsonl'), '{broken\n');
    const entries = readInvoiceLogs(root);
    assert.equal(entries.length, 2);
    assert.match(entries[0].message, /开始巡检/);
    assert.equal(entries[1].level, 'error');
    assert.doesNotMatch(entries[1].message, /abc123|xyz789|foobar/);
    assert.deepEqual(readInvoiceLogs(root, 1), [entries[1]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
