import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {createApp} from '../server.mjs';
test('必须选平台；淘宝专用单价、整单去重；阻止格式错配和预览改平台',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-platform-'));const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(url+'/api/bootstrap').then(r=>r.json());
  const csv='订单号,订单提交时间,订单状态,店铺名称,商品名称,型号款式,商品数量,商品金额,实付金额,运费\nTB1,2026-10-01,交易成功,测试店,甲,A,2,3.00,10.00,0\nTB1,2026-10-01,交易成功,测试店,乙,B,1,4.00,10.00,0';
  const preview=async(platform,source=csv)=>{const f=new FormData();f.append('file',new Blob([source]),'orders.csv');if(platform)f.append('platform',platform);return fetch(url+'/api/import/preview',{method:'POST',headers:{'x-purchase-token':token},body:f}).then(r=>r.json());};
  assert.match((await preview()).error,/先选择/);assert.match((await preview('1688')).error,/淘宝/);assert.match((await preview('拼多多')).error,/淘宝/);
  const p=await preview('淘宝');assert.equal(p.summary.valid,1);assert.equal(p.orders[0].amountCents,1000);assert.deepEqual(p.orders[0].items.map(i=>i.unitPriceCents),[300,400]);assert.equal(p.orders[0].account,'待补充');
  const remap=await fetch(url+'/api/import/'+p.id+'/remap',{method:'POST',headers:{'x-purchase-token':token,'content-type':'application/json'},body:JSON.stringify({platform:'1688'})}).then(r=>r.json());assert.match(remap.error,/重新上传/);
  assert.match((await preview('淘宝','采购平台,订单编号,日期,供应商,实付金额\n1688,A,2026-10-01,店,10')).error,/不一致/);
  assert.equal(store.list().length,0);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('拼多多表格仍可预览、确认入库和去重，保留商品及收货物流',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-pdd-table-'));
 const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(url+'/api/bootstrap').then(r=>r.json());
  const headers=['采购账号','订单编号','下单日期','供应商','商品名称','数量','单位','单价(元)','实付金额','订单状态','收货人姓名','收货地址','联系手机','物流公司','运单号'];
  const rows=[['测试采购号','PDD-TABLE-001','2026-10-01','测试商店','配件甲',2,'个','4.50','10.00','交易成功','测试收件人','测试地址','138****0000','测试物流','00001234567890123456'],['测试采购号','PDD-TABLE-001','2026-10-01','测试商店','配件乙',1,'件','3.00','10.00','交易成功','测试收件人','测试地址','138****0000','测试物流','00001234567890123456']];
  const wb=new ExcelJS.Workbook();wb.addWorksheet('订单').addRows([headers,...rows]);const xlsx=await wb.xlsx.writeBuffer();
  const preview=async(source,name)=>{const form=new FormData();form.append('platform','拼多多');form.append('file',new Blob([source]),name);const r=await fetch(url+'/api/import/preview',{method:'POST',headers:{'x-purchase-token':token},body:form});assert.equal(r.status,200);return r.json();};
  const p=await preview(xlsx,'pdd.xlsx');assert.equal(p.summary.valid,1);assert.equal(store.list().length,0);
  const o=p.orders[0];assert.equal(o.platform,'拼多多');assert.equal(o.amountCents,1000);assert.deepEqual(o.items.map(i=>[i.qty,i.unit,i.unitPriceCents]),[[2,'个',450],[1,'件',300]]);assert.equal(o.phone,'138****0000');assert.equal(o.trackingNo,'00001234567890123456');
  const commit=await fetch(url+'/api/import/'+p.id+'/commit',{method:'POST',headers:{'x-purchase-token':token,'content-type':'application/json'},body:JSON.stringify({indices:[0]})});assert.equal(commit.status,200);assert.equal((await commit.json()).imported,1);assert.equal(store.list().length,1);assert.ok(fs.readdirSync(path.join(dir,'originals')).some(f=>f.endsWith('.xlsx')));
  const again=await preview([headers,...rows].map(r=>r.join(',')).join('\n'),'pdd.csv');assert.equal(again.summary.duplicates,1);assert.equal(again.summary.valid,0);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('已移除的采集接口、扩展文件与 JSON 导入不再可用',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-removed-collector-'));
 const {app,store}=createApp({dataDir:dir});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{
  const {token}=await fetch(url+'/api/bootstrap').then(r=>r.json());
  for(const endpoint of ['/api/collector/status','/api/collector/extension','/pdd.js'])assert.equal((await fetch(url+endpoint)).status,404);
  for(const endpoint of ['pair','receive','preview'])assert.equal((await fetch(url+'/api/collector/'+endpoint,{method:'POST',headers:{'x-purchase-token':token,'content-type':'application/json'},body:'{}'})).status,404);
  const crossOrigin=await fetch(url+'/api/collector/receive',{method:'OPTIONS',headers:{origin:'chrome-extension://'+'a'.repeat(32),'access-control-request-method':'POST','access-control-request-headers':'content-type,x-collector-code'}});assert.equal(crossOrigin.status,403);assert.equal(crossOrigin.headers.get('access-control-allow-origin'),null);
  const form=new FormData();form.append('platform','拼多多');form.append('file',new Blob(['{"version":1,"records":[]}']),'capture.json');const r=await fetch(url+'/api/import/preview',{method:'POST',headers:{'x-purchase-token':token},body:form});assert.equal(r.status,400);assert.match((await r.json()).error,/xlsx.*csv/);assert.equal(store.list().length,0);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
