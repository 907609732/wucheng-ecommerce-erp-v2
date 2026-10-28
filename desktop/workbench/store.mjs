import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';

export const digest=value=>createHash('sha256').update(value).digest('hex');
export function createGatewayStore(storeDir) {
  fs.mkdirSync(storeDir,{recursive:true,mode:0o700});
  // A separate SQLite file gives us an OS-backed process lock, automatically released on crash.
  // Never mark pending operations unknown or clean upload spools while another gateway is alive.
  const ownership=new DatabaseSync(path.join(storeDir,'gateway-ownership.sqlite'));
  try{ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}
  catch{ownership.close();throw Object.assign(Error('此工作台数据目录已有网关在运行'),{code:'GATEWAY_STORE_BUSY',statusCode:409,workbenchPublic:true});}
  try{return openGatewayStore(storeDir,ownership);}catch(error){ownership.close();throw error;}
}
function openGatewayStore(storeDir,ownership) {
  const identityFile=path.join(storeDir,'identity.json');
  try{fs.writeFileSync(identityFile,JSON.stringify({schemaVersion:1,serverId:randomUUID(),dataSetId:randomUUID()},null,2),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const identity=JSON.parse(fs.readFileSync(identityFile,'utf8'));
  if(identity.schemaVersion!==1||![identity.serverId,identity.dataSetId].every(s=>typeof s==='string'&&/^[\w-]{8,80}$/.test(s)))throw Error('工作台身份文件无效');
  const db=new DatabaseSync(path.join(storeDir,'gateway.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL,login TEXT NOT NULL,channel TEXT NOT NULL,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_modules(session_id TEXT NOT NULL,module TEXT NOT NULL,data_set_id TEXT NOT NULL,PRIMARY KEY(session_id,module));
    CREATE TABLE IF NOT EXISTS operations(operation_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT NOT NULL,status INTEGER,headers TEXT,body BLOB,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,request_id TEXT NOT NULL,actor_id TEXT NOT NULL,module TEXT NOT NULL,operation TEXT NOT NULL,outcome TEXT NOT NULL,details TEXT NOT NULL);`);
  // A crashed request might already have committed upstream; never replay it blindly.
  db.prepare("UPDATE operations SET state='unknown',updated_at=? WHERE state='pending'").run(Date.now());
  const api={...identity,db,
    session(token){return token?db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now()):null;},
    saveSession(token,s){db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(digest(token),s.sessionId,s.login,s.channel,s.csrfToken,s.expiresAt);},
    deleteSession(token){if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));},
    bindModule(sessionId,module,dataSetId){
      if(typeof dataSetId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(dataSetId))throw Object.assign(Error('模块尚未返回可验证的正式账本身份，请在主机检查数据和版本'),{statusCode:503,code:'MODULE_DATA_NOT_READY',workbenchPublic:true});
      db.prepare('INSERT OR IGNORE INTO session_modules(session_id,module,data_set_id) VALUES(?,?,?)').run(sessionId,module,dataSetId);
      const pinned=db.prepare('SELECT data_set_id FROM session_modules WHERE session_id=? AND module=?').get(sessionId,module);
      if(pinned.data_set_id!==dataSetId)throw Object.assign(Error('此模块的正式账本已更换，已停止本次会话；请联系管理员核对数据集'),{statusCode:409,code:'DATASET_CHANGED',workbenchPublic:true});
      return pinned.data_set_id;
    },
    audit(entry){db.prepare('INSERT INTO audit(at,request_id,actor_id,module,operation,outcome,details) VALUES(?,?,?,?,?,?,?)').run(Date.now(),entry.requestId||'',entry.actorId||'',entry.module||'',entry.operation||'',entry.outcome||'',JSON.stringify(entry.details||{}));},
    get(key){const r=db.prepare('SELECT * FROM operations WHERE operation_key=?').get(key);if(r){r.headers=r.headers?JSON.parse(r.headers):{};r.body=r.body?Buffer.from(r.body):Buffer.alloc(0);}return r;},
    begin(key,fingerprint,actor,requestId){db.prepare("INSERT INTO operations(operation_key,fingerprint,actor_id,session_id,state,request_id,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?)").run(key,fingerprint,actor.id,actor.sessionId,requestId,Date.now(),Date.now());},
    finish(key,{state='completed',status=200,headers={},body=Buffer.alloc(0)}={}){db.prepare('UPDATE operations SET state=?,status=?,headers=?,body=?,updated_at=? WHERE operation_key=?').run(state,status,JSON.stringify(headers),body,Date.now(),key);},
    close(){try{db.close();}finally{ownership.close();}}
  };
  return api;
}
