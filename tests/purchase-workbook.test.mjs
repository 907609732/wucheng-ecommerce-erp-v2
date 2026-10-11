import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { PurchaseCollector } from '../desktop/shared/purchase-collector.mjs';
import { purchaseJob } from '../desktop/shared/purchase-jobs.mjs';
import { PURCHASE_SHEET as ID, validatePurchaseWorkbook } from '../desktop/shared/purchase-workbook.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-sheet-'));
  const store = new PurchaseCollector(path.join(directory, 'erp.sqlite'), path.join(directory, 'originals'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function add(order, paid = 12) {
    const file = path.join(directory, `${order}.xlsx`), book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ 订单号: order, 下单时间: '2026-09-03 10:20:00', 商品名称: '测试螺丝', 实付款: paid, 数量: 2 }]), '订单');
    fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    store.commit(store.preview(file, { platform: 'taobao', account: '测试账号', month: '2026-09' }).token);
  }
  return { directory, store, add };
}
test('采购表格编辑保存、历史备份和追加不改变原始采集记录', t => {
  const { store, add } = fixture(t); add('A001');
  const draft = store.readWorkbook(); assert.equal(draft.added, 1); assert.equal(draft.snapshot.sheets[ID].cellData[1][12].v, 12);
  draft.snapshot.sheets[ID].cellData[1][12].v = 30;
  draft.snapshot.sheets[ID].cellData[1][15] = { v: '已人工核对', t: 1, s: { bl: 1 } };
  const saved = store.saveWorkbook(draft); assert.equal(saved.revision, 1);
  assert.equal(store.read({ month: '2026-09' }).total, 12);
  add('A002', 18);
  const next = store.readWorkbook(); assert.equal(next.added, 1); assert.equal(next.sourceKeys.length, 2);
  assert.equal(next.snapshot.sheets[ID].cellData[1][12].v, 30); assert.equal(next.snapshot.sheets[ID].cellData[1][15].v, '已人工核对');
  assert.equal(next.snapshot.sheets[ID].cellData[2][12].v, 18);
  store.saveWorkbook(next); assert.equal(store.readWorkbook().added, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM purchase_workbook_history').get().n, 1);
  assert.equal(store.read({ month: '2026-09' }).total, 30);
});
test('采购表格拒绝冲突保存、删除来源和损坏结构', t => {
  const { store, add } = fixture(t); add('A001');
  const draft = store.readWorkbook(); store.saveWorkbook(draft);
  assert.throws(() => store.saveWorkbook(draft), /其他窗口/);
  const next = store.readWorkbook(); assert.throws(() => store.saveWorkbook({ ...next, sourceKeys: [] }), /不能丢失/);
  const broken = structuredClone(next.snapshot); delete broken.sheets[ID]; assert.throws(() => validatePurchaseWorkbook(broken), /保留采购明细/);
  const bad = structuredClone(next.snapshot); bad.sheets[ID].cellData[60000] = {}; assert.throws(() => validatePurchaseWorkbook(bad), /行号/);
  const same = structuredClone(next.snapshot); same.sheets['purchase-analysis'].name = '采购明细'; assert.throws(() => validatePurchaseWorkbook(same), /名称不能重复/);
});
test('来源表头移动可以安全追加，表头改名则不猜测位置', t => {
  const { store, add } = fixture(t); add('A001');
  const draft = store.readWorkbook(), cells = draft.snapshot.sheets[ID].cellData;
  for (const row of Object.values(cells)) [row[0], row[15]] = [row[15], row[0]];
  store.saveWorkbook(draft); add('A002');
  const next = store.readWorkbook(); assert.equal(next.snapshot.sheets[ID].cellData[2][15].v, '2026-09');
  next.snapshot.sheets[ID].cellData[0][5].v = '自定义商品名称'; store.saveWorkbook(next); add('A003');
  assert.throws(() => store.readWorkbook(), /来源字段已改名/);
});
test('工作线程导出可编辑工作簿，保留文本订单号、公式和基础格式', async t => {
  const { directory, store, add } = fixture(t); add('000123456789012345678');
  const draft = store.readWorkbook();
  draft.snapshot.sheets[ID].cellData[1][15] = { v: '=不作为公式执行', t: 1, s: { bl: 1, bg: { rgb: '#ffeeaa' } } };
  draft.snapshot.sheets['purchase-analysis'].cellData[1][1].v = 12;
  const file = path.join(directory, 'edited.xlsx');
  await purchaseJob(path.join(directory, 'erp.sqlite'), path.join(directory, 'originals'), 'exportWorkbook', [draft.snapshot, file]);
  const result = new ExcelJS.Workbook(); await result.xlsx.readFile(file);
  assert.equal(result.getWorksheet('采购明细').getCell('E2').value, '000123456789012345678');
  assert.equal(result.getWorksheet('采购明细').getCell('P2').value, '=不作为公式执行');
  assert.equal(result.getWorksheet('采购明细').getCell('P2').font.bold, true);
  assert.equal(result.getWorksheet('采购明细').getCell('P2').fill.fgColor.argb, 'FFffeeaa');
  assert.equal(result.getWorksheet('分析表').getCell('B2').value.formula, "SUM('采购明细'!M:M)");
  assert.equal(result.getWorksheet('采购明细').views[0].ySplit, 1);
});
