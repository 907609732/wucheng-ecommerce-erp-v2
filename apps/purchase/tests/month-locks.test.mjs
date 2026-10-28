import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
import {confirmationTiming} from '../lib/month-locks.mjs';

// Keep the pre-existing lock workflow tests independent of the actual calendar date.
test.beforeEach(t=>t.mock.timers.enable({apis:['Date'],now:new Date('2026-12-15T00:00:00+08:00')}));

const password='隔离账本-'+randomUUID(),otherPassword='另一个-'+randomUUID();
const base=(orderNo='MONTH-01',extra={})=>({platform:'微信',account:'月度测试',orderNo,date:'2026-09-29',paidAt:'2026-10-01',supplier:'测试供应商',status:'已完成',amountCents:10000,refundCents:1000,shippingCents:0,note:'',items:[{title:'测试物品',qty:1,unit:'件',unitPriceCents:10000}],...extra});
const single=category=>({mode:'single',category,owner:'company'});
const fixture=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-month-lock-'));return {dir,store:openStore(dir)};};
const setup=store=>store.monthLocks.setPassword({password,confirmation:password});
const confirm=(store,month='2026-10',platform='微信')=>store.monthLocks.confirm(store.monthLocks.preview(month,platform));
const locked=fn=>assert.throws(fn,e=>e.code==='MONTH_LOCKED'&&e.status===423);
const meta=()=>({filename:'test.csv',filePath:null,hash:randomUUID(),lineCount:2,summary:{skipped:0,updated:1}});

test('确认时间固定为北京时间次月15日零点，覆盖跨年、大小月和闰年',()=>{
 for(const [month,availableOn] of [['2026-09','2026-10-15'],['2026-10','2026-11-15'],['2026-12','2027-01-15'],['2024-02','2024-03-15'],['2025-02','2025-03-15'],['2026-07','2026-08-15']]){
  const boundary=Date.parse(availableOn+'T00:00:00+08:00');
  for(const [offset,expected] of [[-1,false],[0,true],[1,true],[86400000,true]]){
   const timing=confirmationTiming(month,boundary+offset);assert.equal(timing.canConfirm,expected);assert.equal(timing.availableOn,availableOn);assert.equal(Date.parse(timing.availableAt),boundary);assert.equal(timing.timeZone,'Asia/Shanghai');
  }
 }
 assert.equal(confirmationTiming('2026-10',Date.parse('2026-10-31T23:59:59+08:00')).canConfirm,false);
 assert.equal(confirmationTiming('2026-11',Date.parse('2026-10-31T23:59:59+08:00')).canConfirm,false);
 assert.throws(()=>confirmationTiming('2026-00'),e=>e.code==='INVALID_MONTH_SCOPE');
});

