import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readTable,normalizeTable} from '../lib/importer.mjs';
import {platformMapping} from '../lib/import-rules.mjs';
import {createApp} from '../server.mjs';

const headers=['订单ID','下单日期','商品名','价格','实付','数量','店名','订单状态','收货人名','收货地址','收货电话','快递公司','运单号','用户名','登录用户ID','快递状态','收货时间','平台','备注'];
const row=(status='拼过3次',received='2026-09-25 08:08:03')=>['PDD-TABLE-01','2026-09-14','五金配件',5.47,800,200,'测试店',status,'测试收件人','测试地址','138****0000','测试物流','00001234567890123456','采购账号','USER-TEST','已签收',received,'拼多多','原有备注'];
const csv=rows=>[headers,...rows].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n');
const parse=async rows=>{const t=await readTable(Buffer.from(csv(rows)),'pdd.csv');return {t,p:normalizeTable(t,{platform:'拼多多',mapping:platformMapping(t,'拼多多')})};};
test('拼多多导出字段按账号、商品单价、整单实付和收货物流映射，禁止平台错配',async()=>{
 const {t,p}=await parse([row()]);assert.throws(()=>platformMapping(t,'淘宝'),/拼多多/);assert.equal(p.orders.length,1);const o=p.orders[0];assert.deepEqual(o.errors,[]);assert.equal(o.account,'采购账号');assert.equal(o.supplier,'测试店');assert.equal(o.items[0].title,'五金配件');assert.equal(o.items[0].qty,200);assert.equal(o.items[0].unitPriceCents,547);assert.equal(o.amountCents,80000);assert.equal(o.phone,'138****0000');assert.equal(o.trackingNo,'00001234567890123456');assert.equal(o.status,'已完成');assert.ok(o.note.startsWith('原有备注\n'));assert.match(o.note,/已签收.*2026-09-25/);assert.equal(t.rows[0].cells[7],'拼过3次');assert.equal(o.paidAt,'');
 const other=row();other[13]='另一采购账号';assert.equal((await parse([row(),other])).p.orders.length,2);
});
test('仅有拼购次数不推测状态；退款取消优先，缺收货时间、逆序日期和未知状态不算已完成',async()=>{
 const cases=[row('拼过2次',''),row('拼过2次','2026-09-01'),row('未知状态'),row('退款成功'),row('交易已取消'),row('待收货')];cases.forEach((r,i)=>r[0]='CASE-'+i);
 const {p}=await parse(cases);assert.deepEqual(p.orders.map(o=>o.status),['待核对','待核对','待核对','已关闭','已关闭','待收货']);assert.ok(p.orders.every(o=>o.note==='原有备注'));assert.ok(p.orders.every(o=>o.refundCents===0));
});
test('拼多多新导出格式可预览确认入库，保存原始字段、状态依据并去重',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-pdd-export-'));const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(base+'/api/bootstrap').then(r=>r.json());
  const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{'x-purchase-token':token,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const form=()=>{const f=new FormData();f.append('platform','拼多多');f.append('file',new Blob([csv([row()])]),'pdd.csv');return f;};
  const p=await post('/api/import/preview',form());assert.equal(p.summary.valid,1);assert.equal(store.list().length,0);assert.equal((await post('/api/import/'+p.id+'/commit',{indices:[0]})).imported,1);
  const o=store.list()[0];assert.equal(o.status,'已完成');assert.match(o.note,/原始状态/);const original=JSON.parse(store.db.prepare('SELECT original FROM orders WHERE id=?').get(o.id).original);assert.equal(original.rows[0].cells[7],'拼过3次');assert.equal(original.rows[0].cells[14],'USER-TEST');
  const again=await post('/api/import/preview',form());assert.equal(again.summary.duplicates,1);assert.equal(again.summary.valid,0);
  const d=await fetch(base+'/api/dashboard?year=2026&platform='+encodeURIComponent('拼多多')).then(r=>r.json());assert.equal(d.months[8].amountCents,80000);assert.equal(d.missingPaidCount,1);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
