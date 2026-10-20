// Only retired ERP business tables are removed. Unknown tables are preserved.
export const WAREHOUSE_TABLES = new Set([
  'warehouses', 'skus', 'inventory_snapshots', 'inventory_movements',
  'import_records', 'imported_files', 'operation_logs', 'product_images',
  'monthly_outbound', 'inventory_data_validations', 'warehouse_monthly_sales',
  'warehouse_monthly_sales_validations', 'monthly_report_deliveries'
]);
const retired = new Set([
  'orders', 'order_items', 'order_unmatched_items', 'shipping_fees',
  'competitors', 'competitor_snapshots', 'monthly_financials', 'purchase_records',
  'return_records', 'fixed_assets', 'product_code_mappings', 'barcode_templates',
  'unpack_return_sources', 'unpack_sessions', 'unpack_video_clips', 'unpack_cameras', 'unpack_nas_commands'
]);
export function pruneRetiredTables(database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  const remove = tables.filter(name => retired.has(name) || /^(business_|purchase_|finance_|invoice_)/.test(name));
  if (!remove.length) return [];
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get().foreign_keys;
  database.exec('PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
  try {
    for (const name of remove) database.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`); }
  return remove;
}
