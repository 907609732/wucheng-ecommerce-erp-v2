import {openMonthAdmin} from '../../../shared/month-admin.mjs';
import {randomBytes,scrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {importRules,isStoredPlatform} from '../public/import-rules.mjs';
const derive=promisify(scrypt),cost={N:32768,r:8,p:3,maxmem:64*1024*1024};
const passwordKey='month-admin-password';
const failure=(message,code,status=400,extra={})=>Object.assign(Error(message),{code,status,...extra});
export const purchaseMonth=o=>(o.paidAt||o.date).slice(0,7);
export function confirmationTiming(month,now=Date.now()){
 if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw failure('请选择有效的月份','INVALID_MONTH_SCOPE');
 const [year,number]=month.split('-').map(Number),nextYear=year+(number===12?1:0),nextMonth=number===12?1:number+1;
 const availableOn=String(nextYear).padStart(4,'0')+'-'+String(nextMonth).padStart(2,'0')+'-15';
 // Beijing midnight on the 15th of the following month, independent of the host timezone.
 const availableAt=new Date(0);availableAt.setUTCFullYear(nextYear,nextMonth-1,15);availableAt.setUTCHours(-8,0,0,0);
 return {canConfirm:now>=availableAt.getTime(),availableOn,availableAt:availableAt.toISOString(),timeZone:'Asia/Shanghai'};
}

export function openMonthLocks(db,{list,transaction,dataDir}){
 db.exec(`CREATE TABLE IF NOT EXISTS month_confirmations(month TEXT NOT NULL,platform TEXT NOT NULL,confirmed_at TEXT NOT NULL,snapshot_json TEXT NOT NULL,change_count INTEGER NOT NULL DEFAULT 0,last_modified_at TEXT,PRIMARY KEY(month,platform));
 CREATE TABLE IF NOT EXISTS month_events(id INTEGER PRIMARY KEY AUTOINCREMENT,month TEXT,platform TEXT,action TEXT NOT NULL,order_id TEXT,batch_id TEXT,details_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);`);
 const getSetting=key=>db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
 const event=(action,details={},month=null,platform=null)=>db.prepare('INSERT INTO month_events(month,platform,action,details_json,created_at) VALUES (?,?,?,?,?)').run(month,platform,action,JSON.stringify(details),new Date().toISOString());
 // Enforce the lock at the database write boundary, including maintenance scripts.
 const matches=alias=>`platform=${alias}.platform AND month=substr(CASE WHEN ${alias}.paid_at<>'' THEN ${alias}.paid_at ELSE ${alias}.date END,1,7)`;
 transaction(()=>{for(const [operation,condition] of [['INSERT',matches('NEW')],['UPDATE',`(${matches('OLD')}) OR (${matches('NEW')})`],['DELETE',matches('OLD')]]){
  db.exec(`DROP TRIGGER IF EXISTS month_lock_${operation.toLowerCase()};
   DROP TRIGGER IF EXISTS month_audit_${operation.toLowerCase()};
   CREATE TRIGGER month_lock_${operation.toLowerCase()} BEFORE ${operation} ON orders
   WHEN EXISTS(SELECT 1 FROM month_confirmations WHERE ${condition})
   BEGIN SELECT RAISE(ABORT,'MONTH_LOCKED'); END;`);
 }});
 const admin=openMonthAdmin({dataDir,legacy:{configured:()=>!!getSetting(passwordKey),verify:async password=>{const saved=JSON.parse(getSetting(passwordKey)),valid=typeof password==='string'&&password.length>=8&&password.length<=128,key=await derive(valid?password:'invalid-password',saved.salt,64,cost);return valid&&timingSafeEqual(key,Buffer.from(saved.hash,'hex'));}}});
 const configured=admin.configured;
 const verify=async password=>{const version=admin.status().passwordVersion;if(!await admin.verify(password))throw failure('管理员密码不正确','ADMIN_PASSWORD_INVALID',403);if(admin.status().passwordVersion!==version)throw failure('管理员密码已更新','ADMIN_PASSWORD_CHANGED',409);return version;};
 const checkVersion=version=>{if(admin.status().passwordVersion!==version)throw failure('管理员密码已更新，请重新验证','ADMIN_PASSWORD_CHANGED',409);};
 const reasonRequired=reason=>{if(typeof reason!=='string'||!reason.trim())throw failure('请填写解锁原因','UNLOCK_REASON_REQUIRED');return reason.trim().slice(0,2000);};
 const confirmations=()=>db.prepare("SELECT c.*, (SELECT MAX(id) FROM month_events e WHERE e.month=c.month AND e.platform=c.platform AND e.action='confirm') AS confirmation_version FROM month_confirmations c ORDER BY month DESC,platform").all().map(r=>({month:r.month,platform:r.platform,version:String(r.confirmation_version||r.confirmed_at),confirmedAt:r.confirmed_at,snapshot:JSON.parse(r.snapshot_json),changeCount:r.change_count,lastModifiedAt:r.last_modified_at}));
 function assertWritable(orders){
  const keys=new Set(orders.filter(Boolean).map(o=>o.platform+'|'+purchaseMonth(o))),locks=confirmations().filter(c=>keys.has(c.platform+'|'+c.month)).map(({month,platform})=>({month,platform}));
  if(locks.length)throw failure('该月份的平台采购数据已锁定，请先到「月度确认」取消确认后再修改。','MONTH_LOCKED',423,{locks});
 }
 function validateScope(month,platform){if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!isStoredPlatform(platform))throw failure('请选择有效的月份和采购平台','INVALID_MONTH_SCOPE');}
 function preview(month,platform){
  validateScope(month,platform);const orders=list().filter(o=>o.platform===platform&&purchaseMonth(o)===month);
  return {month,platform,...confirmationTiming(month),count:orders.length,amountCents:orders.reduce((n,o)=>n+o.amountCents,0),refundCents:orders.reduce((n,o)=>n+o.refundCents,0),reviewCount:orders.filter(o=>o.status==='待核对').length,missingPaidCount:orders.filter(o=>!o.paidAt).length,revision:createHash('sha256').update(JSON.stringify(orders.map(o=>[o.id,o.updatedAt]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex')};
 }
 // These contexts are supplied by verified UI requests or the central commit
 // service, never copied from a request body. Never include password material in audit.
 function checkedReview(review){
  if(!review?.actorId||!['workbench-ui-review','agent-central-review'].includes(review.authorization))throw failure('需要本次真实登录人员的复核记录','MONTH_REVIEW_REQUIRED',403);
  if(review.authorization==='workbench-ui-review'&&(!review.sessionId||!review.requestId)||review.authorization==='agent-central-review'&&!review.approvalId)throw failure('复核记录不完整','MONTH_REVIEW_REQUIRED',403);
  return Object.fromEntries(['authorization','actorId','actorLabel','sessionId','requestId','approvalId'].filter(key=>review[key]!==undefined).map(key=>[key,review[key]]));
 }
 function confirmReviewed(entries,review){
  if(!configured())throw failure('请先设置统一管理员密码','ADMIN_NOT_CONFIGURED',409);
  const authorization=checkedReview(review);
  if(!Array.isArray(entries)||!entries.length||entries.length>10000)throw failure('请选择需要锁定的月份和平台','INVALID_MONTH_SCOPE');
  if(new Set(entries.map(c=>c.month+'|'+c.platform)).size!==entries.length)throw failure('锁定范围重复','INVALID_MONTH_SCOPE');
  return transaction(()=>{
   const rows=entries.map(({month,platform,revision,zero=false})=>{
    const current=preview(month,platform);current.zeroConfirmed=zero;if(zero&&current.amountCents>0)throw failure('存在正数采购金额，不能确认零采购','ZERO_HAS_BUSINESS',409);
    if(current.revision!==revision)throw failure('预览后订单已变化，请重新核对','MONTH_CHANGED',409);
    if(confirmations().some(c=>c.month===month&&c.platform===platform))throw failure('确认状态已变化，请刷新','MONTH_ALREADY_CONFIRMED',409);
    if(!current.canConfirm)throw failure(`${month} 需到北京时间 ${current.availableOn} 00:00 后确认`,'MONTH_CONFIRMATION_TOO_EARLY',403,{availableOn:current.availableOn,availableAt:current.availableAt});
    return current;
   }),batchId=randomBytes(16).toString('hex');
   for(const row of rows){
    db.prepare('INSERT INTO month_confirmations(month,platform,confirmed_at,snapshot_json) VALUES(?,?,?,?)').run(row.month,row.platform,new Date().toISOString(),JSON.stringify(row));
    event('confirm',{...row,...authorization,batchId},row.month,row.platform);db.prepare('UPDATE month_events SET batch_id=? WHERE id=last_insert_rowid()').run(batchId);
   }
   return {confirmed:rows.length,batchId};
  });
 }
 async function cancelReviewed(entries,review){
  const reason=reasonRequired(review?.reason),credentialVersion=await verify(review?.password);
  const authorization=checkedReview(review);
  if(!Array.isArray(entries)||!entries.length||entries.length>10000)throw failure('请选择需要解锁的月份和平台','INVALID_MONTH_SCOPE');
  if(new Set(entries.map(c=>c.month+'|'+c.platform)).size!==entries.length)throw failure('解锁范围重复','INVALID_MONTH_SCOPE');
  return transaction(()=>{
   checkVersion(credentialVersion);
   const rows=entries.map(({month,platform,version})=>{
    validateScope(month,platform);const before=confirmations().find(c=>c.month===month&&c.platform===platform);
    if(!before||typeof version!=='string'||version!==before.version)throw failure('确认状态已变化，请重新核对','MONTH_CONFIRMATION_CHANGED',409);
    return before;
   }),batchId=randomBytes(16).toString('hex');
   for(const before of rows){
    event('cancel',{confirmationVersion:before.version,confirmedAt:before.confirmedAt,snapshot:before.snapshot,current:preview(before.month,before.platform),...authorization,reason,batchId},before.month,before.platform);
    db.prepare('UPDATE month_events SET batch_id=? WHERE id=last_insert_rowid()').run(batchId);
    db.prepare('DELETE FROM month_confirmations WHERE month=? AND platform=?').run(before.month,before.platform);
   }
   return {cancelled:rows.length,batchId,scopes:rows.map(({month,platform})=>({month,platform}))};
  });
 }
 return {
  configured,confirmations,preview,assertWritable,adminStatus:admin.status,close:admin.close,
  confirmWithReview(input,review){confirmReviewed([input],review);return confirmations().find(c=>c.month===input.month&&c.platform===input.platform);},
  confirmBatchWithReview:confirmReviewed,
  async cancelWithReview(input,review){const result=await cancelReviewed([input],{...review,password:input.password,reason:input.reason});return {...result,month:input.month,platform:input.platform,cancelled:true};},
  cancelBatchWithReview:(entries,review,auth={})=>cancelReviewed(entries,{...review,...auth}),
  overview(month){return {month,...confirmationTiming(month),basis:'paid',adminConfigured:configured(),platforms:Object.keys(importRules).map(platform=>({...preview(month,platform),confirmation:confirmations().find(c=>c.month===month&&c.platform===platform)||null}))};},
  confirm({month,platform,revision,zero=false}){return transaction(()=>{
   if(!configured())throw failure('请先在数据与备份设置管理员密码','ADMIN_NOT_CONFIGURED',409);
   const current=preview(month,platform);current.zeroConfirmed=zero;if(zero&&current.amountCents>0)throw failure('存在正数采购金额，不能确认零采购','ZERO_HAS_BUSINESS',409);if(current.revision!==revision)throw failure('预览后订单已变化，请重新核对本月数据','MONTH_CHANGED',409);
   if(db.prepare('SELECT 1 FROM month_confirmations WHERE month=? AND platform=?').get(month,platform))throw failure('该月该平台已经确认','MONTH_ALREADY_CONFIRMED',409);
   if(!current.canConfirm)throw failure(`${month} 的采购数据需到北京时间 ${current.availableOn} 00:00 后才能确认锁定`,'MONTH_CONFIRMATION_TOO_EARLY',403,{availableOn:current.availableOn,availableAt:current.availableAt});
   db.prepare('INSERT INTO month_confirmations(month,platform,confirmed_at,snapshot_json) VALUES (?,?,?,?)').run(month,platform,new Date().toISOString(),JSON.stringify(current));event('confirm',current,month,platform);
   return confirmations().find(c=>c.month===month&&c.platform===platform);
  });},
  confirmBatch({confirmations:entries}){return transaction(()=>{
   if(!configured())throw failure('请先设置管理员密码','ADMIN_NOT_CONFIGURED',409);
   if(!Array.isArray(entries)||!entries.length||entries.length>10000)throw failure('请选择需要锁定的月份和平台','INVALID_MONTH_SCOPE');
   if(new Set(entries.map(c=>c.month+'|'+c.platform)).size!==entries.length)throw failure('锁定范围重复','INVALID_MONTH_SCOPE');
   const rows=entries.map(({month,platform,revision,zero=false})=>{
    const current=preview(month,platform);current.zeroConfirmed=zero;if(zero&&current.amountCents>0)throw failure('存在正数采购金额，不能确认零采购','ZERO_HAS_BUSINESS',409);
    if(current.revision!==revision)throw failure('预览后订单已变化，请重新核对','MONTH_CHANGED',409);
    if(confirmations().some(c=>c.month===month&&c.platform===platform))throw failure('确认状态已变化，请刷新','MONTH_ALREADY_CONFIRMED',409);
    if(!current.canConfirm)throw failure(`${month} 尚未到确认时间`,'MONTH_CONFIRMATION_TOO_EARLY',403);
    return current;
   });
   const batchId=randomBytes(16).toString('hex');
   for(const row of rows){
    db.prepare('INSERT INTO month_confirmations(month,platform,confirmed_at,snapshot_json) VALUES(?,?,?,?)').run(row.month,row.platform,new Date().toISOString(),JSON.stringify(row));
    event('confirm',row,row.month,row.platform);db.prepare('UPDATE month_events SET batch_id=? WHERE id=last_insert_rowid()').run(batchId);
   }
   return {confirmed:rows.length,batchId};
  });},
  // Agent review cannot substitute for an interactive password verification.
  cancelWithAgentReview(){throw failure('请在真实登录界面验证统一管理员密码并填写原因后解锁','MONTH_UI_PASSWORD_REQUIRED',403);},
  history(month,platform){validateScope(month,platform);return db.prepare('SELECT * FROM month_events WHERE month=? AND platform=? ORDER BY id DESC').all(month,platform).map(r=>({id:r.id,action:r.action,orderId:r.order_id,batchId:r.batch_id,details:JSON.parse(r.details_json),createdAt:r.created_at}));},
  setPassword:admin.setPassword,
  async cancelBatch({confirmations:entries,password,reason}){
   reason=reasonRequired(reason);
   if(!Array.isArray(entries)||!entries.length||entries.length>10000)throw failure('请选择需要解锁的月份和平台','INVALID_MONTH_SCOPE');
   const scopes=entries.map(({month,platform,version})=>{validateScope(month,platform);return {month,platform,version};});
   if(new Set(scopes.map(c=>c.month+'|'+c.platform)).size!==scopes.length)throw failure('解锁范围重复','INVALID_MONTH_SCOPE');
   const current=()=>scopes.map(scope=>{const c=confirmations().find(c=>c.month===scope.month&&c.platform===scope.platform);if(!c||typeof scope.version!=='string'||c.version!==scope.version)throw failure('月度确认状态已变化，请刷新后重新操作','MONTH_CONFIRMATION_CHANGED',409);return c;});
   current();const record=await verify(password);
   return transaction(()=>{
    checkVersion(record);
    const rows=current(),batchId=randomBytes(16).toString('hex');
    for(const before of rows){
     event('cancel',{confirmationVersion:before.version,confirmedAt:before.confirmedAt,snapshot:before.snapshot,current:preview(before.month,before.platform),changeCount:before.changeCount,reason,batchId},before.month,before.platform);
     db.prepare('UPDATE month_events SET batch_id=? WHERE id=last_insert_rowid()').run(batchId);
     db.prepare('DELETE FROM month_confirmations WHERE month=? AND platform=?').run(before.month,before.platform);
    }
    return {cancelled:rows.length,batchId,scopes:scopes.map(({month,platform})=>({month,platform}))};
   });
  },
  async cancel({month,platform,version,password,reason}){
   reason=reasonRequired(reason);
   validateScope(month,platform);
   const current=()=>{const c=confirmations().find(c=>c.month===month&&c.platform===platform);if(!c||typeof version!=='string'||c.version!==version)throw failure('月度确认状态已变化，请刷新后重新操作','MONTH_CONFIRMATION_CHANGED',409);return c;};
   current();const record=await verify(password);
   return transaction(()=>{
    checkVersion(record);
    const before=current();event('cancel',{confirmationVersion:before.version,confirmedAt:before.confirmedAt,snapshot:before.snapshot,current:preview(month,platform),changeCount:before.changeCount,reason},month,platform);
    db.prepare('DELETE FROM month_confirmations WHERE month=? AND platform=?').run(month,platform);
    return {month,platform,cancelled:true};
   });
  }
 };
}
