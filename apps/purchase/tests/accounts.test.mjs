import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readTable,normalizeTable,accountFromOriginal} from '../lib/importer.mjs';
import {openStore} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
const csv='订单编号,买家会员名,卖家会员名,下单日期,供应商,商品名称,实付金额,订单状态\nACCOUNT1,buyer_a,seller_wrong,2026-10-13,测试店,商品甲,12.00,交易成功\nACCOUNT1,,seller_wrong,2026-10-13,测试店,商品乙,12.00,交易成功\nACCOUNT2,buyer_b,seller_wrong,2026-10-13,测试店,商品丙,20.00,交易成功';
const base=()=>({platform:'1688',account:'默认账号',orderNo:'LEGACY-A',date:'2026-10-13',paidAt:'',supplier:'测试店',amountCents:1200,refundCents:0,shippingCents:0,status:'已完成',note:'原备注',items:[{title:'商品甲',qty:1,unit:'件',unitPriceCents:1200}]});
test('识别买家会员名，源表优先；同单空白账号只在唯一归属时补齐',async()=>{
 const t=await readTable(Buffer.from(csv),'accounts.csv');const p=normalizeTable(t,{account:'手填备用'});assert.deepEqual(p.orders.map(o=>o.account),['buyer_a','buyer_b']);assert.equal(p.orders[0].items.length,2);assert.equal(p.orders[0].amountCents,1200);
 const missing=await readTable(Buffer.from(csv.replace('买家会员名','未映射列')),'missing.csv');assert.ok(!Object.hasOwn(missing.mapping,'account'));assert.ok(normalizeTable(missing,{account:'手填备用'}).orders.every(o=>o.account==='手填备用'));
 assert.equal(accountFromOriginal({headers:['卖家会员名','发票：开户行及账号'],rows:[{cells:['seller','bank']}]}),'');
 const mixed=await readTable(Buffer.from(csv.replace('ACCOUNT2,buyer_b','ACCOUNT1,buyer_b')),'mixed.csv');const result=normalizeTable(mixed);assert.equal(result.issues.length,1);assert.ok(result.orders.every(o=>o.errors.length>0));
});
test('按账号区分相同订单号，避免跨账号误合并',async()=>{
 const t=await readTable(Buffer.from('订单编号,采购账号,下单日期,供应商,商品名称,实付金额\nSAME,a,2026-10-13,测试,甲,10\nSAME,b,2026-10-13,测试,乙,20'),'same.csv');const p=normalizeTable(t);assert.equal(p.orders.length,2);assert.deepEqual(p.orders.map(o=>o.amountCents),[1000,2000]);
});
test('旧账本补账号留审计、原数据不变、旧页面不能覆盖；自填账号和冲突订单保留',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-accounts-'));let store=openStore(dir);
 try{
  const raw={headers:['买家会员名','卖家会员名'],rows:[{row:2,cells:['buyer_a','seller_wrong']}]};const first=store.insert(base(),null,raw),custom=store.insert({...base(),account:'自定义采购组',orderNo:'CUSTOM'},null,raw),collision=store.insert({...base(),orderNo:'COLLISION'},null,raw);store.insert({...base(),account:'buyer_a',orderNo:'COLLISION'},null,raw);
  const before=store.db.prepare('SELECT * FROM orders WHERE id=?').get(first.id),history=store.history(first.id);store.db.exec('PRAGMA user_version=3');store.close();store=openStore(dir);const after=store.db.prepare('SELECT * FROM orders WHERE id=?').get(first.id);
  for(const k of Object.keys(before).filter(k=>!['account','fingerprint','updated_at'].includes(k)))assert.equal(before[k],after[k],k);assert.equal(after.account,'buyer_a');assert.equal(store.history(first.id).length,history.length+1);assert.equal(store.history(first.id)[0].action,'backfill-account');assert.deepEqual(store.history(first.id).slice(1),history);assert.throws(()=>store.update(first.id,first),/刷新/);
  assert.equal(store.get(custom.id).account,'自定义采购组');assert.equal(store.get(collision.id).account,'默认账号');const count=store.db.prepare('SELECT count(*) AS n FROM audit').get().n;store.close();store=openStore(dir);assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n,count);assert.equal(store.get(first.id).account,'buyer_a');
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('导入预览显示识别账号，入库后再次预览全部去重，备用账号变更不覆盖原表账号',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-account-api-'));const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());const headers={'x-purchase-token':boot.token};const preview=async()=>{const f=new FormData();f.append('file',new Blob([csv]),'accounts.csv');f.append('account','备用');f.append('platform','1688');return fetch(url+'/api/import/preview',{method:'POST',headers,body:f}).then(r=>r.json());};const p=await preview();assert.deepEqual(p.orders.map(o=>o.account),['buyer_a','buyer_b']);
  const remap=await fetch(url+'/api/import/'+p.id+'/remap',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({account:'新的备用'})}).then(r=>r.json());assert.equal(remap.orders[0].account,'buyer_a');
  const commit=await fetch(url+'/api/import/'+p.id+'/commit',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({indices:[0,1]})}).then(r=>r.json());assert.equal(commit.imported,2);assert.equal((await preview()).summary.duplicates,2);assert.deepEqual(store.list().map(o=>o.account).sort(),['buyer_a','buyer_b']);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
