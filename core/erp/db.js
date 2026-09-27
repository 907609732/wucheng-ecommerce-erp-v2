import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rootDir } from "../config.js";

const dataDir = process.env.ERP_DATA_DIR || path.join(rootDir, "data");
const dbPath = path.join(dataDir, "erp.sqlite");

let db;

export function getDb() {
  if (!db) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(dbPath);
    const nativePrepare = db.prepare.bind(db);
    db.prepare = (sql) => wrapStatement(nativePrepare(sql));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.transaction = (callback) => (...args) => {
      db.exec("BEGIN");
      try {
        const result = callback(...args);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    migrate(db);
  }
  return db;
}

function wrapStatement(statement) {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "get") {
        return (...args) => toPlainRow(target.get(...args));
      }
      if (property === "all") {
        return (...args) => target.all(...args).map(toPlainRow);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function toPlainRow(row) {
  return row == null ? row : { ...row };
}

export function closeDb() {
  if (!db) return;
  db.close();
  db = undefined;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skus (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      barcode TEXT NOT NULL DEFAULT '',
      external_product_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'active',
      cost_price REAL NOT NULL DEFAULT 0,
      low_stock_threshold INTEGER NOT NULL DEFAULT 10,
      cainiao_code TEXT,
      qianniu_code TEXT,
      jd_code TEXT,
      pdd_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'import',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (sku, warehouse_id, snapshot_date),
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      store TEXT NOT NULL DEFAULT '',
      order_id TEXT NOT NULL,
      order_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      customer TEXT NOT NULL DEFAULT '',
      total_amount REAL NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (platform, order_id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      order_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      refund_status TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (platform, order_id, sku),
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS order_unmatched_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      order_id TEXT NOT NULL,
      sub_order_id TEXT NOT NULL DEFAULT '',
      store TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      sku_text TEXT NOT NULL DEFAULT '',
      attributes TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      refund_status TEXT NOT NULL DEFAULT '',
      order_date TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (platform, order_id, sub_order_id, product_id, name, attributes)
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      movement_date TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      order_id TEXT NOT NULL DEFAULT '',
      sub_order_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_type, platform, order_id, sub_order_id, sku, warehouse_id),
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shipping_fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      fee_month TEXT NOT NULL,
      order_id TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (platform, fee_month, order_id)
    );

    CREATE TABLE IF NOT EXISTS competitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      relation TEXT NOT NULL DEFAULT 'competitor',
      sku TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS competitor_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor_id INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      price REAL,
      sales_text TEXT NOT NULL DEFAULT '',
      sales_value REAL,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (competitor_id, snapshot_date),
      FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS import_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      store TEXT NOT NULL DEFAULT '',
      warehouse_id TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS imported_files (
      hash TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT NOT NULL DEFAULT '',
      import_type TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      warehouse_id TEXT NOT NULL DEFAULT '',
      period TEXT NOT NULL DEFAULT '',
      row_count INTEGER NOT NULL DEFAULT 0,
      first_imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS monthly_financials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      month TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      store TEXT NOT NULL DEFAULT '',
      sales_amount REAL NOT NULL DEFAULT 0,
      refund_amount REAL NOT NULL DEFAULT 0,
      purchase_cost REAL NOT NULL DEFAULT 0,
      shipping_fee REAL NOT NULL DEFAULT 0,
      labor_cost REAL NOT NULL DEFAULT 0,
      gross_profit REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_file, month, platform, store)
    );

    CREATE TABLE IF NOT EXISTS purchase_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      purchase_date TEXT NOT NULL DEFAULT '',
      item_name TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      platform TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_file, purchase_date, item_name, amount)
    );

    CREATE TABLE IF NOT EXISTS return_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      store TEXT NOT NULL DEFAULT '',
      order_id TEXT NOT NULL DEFAULT '',
      refund_id TEXT NOT NULL DEFAULT '',
      tracking_no TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      refund_amount REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      apply_time TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_file, platform, order_id, refund_id, tracking_no)
    );

    CREATE TABLE IF NOT EXISTS fixed_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      asset_code TEXT NOT NULL DEFAULT '',
      asset_name TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      start_month TEXT NOT NULL DEFAULT '',
      original_value REAL NOT NULL DEFAULT 0,
      depreciation_months REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_file, asset_code, asset_name)
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_value TEXT NOT NULL DEFAULT '',
      after_value TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      operator TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      stored_path TEXT NOT NULL,
      public_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_code_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      code_type TEXT NOT NULL DEFAULT 'product_id',
      code_value TEXT NOT NULL,
      attributes TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (platform, code_type, code_value, attributes),
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS barcode_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      label_width_mm REAL NOT NULL DEFAULT 40,
      label_height_mm REAL NOT NULL DEFAULT 60,
      elements_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS monthly_outbound (
      sku TEXT NOT NULL,
      warehouse_id TEXT NOT NULL DEFAULT 'cainiao',
      month TEXT NOT NULL,
      toc_sales REAL NOT NULL DEFAULT 0,
      tob_sales REAL NOT NULL DEFAULT 0,
      total_outbound REAL NOT NULL DEFAULT 0,
      near_30_days_sales REAL NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (sku, warehouse_id, month),
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inventory_data_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id TEXT NOT NULL DEFAULT 'cainiao',
      source_file TEXT NOT NULL DEFAULT '',
      source_date TEXT NOT NULL DEFAULT '',
      expected_source_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'invalid',
      row_count INTEGER NOT NULL DEFAULT 0,
      total_quantity REAL NOT NULL DEFAULT 0,
      checks_json TEXT NOT NULL DEFAULT '{}',
      error_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS warehouse_monthly_sales (
      warehouse_id TEXT NOT NULL DEFAULT 'cainiao',
      sku TEXT NOT NULL,
      month TEXT NOT NULL,
      product_name TEXT NOT NULL DEFAULT '',
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      toc_sales REAL NOT NULL DEFAULT 0,
      tob_sales REAL NOT NULL DEFAULT 0,
      sales_quantity REAL NOT NULL DEFAULT 0,
      source_file TEXT NOT NULL DEFAULT '',
      source_file_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (warehouse_id, sku, month),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
      FOREIGN KEY (sku) REFERENCES skus(sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS warehouse_monthly_sales_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id TEXT NOT NULL DEFAULT 'cainiao',
      month TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL DEFAULT '',
      source_file_hash TEXT NOT NULL DEFAULT '',
      period_start TEXT NOT NULL DEFAULT '',
      period_end TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'invalid',
      row_count INTEGER NOT NULL DEFAULT 0,
      sku_count INTEGER NOT NULL DEFAULT 0,
      total_sales_quantity REAL NOT NULL DEFAULT 0,
      checks_json TEXT NOT NULL DEFAULT '{}',
      error_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_warehouse_monthly_sales_month
      ON warehouse_monthly_sales (month, warehouse_id);

    CREATE INDEX IF NOT EXISTS idx_warehouse_monthly_sales_validation_month
      ON warehouse_monthly_sales_validations (month, warehouse_id, created_at);

    CREATE TABLE IF NOT EXISTS monthly_report_deliveries (
      report_type TEXT NOT NULL,
      report_month TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempted_at TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL DEFAULT '',
      error_text TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (report_type, report_month)
    );

    CREATE TABLE IF NOT EXISTS unpack_return_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_no TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      store TEXT NOT NULL DEFAULT '',
      order_id TEXT NOT NULL DEFAULT '',
      refund_id TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      return_status TEXT NOT NULL DEFAULT '',
      apply_time TEXT NOT NULL DEFAULT '',
      source_sheet TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tracking_no, platform, store, order_id, refund_id, product_name, source_sheet)
    );

    CREATE TABLE IF NOT EXISTS unpack_sessions (
      id TEXT PRIMARY KEY,
      tracking_no TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recording',
      match_status TEXT NOT NULL DEFAULT 'unmatched',
      return_source_id INTEGER,
      operator TEXT NOT NULL DEFAULT 'local',
      scan_source TEXT NOT NULL DEFAULT 'scanner',
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL DEFAULT '',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      video_status TEXT NOT NULL DEFAULT 'pending',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (return_source_id) REFERENCES unpack_return_sources(id)
    );

    CREATE TABLE IF NOT EXISTS unpack_video_clips (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      clip_type TEXT NOT NULL,
      camera_id TEXT NOT NULL DEFAULT '',
      video_ref TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      ended_at TEXT NOT NULL DEFAULT '',
      checksum TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (session_id, clip_type, camera_id),
      FOREIGN KEY (session_id) REFERENCES unpack_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS unpack_cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      camera_type TEXT NOT NULL,
      stream_ref TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS unpack_nas_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (session_id) REFERENCES unpack_sessions(id) ON DELETE CASCADE
    );
  `);

  ensureColumn(database, "skus", "barcode", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "skus", "external_product_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "skus", "source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(database, "skus", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(database, "orders", "store", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "order_unmatched_items", "store", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "import_records", "store", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "imported_files", "store", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "competitors", "note", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "competitors", "enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "competitor_snapshots", "sales_value", "REAL");
  ensureColumn(database, "unpack_nas_commands", "attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "unpack_nas_commands", "delivered_at", "TEXT NOT NULL DEFAULT ''");
  database.exec(`
    UPDATE orders SET store = '店口五金店' WHERE store = '';
    UPDATE order_unmatched_items SET store = '店口五金店' WHERE store = '';
    UPDATE import_records SET store = '店口五金店' WHERE store = '' AND type = 'orders';
    UPDATE imported_files SET store = '店口五金店' WHERE store = '' AND import_type = 'orders';

    UPDATE skus
       SET source = 'inventory',
           status = 'active'
     WHERE EXISTS (
       SELECT 1 FROM inventory_snapshots i WHERE i.sku = skus.sku
     );

    UPDATE skus
       SET source = 'order',
           status = 'unmanaged'
     WHERE NOT EXISTS (
       SELECT 1 FROM inventory_snapshots i WHERE i.sku = skus.sku
     )
       AND EXISTS (
         SELECT 1 FROM inventory_movements m WHERE m.sku = skus.sku
       );
  `);

  const warehouseInsert = database.prepare(
    "INSERT OR IGNORE INTO warehouses (id, name) VALUES (?, ?)"
  );
  warehouseInsert.run("cainiao", "菜鸟云仓");
  warehouseInsert.run("shanghai", "上海仓库");
  warehouseInsert.run("zhuji", "诸暨仓库");
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function nowDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export function currentMonth() {
  return nowDate().slice(0, 7);
}
