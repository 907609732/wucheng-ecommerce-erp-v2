import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';
import {createApp} from '../server.mjs';
import {openOrderImages} from '../lib/order-images.mjs';
import {readImageWorkbook,imageLinks} from '../lib/source-images.mjs';
import {downloadImage,imageUrl,isPublicAddress,MAX_IMAGE_BYTES} from '../lib/image-download.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const pixel=color=>sharp({create:{width:24,height:18,channels:3,background:color}}).png().toBuffer();
const head=['订单编号','下单日期','付款日期','采购账号','供应商','商品名称','规格','数量','实付金额','订单状态','商品图'];
const record=(id,title='物品甲',account='账号甲',url='')=>[id,'2026-08-01','2026-08-02',account,'测试供应商',title,'规格甲',1,100,'已完成',url];
async function workbookFixture({prefixed=false}={}){
 const wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet('采购'),other=wb.addWorksheet('其他表');sheet.addRow(head);other.addRow(head);
 sheet.addRow(record('SAME','物品甲'));sheet.addRow(record('SAME','物品乙','账号乙'));sheet.addRow(record('OTHER','物品丙'));other.addRow(record('OTHER-SHEET'));
 const a=await pixel('red'),b=await pixel('blue'),red=wb.addImage({buffer:a,extension:'png'}),blue=wb.addImage({buffer:b,extension:'png'});
 sheet.addImage(red,{tl:{col:10,row:1},ext:{width:24,height:18}});sheet.addImage(red,{tl:{col:10,row:1},ext:{width:24,height:18}});sheet.addImage(blue,{tl:{col:10,row:1},ext:{width:24,height:18}});sheet.addImage(blue,{tl:{col:10,row:2},ext:{width:24,height:18}});other.addImage(red,{tl:{col:10,row:1},ext:{width:24,height:18}});
 sheet.getCell('K4').value={text:'查看商品图',hyperlink:'https://images.example.test/third.png'};
 const zip=await JSZip.loadAsync(await wb.xlsx.writeBuffer());
 if(prefixed){for(const name of ['xl/workbook.xml','xl/worksheets/sheet1.xml']){const s=await zip.file(name).async('string');zip.file(name,s.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g,'<$1x:$2'));}}
 // Actual legacy files use .bin even for a browser-supported image format.
 zip.file('xl/media/image1.bin',await zip.file('xl/media/image1.png').async('nodebuffer'));zip.remove('xl/media/image1.png');
 for(const name of Object.keys(zip.files).filter(n=>n.endsWith('.rels'))){const s=await zip.file(name).async('string');zip.file(name,s.replaceAll('image1.png','image1.bin'));}
 return {buffer:await zip.generateAsync({type:'nodebuffer'}),red:a,blue:b};
}
async function fixture(t,downloader,{hidden=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),hidden?'.purchase-images-':'purchase-images-')),{app,store}=createApp({dataDir:dir,imageDownloader:downloader}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(url+'/api/bootstrap')).json();
 const request=async(route,body={},authenticated=true)=>{const r=await fetch(url+route,{method:'POST',headers:{...(authenticated?{'X-Purchase-Token':token}:{}),...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
 const importFile=async(buffer,name='images.xlsx')=>{const form=new FormData();form.set('platform','微信');form.set('file',new Blob([buffer]),name);const p=await request('/api/import/preview',form);assert.equal(p.status,200);const result=await request('/api/import/'+p.id+'/commit',{indices:p.orders.filter(o=>o.importStatus==='ready').map(o=>o.index)});assert.equal(result.status,200);return {p,result};};
 return {dir,store,url,request,importFile};
}
const business=store=>Object.fromEntries(['orders','audit','imports','order_supplements','settings','month_confirmations','month_events'].map(table=>[table,store.db.prepare('SELECT * FROM '+table).all()]));

test('特殊命名空间、bin、叠图按来源行及账号关联；相同图片去重，锁定账本保持只读',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-12-15T00:00:00+08:00')});const f=await fixture(t,()=>pixel('green'),{hidden:true}),file=await workbookFixture({prefixed:true});await f.importFile(file.buffer);
 const password='Synthetic-only-842716';await f.store.monthLocks.setPassword({password,confirmation:password});f.store.monthLocks.confirm(f.store.monthLocks.preview('2026-08','微信'));const before=business(f.store);
 const orders=f.store.list(),a=orders.find(o=>o.account==='账号甲'&&o.orderNo==='SAME'),b=orders.find(o=>o.account==='账号乙'),other=orders.find(o=>o.orderNo==='OTHER');
 const p=await f.request(`/api/orders/${a.id}/images/prepare`);assert.equal(p.status,200);assert.equal(p.images.length,2);assert.ok(p.images.every(i=>i.needsReview));assert.ok(p.images.every(i=>i.bindings[0].row===2));
 for(const i of p.images)assert.equal((await f.request(`/api/orders/${a.id}/images/${i.id}/cache`)).status,200);
 const again=await f.request(`/api/orders/${a.id}/images/prepare`);assert.equal(again.images.length,2);assert.ok(again.images.every(i=>i.status==='ready'));assert.equal(again.images[0].bindings[0].itemIndex,0);
 const pb=await f.request(`/api/orders/${b.id}/images/prepare`);assert.equal(pb.images.length,1);assert.equal(pb.images[0].bindings[0].row,3);assert.equal(pb.images[0].needsReview,false);
 assert.equal((await f.request(`/api/orders/${b.id}/images/${p.images[0].id}/cache`)).status,404);assert.equal((await f.request(`/api/orders/${a.id}/images/prepare`,{},false)).status,403);
 const po=await f.request(`/api/orders/${other.id}/images/prepare`);assert.equal(po.images.length,1);assert.equal(po.images[0].bindings[0].kind,'url');assert.equal(po.images[0].bindings[0].row,4);
 const response=await fetch(f.url+again.images.find(i=>i.assetId===sha(file.red)).fullUrl);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),file.red);
 assert.deepEqual(business(f.store),before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM order_images').get().n,4);assert.equal((await f.request(`/api/orders/${a.id}/images/prepare`)).images.length,2);assert.deepEqual(business(f.store),before);
});

test('图片链接首次缓存后离线重启可看，缺失缓存可重建，失败重试及备份恢复不重复入账',async t=>{
 let calls=0,offline=false;const red=await pixel('red'),f=await fixture(t,async()=>{calls++;if(offline)throw Error('测试断网');return red;});
 const csv='\uFEFF'+head.join(',')+'\n'+record('LINK','物品甲','账号甲','https://images.example.test/a.png').join(',');await f.importFile(Buffer.from(csv),'images.csv');const order=f.store.list()[0],before=business(f.store);
 const prepared=await f.request(`/api/orders/${order.id}/images/prepare`),image=prepared.images[0];
 await Promise.all([f.request(`/api/orders/${order.id}/images/${image.id}/cache`),f.request(`/api/orders/${order.id}/images/${image.id}/cache`)]);assert.equal(calls,1);offline=true;
 const reopened=openOrderImages(f.store,{downloader:async()=>{throw Error('不应再次联网');}});assert.equal((await reopened.prepare(order.id)).images[0].status,'ready');assert.equal((await reopened.cache(order.id,image.id)).images[0].status,'ready');assert.equal(calls,1);
 const saved=f.store.db.prepare('SELECT * FROM image_assets').get();fs.unlinkSync(path.join(f.dir,saved.thumb_path));
 const failed=await f.request(`/api/orders/${order.id}/images/${image.id}/cache`);assert.equal(failed.status,400);assert.equal((await f.request(`/api/orders/${order.id}/images/prepare`)).images[0].status,'failed');offline=false;
 const retry=await f.request(`/api/orders/${order.id}/images/${image.id}/cache`);assert.equal(retry.status,200);assert.equal(retry.images[0].status,'ready');assert.deepEqual(business(f.store),before);
 const backup=await f.request('/api/backup'),archive=await JSZip.loadAsync(Buffer.from(await(await fetch(f.url+backup.url)).arrayBuffer()));
 assert.deepEqual(await archive.file(saved.file_path).async('nodebuffer'),red);assert.ok(archive.file(saved.thumb_path));assert.ok(archive.file('purchases.sqlite'));assert.ok(!Object.keys(archive.files).some(n=>n.endsWith('.tmp')));
 const restore=path.join(f.dir,'restored');fs.mkdirSync(restore);for(const item of Object.values(archive.files)){if(item.dir)continue;const target=path.join(restore,item.name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,await item.async('nodebuffer'));}
 const restored=createApp({dataDir:restore,imageDownloader:()=>{throw Error('恢复后不应联网');}});try{const images=openOrderImages(restored.store,{downloader:()=>{throw Error('不应联网');}});assert.equal((await images.prepare(order.id)).images[0].status,'ready');assert.deepEqual(fs.readFileSync(images.resource(saved.id,'full').path),red);assert.deepEqual(business(restored.store),before);}finally{restored.store.close();}
});

test('补充原件图片关联、已编辑商品回退原表图片、缺失原件提示且已缓存图片仍可用',async t=>{
 const f=await fixture(t,()=>pixel('yellow')),file=await workbookFixture();await f.importFile(file.buffer);const a=f.store.list().find(o=>o.orderNo==='SAME'&&o.account==='账号甲');
 const source=f.store.imports()[0];f.store.db.prepare('INSERT INTO order_supplements(order_id,source_id,raw_json,fields_json,created_at) VALUES (?,?,?,?,?)').run(a.id,source.id,JSON.stringify({sheet:'采购',headers:['商品名','规格','商品图'],rows:[{row:9,cells:['物品甲','规格甲','https://images.example.test/supplement.png']}]}),JSON.stringify({filled:[],conflicts:[]}),new Date().toISOString());
 let result=await f.request(`/api/orders/${a.id}/images/prepare`);assert.equal(result.images.length,3);const extra=result.images.find(i=>i.bindings[0].row===9);assert.equal(extra.bindings[0].itemIndex,0);
 await f.request(`/api/orders/${a.id}/images/${extra.id}/cache`);f.store.update(a.id,{...a,items:[{...a.items[0],title:'已改成新商品'}]});result=await f.request(`/api/orders/${a.id}/images/prepare`);assert.ok(result.images.every(i=>i.bindings[0].itemIndex===null));assert.ok(result.images.every(i=>i.bindings[0].title==='物品甲'));
 const raw=f.store.db.prepare('SELECT file_path FROM imports WHERE id=?').get(source.id);fs.unlinkSync(path.join(f.dir,raw.file_path));result=await f.request(`/api/orders/${a.id}/images/prepare`);assert.match(result.warnings.join(''),/原始文件缺失/);assert.equal(result.images.find(i=>i.id===extra.id).status,'ready');
});

test('图片读取不改变去重指纹；重复源表、无图片、无效订单及资源参数保持兼容',async t=>{
 const f=await fixture(t,()=>pixel('red'));const csv='\uFEFF'+head.join(',')+'\n'+record('EMPTY').join(',');await f.importFile(Buffer.from(csv),'plain.csv');const o=f.store.list()[0];const p=await f.request(`/api/orders/${o.id}/images/prepare`);assert.deepEqual(p.images,[]);assert.deepEqual(p.warnings,[]);
 const form=new FormData();form.set('platform','微信');form.set('file',new Blob([csv]),'plain.csv');const preview=await f.request('/api/import/preview',form);assert.equal(preview.summary.duplicates,1);assert.equal(f.store.get(o.id).fingerprint,o.fingerprint);
 assert.equal((await f.request('/api/orders/not-an-order/images/prepare')).status,404);assert.equal((await fetch(f.url+'/api/images/no-such-image')).status,404);assert.equal((await fetch(f.url+'/api/images/no-such-image?size=../../secret')).status,400);
});

test('公网图片下载阻止内网、地址混合、重定向绕过，固定 DNS 地址且限制大小与超时',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','0.0.0.0'])assert.equal(isPublicAddress(address),false,address);
 assert.equal(isPublicAddress('8.8.8.8'),true);for(const url of ['file:///x','http://localhost/a','http://127.1/a','http://2130706433/a','http://[::1]/a','https://user:pass@images.example.test/a','http://images.example.test:1234/a'])assert.throws(()=>imageUrl(url));
 let requests=0;await assert.rejects(downloadImage('https://images.example.test/a',{lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request:()=>{requests++;}}),/非公网/);assert.equal(requests,0);
 const lookup=async()=>[{address:'8.8.8.8',family:4}];
 const response=(status,headers,body)=>{return (_url,options,callback)=>{requests++;options.lookup('images.example.test',{all:true},(e,a)=>assert.deepEqual(a,[{address:'8.8.8.8',family:4}]));const req=new EventEmitter();req.end=()=>{const res=Readable.from(body?[body]:[]);res.statusCode=status;res.headers=headers;callback(res);};return req;};};
 await assert.rejects(downloadImage('https://images.example.test/a',{lookup,request:response(302,{location:'http://127.0.0.1/secret'})}),/内网/);
 await assert.rejects(downloadImage('https://images.example.test/a',{lookup,request:response(200,{'content-type':'text/html'},Buffer.from('<html>'))}),/不是图片/);
 await assert.rejects(downloadImage('https://images.example.test/a',{lookup,request:response(200,{'content-length':MAX_IMAGE_BYTES+1})}),/10 MB/);
 await assert.rejects(downloadImage('https://images.example.test/a',{lookup,request:response(200,{},Buffer.alloc(MAX_IMAGE_BYTES+1))}),/10 MB/);
 await assert.rejects(downloadImage('https://images.example.test/a',{lookup:()=>new Promise(()=>{}),timeoutMs:20}),/超时/);
 const good=Buffer.from('test');assert.deepEqual(await downloadImage('https://images.example.test/a',{lookup,request:response(200,{'content-type':'image/png'},good)}),good);
});

