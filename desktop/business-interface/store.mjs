import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

export function openBusinessReviewStore(directory,{now=Date.now}={}){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 for(let cursor=path.resolve(directory);;cursor=path.dirname(cursor)){if(fs.lstatSync(cursor).isSymbolicLink())throw Error('业务复核目录不能使用链接');if(path.dirname(cursor)===cursor)break;}
 const file=path.join(directory,'business-reviews.sqlite');
 if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('业务复核文件不能使用链接');
 const db=new DatabaseSync(file);db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS business_records(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));");
 const get=(kind,id)=>{const row=db.prepare('SELECT payload FROM business_records WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.payload):null;};
 const insert=(kind,input)=>{const value={...input,id:input.id||randomUUID(),version:1,createdAt:now(),updatedAt:now()};db.prepare('INSERT INTO business_records VALUES(?,?,?,?)').run(kind,value.id,value.version,JSON.stringify(value));return value;};
 function update(kind,id,patch,{expectedVersion}={}){
  db.exec('BEGIN IMMEDIATE');try{const old=get(kind,id);if(!old||expectedVersion!==undefined&&old.version!==expectedVersion)throw Object.assign(Error('业务复核版本已变化，请重新查看'),{code:'REVIEW_STALE',statusCode:409});const value={...old,...patch,id,version:old.version+1,updatedAt:now()};const changed=db.prepare('UPDATE business_records SET version=?,payload=? WHERE kind=? AND id=? AND version=?').run(value.version,JSON.stringify(value),kind,id,old.version);if(changed.changes!==1)throw Error('业务复核版本冲突');db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}
 }
 const list=(kind,{state,limit,offset=0}={})=>{
  const filter=state?" AND json_extract(payload, '$.state')=?":"";
  const bounded=Number.isSafeInteger(limit)?' LIMIT ? OFFSET ?':'';
  return db.prepare('SELECT payload FROM business_records WHERE kind=?'+filter+' ORDER BY rowid DESC'+bounded).all(kind,...(state?[state]:[]),...(bounded?[limit,offset]:[])).map(row=>JSON.parse(row.payload));
 };
 const summary=kind=>{const row=db.prepare("SELECT count(*) AS total, coalesce(sum(json_extract(payload,'$.state')='awaiting_review'),0) AS pendingCount FROM business_records WHERE kind=?").get(kind);return {total:row.total,pendingCount:row.pendingCount};};
 const count=(kind,state)=>db.prepare("SELECT count(*) AS total FROM business_records WHERE kind=? AND json_extract(payload,'$.state')=?").get(kind,state).total;
 return {get,insert,update,list,summary,count,close:()=>db.close()};
}
