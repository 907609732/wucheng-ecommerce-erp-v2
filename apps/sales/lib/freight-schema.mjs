// Only the warehouse "other" bucket may include signed compensation offsets.
export function installFreightSchema(db) {
  const existing=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='freight_records'").get();
  if(existing&&/CHECK\s*\(\s*other\s*>=\s*0\s*\)/i.test(existing.sql)){
    const objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='freight_records' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
    const foreignKeys=db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    const legacyAlter=db.prepare('PRAGMA legacy_alter_table').get().legacy_alter_table;
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
    try{
      const sql=existing.sql.replace(/CREATE TABLE\s+(?:"freight_records"|freight_records)/i,'CREATE TABLE freight_records_signed_other').replace(/CHECK\s*\(\s*other\s*>=\s*0\s*\)/i,"CHECK(channel='warehouse' OR other=0)");
      db.exec(sql);
      db.exec('INSERT INTO freight_records_signed_other SELECT * FROM freight_records; DROP TABLE freight_records; ALTER TABLE freight_records_signed_other RENAME TO freight_records');
      for(const object of objects)db.exec(object.sql);
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Freight migration foreign key check failed');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    finally{db.exec(`PRAGMA foreign_keys=${foreignKeys}; PRAGMA legacy_alter_table=${legacyAlter}`);}
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS freight_records (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK(channel IN ('warehouse','merchant','sf')),
      entry_mode TEXT NOT NULL CHECK(entry_mode IN ('month','day','single')),
      period TEXT NOT NULL,
      month TEXT NOT NULL CHECK(month=substr(period,1,7)),
      shop_id TEXT REFERENCES shops(id),
      shipping INTEGER NOT NULL CHECK(shipping>=0),
      packing INTEGER NOT NULL CHECK(packing>=0),
      materials INTEGER NOT NULL CHECK(materials>=0),
      storage INTEGER NOT NULL CHECK(storage>=0),
      other INTEGER NOT NULL CHECK(channel='warehouse' OR other=0),
      other_note TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL CHECK(total=shipping+packing+materials+storage+other),
      pieces INTEGER CHECK(pieces IS NULL OR pieces>=0),
      bill_no TEXT NOT NULL DEFAULT '',
      tracking_no TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),
      void_reason TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(channel<>'warehouse' OR shop_id IS NULL),
      CHECK(channel<>'merchant' OR shop_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS freight_month_scope ON freight_records(month,shop_id,channel,status);
    CREATE TABLE IF NOT EXISTS freight_attachments (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES freight_records(id),
      filename TEXT NOT NULL,
      original_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      created_at TEXT NOT NULL,
      removed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS freight_attachment_record ON freight_attachments(record_id);
    CREATE TABLE IF NOT EXISTS freight_requests (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}
