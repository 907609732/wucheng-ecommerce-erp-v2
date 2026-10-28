import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SHOPS } from './config.mjs';
import { now, serial, id } from './util.mjs';
import { installFreightSchema } from './freight-schema.mjs';

export function openStore(dir) {
  mkdirSync(dir,{recursive:true});
  for(const d of ['originals','backups','reports','inbox'])mkdirSync(path.join(dir,d),{recursive:true});
  const db=new DatabaseSync(path.join(dir,'sales.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
  CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY,platform TEXT NOT NULL,name TEXT NOT NULL,receipts TEXT NOT NULL,manual INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),dataset TEXT NOT NULL,filename TEXT NOT NULL,sha256 TEXT NOT NULL,original_path TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL,context_json TEXT NOT NULL,preview_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),start TEXT NOT NULL,end TEXT NOT NULL,currency TEXT NOT NULL,sales INTEGER,orders INTEGER,refunds INTEGER,ad_spend INTEGER,ad_sales INTEGER,visitors INTEGER,buyers INTEGER,definition TEXT NOT NULL,compatible INTEGER NOT NULL DEFAULT 0,batch_id TEXT REFERENCES imports(id),source TEXT NOT NULL,UNIQUE(shop_id,start,end,currency));
  CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),date TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,external_id TEXT NOT NULL,match_key TEXT NOT NULL DEFAULT '',order_ref TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',deducted INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,batch_id TEXT REFERENCES imports(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(shop_id,source,kind,external_id));
  CREATE UNIQUE INDEX IF NOT EXISTS ledger_business_identity ON ledger(shop_id,kind,external_id);
  CREATE INDEX IF NOT EXISTS ledger_shop_source_date ON ledger(shop_id,source,date,id);
  CREATE INDEX IF NOT EXISTS ledger_date_id ON ledger(date,id);
  CREATE INDEX IF NOT EXISTS imports_shop_dataset_status ON imports(shop_id,dataset,status);
  CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,left_id TEXT NOT NULL REFERENCES ledger(id),right_id TEXT NOT NULL REFERENCES ledger(id),left_amount INTEGER NOT NULL,right_amount INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS coverage(shop_id TEXT NOT NULL REFERENCES shops(id),month TEXT NOT NULL,dataset TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(shop_id,month,dataset));
  CREATE TABLE IF NOT EXISTS rates(date TEXT NOT NULL,currency TEXT NOT NULL,rate INTEGER NOT NULL,effective_date TEXT NOT NULL,source TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(date,currency));
  CREATE TABLE IF NOT EXISTS month_locks(month TEXT PRIMARY KEY,revision TEXT NOT NULL,snapshot TEXT NOT NULL,locked_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS month_history(id TEXT PRIMARY KEY,month TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,entity_id TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,period TEXT NOT NULL,trigger TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT);
  CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,message TEXT NOT NULL,created_at TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS mutex(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS batch_attributions(import_id TEXT PRIMARY KEY REFERENCES imports(id),status TEXT NOT NULL CHECK(status IN ('confirmed','unassigned')),reason TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS platform_references(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),month TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(shop_id,month));
  CREATE TABLE IF NOT EXISTS report_history(filename TEXT PRIMARY KEY,status TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE VIEW IF NOT EXISTS active_ledger AS SELECT l.* FROM ledger l WHERE NOT EXISTS(SELECT 1 FROM batch_attributions a WHERE a.import_id=l.batch_id AND a.status='unassigned');
  CREATE VIEW IF NOT EXISTS active_operations AS SELECT o.* FROM operations o WHERE NOT EXISTS(SELECT 1 FROM batch_attributions a WHERE a.import_id=o.batch_id AND a.status='unassigned');
  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS history_no_update BEFORE UPDATE ON month_history BEGIN SELECT RAISE(ABORT,'HISTORY_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS history_no_delete BEFORE DELETE ON month_history BEGIN SELECT RAISE(ABORT,'HISTORY_IMMUTABLE'); END;`);
  installFreightSchema(db);
  const predicates={
    freight_records:p=>`EXISTS(SELECT 1 FROM month_locks WHERE month=${p}.month)`,
    freight_attachments:p=>`EXISTS(SELECT 1 FROM freight_records f JOIN month_locks m ON m.month=f.month WHERE f.id=${p}.record_id)`,
    batch_attributions:p=>`EXISTS(SELECT 1 FROM ledger l JOIN month_locks m ON m.month=substr(l.date,1,7) WHERE l.batch_id=${p}.import_id) OR EXISTS(SELECT 1 FROM operations o JOIN month_locks m ON m.month BETWEEN substr(o.start,1,7) AND substr(o.end,1,7) WHERE o.batch_id=${p}.import_id)`,
    ledger: p=>`EXISTS(SELECT 1 FROM month_locks WHERE month=substr(${p}.date,1,7))`,
    operations:p=>`EXISTS(SELECT 1 FROM month_locks WHERE month BETWEEN substr(${p}.start,1,7) AND substr(${p}.end,1,7))`,
    coverage:p=>`EXISTS(SELECT 1 FROM month_locks WHERE month=${p}.month)`,
    rates:p=>`EXISTS(SELECT 1 FROM month_locks WHERE month=substr(${p}.date,1,7))`,
    matches:p=>`EXISTS(SELECT 1 FROM ledger l JOIN month_locks m ON m.month=substr(l.date,1,7) WHERE l.id IN (${p}.left_id,${p}.right_id))`,
  };
  for(const [table,pred] of Object.entries(predicates))for(const op of ['INSERT','UPDATE','DELETE']){
    const cond=op==='INSERT'?pred('NEW'):op==='DELETE'?pred('OLD'):`(${pred('NEW')} OR ${pred('OLD')})`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS lock_${table}_${op.toLowerCase()} BEFORE ${op} ON ${table} WHEN ${cond} BEGIN SELECT RAISE(ABORT,'MONTH_LOCKED'); END;`);
  }
  for(const op of ['INSERT','UPDATE','DELETE']){
    const p=op==='DELETE'?'OLD':'NEW';
    db.exec(`CREATE TRIGGER IF NOT EXISTS lock_attribution_scope_${op.toLowerCase()} BEFORE ${op} ON batch_attributions WHEN EXISTS(SELECT 1 FROM imports b JOIN month_locks m ON m.month BETWEEN substr(json_extract(b.context_json,'$.scope.start'),1,7) AND substr(json_extract(b.context_json,'$.scope.end'),1,7) WHERE b.id=${p}.import_id AND b.status='committed') BEGIN SELECT RAISE(ABORT,'MONTH_LOCKED'); END;`);
  }
  const insertShop=db.prepare('INSERT OR IGNORE INTO shops VALUES(?,?,?,?,?)');
  const deletedShopIds=new Set(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='deletedShopIds'").get()?.value||'[]'));
  for(const s of SHOPS) if(!deletedShopIds.has(s.id))insertShop.run(s.id,s.platform,s.name,s.receipts,+s.manual);
  insertShop.run('__unassigned__','待归属','店铺待确认','待确认',0);
  let transactionDepth=0;
  const ownership=new AsyncLocalStorage();let activeOwner=null;
  function assertOwner(){const owner=ownership.getStore();if((activeOwner&&owner!==activeOwner)||owner?.closed)throw Object.assign(new Error('数据库正由另一事务使用，请重试'),{code:'AGENT_COMMIT_BUSY',status:409,statusCode:409});}
  // Guard the native handle too: legacy jobs may retain prepared statements.
  const nativePrepare=db.prepare.bind(db),nativeExec=db.exec.bind(db);
  const nativeClose=db.close.bind(db);db.close=(...args)=>{assertOwner();return nativeClose(...args);};
  db.exec=(...args)=>{assertOwner();return nativeExec(...args);};
  db.prepare=(...args)=>{assertOwner();const statement=nativePrepare(...args);for(const method of ['run','get','all','iterate']){const original=statement[method]?.bind(statement);if(original)statement[method]=(...values)=>{assertOwner();return original(...values);};}return statement;};
  const store={db,dir,
    shops:()=>db.prepare("SELECT * FROM shops WHERE platform<>'待归属' ORDER BY rowid").all().map(s=>({...s,manual:!!s.manual})),
    all:(sql,...args)=>db.prepare(sql).all(...args),
    get:(sql,...args)=>db.prepare(sql).get(...args),
    run:(sql,...args)=>db.prepare(sql).run(...args),
    transaction(fn){const nested=transactionDepth>0,name='sales_tx_'+transactionDepth;db.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');transactionDepth++;try{const v=fn();db.exec(nested?'RELEASE '+name:'COMMIT');return v;}catch(e){db.exec(nested?'ROLLBACK TO '+name:'ROLLBACK');if(nested)db.exec('RELEASE '+name);throw e;}finally{transactionDepth--;}},
    async agentTransaction(fn){assertOwner();store.agentTransactionGuard?.();if(transactionDepth)throw Object.assign(new Error('Agent transaction already active'),{code:'AGENT_COMMIT_BUSY',status:409});const owner={closed:false};return ownership.run(owner,async()=>{activeOwner=owner;let begun=false;try{db.exec('BEGIN IMMEDIATE');begun=true;transactionDepth++;const result=await fn();db.exec('COMMIT');return result;}catch(error){if(begun)db.exec('ROLLBACK');throw error;}finally{if(begun)transactionDepth--;activeOwner=null;owner.closed=true;}});},
    audit(action,entity,details={}){db.prepare('INSERT INTO audit(action,entity_id,details,created_at) VALUES(?,?,?,?)').run(action,entity,serial(details),now());},
    setting(key,fallback=null){const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):fallback;},
    setSetting(key,value){db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,serial(value));},
    notice(message){db.prepare('INSERT INTO notices(id,message,created_at) VALUES(?,?,?)').run(id(),message,now());},
    close(){db.close();}
  };
  return store;
}