test('损坏内容、超限图片不会留下成功缓存；明确图片公式和超链接可读',async t=>{
 let payload=Buffer.from('<html>not an image</html>');const f=await fixture(t,async()=>payload);
 const csv='\uFEFF'+head.join(',')+'\n'+record('BROKEN','物品甲','账号甲','https://images.example.test/bad').join(',');await f.importFile(Buffer.from(csv),'bad.csv');const o=f.store.list()[0],p=await f.request(`/api/orders/${o.id}/images/prepare`),route=`/api/orders/${o.id}/images/${p.images[0].id}/cache`;
 assert.equal((await f.request(route)).status,400);payload=Buffer.alloc(MAX_IMAGE_BYTES+1);assert.equal((await f.request(route)).status,400);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_assets').get().n,0);assert.deepEqual(fs.readdirSync(path.join(f.dir,'images')),[]);
 assert.deepEqual(imageLinks('IMAGE("https://images.example.test/a.png", "caption")'),['https://images.example.test/a.png']);assert.deepEqual(imageLinks('=HYPERLINK("https://images.example.test/a.png","图片")'),['https://images.example.test/a.png']);
 const file=await workbookFixture();const book=await readImageWorkbook(file.buffer);assert.equal(book.sheets[0].links[0].row,4);assert.equal(book.sheets[1].images.length,1);
});
