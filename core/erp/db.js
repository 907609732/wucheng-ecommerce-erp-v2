import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pruneRetiredTables } from "./warehouse-schema.js";
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
  pruneRetiredTables(database);
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

  `);

  ensureColumn(database, "skus", "barcode", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "skus", "external_product_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "skus", "source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(database, "skus", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(database, "import_records", "store", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "imported_files", "store", "TEXT NOT NULL DEFAULT ''");
  database.exec(`
    UPDATE skus
       SET source = 'inventory',
           status = 'active'
     WHERE EXISTS (
       SELECT 1 FROM inventory_snapshots i WHERE i.sku = skus.sku
     );

  `);

  const warehouseInsert = database.prepare(
    "INSERT OR IGNORE INTO warehouses (id, name) VALUES (?, ?)"
  );
  warehouseInsert.run("cainiao", "菜鸟云仓");
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
