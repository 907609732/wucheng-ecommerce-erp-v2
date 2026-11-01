import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {money,dateValue,normalizeTable,readTable,validateOrder,extractText} from '../lib/importer.mjs';
import {openStore,summarize} from '../lib/store.mjs';
import {createApp} from '../server.mjs';

const base=()=>({platform:'手工',account:'默认账号',orderNo:'TEST-001',date:'2026-01-31',paidAt:'2026-02-01',supplier:'测试供应商',amountCents:10001,refundCents:101,shippingCents:500,status:'已完成',note:'',items:[{title:'配件',spec:'M5',sku:'',qty:2,unitPriceCents:4750}]});
const csv=Buffer.from('订单编号,下单日期,付款日期,供应商,商品名称,数量,实付金额,订单状态\nA1,2026-01-01,2026-01-02,五金店,商品一,2,99.90,交易成功\nA1,2026-01-01,2026-01-02,五金店,商品二,3,99.90,交易成功\nA2,2026-02-01,,五金店,退单商品,1,10.00,交易关闭\n');
test('金额精确到分，拒绝缺失、负数、混合文本及超精度',()=>{assert.equal(money('¥1,234.56'),123456);assert.equal(money(0),0);assert.equal(money('0.29'),29);for(const v of ['',-1,'10元abc','2.333','1e3'])assert.throws(()=>money(v));});
test('日期校验与 Excel serial 不产生错误归月',()=>{assert.equal(dateValue('2026/2/28 23:59:59'),'2026-02-28');assert.equal(dateValue('2024年2月29日'),'2024-02-29');assert.throws(()=>dateValue('2026-02-29'));assert.throws(()=>dateValue('2026-13-01'));});
test('整单重复金额仅计一次，保留全部商品行',async()=>{const t=await readTable(csv,'x.csv'),r=normalizeTable(t);assert.equal(r.orders.length,2);assert.equal(r.orders[0].items.length,2);assert.equal(r.orders[0].amountCents,9990);assert.equal(r.orders[1].status,'已关闭');assert.equal(r.issues.length,0);});
test('逐行金额模式、冲突金额与异常行',async()=>{const t=await readTable(csv,'x.csv');assert.equal(normalizeTable(t,{amountMode:'line'}).orders[0].amountCents,19980);t.rows[1].cells[6]='100';assert.match(normalizeTable(t).orders[0].errors[0],/不同金额/);t.rows[0].cells[0]='';assert.equal(normalizeTable(t).issues.length,1);});
test('月度看板区分付款和下单，排除关闭和待核对，扣已知退款',()=>{const a=base(),b={...base(),orderNo:'2',status:'已关闭',amountCents:90000},c={...base(),orderNo:'3',status:'待核对'},d={...base(),orderNo:'4',paidAt:'',amountCents:999,refundCents:0};const paid=summarize([a,b,c,d],2026,'paid');assert.equal(paid.netCents,10899);assert.equal(paid.orderCount,2);assert.equal(paid.excludedCount,2);assert.equal(paid.months[0].netCents,999);assert.equal(paid.months[1].netCents,9900);assert.equal(paid.missingPaidCount,1);assert.equal(summarize([a],2026,'created').months[0].netCents,9900);});
test('文字提取保留缺失字段，不能编造日期或金额',()=>{const o=extractText('订单号：PO20261013001\n供应商：五金店\n日期：2026-10-13\n商品：螺丝\n数量：2\n实付金额：128.50');assert.equal(o.orderNo,'PO20261013001');assert.equal(o.amountCents,12850);assert.equal(o.date,'2026-10-13');assert.equal(o.supplier,'五金店');assert.equal(o.items[0].title,'螺丝');assert.equal(o.items[0].qty,2);assert.equal(extractText('没有金额日期').amountCents,null);assert.equal(extractText('没有金额日期').date,'');assert.throws(()=>validateOrder({...base(),amountCents:null}));});
test('持久化、去重、更新审计、并发版本与备份恢复',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-test-'));let store=openStore(dir);try{const o=store.transaction(()=>store.insert(base(),null));assert.equal(store.find(base()).id,o.id);assert.throws(()=>store.transaction(()=>store.insert(base(),null)));const next=store.update(o.id,{...o,refundCents:200});assert.equal(store.history(o.id).length,2);assert.throws(()=>store.update(o.id,{...o,amountCents:20000}),/刷新/);assert.throws(()=>validateOrder({...base(),refundCents:20000}));await store.backup(path.join(dir,'copy.sqlite'));store.close();store=openStore(dir);assert.equal(store.get(o.id).refundCents,200);assert.equal(store.get(o.id).updatedAt,next.updatedAt);}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}});
test('导入接口预览不写账、二次导入去重、保护写操作、CSV 导出与备份',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-api-'));const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;try{
 const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());assert.equal(boot.orders.length,0);assert.equal((await fetch(url+'/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(base())})).status,403);
 const request=async(p,b)=>{const r=await fetch(url+p,{method:'POST',headers:{'x-purchase-token':boot.token,...(b instanceof FormData?{}:{'content-type':'application/json'})},body:b instanceof FormData?b:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw Error(j.error);return j;};
 const form=()=>{const f=new FormData();f.append('file',new Blob([csv]),'sample.csv');f.append('platform','1688');return f;};
 const custom=new FormData();custom.append('file',new Blob(['编号,日子,店家,货名,合计钱\nCUSTOM1,2026-10-01,测试店,螺丝,13.50']),'custom.csv');custom.append('platform','拼多多');const unmapped=await request('/api/import/preview',custom);assert.equal(unmapped.summary.valid,0);assert.ok(unmapped.headers.length);const mapped=await request('/api/import/'+unmapped.id+'/remap',{mapping:{orderNo:'0',date:'1',supplier:'2',title:'3',amount:'4'}});assert.equal(mapped.summary.valid,1);assert.equal(mapped.orders[0].platform,'拼多多');assert.equal(mapped.orders[0].status,'待核对');
 const p=await request('/api/import/preview',form());assert.equal(store.list().length,0);assert.equal(p.summary.orders,2);const r=await request('/api/import/'+p.id+'/commit',{indices:[0,1]});assert.equal(r.imported,2);assert.equal(store.list().length,2);const again=await request('/api/import/preview',form());assert.equal(again.summary.duplicates,2);assert.equal(again.summary.valid,0);
 const conflictForm=new FormData();conflictForm.append('file',new Blob([csv.toString().replaceAll('99.90','111.00')]),'changed.csv');conflictForm.append('platform','1688');const conflict=await request('/api/import/preview',conflictForm);assert.equal(conflict.summary.conflicts,1);
 const s=await fetch(url+'/api/dashboard?year=2026').then(r=>r.json());assert.equal(s.netCents,9990);assert.equal(s.excludedCents,1000);const exported=await fetch(url+'/api/export').then(r=>r.text());assert.match(exported,/A1/);assert.match(exported,/99.90/);const backup=await request('/api/backup',{});assert.equal((await fetch(url+backup.url)).status,200);assert.ok(fs.statSync(path.join(dir,'backups',backup.filename)).size>100);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}});


test('平台列表和月度确认不再提供手工，文本录入默认其他且旧订单可读取',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-platform-')),store=openStore(dir);
 try{
  const rows=store.monthLocks.overview('2026-01').platforms;
  assert.equal(rows.length,7);
  assert.equal(rows.some(p=>p.platform==='手工'),false);
  assert.equal(extractText('商品：测试').platform,'其他');
  const legacy=store.insert(validateOrder(base()),null);
  assert.equal(store.get(legacy.id).platform,'手工');
  assert.equal(store.monthLocks.preview('2026-02','手工').count,1);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('看板快捷月份遵守付款与下单口径、平台和分类筛选，空月份金额为零',()=>{
 const rows=[{...base(),platform:'微信'},{...base(),platform:'淘宝',orderNo:'SECOND',date:'2026-02-01',paidAt:'2026-03-01',amountCents:20000,refundCents:0}];
 assert.equal(summarize(rows,2026,'paid','全部','','02').netCents,9900);
 assert.equal(summarize(rows,2026,'created','全部','','02').netCents,20000);
 assert.equal(summarize(rows,2026,'paid','淘宝','','02').orderCount,0);
 assert.equal(summarize(rows,2026,'paid','全部','expense','02').netCents,0);
 assert.equal(summarize(rows,2026,'paid','全部','','12').netCents,0);
 assert.equal(summarize(rows,2026).netCents,29900);
 assert.throws(()=>summarize(rows,2026,'paid','全部','','13'),/月份/);
});