test('HTTP 提前确认被拒绝且不写记录，到北京时间15日零点允许；不信任客户端日期与标记',async t=>{
 t.mock.timers.setTime(Date.parse('2026-11-14T23:59:59.999+08:00'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-month-date-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(url+'/api/bootstrap')).json();await setup(store);store.insert(base());
  const get=async route=>(await fetch(url+route)).json(),post=body=>fetch(url+'/api/month-confirmations',{method:'POST',headers:{'X-Purchase-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const overview=await get('/api/month-confirmations?month=2026-10');assert.equal(overview.canConfirm,false);assert.equal(overview.availableOn,'2026-11-15');assert.ok(overview.platforms.every(p=>!p.canConfirm));
  const p=await get('/api/month-confirmations/preview?month=2026-10&platform='+encodeURIComponent('微信')),before=store.db.prepare('SELECT * FROM month_events').all();
  const response=await post({...p,canConfirm:true,availableOn:'2000-01-15',availableAt:'2000-01-14T16:00:00.000Z',today:'2099-12-31',password});assert.equal(response.status,403);const error=await response.json();assert.equal(error.code,'MONTH_CONFIRMATION_TOO_EARLY');assert.match(error.error,/2026-11-15/);assert.deepEqual(store.monthLocks.confirmations(),[]);assert.deepEqual(store.db.prepare('SELECT * FROM month_events').all(),before);
  for(const platform of ['微信','淘宝','1688'])assert.throws(()=>confirm(store,'2026-11',platform),e=>e.code==='MONTH_CONFIRMATION_TOO_EARLY');
  const o=store.list()[0];store.update(o.id,{...o,note:'仍可录入核对'});const current=store.monthLocks.preview('2026-10','微信');
  t.mock.timers.setTime(Date.parse('2026-11-15T00:00:00+08:00'));assert.equal((await get('/api/month-confirmations?month=2026-10')).canConfirm,true);
  assert.equal((await post(current)).status,200);assert.equal(store.monthLocks.confirmations().length,1);locked(()=>store.update(o.id,{...store.get(o.id),note:'已锁定'}));
  const c=store.monthLocks.confirmations()[0];await store.monthLocks.cancel({...c,password});assert.equal((await post(store.monthLocks.preview('2026-10','微信'))).status,200);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('已存在的提前确认保留锁定和密码；取消后也必须等到次月15日才能重新确认',async t=>{
 const {dir,store:initial}=fixture();let store=initial;
 try{
  const o=store.insert(base());await setup(store);const c=confirm(store);
  const dump=()=>Object.fromEntries(['orders','audit','settings','month_confirmations','month_events'].map(table=>[table,store.db.prepare('SELECT * FROM '+table).all()])),before=dump();
  store.close();t.mock.timers.setTime(Date.parse('2026-10-13T20:00:00+08:00'));store=openStore(dir);assert.deepEqual(dump(),before);locked(()=>store.update(o.id,{...o,note:'锁定仍保留'}));
  await store.monthLocks.cancel({...c,password});assert.equal(store.monthLocks.confirmations().length,0);assert.throws(()=>confirm(store),e=>e.code==='MONTH_CONFIRMATION_TOO_EARLY');
  t.mock.timers.setTime(Date.parse('2026-11-15T00:00:00+08:00'));assert.notEqual(confirm(store).version,c.version);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('付款月优先、缺失回退、按平台独立确认；确认预览过期保护，重复启动不自动锁历史数据',async()=>{
 const {dir,store:initial}=fixture();let store=initial;
 try{
  const paid=store.insert(base());store.insert(base('FALLBACK',{date:'2026-10-02',paidAt:'',status:'待核对'}));store.insert(base('OTHER',{platform:'淘宝'}));store.insert(base('SEPT',{paidAt:'2026-09-30'}));
  const before=store.db.prepare('SELECT * FROM orders ORDER BY id').all(),audit=store.db.prepare('SELECT * FROM audit ORDER BY id').all();
  assert.equal(store.monthLocks.configured(),false);assert.deepEqual(store.monthLocks.confirmations(),[]);
  assert.throws(()=>confirm(store),e=>e.code==='ADMIN_NOT_CONFIGURED');
  await setup(store);const p=store.monthLocks.preview('2026-10','微信');assert.equal(p.count,2);assert.equal(p.missingPaidCount,1);assert.equal(p.reviewCount,1);assert.equal(p.amountCents,20000);
  store.update(paid.id,{...paid,note:'已核对'});assert.throws(()=>store.monthLocks.confirm(p),e=>e.code==='MONTH_CHANGED');assert.equal(store.monthLocks.confirmations().length,0);
  const c=confirm(store);assert.equal(c.changeCount,0);assert.throws(()=>confirm(store),e=>e.code==='MONTH_ALREADY_CONFIRMED');
  assert.equal(store.monthLocks.overview('2026-10').platforms.find(p=>p.platform==='淘宝').confirmation,null);
  assert.throws(()=>store.monthLocks.preview('2026-13','微信'));assert.throws(()=>store.monthLocks.preview('2026-10','随便'));
  const after=store.db.prepare('SELECT * FROM orders ORDER BY id').all(),newAudit=store.db.prepare('SELECT * FROM audit ORDER BY id').all();assert.equal(after.length,before.length);assert.equal(newAudit.length,audit.length+1);
  store.close();store=openStore(dir);assert.deepEqual(store.monthLocks.confirmations(),[c]);assert.deepEqual(store.db.prepare('SELECT * FROM orders ORDER BY id').all(),after);assert.deepEqual(store.db.prepare('SELECT * FROM audit ORDER BY id').all(),newAudit);
  assert.equal(store.monthLocks.overview('2026-09').platforms.filter(p=>p.confirmation).length,0);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('取消确认验证管理员密码，错误与限流不解锁；更换密码和重启后保留保护',async()=>{
 const {dir,store:initial}=fixture();let store=initial;
 try{
  await assert.rejects(()=>store.monthLocks.setPassword({password:'short',confirmation:'short'}));await assert.rejects(()=>store.monthLocks.setPassword({password,confirmation:'different'}));
  const o=store.insert(base());await setup(store);const c=confirm(store),request={month:c.month,platform:c.platform,version:c.version};
  const stored=store.db.prepare("SELECT value FROM settings WHERE key='month-admin-password'").get().value;assert.equal(stored.includes(password),false);assert.equal(JSON.parse(stored).algorithm,'scrypt');assert.equal(JSON.parse(stored).salt.length,32);
  await assert.rejects(()=>store.monthLocks.cancel({...request,password:'incorrect'}),e=>e.status===403);assert.deepEqual(store.monthLocks.confirmations(),[c]);assert.deepEqual(store.get(o.id),o);assert.equal(store.monthLocks.history(c.month,c.platform).length,1);
  await assert.rejects(()=>store.monthLocks.setPassword({password:otherPassword,confirmation:otherPassword}),e=>e.code==='ADMIN_PASSWORD_INVALID');
  await store.monthLocks.setPassword({password:otherPassword,confirmation:otherPassword,currentPassword:password});
  for(let i=0;i<5;i++)await assert.rejects(()=>store.monthLocks.cancel({...request,password}),e=>[403,429].includes(e.status));
  store.close();store=openStore(dir);await assert.rejects(()=>store.monthLocks.cancel({...request,password:otherPassword}),e=>e.code==='ADMIN_RATE_LIMIT');locked(()=>store.update(o.id,{...o,note:'仍不可改'}));
  store.db.prepare("UPDATE settings SET value=? WHERE key='month-admin-attempts'").run(JSON.stringify({failures:0,until:Date.now()-1}));
  await store.monthLocks.cancel({...request,password:otherPassword});assert.deepEqual(store.monthLocks.confirmations(),[]);assert.deepEqual(store.get(o.id),o);
  const saved=store.update(o.id,{...o,note:'取消确认后可以编辑'});assert.equal(saved.note,'取消确认后可以编辑');
  const events=store.monthLocks.history(c.month,c.platform);assert.deepEqual(events.map(e=>e.action),['cancel','confirm']);assert.equal(events[0].details.confirmationVersion,c.version);assert.equal(JSON.stringify(events).includes(otherPassword),false);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('锁定覆盖所有写入口与数据库边界；取消后恢复整批修改，重新确认立即锁定',async()=>{
 const {dir,store}=fixture();try{
  const a=store.insert(base()),b=store.insert(base('B')),unlocked=store.insert(base('SEPT',{paidAt:'2026-09-01'}));await setup(store);const c=confirm(store);
  locked(()=>store.classify(a.id,{updatedAt:a.updatedAt,classification:single('expense')}));
  locked(()=>store.update(a.id,{...a,paidAt:'2026-11-01',platform:'淘宝'}));locked(()=>store.update(unlocked.id,{...unlocked,paidAt:'2026-10-01'}));
  assert.throws(()=>store.db.prepare('UPDATE orders SET note=? WHERE id=?').run('绕过',a.id),/MONTH_LOCKED/);assert.throws(()=>store.db.prepare('DELETE FROM orders WHERE id=?').run(a.id),/MONTH_LOCKED/);locked(()=>store.insert(base('NEW')));
  const raw=store.db.prepare('SELECT * FROM orders WHERE id=?').get(a.id),keys=Object.keys(raw);assert.throws(()=>store.db.prepare('INSERT INTO orders('+keys.join(',')+') VALUES ('+keys.map(()=>'?')+')').run(...keys.map(k=>k==='id'?randomUUID():k==='order_no'?'RAW-INSERT':raw[k])),/MONTH_LOCKED/);
  const audit=store.db.prepare('SELECT * FROM audit').all();locked(()=>store.classifyBatch({category:'expense',orders:[unlocked,a].map(({id,updatedAt})=>({id,updatedAt}))}));assert.deepEqual(store.db.prepare('SELECT * FROM audit').all(),audit);assert.deepEqual(store.get(unlocked.id),unlocked);
  await store.monthLocks.cancel({...c,password});assert.throws(()=>store.classifyBatch({category:'expense',orders:[{id:a.id,updatedAt:a.updatedAt},{id:b.id,updatedAt:'stale'}]}),/已被修改/);assert.deepEqual(store.get(a.id),a);assert.deepEqual(store.db.prepare('SELECT * FROM audit').all(),audit);
  const saved=store.classifyBatch({category:'expense',orders:[a,b].map(({id,updatedAt})=>({id,updatedAt}))});assert.equal(saved.orders.length,2);assert.equal(store.history(a.id)[0].batch_id,store.history(b.id)[0].batch_id);
  const again=confirm(store);assert.notEqual(again.version,c.version);locked(()=>store.classifyBatch({category:'goods',orders:saved.orders.map(({id,updatedAt})=>({id,updatedAt}))}));
  const other=store.insert(base('OTHER',{platform:'淘宝'}));store.update(other.id,{...other,note:'其他平台可编辑'});store.update(unlocked.id,{...unlocked,note:'其他月可编辑'});
  confirm(store,'2026-11','淘宝');await store.monthLocks.cancel({...again,password});locked(()=>store.update(a.id,{...store.get(a.id),paidAt:'2026-11-01',platform:'淘宝'}));assert.equal(store.monthLocks.confirmations().length,1);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('导入和补充不得绕过锁定，取消后可修改；重新导入不覆盖分类，备份保存取消与重确认历史',async()=>{
 const {dir,store}=fixture();try{
  const a=store.insert(base('TAO',{platform:'淘宝',paidAt:'',date:'2026-10-01'}));await setup(store);const c=confirm(store,'2026-10','淘宝');
  const before=store.list(),beforeImports=store.imports();
  locked(()=>store.importBatch([{order:base('FREE',{platform:'微信'})},{order:base('LOCKED',{platform:'淘宝'})}],meta()));assert.deepEqual(store.list(),before);assert.deepEqual(store.imports(),beforeImports);
  locked(()=>store.supplementBatch([{id:a.id,orderNo:a.orderNo,updatedAt:a.updatedAt,patch:{paidAt:'2026-10-03'},original:{source:'table'},conflicts:[]}],meta()));assert.deepEqual(store.imports(),beforeImports);assert.equal(store.supplements(a.id).length,0);
  await store.monthLocks.cancel({...c,password});const changed=store.classify(a.id,{updatedAt:a.updatedAt,classification:single('fixed_asset')});confirm(store,'2026-10','淘宝');
  const result=store.importBatch([{order:base('TAO',{platform:'淘宝',paidAt:'',date:'2026-10-01'})}],meta());assert.equal(result.skipped,1);assert.deepEqual(store.get(a.id),changed);
  const backupPath=path.join(dir,'snapshot.sqlite');await store.backup(backupPath);const db=new DatabaseSync(backupPath,{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT count(*) AS n FROM month_confirmations').get().n,1);assert.ok(db.prepare("SELECT value FROM settings WHERE key='month-admin-password'").get());assert.equal(db.prepare('SELECT count(*) AS n FROM month_events').get().n,4);}finally{db.close();}
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('HTTP 锁定订单不接受旧版密码授权；先取消确认再编辑，旧取消请求不能解除新确认',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-month-api-'));let service=createApp({dataDir:dir}),server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 let url='http://127.0.0.1:'+server.address().port,token=(await (await fetch(url+'/api/bootstrap')).json()).token;
 const call=async(endpoint,body,method='POST',secret)=>{const response=await fetch(url+endpoint,body===undefined?{}:{method,headers:{'X-Purchase-Token':token,'Content-Type':'application/json',...(secret?{'X-Purchase-Admin':encodeURIComponent(secret)}:{})},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 const stop=async()=>{await new Promise(r=>server.close(r));service.store.close();};
 try{
  const order=(await call('/api/orders',base())).data;assert.equal((await call('/api/admin/password',{password,confirmation:password})).status,200);
  let boot=(await call('/api/bootstrap')).data;assert.equal(boot.adminConfigured,true);assert.equal(JSON.stringify(boot).includes('scrypt'),false);assert.equal(JSON.stringify(boot).includes(password),false);
  const preview=(await call('/api/month-confirmations/preview?month=2026-10&platform='+encodeURIComponent('微信'))).data,c=(await call('/api/month-confirmations',preview)).data;
  const endpoint='/api/orders/'+order.id+'/note',note={note:'取消确认后修改',updatedAt:order.updatedAt};
  for(const [route,body,method] of [[endpoint,note,'PATCH'],['/api/orders/'+order.id+'/classification',{updatedAt:order.updatedAt,classification:single('expense')},'PATCH'],['/api/orders/'+order.id,{...order,paidAt:'2026-11-01'},'PUT'],['/api/orders/classification/batch',{category:'expense',orders:[{id:order.id,updatedAt:order.updatedAt}]},'POST'],['/api/orders',base('NEW'),'POST']]){
   for(const secret of [undefined,'wrong-password',password]){const result=await call(route,body,method,secret);assert.equal(result.status,423);assert.equal(result.data.code,'MONTH_LOCKED');assert.match(result.data.error,/取消确认/);}
  }
  assert.deepEqual(service.store.get(order.id),order);
  assert.equal((await call('/api/month-confirmations/cancel',c)).status,403);assert.equal((await call('/api/month-confirmations/cancel',{...c,password:'wrong'})).status,403);assert.equal(service.store.monthLocks.confirmations().length,1);
  assert.equal((await call('/api/month-confirmations/cancel',{...c,password})).status,200);const saved=await call(endpoint,note,'PATCH');assert.equal(saved.status,200);assert.equal(saved.data.note,note.note);assert.equal((await call('/api/orders',base('NEW'))).status,200);
  const again=confirm(service.store);assert.equal((await call('/api/month-confirmations/cancel',{...c,password})).status,409);assert.deepEqual(service.store.monthLocks.confirmations(),[again]);
  await stop();service=createApp({dataDir:dir});server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url='http://127.0.0.1:'+server.address().port;boot=(await call('/api/bootstrap')).data;token=boot.token;
  assert.equal(boot.monthConfirmations[0].version,again.version);assert.equal((await call(endpoint,{...note,updatedAt:saved.data.updatedAt},'PATCH',password)).status,423);
  assert.deepEqual((await call('/api/month-confirmations/history?month=2026-10&platform='+encodeURIComponent('微信'))).data.map(e=>e.action),['confirm','cancel','confirm']);
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('取消验证期间状态变化不解锁新确认；取消写入失败整笔回滚且不留下成功记录',async()=>{
 const {dir,store}=fixture();try{
  store.insert(base());await setup(store);const c=confirm(store),pending=store.monthLocks.cancel({...c,password});
  // Simulate another connection completing a cancellation and a new confirmation during scrypt.
  store.db.prepare('DELETE FROM month_confirmations WHERE month=? AND platform=?').run(c.month,c.platform);const newer=confirm(store);
  await assert.rejects(()=>pending,e=>e.code==='MONTH_CONFIRMATION_CHANGED');assert.deepEqual(store.monthLocks.confirmations(),[newer]);
  const events=store.monthLocks.history(c.month,c.platform);store.db.exec("CREATE TRIGGER fixture_cancel_failure BEFORE DELETE ON month_confirmations BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
  await assert.rejects(()=>store.monthLocks.cancel({...newer,password}),/fixture write failure/);assert.deepEqual(store.monthLocks.confirmations(),[newer]);assert.deepEqual(store.monthLocks.history(c.month,c.platform),events);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('旧版锁迁移保留确认、密码和历史；删除旧版单次授权通道且重复启动不改业务数据',async()=>{
 const {dir,store:initial}=fixture();let store=initial;try{
  const o=store.insert(base());await setup(store);const c=confirm(store);
  store.db.exec("DROP TRIGGER month_lock_update; CREATE TRIGGER month_lock_update BEFORE UPDATE ON orders WHEN purchase_admin_allowed()=0 AND EXISTS(SELECT 1 FROM month_confirmations) BEGIN SELECT RAISE(ABORT,'MONTH_LOCKED'); END; CREATE TRIGGER month_audit_update AFTER UPDATE ON orders WHEN purchase_admin_allowed()=1 BEGIN SELECT purchase_admin_batch(); END;");
  const dump=()=>Object.fromEntries(['orders','audit','settings','month_confirmations','month_events'].map(t=>[t,store.db.prepare('SELECT * FROM '+t).all()])),before=dump();
  store.close();store=openStore(dir);assert.deepEqual(dump(),before);assert.deepEqual(store.monthLocks.confirmations(),[c]);
  store.db.function('purchase_admin_allowed',()=>1);assert.throws(()=>store.db.prepare('UPDATE orders SET note=? WHERE id=?').run('旧授权不能绕过',o.id),/MONTH_LOCKED/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'month_audit_%'").get().n,0);
  store.close();store=openStore(dir);assert.deepEqual(dump(),before);await store.monthLocks.cancel({...c,password});assert.equal(store.get(o.id).note,'');
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('HTTP 表格预览可读，锁定月份提交不落原文件；取消确认后整批保存，再确认后重新锁定',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-month-import-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(url+'/api/bootstrap')).json();await setup(store);confirm(store);
  const csv='订单编号,下单日期,付款日期,供应商,商品名称,数量,实付金额,订单状态\nNEW-CSV,2026-09-30,2026-10-02,测试供应商,商品,1,100.00,已完成\nFREE-CSV,2026-09-30,2026-09-30,测试供应商,商品,1,80.00,已完成';
  const form=new FormData();form.set('platform','微信');form.set('file',new Blob(['\uFEFF'+csv]),'month.csv');
  let response=await fetch(url+'/api/import/preview',{method:'POST',headers:{'X-Purchase-Token':token},body:form});const preview=await response.json();assert.equal(preview.summary.valid,1);assert.equal(preview.summary.locked,1);
  const commit=secret=>fetch(url+'/api/import/'+preview.id+'/commit',{method:'POST',headers:{'X-Purchase-Token':token,'Content-Type':'application/json',...(secret?{'X-Purchase-Admin':encodeURIComponent(secret)}:{})},body:JSON.stringify({indices:[0,1]})});
  response=await commit();assert.equal(response.status,423);assert.equal(store.list().length,0);assert.equal(store.imports().length,0);assert.equal(fs.readdirSync(path.join(dir,'originals')).length,0);
  response=await commit(password);assert.equal(response.status,423);await store.monthLocks.cancel({...store.monthLocks.confirmations()[0],password});response=await commit();assert.equal(response.status,200);assert.equal((await response.json()).imported,2);assert.equal(fs.readdirSync(path.join(dir,'originals')).length,1);assert.equal(store.monthLocks.confirmations().length,0);confirm(store);
  const o=store.list().find(o=>o.orderNo==='NEW-CSV');locked(()=>store.update(o.id,{...o,note:'仍锁定'}));
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('一键解锁一次验证密码，范围和版本校验，整批原子回滚，逐项保留批次审计',async()=>{
 const {dir,store}=fixture();try{
  await setup(store);confirm(store,'2026-08','微信');confirm(store,'2026-09','1688');
  const entries=store.monthLocks.confirmations().map(({month,platform,version})=>({month,platform,version}));
  await assert.rejects(()=>store.monthLocks.cancelBatch({confirmations:entries,password:'wrong'}),e=>e.code==='ADMIN_PASSWORD_INVALID');assert.equal(store.monthLocks.confirmations().length,2);
  await assert.rejects(()=>store.monthLocks.cancelBatch({confirmations:[entries[0],{...entries[1],version:'stale'}],password}),e=>e.code==='MONTH_CONFIRMATION_CHANGED');
  await assert.rejects(()=>store.monthLocks.cancelBatch({confirmations:[entries[0],entries[0]],password}),e=>e.code==='INVALID_MONTH_SCOPE');
  store.db.exec("CREATE TRIGGER fail_batch_unlock BEFORE DELETE ON month_confirmations WHEN OLD.month='2026-08' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(()=>store.monthLocks.cancelBatch({confirmations:entries,password}));assert.equal(store.monthLocks.confirmations().length,2);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM month_events WHERE action='cancel'").get().n,0);
  store.db.exec('DROP TRIGGER fail_batch_unlock');
  const result=await store.monthLocks.cancelBatch({confirmations:[entries[0]],password});assert.equal(result.cancelled,1);assert.equal(store.monthLocks.confirmations().length,1);
  const history=store.monthLocks.history(entries[0].month,entries[0].platform);assert.equal(history[0].action,'cancel');assert.equal(history[0].batchId,result.batchId);
  await store.monthLocks.cancelBatch({confirmations:[entries[1]],password});assert.equal(store.monthLocks.confirmations().length,0);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('勾选月份批量锁定：版本、日期、重复范围与整批失败回滚；逐项保留统一审计批次',async()=>{
 const {dir,store}=fixture();try{
  await setup(store);const original=store.insert(base('BATCH-LOCK'));
  const entries=[store.monthLocks.preview('2026-08','1688'),store.monthLocks.preview('2026-10','微信')];
  assert.throws(()=>store.monthLocks.confirmBatch({confirmations:[entries[0],{...entries[1],revision:'stale'}]}),e=>e.code==='MONTH_CHANGED');assert.equal(store.monthLocks.confirmations().length,0);
  assert.throws(()=>store.monthLocks.confirmBatch({confirmations:[entries[0],entries[0]]}),e=>e.code==='INVALID_MONTH_SCOPE');
  assert.throws(()=>store.monthLocks.confirmBatch({confirmations:[entries[0],store.monthLocks.preview('2026-12','微信')]}),e=>e.code==='MONTH_CONFIRMATION_TOO_EARLY');assert.equal(store.monthLocks.confirmations().length,0);
  store.db.exec("CREATE TRIGGER fail_batch_confirm BEFORE INSERT ON month_confirmations WHEN NEW.month='2026-10' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>store.monthLocks.confirmBatch({confirmations:entries}));assert.equal(store.monthLocks.confirmations().length,0);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM month_events WHERE action='confirm'").get().n,0);
  store.db.exec('DROP TRIGGER fail_batch_confirm');const result=store.monthLocks.confirmBatch({confirmations:entries});assert.equal(result.confirmed,2);assert.equal(store.monthLocks.confirmations().length,2);assert.deepEqual(store.get(original.id),original);
  for(const entry of entries){const history=store.monthLocks.history(entry.month,entry.platform);assert.equal(history[0].action,'confirm');assert.equal(history[0].batchId,result.batchId);}
  assert.throws(()=>store.monthLocks.confirmBatch({confirmations:entries}),e=>e.code==='MONTH_ALREADY_CONFIRMED');locked(()=>store.update(original.id,{...original,note:'blocked'}));
  const one=store.monthLocks.confirmations().filter(c=>c.month==='2026-08');await store.monthLocks.cancelBatch({confirmations:one,password});assert.equal(store.monthLocks.confirmations().length,1);assert.equal(store.monthLocks.confirmations()[0].month,'2026-10');
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
