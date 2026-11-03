import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './helpers.mjs';
import {createApp} from '../server.mjs';
import {CainiaoDownloads,findNewTask} from '../lib/cainiao.mjs';
import {inspectBill,reconcile,monthRange,monthDates,chinaMonth,resolveArchive} from '../lib/cainiao-files.mjs';
import {makeBackup,restoreBackup} from '../lib/files.mjs';

async function samples(){
 const pack=async items=>{const z=new JSZip();for(const [n,b] of Object.entries(items))z.file(n,b);return z.generateAsync({type:'nodebuffer'});};
 const detail='物流履约单号,费用项,计费金额,业务时间\n001,配送,10,2026-09-01\n002,赔付,-2,2026-09-01\n003,气枕,0,2026-09-01';
 return {transactions:await pack({'交易.csv':'交易单号,店铺ID,计费金额合计(CNY)\n0001,12345678901234567890,10\n0002,12345678901234567890,-2\n0003,12345678901234567890,0','货品.csv':'物流履约单号,货品ID\n001,000001','明细.csv':detail}),fees:await pack({'汇总.csv':'费用项,主单行数量,计费金额\n配送,1,10\n赔付,1,-2\n气枕,1,0','明细.csv':detail}),warehouse:await pack({'inner.zip':await pack({'仓储.csv':'仓库资源名称,业务日期_分区字段\n测试仓,20260901'})})};
}
class FakeBrowser{
 constructor(dir,data){this.dir=path.join(dir,'stage');fs.mkdirSync(this.dir);this.data=data;this.tasks=[];this.count=0;this.submits=0;this.downloads=0;this.available=true;this.account='cn-test';}
 status(){return {status:'connected',account:this.account};}
 async disconnect(){}
 async run(op,a){
  if(this.failLogin)throw Error('NEEDS_LOGIN:需要登录');
  if(op==='prepare')return {period:a.month,count:3,amountCents:800,feeNames:a.type==='fees'?['配送','赔付','气枕']:[],feeRows:[]};
  if(op==='tasks')return this.tasks.map(t=>({...t,status:this.available?'已完成':'生成中'}));
  if(op==='submit'){
   this.submits++;if(this.empty&&a.type==='warehouse')return {empty:true,reason:'平台明确无数据'};
   const range=a.from.replaceAll('-','')+'_'+a.to.replaceAll('-','');const task={id:String(++this.count),account:this.account,basis:'业务时间',name:a.type==='warehouse'?a.month.replace('-','')+'商家仓储费明细下载任务':'明细账单下载任务_交易明细账单_'+range,type:a.type,status:'已完成'};this.tasks.push(task);if(this.uncertain){this.uncertain=false;throw Error('UNCERTAIN:请求返回前断开');}return {submitted:true};
  }
  if(op==='download'){this.downloads++;if(this.failOne&&a.task.type==='fees'){this.failOne=false;throw Error('下载失败');}fs.writeFileSync(a.target,this.data[a.task.type]);return {filename:a.task.type+'.zip'};}
 }
}
test('云仓原件：零金额、负数、长编号、嵌套仓储 ZIP；月份和错误文件校验',async()=>{
 const data=await samples();for(const type of Object.keys(data)){const inspected=await inspectBill(data[type],type+'.zip'),r=reconcile(type,inspected,{period:'2026-09',count:3,amountCents:800,feeNames:['配送','赔付','气枕']});assert.equal(r.verified,true,JSON.stringify(r));}
 const fee=await inspectBill(data.fees,'fees.zip');assert.equal(reconcile('fees',fee,{count:3,amountCents:1000}).verified,false);assert.equal(reconcile('transactions',fee,{count:3,amountCents:800}).verified,false);
 const storage=await inspectBill(data.warehouse,'warehouse.zip');assert.equal(reconcile('warehouse',storage,{period:'2026-08'}).verified,false);
 await assert.rejects(inspectBill(Buffer.from('<html>登录</html>'),'账单.xlsx'),/错误页面/);await assert.rejects(inspectBill(data.transactions.subarray(0,50),'bad.zip'));
 assert.equal(chinaMonth(new Date('2026-09-30T20:00:00Z')),'2026-10');assert.equal(monthDates('2024-02').to,'2024-02-29');assert.deepEqual(monthRange('2025-12','2026-02'),['2025-12','2026-01','2026-02']);assert.throws(()=>monthRange('2026-09','2026-08'));assert.throws(()=>monthRange('2099-01'));
 assert.throws(()=>resolveArchive('C:/data','downloads/cainiao/../../secret.csv'));
});
test('同名交易/费用任务：只接受提交基线之后的唯一编号，账户和月份须一致',()=>{
 const j={account:'cn-test'},i={month:'2026-09',type:'fees',baselineIds:['old']};const t={account:'cn-test',name:'明细账单下载任务_交易明细账单_20260901_20260930',basis:'业务时间'};
 assert.equal(findNewTask([{...t,id:'old'},{...t,id:'other',account:'wrong'},{...t,id:'new'}],j,i).id,'new');assert.equal(findNewTask([{...t,id:'old'}],j,i),null);assert.throws(()=>findNewTask([{...t,id:'1'},{...t,id:'2'}],j,i),/多个/);
});
test('下载成功、再次复用、强制下载按哈希去重，账本金额不变，备份恢复包含原件',async()=>{
 const f=fixture(),browser=new FakeBrowser(f.dir,await samples()),m=new CainiaoDownloads(f.s,{browser,pollMs:1,waitMs:1});try{
  const before=[f.s.bills(),f.s.payments(),f.s.all('SELECT * FROM coverage')];let j=m.start({from:'2026-09',account:'cn-test'});assert.throws(()=>m.start({from:'2026-09',account:'cn-test'}),/已有/);const other=new CainiaoDownloads(f.s,{browser,pollMs:1,waitMs:1});assert.equal(other.get(j.id).status,'running');assert.throws(()=>other.start({from:'2026-09',account:'cn-test'}),/已有/);assert.throws(()=>other.cancel(j.id),/另一个/);await m.running;j=m.get(j.id);assert.equal(j.status,'completed');assert.equal(m.multiMonthReady(),true);assert.equal(m.files(j).length,3);assert.equal(browser.submits,3);
  let again=m.start({from:'2026-09',account:'cn-test'});await m.running;again=m.get(again.id);assert.equal(again.status,'completed');assert.equal(browser.submits,3);assert.ok(again.items.every(i=>i.reused));
  m.start({from:'2026-09',account:'cn-test',force:true});await m.running;assert.equal(browser.submits,6);assert.equal(f.s.get('SELECT COUNT(*) AS n FROM cainiao_files').n,3);assert.deepEqual([f.s.bills(),f.s.payments(),f.s.all('SELECT * FROM coverage')],before);
  const backup=await makeBackup(f.s),restored=await restoreBackup(fs.readFileSync(path.join(f.s.dir,'backups',backup.name)),f.dir);const db=new DatabaseSync(path.join(restored.path,'overview.sqlite'),{readOnly:true});const refs=db.prepare('SELECT * FROM cainiao_files').all();assert.equal(refs.length,3);refs.forEach(r=>assert.equal(fs.statSync(path.join(restored.path,r.path)).size,r.bytes));db.close();
  const zip=await JSZip.loadAsync(fs.readFileSync(path.join(f.s.dir,'backups',backup.name)));const manifest=JSON.parse(await zip.file('manifest.json').async('string'));delete manifest.files[refs[0].path];zip.remove(refs[0].path);zip.file('manifest.json',JSON.stringify(manifest));await assert.rejects(restoreBackup(await zip.generateAsync({type:'nodebuffer'}),f.dir),/缺少已引用原件/);
 }finally{await m.close();f.close();}
});
test('部分失败只补缺失文件；提交结果不明先查任务，不重复申请',async()=>{
 const f=fixture(),b=new FakeBrowser(f.dir,await samples()),m=new CainiaoDownloads(f.s,{browser:b,pollMs:1,waitMs:1});try{b.failOne=true;b.uncertain=true;const j=m.start({from:'2026-09',account:'cn-test'});await m.running;assert.equal(m.get(j.id).status,'paused');assert.equal(b.submits,1);m.resume(j.id);await m.running;assert.equal(m.get(j.id).status,'partial');const submissions=b.submits;m.resume(j.id);await m.running;assert.equal(m.get(j.id).status,'completed');assert.equal(b.submits,submissions);assert.equal(m.files(m.get(j.id)).length,3);}finally{await m.close();f.close();}
});
test('平台等待、取消、重启和登录恢复：保留平台编号，不重复申请',async()=>{
 const f=fixture(),b=new FakeBrowser(f.dir,await samples()),m=new CainiaoDownloads(f.s,{browser:b,pollMs:1,waitMs:1});try{b.available=false;const j=m.start({from:'2026-09',account:'cn-test'});await m.running;assert.ok(m.get(j.id).items.every(i=>i.status==='waiting'));const n=b.submits;m.cancel(j.id);let saved=m.get(j.id);saved.status='running';m.save(saved);const reloaded=new CainiaoDownloads(f.s,{browser:b,pollMs:1,waitMs:1});assert.equal(reloaded.get(j.id).status,'paused');b.failLogin=true;reloaded.resume(j.id);await reloaded.running;assert.equal(reloaded.get(j.id).status,'paused');b.failLogin=false;b.available=true;reloaded.resume(j.id);await reloaded.running;assert.equal(reloaded.get(j.id).status,'completed');assert.equal(b.submits,n);await reloaded.close();}finally{await m.close();f.close();}
});
test('下载 API：会话、来源保护，未知任务与路径，九月核验前限制多月',async()=>{
 const f=fixture(),browser=new FakeBrowser(f.dir,await samples()),a=createApp({dataDir:path.join(f.dir,'api'),sources:f.paths,cainiaoOptions:{browser,pollMs:1,waitMs:1}}),server=a.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;try{
  const boot=await fetch(base+'/api/bootstrap').then(r=>r.json()),post=(body,token=boot.token)=>fetch(base+'/api/cainiao/download-jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Overview-Token':token},body:JSON.stringify(body)});
  assert.equal((await post({from:'2026-09',account:'cn-test'},'')).status,403);assert.equal((await fetch(base+'/api/cainiao/connection',{headers:{Origin:'https://example.com'}})).status,403);assert.equal((await post({from:'2026-08',to:'2026-09',account:'cn-test'})).status,409);assert.equal((await post({from:'2026-09',account:'wrong'})).status,409);assert.equal((await fetch(base+'/api/cainiao/files/anything')).status,404);
  const r=await post({from:'2026-09',account:'cn-test'});assert.equal(r.status,202);const j=await r.json();await a.cainiao.running;const result=await fetch(base+'/api/cainiao/download-jobs/'+j.id).then(r=>r.json());assert.equal(result.status,'completed');assert.equal((await fetch(base+result.files[0].url)).status,200);assert.equal(a.store.bills().length,0);
 }finally{await a.cainiao.close();await new Promise(r=>server.close(r));a.store.close();f.close();}
});
test('v1 备份兼容：没有云仓表的旧数据库可恢复',async()=>{
 const f=fixture();try{const b=await makeBackup(f.s),z=await JSZip.loadAsync(fs.readFileSync(path.join(f.s.dir,'backups',b.name))),manifest=JSON.parse(await z.file('manifest.json').async('string'));manifest.version=1;z.file('manifest.json',JSON.stringify(manifest));const restored=await restoreBackup(await z.generateAsync({type:'nodebuffer'}),f.dir);const db=new DatabaseSync(path.join(restored.path,'overview.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM bills').get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='cainiao_jobs'").get().n,0);db.close();}finally{f.close();}
});
test('运行中取消：保留正在完成的原件，停止后续导出，之后可继续',async()=>{
 const f=fixture(),b=new FakeBrowser(f.dir,await samples()),m=new CainiaoDownloads(f.s,{browser:b,pollMs:1,waitMs:1});let release,entered;const ready=new Promise(r=>{entered=r;}),hold=new Promise(r=>{release=r;}),original=b.run.bind(b);b.run=async(op,a)=>{if(op==='download'&&a.task.type==='transactions'){entered();await hold;}return original(op,a);};
 try{const j=m.start({from:'2026-09',account:'cn-test'});await ready;m.cancel(j.id);release();await m.running;let result=m.get(j.id);assert.equal(result.status,'cancelled');assert.equal(result.items[0].status,'completed');assert.equal(m.files(result).length,1);assert.equal(b.submits,1);b.run=original;m.resume(j.id);await m.running;result=m.get(j.id);assert.equal(result.status,'completed');assert.equal(b.submits,3);}finally{release?.();await m.close();f.close();}
});
