import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { PurchaseCollector } from '../desktop/shared/purchase-collector.mjs';
import { purchaseJob } from '../desktop/shared/purchase-jobs.mjs';

test('采购官方导出先预览后入库，并按明细键去重', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-test-'));
  const file = path.join(directory, 'taobao-2026-09.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { 订单号: 'A001', 下单时间: '2026-09-03 10:20:00', 商品名称: '不锈钢螺丝', 规格: 'M6', 数量: 2, 商品金额: 10, 运费: 1, 优惠金额: 1, 实付款: 10, 供应商: '五金店', 订单状态: '已完成' },
    { 订单号: 'A002', 下单时间: '2026-10-01 10:20:00', 商品名称: '跨月商品', 实付款: 99 }
  ]), '订单');
  fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const store = new PurchaseCollector(path.join(directory, 'erp.sqlite'), path.join(directory, 'exports'));
  try {
    const preview = store.preview(file, { platform: 'taobao', account: '采购主号', month: '2026-09' });
    assert.equal(preview.rows, 1); assert.equal(preview.total, 10); assert.equal(store.read({ month: '2026-09' }).count, 0);
    assert.deepEqual(store.commit(preview.token), { inserted: 1, skipped: 0, month: '2026-09' });
    const data = store.read({ month: '2026-09' }); assert.equal(data.count, 1); assert.equal(data.total, 10); assert.equal(data.rows[0].item, '不锈钢螺丝 M6');
    const repeat = store.preview(file, { platform: 'taobao', account: '采购主号', month: '2026-09' }); assert.equal(repeat.duplicate, true);
    const expanded = store.preview(file, { platform: 'taobao', account: '采购主号', month: '2026-09', startDate: '2026-09-01', endDate: '2026-10-31' });
    assert.equal(expanded.rows, 2); assert.equal(expanded.duplicates, 1);
    assert.deepEqual(store.commit(expanded.token), { inserted: 1, skipped: 1, month: '2026-09' });
    assert.equal(store.read({ month: '2026-10' }).total, 99);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('采购工作线程可读取空台账', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-purchase-worker-'));
  try {
    const result = await purchaseJob(path.join(directory, 'erp.sqlite'), path.join(directory, 'exports'), 'read', [{ month: '2026-09' }]);
    assert.equal(result.count, 0); assert.deepEqual(result.months, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
