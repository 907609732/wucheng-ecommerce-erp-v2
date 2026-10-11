import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  InvoiceInspectionStore,
  buildInvoiceInspectionText,
  chinaDateString,
  summarizeChecks,
  validateInvoiceObservation
} from '../desktop/shared/invoice-inspection.mjs';

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-inspection-')); }

test('validateInvoiceObservation: observed requires both non-negative counts', () => {
  assert.throws(() => validateInvoiceObservation({ shop: '米配匠', outcome: 'observed', coverage: 'visible_range', pending_count: 1 }), /待录入/);
  assert.throws(() => validateInvoiceObservation({ shop: '米配匠', outcome: 'observed', coverage: 'visible_range', pending_count: -1, unrecorded_count: 0 }), /非负整数/);
  const ok = validateInvoiceObservation({ shop: '米配匠', outcome: 'observed', coverage: 'visible_range', pending_count: 3, unrecorded_count: 1 });
  assert.equal(ok.state, 'attention');
  assert.equal(ok.pending_count, 3);
  assert.ok(ok.id);
});

test('validateInvoiceObservation: failure cannot record counts; zero is never fabricated from failure', () => {
  assert.throws(() => validateInvoiceObservation({ shop: '米配匠', outcome: 'error', coverage: 'unknown', pending_count: 0 }), /不能记录/);
  assert.throws(() => validateInvoiceObservation({ shop: '米配匠', outcome: 'needs_login', coverage: 'unknown' }), /失败时必须记录原因/);
  const failed = validateInvoiceObservation({ shop: '米配匠', outcome: 'needs_login', coverage: 'unknown', message: '未登录' });
  assert.equal(failed.pending_count, null);
  assert.equal(failed.state, 'needs_login');
});

test('validateInvoiceObservation: platform_available_range requires a real date scope', () => {
  assert.throws(() => validateInvoiceObservation({ shop: '米配匠', outcome: 'observed', coverage: 'platform_available_range', pending_count: 0, unrecorded_count: 0 }), /起止日期/);
  const ok = validateInvoiceObservation({ shop: '米配匠', outcome: 'observed', coverage: 'platform_available_range', pending_count: 0, unrecorded_count: 0, scope_start: '2026-08-11', scope_end: '2026-10-11' });
  assert.equal(ok.state, 'clear');
});

test('store: record + summary returns latest per shop and honest totals', () => {
  const store = new InvoiceInspectionStore(tmpdir());
  try {
    store.record({ shop: '米配匠', outcome: 'observed', coverage: 'visible_range', pending_count: 2, unrecorded_count: 1 });
    store.record({ shop: '米配匠', outcome: 'observed', coverage: 'visible_range', pending_count: 5, unrecorded_count: 0 });
    store.record({ shop: '店口五金店', outcome: 'error', coverage: 'unknown', message: '登录失效' });
    const summary = store.summary();
    assert.equal(summary.shops.length, 2);
    assert.equal(summary.total_pending, 5);
    assert.equal(summary.total_unrecorded, 0);
    const m = summary.shops.find(s => s.shop === '米配匠');
    assert.equal(m.pending_count, 5, 'summary keeps the latest record per shop');
  } finally { store.close(); }
});

test('summarizeChecks sorts by latest checked_at and ignores null counts in totals', () => {
  const rows = [
    { shop: 'A', checked_at: '2026-10-11T10:00:00.000Z', pending_count: 1, unrecorded_count: 0, state: 'attention' },
    { shop: 'A', checked_at: '2026-10-11T12:00:00.000Z', pending_count: 7, unrecorded_count: 2, state: 'attention' },
    { shop: 'B', checked_at: '2026-10-11T11:00:00.000Z', pending_count: null, unrecorded_count: null, state: 'error' }
  ];
  const summary = summarizeChecks(rows);
  assert.equal(summary.shops.length, 2);
  assert.equal(summary.total_pending, 7);
  assert.equal(summary.shops[0].shop, 'A');
});

test('buildInvoiceInspectionText lists per-shop counts and never claims zero on failure', () => {
  const summary = {
    shops: [
      { shop: '米配匠', state: 'attention', pending_count: 3, unrecorded_count: 1 },
      { shop: '店口五金店', state: 'needs_login', message: '未登录' },
      { shop: '西施五金店', state: 'error', message: '页面加载失败' }
    ],
    total_pending: 3,
    total_unrecorded: 1
  };
  const text = buildInvoiceInspectionText(summary, { date: '2026-10-12', time: '20:00' });
  assert.match(text, /每日开票巡检/);
  assert.match(text, /米配匠：待处理 3 · 待录入 1/);
  assert.match(text, /店口五金店：需要登录/);
  assert.match(text, /西施五金店：检查失败/);
  assert.match(text, /待录入开票不等于尚未开具/);
  const empty = buildInvoiceInspectionText({ shops: [], total_pending: 0, total_unrecorded: 0 }, {});
  assert.match(empty, /不能视为没有待开票申请/);
});

test('chinaDateString returns Beijing date', () => {
  assert.match(chinaDateString(new Date('2026-10-11T16:00:00Z')), /^2026-10-12$/);
});
