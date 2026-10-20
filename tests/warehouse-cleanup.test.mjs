import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pruneRetiredTables } from '../core/erp/warehouse-schema.js';

test('retired table cleanup preserves warehouse rows and unknown extensions, and is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE inventory_snapshots(sku TEXT,quantity INTEGER);
    INSERT INTO inventory_snapshots VALUES('cloud-sku',123);
    CREATE TABLE warehouse_monthly_sales(sku TEXT,sales_quantity INTEGER);
    INSERT INTO warehouse_monthly_sales VALUES('cloud-sku',456);
    CREATE TABLE orders(id INTEGER PRIMARY KEY);
    CREATE TABLE order_items(order_id INTEGER REFERENCES orders(id));
    INSERT INTO orders VALUES(1); INSERT INTO order_items VALUES(1);
    CREATE TABLE business_assets(payload BLOB); INSERT INTO business_assets VALUES(x'123456');
    CREATE TABLE purchase_lines(value TEXT); INSERT INTO purchase_lines VALUES('retired');
    CREATE TABLE extension_data(value TEXT); INSERT INTO extension_data VALUES('preserve');`);
  try {
    assert.deepEqual(pruneRetiredTables(db).sort(), ['business_assets','order_items','orders','purchase_lines']);
    assert.equal(db.prepare('SELECT quantity FROM inventory_snapshots').get().quantity,123);
    assert.equal(db.prepare('SELECT sales_quantity FROM warehouse_monthly_sales').get().sales_quantity,456);
    assert.equal(db.prepare('SELECT value FROM extension_data').get().value,'preserve');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.deepEqual(pruneRetiredTables(db),[]);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally { db.close(); }
});
