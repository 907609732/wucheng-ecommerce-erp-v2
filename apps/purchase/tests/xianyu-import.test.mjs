import {parse as parseCsv} from 'csv-parse/sync';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {readTable,normalizeTable,validateOrder,statusValue} from '../lib/importer.mjs';
import {platformMapping} from '../lib/import-rules.mjs';
import {createApp} from '../server.mjs';
import {openStore} from '../lib/store.mjs';

const headers=['订单号','创建时间','商品标题','实付款','数量','订单状态','卖家昵称','收货地址','运费','闲鱼币抵扣','付款时间','登录账号昵称','登录用户ID'];
async function fixture(){
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('闲鱼订单');ws.addRow(headers);
 ws.addRow(['100000000000000001',new Date('2026-03-01T00:30:00Z'),'配件',292,1,'交易成功','测试卖家','测试买家 13800000000 测试省测试市测试路 10 号',12,'',new Date('2026-03-01T00:31:00Z'),'采购甲','USER-A']);
 ws.addRow(['100000000000000001',new Date('2026-03-02T01:00:00Z'),'零件',10,2,'交易关闭','另一卖家','地址格式待核对',0,'',new Date('2026-03-02T01:01:00Z'),'采购乙','USER-B']);
 for(const r of [2,3])for(const c of [2,11])ws.getCell(r,c).numFmt='yyyy-mm-dd hh:mm:ss';
 const zip=await JSZip.loadAsync(await wb.xlsx.writeBuffer());
 const workbook=await zip.file('xl/workbook.xml').async('string');
 zip.file('xl/workbook.xml',workbook.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g,'<$1x:$2'));
 return zip.generateAsync({type:'nodebuffer'});
}
test('兼容带前缀的 Excel XML，日期不跨日，登录账号不误用卖家，缺少单价保留空值',async()=>{
 assert.equal(statusValue('等待买家收货'),'待收货');assert.equal(statusValue('交易关闭，有退款'),'已关闭');
 const table=await readTable(await fixture(),'xianyu.xlsx');
 assert.equal(table.rows[0].cells[1],'2026-03-01 00:30:00');assert.equal(table.rows[0].cells[0],'100000000000000001');
 assert.throws(()=>platformMapping(table,'淘宝'),/闲鱼/);
 const p=normalizeTable(table,{platform:'闲鱼',mapping:platformMapping(table,'闲鱼')});assert.equal(p.orders.length,2);assert.deepEqual(p.issues,[]);
 const a=p.orders[0];assert.deepEqual(a.errors,[]);assert.equal(a.account,'采购甲');assert.equal(a.supplier,'测试卖家');assert.equal(a.amountCents,29200);assert.equal(a.shippingCents,1200);assert.equal(a.recipient,'测试买家');assert.equal(a.phone,'13800000000');assert.equal(a.address,'测试省测试市测试路 10 号');assert.equal(a.items[0].unitPriceCents,null);assert.equal(validateOrder(a).items[0].unitPriceCents,null);
 const b=p.orders[1];assert.equal(b.account,'采购乙');assert.equal(b.status,'已关闭');assert.equal(b.recipient,'');assert.equal(b.address,'地址格式待核对');
 const withZero={...a,items:[{...a.items[0],unitPriceCents:0}]};assert.equal(validateOrder(withZero).items[0].unitPriceCents,0);
});
test('闲鱼原件完整保存，重复上传去重，月度看板含闲鱼，空单价经编辑和导出不变成零',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-xianyu-'));const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(base+'/api/bootstrap').then(r=>r.json()),buffer=await fixture();
  const post=async(endpoint,body)=>{const r=await fetch(base+endpoint,{method:'POST',headers:{'x-purchase-token':token,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const form=()=>{const f=new FormData();f.append('platform','闲鱼');f.append('file',new Blob([buffer]),'xianyu.xlsx');return f;};
  const p=await post('/api/import/preview',form());assert.equal(p.summary.valid,2);assert.equal(store.list().length,0);
  const c=await post('/api/import/'+p.id+'/commit',{indices:[0,1]});assert.equal(c.imported,2);
  const existing=store.list().find(o=>o.account==='采购甲');const original=store.db.prepare('SELECT original FROM orders WHERE id=?').get(existing.id);assert.equal(JSON.parse(original.original).rows[0].cells[12],'USER-A');
  const downloaded=Buffer.from(await fetch(base+'/api/source/'+existing.sourceId).then(r=>r.arrayBuffer()));assert.deepEqual(downloaded,buffer);
  const again=await post('/api/import/preview',form());assert.equal(again.summary.duplicates,2);assert.equal(again.summary.valid,0);
  const dashboard=await fetch(base+'/api/dashboard?year=2026&platform='+encodeURIComponent('闲鱼')).then(r=>r.json());assert.equal(dashboard.amountCents,29200);assert.equal(dashboard.months[2].amountCents,29200);assert.equal(dashboard.platforms.find(p=>p.name==='闲鱼').amountCents,29200);assert.equal(dashboard.excludedCents,1000);
  const updated=store.update(existing.id,{...existing,note:'已核对'},existing.updatedAt);assert.equal(updated.items[0].unitPriceCents,null);
  const csv=await fetch(base+'/api/export?platform='+encodeURIComponent('闲鱼')).then(r=>r.text());const rows=parseCsv(csv,{columns:true,bom:true});const row=rows.find(r=>r['收货人姓名']==='测试买家');assert.ok(row);assert.equal(row['单价(元)'],'');assert.equal(row['数量'],'1');assert.equal(row['单位'],'');
 }finally{await new Promise(r=>server.close(r));store.close();const reopened=openStore(dir);try{assert.equal(reopened.list().length,2);assert.ok(reopened.list().every(o=>o.items[0].unitPriceCents===null));}finally{reopened.close();fs.rmSync(dir,{recursive:true,force:true});}}
});
