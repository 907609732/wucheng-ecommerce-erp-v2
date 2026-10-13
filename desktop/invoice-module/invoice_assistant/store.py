from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager, closing
from datetime import datetime
from pathlib import Path


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def uid():
    return uuid.uuid4().hex


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def fingerprint(value):
    return hashlib.sha256(dump(value).encode("utf-8")).hexdigest()


SCHEMA = """
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,platform TEXT NOT NULL,name TEXT NOT NULL,
 company TEXT NOT NULL DEFAULT '',shop_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'needs_login',
 binding TEXT NOT NULL DEFAULT '{}',updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,mode TEXT NOT NULL,state TEXT NOT NULL,
 created TEXT NOT NULL,updated TEXT NOT NULL,options TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS batch_accounts(batch_id TEXT NOT NULL,account_id TEXT NOT NULL,state TEXT NOT NULL,
 evidence TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(batch_id,account_id));
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,source_id TEXT NOT NULL,
 payload TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'needs_review',
 problems TEXT NOT NULL DEFAULT '[]',revision INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batch_requests(batch_id TEXT NOT NULL,request_id TEXT NOT NULL,
 PRIMARY KEY(batch_id,request_id));
CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,part INTEGER NOT NULL,
 revision INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'prepared',
 invoice_no TEXT NOT NULL DEFAULT '',issued_at TEXT NOT NULL DEFAULT '',UNIQUE(request_id,part,revision));
CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,target TEXT NOT NULL,
 path TEXT NOT NULL,template_hash TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS export_artifacts(export_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mappings(id TEXT PRIMARY KEY,kind TEXT NOT NULL,map_key TEXT NOT NULL,
 value TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(kind,map_key));
CREATE TABLE IF NOT EXISTS templates(target TEXT PRIMARY KEY,path TEXT NOT NULL,
 signature TEXT NOT NULL,profile TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints(batch_id TEXT NOT NULL,account_id TEXT NOT NULL,stage TEXT NOT NULL,
 value TEXT NOT NULL,PRIMARY KEY(batch_id,account_id,stage));
CREATE TABLE IF NOT EXISTS legacy_issued(order_no TEXT PRIMARY KEY,invoice_no TEXT NOT NULL,source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,created TEXT NOT NULL,kind TEXT NOT NULL,
 object_id TEXT NOT NULL,before_value TEXT NOT NULL,after_value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS migrations(key TEXT PRIMARY KEY,created TEXT NOT NULL,report TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS execution_tasks(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,provider TEXT NOT NULL,
 state TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
 attempts INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,updated TEXT NOT NULL,
 UNIQUE(invoice_id,provider));
CREATE TABLE IF NOT EXISTS execution_events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,created TEXT NOT NULL,
 previous_state TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_receipts(idempotency_key TEXT PRIMARY KEY,provider TEXT NOT NULL,
 invoice_no TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archive_files(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,sha256 TEXT NOT NULL,
 path TEXT NOT NULL,original_name TEXT NOT NULL,kind TEXT NOT NULL,simulated INTEGER NOT NULL,created TEXT NOT NULL,
 UNIQUE(invoice_id,sha256,kind));
CREATE TABLE IF NOT EXISTS request_reviews(request_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,
 payload_hash TEXT NOT NULL,reviewed TEXT NOT NULL);
"""


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        (self.root / "数据").mkdir(parents=True, exist_ok=True)
        self.path = self.root / "数据" / "开票助手.sqlite3"
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            conn.execute("PRAGMA user_version=2")

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def rows(self, sql, args=()):
        with self.connect() as conn:
            return [dict(r) for r in conn.execute(sql, args)]

    def execute(self, sql, args=()):
        with self.connect() as conn:
            conn.execute(sql, args)

    def get(self, key, default=None):
        rows = self.rows("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(rows[0]["value"]) if rows else default

    def set(self, key, value):
        self.execute("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, dump(value)))

    def audit(self, kind, object_id, before, after):
        self.execute("INSERT INTO audit VALUES(?,?,?,?,?,?)", (uid(), now(), kind, object_id, dump(before), dump(after)))

    def batch(self, mode, options, account_ids=()):
        bid = uid()
        with self.connect() as conn:
            conn.execute("INSERT INTO batches(id,mode,state,created,updated,options) VALUES(?,?,?,?,?,?)",
                         (bid, mode, "queued", now(), now(), dump(options)))
            for aid in account_ids:
                conn.execute("INSERT INTO batch_accounts VALUES(?,?,?,?)", (bid, aid, "queued", "{}"))
        return bid

    def update_batch(self, bid, state, summary=None):
        if summary is None:
            self.execute("UPDATE batches SET state=?,updated=? WHERE id=?", (state, now(), bid))
        else:
            self.execute("UPDATE batches SET state=?,summary=?,updated=? WHERE id=?", (state, dump(summary), now(), bid))

    def mapping(self, kind, key, value):
        before = self.rows("SELECT value FROM mappings WHERE kind=? AND map_key=?", (kind, key))
        value = {**(json.loads(before[0]["value"]) if before else {}), **value}
        with self.connect() as conn:
            conn.execute("INSERT INTO mappings VALUES(?,?,?,?,?) ON CONFLICT(kind,map_key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
                         (uid(), kind, key, dump(value), now()))
            conn.execute("INSERT INTO audit VALUES(?,?,?,?,?,?)", (uid(), now(), "mapping", kind+":"+key,
                         before[0]["value"] if before else "null", dump(value)))

    def backup(self):
        dest = self.root / "数据" / "备份" / f"开票助手_{datetime.now():%Y%m%d_%H%M%S_%f}.sqlite3"
        dest.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn, closing(sqlite3.connect(dest)) as target:
            conn.backup(target)
        return str(dest)
