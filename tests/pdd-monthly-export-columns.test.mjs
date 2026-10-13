import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { exportPddOrders } from '../desktop/shared/pdd-order-export.mjs';

test('PDD monthly Excel preserves full text tracking numbers without moving legacy columns', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-pdd-tracking-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'tracking.xlsx');
  const order={orderId:'000-ORDER',amountCents:100,items:[],attributes:{trackingNumber:'0001234567890123456789'}};
  await exportPddOrders([order],file,{includeTrackingNumber:true});
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(file);
  const sheet=book.getWorksheet('采购订单'),header=sheet.getRow(1).values;
  assert(header.includes('快递单号'),'独立拼多多导出须保留快递单号');
  assert.equal(sheet.getRow(2).getCell(header.indexOf('快递单号')).value,order.attributes.trackingNumber);
  assert.equal(sheet.getRow(2).getCell(header.indexOf('快递单号')).numFmt,'@');
  const legacy=path.join(directory,'legacy.xlsx');await exportPddOrders([order],legacy);
  const old=new ExcelJS.Workbook();await old.xlsx.readFile(legacy);
  assert.equal(old.getWorksheet('采购订单').getRow(1).values.includes('快递单号'),false);
  assert.equal(old.getWorksheet('采购订单').columnCount,16);
});
