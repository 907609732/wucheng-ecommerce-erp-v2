import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BusinessStore } from '../desktop/shared/business-store.mjs';
import { parseBusinessWorkbook, selectBusinessData, exportBusinessWorkbook } from '../desktop/shared/business-workbook.mjs';
import { createRemoteService } from '../desktop/shared/remote-service.mjs';
import { applySheetChanges } from '../desktop/shared/business-sheet.mjs';

const sourceFile = process.env.BUSINESS_TEST_WORKBOOK;
test('原表编辑、相关公式重算、凭证绑定、版本恢复和错误回滚', { skip: !sourceFile }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sheet-edit-'));
  const store = new BusinessStore(path.join(temp, 'erp.sqlite'), path.join(temp, 'files'));
  try {
    const p = store.preview(sourceFile); store.commit(p.token);
    const initial = await store.sheetSnapshot(2025);
    const sales = '店铺的销售额具体内容月报';
    const cell = (snapshot, address) => snapshot.sheets.find(s => s.name === sales).cells.find(c => c.cell === address);
    const paid = cell(initial, 'F5').value;
    const pictures = initial.sheets.flatMap(s => s.images).map(i => `${i.sheet}!${i.cell}:${i.assetId}`).sort();
    const updated = await store.saveCells({ year: 2025, versionId: initial.versionId, changes: [{ sheet: sales, cell: 'F5', input: String(paid + 10) }] });
    assert.ok(updated.recalculated > 0);
    const after = await store.sheetSnapshot(2025);
    assert.equal(cell(after, 'F5').value, paid + 10);
    assert.equal(cell(after, 'I5').value, paid + 10 - cell(after, 'G5').value);
    assert.equal(cell(after, 'I32').value, cell(initial, 'I32').value, '不更改无关原表缓存金额');
    assert.deepEqual(after.sheets.flatMap(s => s.images).map(i => `${i.sheet}!${i.cell}:${i.assetId}`).sort(), pictures);
    assert.equal(store.original(initial.versionId).data.equals(fs.readFileSync(sourceFile)), true);
    assert.equal(parseBusinessWorkbook(await store.exportSheets(2025)).data.images.length, 53);
    await assert.rejects(store.saveCells({ year: 2025, versionId: initial.versionId, changes: [{ sheet: sales, cell: 'F5', input: '10' }] }), /版本已变化/);
    for (const [address, input, error] of [['B5', '1', /图片/], ['F5', '坏数据', /数字/], ['F5', '=F5+1', /计算失败|循环/], ['F5', '=1\/0', /计算失败/], ['F5', '=[external]A1', /不支持/]]) {
      assert.throws(() => applySheetChanges(after, [{ sheet: sales, cell: address, input }]), error);
    }
    assert.equal(store.read().versionId, after.versionId);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM business_edits').get().n, 1);
    store.restore(initial.versionId);
    assert.equal(cell(await store.sheetSnapshot(2025), 'F5').value, paid);
  } finally { store.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
const synthetic = () => ({ schemaVersion: 1, year: 2025, monthly: [{ id: 'shop:2025-03', shop: '店口五金淘宝', month: '2025-03', paid: 100, refund: 20, net: 80, quantity: 2, conversion: 0.1, sourceSheet: '原表', sourceRow: 3 }], finance: [{ id: 'finance:2025-03', month: '2025-03', purchase: 30, earnings: 50, sourceSheet: '原表', sourceRow: 3 }], purchases: [{ id: 'p1', month: '2025-03', date: '2025-03-01', item: '测试', amount: 30, platform: '1688', sourceSheet: '采购', sourceRow: 3 }], labor: [], controls: [{ id: 'balance', year: 2025, metric: '原表结余', amount: 50 }], images: [], sourceCells: [{ sheet: '原表', cell: 'I3', value: 80, formula: 'F3-G3' }], issues: [] });

test('标准模板、年度版本、过滤与恢复', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-business-test-'));
  let store;
  try {
    const a = path.join(temp, 'a.xlsx'), b = path.join(temp, 'b.xlsx');
    await fs.promises.writeFile(a, await exportBusinessWorkbook(synthetic()));
    store = new BusinessStore(path.join(temp, 'erp.sqlite'), path.join(temp, 'files'));
    const p = store.preview(a); assert.equal(p.year, 2025); assert.equal(p.diff.monthly.added, 1);
    assert.equal(store.read().available, false);
    store.commit(p.token, null); assert.equal(store.read().summary.net, 80);
    assert.equal(store.preview(a).duplicate, true);
    const changed = synthetic(); changed.monthly[0].paid = 120; changed.monthly[0].net = 100;
    await fs.promises.writeFile(b, await exportBusinessWorkbook(changed));
    const p2 = store.preview(b); assert.equal(p2.diff.monthly.changed, 1);
    assert.throws(() => store.commit(p2.token, 'stale'), /重新预览/);
    store.commit(p2.token, p.previousVersionId || p.token);
    assert.equal(store.read().summary.net, 100); assert.equal(store.versions().length, 2);
    store.restore(p.token); assert.equal(store.read().summary.net, 80);
    assert.deepEqual(store.read({ shop: '店口五金淘宝' }).finance, []);
    assert.equal(store.read({ month: '2025-04' }).summary.net, null);
    const p3 = store.preview(b); assert.equal(p3.duplicate, true);
    store.close(); store = new BusinessStore(path.join(temp, 'erp.sqlite'), path.join(temp, 'files'));
    assert.equal(store.read().summary.net, 80);
    assert.equal(store.original(p.token).data.equals(fs.readFileSync(a)), true);
    const roundtrip = parseBusinessWorkbook(await store.export({}));
    assert.equal(roundtrip.data.sourceCells[0].formula, 'F3-G3');
    assert.equal(selectBusinessData(roundtrip.data).summary.net, 80);
    const sheetView = await store.sheetSnapshot(2025);
    assert.equal(sheetView.raw, false);
    await store.saveCells({ year: 2025, versionId: sheetView.versionId, changes: [{ sheet: '店铺月报', cell: 'E2', input: '120' }, { sheet: '店铺月报', cell: 'H2', input: '=E2-F2' }] });
    assert.equal(store.read().summary.paid, 120);
    assert.equal(store.read().summary.net, 100);
    assert.throws(() => parseBusinessWorkbook(Buffer.from('broken')), /损坏/);
    const empty = await exportBusinessWorkbook({}, [], { template: true });
    assert.throws(() => parseBusinessWorkbook(empty), /完整年度/);
  } finally { store?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('原始业务工作簿：金额、全部图片、导出重导入', { skip: !sourceFile }, async () => {
  const parsed = parseBusinessWorkbook(sourceFile), view = selectBusinessData(parsed.data);
  assert.equal(parsed.data.monthly.length, 36); assert.equal(parsed.data.purchases.length, 162);
  assert.equal(parsed.data.images.length, 53); assert.equal(parsed.assets.length, 52);
  assert.equal(view.summary.earnings, 7913.05); assert.equal(view.summary.balance, 518.55);
  assert.equal(view.summary.purchase, 39439.18);
  assert.equal(view.reconciliation.find(r => r.metric === '采购逐笔明细合计').amount, 39439.49);
  assert.equal(view.summary.labor, 7384.5); assert.equal(view.summary.originalLabor, 7394.5);
  assert.ok(parsed.data.issues.some(r => r.message.includes('差额 10.00')));
  assert.ok(parsed.data.issues.some(r => r.message.includes('2025-12') && r.message.includes('1104.48')));
  assert.equal(view.summary.paid, 71774.94); assert.equal(view.summary.net, 54234.31);
  const bytes = await exportBusinessWorkbook(parsed.data, parsed.assets);
  const next = parseBusinessWorkbook(bytes);
  for (const key of ['monthly', 'finance', 'purchases', 'labor', 'images']) assert.equal(next.data[key].length, parsed.data[key].length);
  assert.deepEqual(selectBusinessData(next.data).summary, view.summary);
  assert.deepEqual(new Set(next.assets.map(a => a.id)), new Set(parsed.assets.map(a => a.id)));
  assert.deepEqual(next.data.images.map(i => [i.id, i.assetId, i.sheet, i.cell]), parsed.data.images.map(i => [i.id, i.assetId, i.sheet, i.cell]));
  assert.equal(createHash('sha256').update(parsed.buffer).digest('hex'), parsed.data.hash);
  const filtered = selectBusinessData(parsed.data, { month: '2025-09', shop: '西施五金淘宝' });
  assert.equal(filtered.monthly.length, 1); assert.equal(filtered.summary.net, 57.01);
  const filteredNext = parseBusinessWorkbook(await exportBusinessWorkbook(filtered, parsed.assets));
  assert.equal(filteredNext.data.monthly.length, 1); assert.equal(filteredNext.data.finance.length, 0);
});

test('远程经营接口遵循现有 Access 认证，且不提供导入端点', async () => {
  const remote = createRemoteService({ getBusiness: async () => ({ available: true }), getBusinessSheets: async () => ({ available: true, sheets: [] }), getBusinessImage: async () => ({ base64: 'test' }), getBusinessOriginal: async () => ({ base64: 'source' }) });
  try {
    assert.equal((await remote.app.inject({ url: '/api/v1/business' })).statusCode, 401);
    const headers = { 'cf-access-authenticated-user-email': 'reader@example.com' };
    assert.equal((await remote.app.inject({ url: '/api/v1/business', headers })).json().data.available, true);
    assert.equal((await remote.app.inject({ url: '/api/v1/business/sheets' })).statusCode, 401);
    assert.equal((await remote.app.inject({ url: '/api/v1/business/sheets', headers })).json().data.available, true);
    assert.equal((await remote.app.inject({ method: 'POST', url: '/api/v1/business/save-cells', headers })).statusCode, 404);
    assert.equal((await remote.app.inject({ url: '/api/v1/business/images/bad', headers })).statusCode, 400);
    assert.equal((await remote.app.inject({ url: '/api/v1/business/images/' + 'a'.repeat(64), headers })).json().data.base64, 'test');
    assert.equal((await remote.app.inject({ method: 'POST', url: '/api/v1/business/import', headers })).statusCode, 404);
  } finally { await remote.stop(); }
});
