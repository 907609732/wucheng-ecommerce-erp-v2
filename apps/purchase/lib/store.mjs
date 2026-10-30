import {createPurchaseActorContext} from './actor-context.mjs';
import {openOrderAttachments} from './order-attachments.mjs';
import {preserveShipments} from '../public/shipments.mjs';
import {openAuditLog} from './audit-log.mjs';
import {openMonthLocks} from './month-locks.mjs';
import {attributePatch,includedInSpend} from '../public/order-attributes.mjs';
import {notImportedOrder} from './import-review.mjs';
import {normalizeClassification,defaultClassification,classificationTotals,contribution,hasCategory} from '../public/classification.mjs';
import {DatabaseSync,backup} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateOrder,deliveryOf,deliveryFromOriginal,fingerprint,backfillItemUnits,accountFromOriginal} from './importer.mjs';
import {supplementFields} from './taobao-supplement.mjs';
import {importRules} from '../public/import-rules.mjs';

export function openStore(dir){
 fs.mkdirSync(dir,{recursive:true});for(const folder of ['originals','staging','backups'])fs.mkdirSync(path.join(dir,folder),{recursive:true});
 const db=new DatabaseSync(path.join(dir,'purchases.sqlite')),actors=createPurchaseActorContext(),auditActor=actors.json;
 db.function('purchase_admin_allowed',()=>0);db.function('purchase_admin_batch',()=> '');
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, order_no TEXT NOT NULL, date TEXT NOT NULL, paid_at TEXT NOT NULL, supplier TEXT NOT NULL, status TEXT NOT NULL, amount_cents INTEGER NOT NULL, refund_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL, note TEXT NOT NULL, items TEXT NOT NULL, fingerprint TEXT NOT NULL, source_id TEXT, original TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(platform,account,order_no));
 CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, filename TEXT NOT NULL, hash TEXT NOT NULL, file_path TEXT, created_at TEXT NOT NULL, imported INTEGER NOT NULL, skipped INTEGER NOT NULL, line_count INTEGER NOT NULL, metadata TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 if(!db.prepare('PRAGMA table_info(audit)').all().some(c=>c.name==='actor_json'))db.exec("ALTER TABLE audit ADD COLUMN actor_json TEXT NOT NULL DEFAULT 'null'");
 db.exec(`CREATE TABLE IF NOT EXISTS order_supplements(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL REFERENCES orders(id),source_id TEXT NOT NULL REFERENCES imports(id),raw_json TEXT NOT NULL,fields_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(order_id,source_id));`);
 db.exec(`CREATE TABLE IF NOT EXISTS order_fingerprint_compat(order_id TEXT PRIMARY KEY,stored_fingerprint TEXT NOT NULL,canonical_fingerprint TEXT NOT NULL)`);
 db.exec(`CREATE TABLE IF NOT EXISTS order_origins(order_id TEXT PRIMARY KEY,channel TEXT NOT NULL,username TEXT NOT NULL DEFAULT '')`);
 const originOf=r=>{
  const origin=db.prepare('SELECT channel,username FROM order_origins WHERE order_id=?').get(r.id);
  const source=r.source_id?db.prepare('SELECT filename,metadata FROM imports WHERE id=?').get(r.source_id):null;
  const channel=origin?.channel||(source?(JSON.parse(source.metadata||'{}').method==='ocr'?'desktop':'spreadsheet'):'desktop');
  return {sourceChannel:channel,sourceFilename:source?.filename||'',uploadedBy:origin?.username||(()=>{const record=db.prepare("SELECT actor_json FROM audit WHERE order_id=? AND action='create' ORDER BY id LIMIT 1").get(r.id);const actor=JSON.parse(record?.actor_json||'null');return actor?.label||actor?.login||actor?.id||'';})(),sourceLabel:(channel==='mobile'?'手机上传':channel==='order-transfer'?'历史订单核对导入':channel==='spreadsheet'?'表格导入':'电脑人工录入 / 上传')+(source?' · '+source.filename:'')};
 };
 let attachments;
 const decode=r=>r?({id:r.id,platform:r.platform,account:r.account,orderNo:r.order_no,date:r.date,paidAt:r.paid_at,supplier:r.supplier,status:r.status,excludedFromSpend:!!r.excluded_from_spend,amountCents:r.amount_cents,refundCents:r.refund_cents,shippingCents:r.shipping_cents,note:r.note,classification:r.classification?JSON.parse(r.classification):defaultClassification(),...deliveryOf(JSON.parse(r.delivery||'{}')),supplierContact:JSON.parse(r.supplier_contact||'null'),attachmentIds:attachments?.ids(r.id)||[],items:JSON.parse(r.items),fingerprint:db.prepare('SELECT canonical_fingerprint FROM order_fingerprint_compat WHERE order_id=? AND stored_fingerprint=?').get(r.id,r.fingerprint)?.canonical_fingerprint||r.fingerprint,sourceId:r.source_id,...originOf(r),createdAt:r.created_at,updatedAt:r.updated_at}):null;
 if(!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='delivery')){
  db.exec('BEGIN IMMEDIATE');
  try{
   db.exec("ALTER TABLE orders ADD COLUMN delivery TEXT NOT NULL DEFAULT '{}'");
   const write=db.prepare('UPDATE orders SET delivery=?,fingerprint=? WHERE id=?');
   for(const row of db.prepare('SELECT * FROM orders').all()){
    const delivery=deliveryFromOriginal(JSON.parse(row.original));
    write.run(JSON.stringify(delivery),fingerprint({...decode(row),...delivery}),row.id);
   }
   db.exec('PRAGMA user_version=2; COMMIT');
  }catch(e){db.exec('ROLLBACK');db.close();throw e;}
 }
 if(db.prepare('PRAGMA user_version').get().user_version<3){
  db.exec('BEGIN IMMEDIATE');
  try{
   const write=db.prepare('UPDATE orders SET items=?,fingerprint=? WHERE id=?');
   for(const row of db.prepare('SELECT * FROM orders').all()){
    const order=decode(row),items=backfillItemUnits(order.items,JSON.parse(row.original));
    write.run(JSON.stringify(items),fingerprint({...order,items}),row.id);
   }
   db.exec('PRAGMA user_version=3; COMMIT');
  }catch(e){db.exec('ROLLBACK');db.close();throw e;}
 }
 if(db.prepare('PRAGMA user_version').get().user_version<4){
  db.exec('BEGIN IMMEDIATE');
  try{
   const report={updated:0,conflicts:0,missing:0};
   for(const row of db.prepare("SELECT * FROM orders WHERE platform='1688' AND (account='默认账号' OR trim(account)='')").all()){
    const account=accountFromOriginal(JSON.parse(row.original));if(!account||account==='默认账号'||account.length>200){report.missing++;continue;}
    if(db.prepare('SELECT id FROM orders WHERE platform=? AND account=? AND order_no=? AND id<>?').get(row.platform,account,row.order_no,row.id)){report.conflicts++;continue;}
    const before=decode(row),now=new Date(Math.max(Date.now(),Date.parse(row.updated_at)+1)).toISOString(),after={...before,account,updatedAt:now};after.fingerprint=fingerprint(after);
    db.prepare('UPDATE orders SET account=?,fingerprint=?,updated_at=? WHERE id=?').run(account,after.fingerprint,now,row.id);
    db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,actor_json) VALUES (?,?,?,?,?,?)').run(row.id,'backfill-account',JSON.stringify(before),JSON.stringify(after),now,auditActor());report.updated++;
   }
   db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('account-backfill-report',JSON.stringify(report));
   db.exec('PRAGMA user_version=4; COMMIT');
  }catch(e){db.exec('ROLLBACK');db.close();throw e;}
 }

 if(!db.prepare('PRAGMA table_info(audit)').all().some(c=>c.name==='batch_id'))db.exec('ALTER TABLE audit ADD COLUMN batch_id TEXT');
 if(!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='classification')){
  db.exec('BEGIN IMMEDIATE');
  try{
   db.exec(`ALTER TABLE orders ADD COLUMN classification TEXT NOT NULL DEFAULT '{"mode":"single","category":"goods","owner":"company"}'`);
   const batchId=randomUUID(),now=new Date().toISOString();
   for(const row of db.prepare('SELECT * FROM orders').all()){
    const after=decode(row),before={...after};delete before.classification;
    db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,batch_id,actor_json) VALUES (?,?,?,?,?,?,?)').run(row.id,'initialize-classification',JSON.stringify(before),JSON.stringify(after),now,batchId,auditActor());
   }
   db.exec('PRAGMA user_version=5; COMMIT');
  }catch(e){db.exec('ROLLBACK');db.close();throw e;}
 }
 // Default preserves all existing status-based totals, including confirmed months.
 // ALTER adds a default without updating order rows, fingerprints or lock revisions.
 if(!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='excluded_from_spend')){
  db.exec('ALTER TABLE orders ADD COLUMN excluded_from_spend INTEGER NOT NULL DEFAULT 0 CHECK(excluded_from_spend IN (0,1))');
 }
 // v6 uses a compatibility index: even locked order rows remain byte-for-byte unchanged.
 // Only use a mapping while its original stored fingerprint still matches the order.
 if(db.prepare('PRAGMA user_version').get().user_version<6){
  db.exec('BEGIN IMMEDIATE');
  try{
   const write=db.prepare('INSERT OR REPLACE INTO order_fingerprint_compat(order_id,stored_fingerprint,canonical_fingerprint) VALUES (?,?,?)');
   for(const row of db.prepare('SELECT * FROM orders').all()){
    const next=fingerprint(decode(row));
    if(row.fingerprint===next)continue;
    write.run(row.id,row.fingerprint,next);
   }
   db.exec('PRAGMA user_version=6; COMMIT');
  }catch(e){db.exec('ROLLBACK');db.close();throw e;}
 }
 if(!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='supplier_contact'))db.exec("ALTER TABLE orders ADD COLUMN supplier_contact TEXT NOT NULL DEFAULT 'null'");
 const list=()=>db.prepare('SELECT * FROM orders ORDER BY date DESC, created_at DESC').all().map(decode);
 const get=id=>decode(db.prepare('SELECT * FROM orders WHERE id=?').get(id));
 const find=o=>{
  const exact=decode(db.prepare('SELECT * FROM orders WHERE platform=? AND account=? AND order_no=?').get(o.platform,o.account,o.orderNo));
  if(exact)return exact;
  const aliases=db.prepare("SELECT DISTINCT o.* FROM orders o JOIN audit a ON a.order_id=o.id WHERE json_extract(a.before_json,'$.platform')=? AND json_extract(a.before_json,'$.account')=? AND json_extract(a.before_json,'$.orderNo')=? AND a.action IN ('update','attributes','rollback')").all(o.platform,o.account,o.orderNo);
  if(aliases.length>1)throw Error('订单历史对应多个采购账号，请核对后导入');
  if(aliases.length)return decode(aliases[0]);
  if(o.platform!=='淘宝'||!['默认账号','待补充'].includes(o.account))return null;
  // A legacy export can still carry the placeholder account from before enrichment.
  const rows=db.prepare("SELECT o.*,a.before_json FROM orders o JOIN audit a ON a.order_id=o.id WHERE o.platform=? AND o.order_no=? AND a.action='supplement-source'").all(o.platform,o.orderNo).filter(r=>JSON.parse(r.before_json).account===o.account);
  const matches=[...new Map(rows.map(r=>[r.id,r])).values()];
  if(matches.length>1)throw Error('此订单对应多个采购账号，请填写实际账号后重新导入');
  return decode(matches[0]);
 };
 const insert=(o,sourceId,original,{reservedId,originalCreatedAt}={})=>transaction(()=>{
  if(reservedId&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(reservedId))throw Error('内部预留订单标识无效');
  if(originalCreatedAt&&!Number.isFinite(Date.parse(originalCreatedAt)))throw Error('原始录入日期无效');o=validateOrder(o);monthLocks.assertWritable([o]);const id=reservedId||randomUUID(),now=new Date().toISOString(),createdAt=originalCreatedAt?new Date(originalCreatedAt).toISOString():now;
  db.prepare('INSERT INTO orders (id,platform,account,order_no,date,paid_at,supplier,status,amount_cents,refund_cents,shipping_cents,note,items,fingerprint,source_id,original,created_at,updated_at,delivery,classification,excluded_from_spend) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,o.platform,o.account,o.orderNo,o.date,o.paidAt,o.supplier,o.status,o.amountCents,o.refundCents,o.shippingCents,o.note,JSON.stringify(o.items),o.fingerprint,sourceId||null,JSON.stringify(original||o),createdAt,now,JSON.stringify(deliveryOf(o)),JSON.stringify(o.classification),Number(o.excludedFromSpend));
  attachments.setActive(id,o.attachmentIds||[]);
  db.prepare('UPDATE orders SET supplier_contact=? WHERE id=?').run(JSON.stringify(o.supplierContact),id);
  db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,actor_json) VALUES (?,?,?,?,?,?)').run(id,'create',null,JSON.stringify(get(id)),now,auditActor());return get(id);
 });
 let transactionDepth=0;
 const transaction=fn=>{if(transactionDepth)return fn();db.exec('BEGIN IMMEDIATE');transactionDepth++;try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}finally{transactionDepth--;}};
 const monthLocks=openMonthLocks(db,{list,transaction});
 attachments=openOrderAttachments({db,dir,get,transaction,update:(id,input)=>api.update(id,input)});
 const classify=(id,version,value,batchId)=>{
  const before=get(id);if(!before)throw Error('订单不存在');
  if(version!==before.updatedAt)throw Error('此订单已被修改，请刷新后重试：'+before.orderNo);
  monthLocks.assertWritable([before]);
  const classification=normalizeClassification(value,before.amountCents,before.refundCents);
  const now=new Date(Math.max(Date.now(),Date.parse(before.updatedAt)+1)).toISOString(),after={...before,classification,updatedAt:now};
  db.prepare('UPDATE orders SET classification=?,updated_at=? WHERE id=?').run(JSON.stringify(classification),now,id);
  db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,batch_id,actor_json) VALUES (?,?,?,?,?,?,?)').run(id,'classification',JSON.stringify(before),JSON.stringify(after),now,batchId,auditActor());
  return after;
 };
 const persistOrder=(o,id,now)=>{
   attachments.setActive(id,o.attachmentIds??attachments.ids(id));
   db.prepare('UPDATE orders SET supplier_contact=? WHERE id=?').run(JSON.stringify(o.supplierContact??null),id);
   db.prepare('UPDATE orders SET platform=?,account=?,order_no=?,date=?,paid_at=?,supplier=?,status=?,amount_cents=?,refund_cents=?,shipping_cents=?,note=?,items=?,fingerprint=?,updated_at=?,delivery=?,classification=?,excluded_from_spend=? WHERE id=?').run(o.platform,o.account,o.orderNo,o.date,o.paidAt,o.supplier,o.status,o.amountCents,o.refundCents,o.shippingCents,o.note,JSON.stringify(o.items),o.fingerprint,now,JSON.stringify(deliveryOf(o)),JSON.stringify(o.classification),Number(o.excludedFromSpend),id);
 };
 const auditLog=openAuditLog(db,{get,transaction,monthLocks,persistOrder,auditActor});
 const api={db,dir,list,get,find,transaction,insert,monthLocks,auditLog,attachments,withActor:actors.run,actorContext:actors.read,
  attributesBatch(input){return transaction(()=>{
   const patch=attributePatch(input?.patch),entries=input?.orders;
   if(!Array.isArray(entries)||!entries.length||entries.length>100000)throw Error('请提交明确的订单 ID 和版本列表');
   if(entries.some(e=>!e||typeof e.id!=='string'||typeof e.updatedAt!=='string')||new Set(entries.map(e=>e.id)).size!==entries.length)throw Error('批量订单 ID 或版本无效、重复');
   const targets=entries.map(e=>{
    const before=get(e.id);if(!before)throw Error('订单不存在');
    if(before.updatedAt!==e.updatedAt)throw Object.assign(Error('订单已被修改，整批未保存，请刷新后重试：'+before.orderNo),{status:409,code:'ORDER_VERSION_CONFLICT'});
    return before;
   });
   monthLocks.assertWritable(targets);
   const proposed=targets.map(before=>validateOrder({...before,...patch})),conflicts=[];
   for(let i=0;i<proposed.length;i++){
    const o=proposed[i],other=db.prepare('SELECT id FROM orders WHERE platform=? AND account=? AND order_no=? AND id<>?').get(o.platform,o.account,o.orderNo,targets[i].id);
    if(other||proposed.some((p,j)=>j!==i&&p.platform===o.platform&&p.account===o.account&&p.orderNo===o.orderNo))conflicts.push({id:targets[i].id,orderNo:o.orderNo,platform:o.platform,account:o.account,reason:'目标采购账号下已存在相同订单号'});
   }
   if(conflicts.length)throw Object.assign(Error('整批未保存，请处理以下订单冲突'),{status:409,code:'ORDER_IDENTITY_CONFLICT',conflicts});
   const batchId=randomUUID();let changed=0;const skipped=[];
   const orders=targets.map((before,index)=>{
    if(Object.entries(patch).every(([key,value])=>before[key]===value))return before;
    const o=proposed[index];
    const now=new Date(Math.max(Date.now(),Date.parse(before.updatedAt)+1)).toISOString(),after={...before,...o,updatedAt:now};
    db.prepare('UPDATE orders SET status=?,excluded_from_spend=?,supplier=?,account=?,fingerprint=?,updated_at=? WHERE id=?').run(o.status,Number(o.excludedFromSpend),o.supplier,o.account,o.fingerprint,now,before.id);
    db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,batch_id,actor_json) VALUES (?,?,?,?,?,?,?)').run(before.id,'attributes',JSON.stringify(before),JSON.stringify(after),now,batchId,auditActor());changed++;return get(before.id);
   });
   return {batchId,changed,skipped,orders};
  });},
  classify(id,input){return transaction(()=>classify(id,input.updatedAt,input.classification,randomUUID()));},
  classifyBatch(input){return transaction(()=>{
   const target=normalizeClassification({mode:'single',category:input.category},0,0),entries=input.orders;
   if(!Array.isArray(entries)||!entries.length||entries.length>100000)throw Error('请提交明确的订单 ID 和版本列表');
   if(entries.some(e=>!e||typeof e.id!=='string'||typeof e.updatedAt!=='string')||new Set(entries.map(e=>e.id)).size!==entries.length)throw Error('批量订单 ID 或版本无效、重复');
   monthLocks.assertWritable(entries.map(e=>get(e.id)));
   const batchId=randomUUID();return {batchId,orders:entries.map(e=>classify(e.id,e.updatedAt,target,batchId))};
  });},
  update(id,input){return transaction(()=>{const before=get(id);if(!before)throw Error('订单不存在');if(input.updatedAt!==before.updatedAt)throw Error('此订单已被修改，请刷新后重试');const o=validateOrder({...input,supplierContact:input.supplierContact===undefined?before.supplierContact:input.supplierContact,attachmentIds:[...new Set([...before.attachmentIds,...attachments.validate(id,input.attachmentIds===undefined?[]:input.attachmentIds)])],excludedFromSpend:input.excludedFromSpend===undefined?before.excludedFromSpend:input.excludedFromSpend,classification:input.classification===undefined?before.classification:input.classification,items:preserveShipments(backfillItemUnits(input.items||before.items,{items:before.items}),before.items)}),now=new Date(Math.max(Date.now(),Date.parse(before.updatedAt)+1)).toISOString();
   monthLocks.assertWritable([before,o]);
   persistOrder(o,id,now);
   db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,actor_json) VALUES (?,?,?,?,?,?)').run(id,'update',JSON.stringify(before),JSON.stringify({...o,updatedAt:now}),now,auditActor());
   if(JSON.stringify(before.classification)!==JSON.stringify(o.classification))db.prepare('UPDATE audit SET batch_id=? WHERE id=last_insert_rowid()').run(randomUUID());return get(id);
  });},
  history(id){return db.prepare('SELECT id,action,before_json,after_json,created_at,batch_id,rollback_of,reason,actor_json FROM audit WHERE order_id=? ORDER BY id DESC').all(id);},
  supplements(id){return db.prepare('SELECT s.*,i.filename FROM order_supplements s JOIN imports i ON i.id=s.source_id WHERE order_id=? ORDER BY s.id DESC').all(id).map(r=>({sourceId:r.source_id,filename:r.filename,createdAt:r.created_at,fields:JSON.parse(r.fields_json),original:JSON.parse(r.raw_json)}));},
  supplementBatch(entries,meta){return transaction(()=>{
   const prior=db.prepare('SELECT id,metadata FROM imports WHERE hash=?').all(meta.hash).find(r=>JSON.parse(r.metadata).method==='supplement-taobao');
   if(prior)return {id:prior.id,alreadyApplied:true,...JSON.parse(prior.metadata).summary};
   if(!entries.length)throw Error('没有可安全补充的订单');
   const sourceId=randomUUID(),createdAt=new Date().toISOString();let updated=0;
   db.prepare('INSERT INTO imports(id,filename,hash,file_path,created_at,imported,skipped,line_count,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run(sourceId,meta.filename,meta.hash,meta.filePath,createdAt,0,meta.summary.skipped,meta.lineCount,JSON.stringify({method:'supplement-taobao',summary:meta.summary,skipped:meta.skipped||[]}));
   for(const e of entries){
    const before=get(e.id);if(!before||before.platform!=='淘宝'||before.orderNo!==e.orderNo)throw Error('补充目标订单不符');
    if(before.updatedAt!==e.updatedAt)throw Error('订单已被修改，请重新核对补充数据');
    for(const [key,value] of Object.entries(e.patch)){
     if(!supplementFields.includes(key)||typeof value!=='string'||!value.trim())throw Error('无效的补充字段');
     if(before[key]&&!(key==='account'&&['默认账号','待补充'].includes(before[key])))throw Error('补充操作不能覆盖已有字段');
    }
    const now=new Date(Math.max(Date.now(),Date.parse(before.updatedAt)+1)).toISOString();
    const after={...before,...e.patch,updatedAt:now};validateOrder(after);monthLocks.assertWritable([before,after]);after.fingerprint=fingerprint(after);
    db.prepare('UPDATE orders SET account=?,paid_at=?,delivery=?,fingerprint=?,updated_at=? WHERE id=?').run(after.account,after.paidAt,JSON.stringify(deliveryOf(after)),after.fingerprint,now,e.id);
    db.prepare('INSERT INTO order_supplements(order_id,source_id,raw_json,fields_json,created_at) VALUES (?,?,?,?,?)').run(e.id,sourceId,JSON.stringify(e.original),JSON.stringify({filled:Object.keys(e.patch),conflicts:e.conflicts}),now);
    db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,actor_json) VALUES (?,?,?,?,?,?)').run(e.id,'supplement-source',JSON.stringify(before),JSON.stringify({...after,supplementSourceId:sourceId}),now,auditActor());
    if(Object.keys(e.patch).length)updated++;
   }
   return {id:sourceId,alreadyApplied:false,...meta.summary,updated};
  });},
  imports(){return db.prepare('SELECT id,filename,created_at,imported,skipped,line_count,metadata FROM imports ORDER BY created_at DESC').all().map(r=>({...r,metadata:JSON.parse(r.metadata)}));},
  importBatch(orders,meta){return transaction(()=>{
   monthLocks.assertWritable(orders.filter(e=>!find(e.order)).map(e=>e.order));
   const id=randomUUID(),skippedOrders=[];let imported=0,skipped=0;
   for(const {order,original,index} of orders){
    const old=find(order);
    if(old){
     skipped++;const same=old.fingerprint===order.fingerprint;
     skippedOrders.push(notImportedOrder({...order,index,sourceRows:original?.normalized?.sourceRows},same?'订单已存在，重复数据未导入':'订单已存在且内容不同，未覆盖原订单',same?'duplicate':'conflict'));continue;
    }
    insert(order,id,original);imported++;
   }
   const metadata={...meta.metadata};
   const report=metadata.importReport?{...metadata.importReport,imported,notImported:[...metadata.importReport.notImported,...skippedOrders].sort((a,b)=>a.index-b.index)}:null;
   if(report)metadata.importReport=report;
   db.prepare('INSERT INTO imports(id,filename,hash,file_path,created_at,imported,skipped,line_count,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run(id,meta.filename,meta.hash,meta.filePath||null,new Date().toISOString(),imported,skipped,meta.lineCount,JSON.stringify(metadata));return {id,imported,skipped,...(report?{report}:{})};
  });},
  async backup(file){await backup(db,file);},
  close(){db.close();}
 };
 return api;
}
export const included=includedInSpend;
export function summarize(orders,year,basis='paid',platform='全部',category='',month=''){
 if(month&&!/^(0[1-9]|1[0-2])$/.test(String(month)))throw Error('请选择有效的统计月份');
 const filtered=orders.filter(o=>(platform==='全部'||o.platform===platform)&&hasCategory(o,category)&&String(basis==='paid'?(o.paidAt||o.date):o.date).startsWith(month?`${year}-${month}`:String(year)));
 const originalEffective=filtered.filter(included),classification=classificationTotals(originalEffective,category),effective=originalEffective.map(o=>({...o,...contribution(o,category)})),months=Array.from({length:12},(_,i)=>({month:i+1,amountCents:0,refundCents:0,netCents:0,count:0,platforms:{}}));
 for(const o of effective){const d=basis==='paid'?(o.paidAt||o.date):o.date,m=months[Number(d.slice(5,7))-1];m.amountCents+=o.amountCents;m.refundCents+=o.refundCents;m.netCents+=o.amountCents-o.refundCents;m.count++;m.platforms[o.platform]=(m.platforms[o.platform]||0)+o.amountCents-o.refundCents;}
 const suppliers=new Map();for(const o of effective){let s=suppliers.get(o.supplier)||{name:o.supplier,amountCents:0,count:0};s.amountCents+=o.amountCents-o.refundCents;s.count++;suppliers.set(o.supplier,s);}
 return {year,months,...classification,category,orderCount:effective.length,allOrderCount:filtered.length,supplierCount:suppliers.size,amountCents:effective.reduce((s,o)=>s+o.amountCents,0),refundCents:effective.reduce((s,o)=>s+o.refundCents,0),netCents:effective.reduce((s,o)=>s+o.amountCents-o.refundCents,0),excludedCount:filtered.length-effective.length,excludedCents:filtered.filter(o=>!included(o)).reduce((s,o)=>s+contribution(o,category).amountCents,0),missingPaidCount:effective.filter(o=>!o.paidAt).length,suppliers:[...suppliers.values()].sort((a,b)=>b.amountCents-a.amountCents),platforms:Object.keys(importRules).map(name=>({name,count:effective.filter(o=>o.platform===name).length,amountCents:effective.filter(o=>o.platform===name).reduce((s,o)=>s+o.amountCents-o.refundCents,0)}))};
}
