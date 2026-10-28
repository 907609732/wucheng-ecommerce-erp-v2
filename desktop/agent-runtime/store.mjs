import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {agentError} from './approval.mjs';

export function createAgentStore(directory,{now=Date.now}={}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const ownership=new DatabaseSync(path.join(directory,'agent-owner.sqlite'));
  try{ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{ownership.close();throw agentError('AGENT_STORE_BUSY','该任务中心已由另一进程运行',409);}
  let db;
  try{db=new DatabaseSync(path.join(directory,'agent-tasks.sqlite'));db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_task ON events(task_id,sequence);
    CREATE TABLE IF NOT EXISTS schedule_runs(schedule_id TEXT NOT NULL,occurrence TEXT NOT NULL,task_id TEXT,state TEXT NOT NULL,PRIMARY KEY(schedule_id,occurrence));
    CREATE TABLE IF NOT EXISTS effects(idempotency_key TEXT PRIMARY KEY,task_id TEXT NOT NULL,step_id TEXT NOT NULL,state TEXT NOT NULL,json TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  }catch(error){db?.close();ownership.close();throw error;}
  const parse=row=>row?JSON.parse(row.json):null;
  const api={directory,db,
    get:(kind,id)=>parse(db.prepare('SELECT json FROM entities WHERE kind=? AND id=?').get(kind,id)),
    list(kind,owner){return db.prepare('SELECT json FROM entities WHERE kind=?'+(owner?' AND owner=?':'')+' ORDER BY updated_at DESC').all(...(owner?[kind,owner]:[kind])).map(parse);},
    insert(kind,value){const record={...value,version:value.version||1};db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)').run(kind,record.id,record.ownerId||'',record.version,JSON.stringify(record),now());return record;},
    update(kind,id,change,{expectedVersion}={}){
      const current=api.get(kind,id);if(!current)throw agentError('AGENT_NOT_FOUND','任务或记录不存在',404);
      if(expectedVersion!==undefined&&current.version!==expectedVersion)throw agentError('AGENT_REVISION_CHANGED','记录已被更新，请重新加载',409);
      const next={...current,...(typeof change==='function'?change(current):change),id:current.id,ownerId:current.ownerId,version:current.version+1,updatedAt:now()};
      const updated=db.prepare('UPDATE entities SET json=?,version=?,updated_at=? WHERE kind=? AND id=? AND version=?').run(JSON.stringify(next),next.version,now(),kind,id,current.version);
      if(updated.changes!==1)throw agentError('AGENT_REVISION_CHANGED','记录已被另一请求更新',409);return next;
    },
    remove(kind,id){return db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind,id);},
    event(taskId,type,value={}){const at=now();const row=db.prepare('INSERT INTO events(task_id,type,json,at) VALUES(?,?,?,?)').run(taskId,type,JSON.stringify(value),at);return {sequence:Number(row.lastInsertRowid),taskId,type,at,...value};},
    events(taskId,after=0){return db.prepare('SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 500').all(taskId,Math.max(0,Number(after)||0)).map(r=>({sequence:r.sequence,taskId:r.task_id,type:r.type,at:r.at,...JSON.parse(r.json)}));},
    claimRun(scheduleId,occurrence,taskId){return db.prepare("INSERT OR IGNORE INTO schedule_runs VALUES(?,?,?,'queued')").run(scheduleId,occurrence,taskId).changes===1;},
    finishRun(scheduleId,occurrence,state){db.prepare('UPDATE schedule_runs SET state=? WHERE schedule_id=? AND occurrence=?').run(state,scheduleId,occurrence);},
    runs(scheduleId){return db.prepare('SELECT schedule_id AS scheduleId,occurrence,task_id AS taskId,state FROM schedule_runs WHERE schedule_id=? ORDER BY occurrence DESC LIMIT 100').all(scheduleId);},
    effect(key){const row=db.prepare('SELECT * FROM effects WHERE idempotency_key=?').get(key);return row?{...JSON.parse(row.json),state:row.state}:null;},
    beginEffect(key,taskId,stepId,value){return db.prepare("INSERT OR IGNORE INTO effects VALUES(?,?,?,'committing',?,?)").run(key,taskId,stepId,JSON.stringify(value),now()).changes===1;},
    finishEffect(key,state,value){db.prepare('UPDATE effects SET state=?,json=?,updated_at=? WHERE idempotency_key=?').run(state,JSON.stringify(value),now(),key);},
    transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();if(result?.then)throw Error('Agent store transaction must be synchronous');db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
    close(){try{db.close();}finally{ownership.close();}}
  };
  // The engine may have stopped after an upstream write. Never replay those effects.
  db.prepare("UPDATE effects SET state='unknown',updated_at=? WHERE state='committing'").run(now());
  for(const usage of api.list('usage'))if(usage.state==='pending')api.update('usage',usage.id,{state:'unknown',reason:'host_restarted',finishedAt:now()});
  for(const task of api.list('task')){
    if(['running','queued'].includes(task.status))api.update('task',task.id,{status:'paused',pauseReason:'host_restarted'});
    if(task.status==='committing')api.update('task',task.id,{status:'unknown',pauseReason:'verify_receipt_after_restart'});
  }
  return api;
}
