import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore,createApp,createSessionFetch} from './helpers.mjs';
import {deleteEmptyShop} from '../lib/shops.mjs';
import {addLedger} from '../lib/ledger.mjs';

test('删除空店铺保留审计，默认店铺重启不会复活',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-shop-delete-'));let s=openStore(dir);
 try{const shop=s.shops().find(item=>item.id==='offline');assert.ok(shop);assert.throws(()=>deleteEmptyShop(s,shop.id,{name:'另一个店',confirm:true}),/核对店铺名称/);assert.ok(s.shops().some(item=>item.id===shop.id));
 const result=deleteEmptyShop(s,shop.id,{name:shop.name,confirm:true});assert.equal(result.ok,true);assert.equal(s.get("SELECT COUNT(*) n FROM audit WHERE action='shop.delete'").n,1);s.close();s=openStore(dir);assert.equal(s.shops().some(item=>item.id===shop.id),false);
 }finally{s.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'sales-shop-delete-')));fs.rmSync(dir,{recursive:true,force:true});}
});
test('有流水、导入原件或锁定快照的店铺不能删除',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-shop-delete-')),s=openStore(dir);
 try{const shop=s.shops().find(item=>item.id==='offline');addLedger(s,{shop_id:shop.id,date:'2026-09-01',kind:'sale',amount:'10.00',external_id:'keep-sale'});
 assert.throws(()=>deleteEmptyShop(s,shop.id,{name:shop.name,confirm:true}),error=>error.code==='SHOP_HAS_RECORDS');assert.equal(s.get('SELECT COUNT(*) n FROM ledger').n,1);
 const empty=s.shops().find(item=>item.id==='dropship');s.run('INSERT INTO month_locks VALUES(?,?,?,?)','2026-08','test',JSON.stringify({shops:[{id:empty.id}]}),'2026-09-01');assert.throws(()=>deleteEmptyShop(s,empty.id,{name:empty.name,confirm:true}),error=>error.code==='SHOP_HAS_RECORDS');
 const imported=s.shops().find(item=>item.id==='tb-diankou');s.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)','original-only',imported.id,'ledger','原件.csv','synthetic-sha','originals/kept.csv','2026-10-01','staged','{}','{}');assert.throws(()=>deleteEmptyShop(s,imported.id,{name:imported.name,confirm:true}),error=>error.code==='SHOP_HAS_RECORDS');assert.ok(s.get('SELECT 1 FROM imports WHERE id=?','original-only'));
 }finally{s.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'sales-shop-delete-')));fs.rmSync(dir,{recursive:true,force:true});}
});
test('真实HTTP删除仅老板可用，确认名称与业务引用都在服务端校验',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-shop-delete-'));const {app,store}=createApp({dataDir:dir,port:18877,demo:true}),server=app.listen(18877,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'sales-shop-delete-')));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:18877',token=(await(await fetch(base+'/api/bootstrap')).json()).token,boss=await createSessionFetch(base,'boss'),employee=await createSessionFetch(base,'employee');
 const shop=store.shops().find(item=>item.id==='tb-diankou'),options={method:'DELETE',headers:{'content-type':'application/json','x-sales-token':token},body:JSON.stringify({name:shop.name,confirm:true})};
 assert.equal((await employee(base+'/API/SHOPS/'+shop.id,options)).status,403);assert.equal((await boss(base+'/api/shops/'+shop.id,{...options,body:JSON.stringify({name:'错误名称',confirm:true})})).status,409);
 assert.equal((await boss(base+'/api/shops/'+shop.id,options)).status,200);assert.equal(store.get('SELECT 1 FROM shops WHERE id=?',shop.id),undefined);assert.equal((await boss(base+'/api/shops/'+shop.id,options)).status,404);
});
