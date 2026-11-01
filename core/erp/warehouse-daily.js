import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readCainiaoInventory,inventorySnapshotFingerprint} from '../../desktop/shared/inventory-store.mjs';

export const CHANNELS = ['email', 'dingtalk', 'sms', 'phone'];
export function businessDate(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function expectedInventoryDate(now=new Date()) {
  const day=new Date(businessDate(now)+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-1);return day.toISOString().slice(0,10);
}
const problem = (message, status=400) => Object.assign(Error(message), {status});
const admin = actor => {if(!actor?.id)throw problem('缺少已验证的工作台身份',401);};
const safeError = () => '服务请求失败，请检查渠道配置或服务商记录';
const weekday = day => new Date(day+'T00:00:00Z').getUTCDay() || 7;
const normalizeLogin = value => String(value||'').trim().toLowerCase();
const json = value => JSON.stringify(value);

// This store lives in the existing warehouse ledger. It is opened only by the
// owning host, never by a remote client or a new independently-created ledger.
export function createWarehouseDaily({databasePath, now=()=>new Date(), senders={}, getChannels=async()=>({})}) {
  if(!fs.existsSync(databasePath))throw problem('原云仓账本不存在，无法初始化工作记录',503);
  const db=new DatabaseSync(databasePath,{timeout:5000});
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS warehouse_sync_runs(id TEXT PRIMARY KEY,business_date TEXT NOT NULL,started_at TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS warehouse_daily_config(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS warehouse_attendance(login TEXT NOT NULL,business_date TEXT NOT NULL,check_in_at TEXT NOT NULL,completed_at TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',PRIMARY KEY(login,business_date));
    CREATE TABLE IF NOT EXISTS warehouse_reminders(id TEXT PRIMARY KEY,login TEXT NOT NULL,business_date TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(login,business_date,channel));
    CREATE TABLE IF NOT EXISTS warehouse_daily_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);`);
  const time=()=>now().toISOString();
  const config=()=>JSON.parse(db.prepare('SELECT payload FROM warehouse_daily_config WHERE id=1').get()?.payload||'{"employees":[],"autoRemind":false}');
  const audit=(actor,action,payload)=>db.prepare('INSERT INTO warehouse_daily_audit VALUES(?,?,?,?,?)').run(randomUUID(),String(actor?.id||'system'),action,time(),json(payload));
  function beginRun({id=randomUUID(),expectedSourceDate=expectedInventoryDate(now()),kind='sync'}={}) {
    const startedAt=time(),day=businessDate(now());
    db.prepare('INSERT INTO warehouse_sync_runs VALUES(?,?,?,?)').run(id,day,startedAt,json({id,runId:id,businessDate:day,expectedSourceDate,kind,startedAt,collectionStatus:'pending',validationStatus:'pending',deliveryStatus:'pending'}));
    return id;
  }
  function updateRun(id,patch) {
    const row=db.prepare('SELECT payload FROM warehouse_sync_runs WHERE id=?').get(id);
    if(!row)throw problem('同步批次不存在',404);
    const previous=JSON.parse(row.payload);
    const next={...previous,...patch,id,runId:id,businessDate:previous.businessDate,startedAt:previous.startedAt};
    if(patch.importedAt)next.snapshotHash=inventorySnapshotFingerprint(readCainiaoInventory(databasePath));
    db.prepare('UPDATE warehouse_sync_runs SET payload=? WHERE id=?').run(json(next),id);
  }
  function syncStatus() {
    const day=businessDate(now()), rows=db.prepare('SELECT payload FROM warehouse_sync_runs WHERE business_date=? ORDER BY started_at DESC,rowid DESC').all(day).map(r=>JSON.parse(r.payload));
    let inventory;
    try{inventory=readCainiaoInventory(databasePath);}catch{inventory={available:false};}
    const expected=expectedInventoryDate(now());
    const verified=r=>r.kind==='sync'&&r.sourceDate>=expected&&r.sourceDate<=day&&r.expectedSourceDate>=expected&&r.expectedSourceDate<=day&&r.sourceDate>=r.expectedSourceDate&&r.collectionStatus==='success'&&r.validationStatus==='success'&&r.deliveryStatus==='accepted'&&r.collectedAt&&r.validatedAt&&r.importedAt&&r.sentAt&&r.fileHash&&r.validationId&&inventory.available&&inventory.validation?.matchesSnapshot&&inventory.sourceDate===r.sourceDate&&inventory.skuCount===r.rowCount&&Math.abs(inventory.totalQuantity-r.totalQuantity)<0.001&&inventory.validation.id===r.validationId;
    const successful=rows.find(r=>verified(r)&&r.snapshotHash&&r.snapshotHash===inventorySnapshotFingerprint(inventory)),latest=rows[0];
    return {...(successful||latest||{collectionStatus:'pending',validationStatus:'pending',deliveryStatus:'pending'}),complete:Boolean(successful),runId:(successful||latest)?.id||'',expectedSourceDate:expected,lastAttempt:latest||null};
  }
  async function status(actor) {
    if(!actor?.id)throw problem('缺少已验证的工作台身份',401);
    return {businessDate:businessDate(now()),timeZone:'Asia/Shanghai',expectedSourceDate:expectedInventoryDate(now()),sync:syncStatus(),actor:{id:actor.id,login:actor.login,role:actor.role,local:Boolean(actor.local)},me:null,employees:[],team:{expected:0,checkedIn:0,completed:0,pending:0},config:{employees:[],autoRemind:false},channels:{},reminders:[]};
  }
  function removed(){throw problem('云仓签到功能已移除',410);}
  async function tick(){return {skipped:true,reason:'attendance-removed'};}
  return {beginRun,updateRun,status,configure:removed,action:removed,remind:removed,tick,close:()=>db.close()};
}
