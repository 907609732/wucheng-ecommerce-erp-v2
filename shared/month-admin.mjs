import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const derive=promisify(scrypt),cost={N:32768,r:8,p:3,maxmem:64*1024*1024};
const fail=(message,code,status=400)=>Object.assign(Error(message),{code,status});
export function openMonthAdmin({dataDir,legacy}={}){
 const dir=process.env.LINGTU_MONTH_ADMIN_DIR||dataDir;if(!dir)throw Error('Month administrator data directory required');fs.mkdirSync(dir,{recursive:true});
 const db=new DatabaseSync(path.join(dir,'month-admin.sqlite'));db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS credentials(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT,failures INTEGER NOT NULL DEFAULT 0,until INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO credentials(id) VALUES(1)");
 if(!db.prepare('PRAGMA table_info(credentials)').all().some(c=>c.name==='version'))db.exec('ALTER TABLE credentials ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
 const legacyFile=process.env.LINGTU_MONTH_ADMIN_LEGACY_PURCHASE_DIR&&path.join(process.env.LINGTU_MONTH_ADMIN_LEGACY_PURCHASE_DIR,'purchases.sqlite');
 if(legacyFile&&fs.existsSync(legacyFile)){const oldDb=new DatabaseSync(legacyFile,{readOnly:true});try{const old=oldDb.prepare("SELECT value FROM settings WHERE key='month-admin-password'").get()?.value;if(old){const saved=JSON.parse(old);legacy={configured:()=>true,verify:async password=>{const valid=typeof password==='string'&&password.length>=8&&password.length<=128;const key=await derive(valid?password:'invalid-password',saved.salt,64,cost);return valid&&timingSafeEqual(key,Buffer.from(saved.hash,'hex'));}};}}finally{oldDb.close();}}
 const row=()=>db.prepare('SELECT * FROM credentials WHERE id=1').get();
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const configured=()=>!!row().record;
 const status=()=>{const r=row();return {passwordVersion:r.version,configured:!!r.record,adminConfigured:!!r.record,legacyRequired:!r.record&&!!legacy?.configured?.(),failedAttempts:r.failures,lockedUntil:r.until};};
 async function verify(password){const initial=row();if(!initial.record)throw fail('请先设置统一管理员密码','ADMIN_NOT_CONFIGURED',409);if(initial.until>Date.now())throw fail('密码错误次数过多，请一分钟后重试','ADMIN_RATE_LIMIT',429);
 const saved=JSON.parse(initial.record),valid=typeof password==='string'&&password.length>=8&&password.length<=128,key=await derive(valid?password:'invalid-password',saved.salt,64,cost),matches=valid&&timingSafeEqual(key,Buffer.from(saved.hash,'hex'));
 return tx(()=>{const current=row();if(current.record!==initial.record)throw fail('管理员密码已更新，请重新验证','ADMIN_PASSWORD_CHANGED',409);if(current.until>Date.now())throw fail('密码错误次数过多，请一分钟后重试','ADMIN_RATE_LIMIT',429);const failures=matches?0:(current.until?0:current.failures)+1;db.prepare('UPDATE credentials SET failures=?,until=? WHERE id=1').run(failures>=5?0:failures,failures>=5?Date.now()+60000:0);return !!matches;});}
 async function setPassword({password,confirmation,currentPassword,legacyPassword}={}){if(typeof password!=='string'||password.length<8||password.length>128)throw fail('管理员密码需为 8–128 位','PASSWORD_FORMAT');if(password!==confirmation)throw fail('两次输入的新密码不一致','PASSWORD_MISMATCH');const prior=row().record;if(prior){if(!await verify(currentPassword))throw fail('管理员密码不正确','ADMIN_PASSWORD_INVALID',403);}else if(legacy?.configured?.()){if(!legacyPassword)throw fail('请验证旧采购管理员密码后迁移','LEGACY_PASSWORD_REQUIRED',409);const state=row();if(state.until>Date.now())throw fail('密码错误次数过多，请一分钟后重试','ADMIN_RATE_LIMIT',429);if(!await legacy.verify(legacyPassword)){tx(()=>{const r=row(),n=(r.until?0:r.failures)+1;db.prepare('UPDATE credentials SET failures=?,until=? WHERE id=1').run(n>=5?0:n,n>=5?Date.now()+60000:0);});throw fail('旧管理员密码不正确','ADMIN_PASSWORD_INVALID',403);}}
 const salt=randomBytes(16).toString('hex'),key=await derive(password,salt,64,cost),record=JSON.stringify({algorithm:'scrypt',salt,hash:key.toString('hex')});return tx(()=>{if(row().record!==prior)throw fail('密码设置已变化，请重新操作','ADMIN_PASSWORD_CHANGED',409);db.prepare('UPDATE credentials SET record=?,failures=0,until=0,version=version+1 WHERE id=1').run(record);return status();});}
 return {configured,status,setPassword,verify,close:()=>db.close()};
}
