import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {fixture,bill} from './helpers.mjs';
import {savePaymentWithEvidence,paymentEvidencePath,readPaymentEvidence} from '../lib/payment-evidence.mjs';
import {makeBackup,restoreBackup} from '../lib/files.mjs';
import {openStore} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=','base64');
const image=(extra={})=>({originalname:'付款.png',buffer:png,mimetype:'image/png',...extra});
const input=b=>({version:b.version,date:'2026-09-30',direction:'pay',amountCents:1000,reference:'PAY-TEST',note:'付款测试'});
test('付款和图片同时保存，撤销仍保留历史凭证；备份恢复带回原图',async()=>{
 const f=fixture();try{const b=f.s.createBill(bill(),f.sources()),p=savePaymentWithEvidence(f.s,b.id,input(b),[image()]);assert.equal(f.s.paid(b.id),1000);assert.equal(p.evidence.length,1);assert.deepEqual(readPaymentEvidence(f.s,p.id,p.evidence[0].id).buffer,png);
  f.s.voidPayment(p.id,{reason:'撤销测试'});assert.deepEqual(readPaymentEvidence(f.s,p.id,p.evidence[0].id).buffer,png);
  const backup=await makeBackup(f.s),bytes=fs.readFileSync(path.join(f.s.dir,'backups',backup.name)),restored=await restoreBackup(bytes,f.dir),s=openStore(restored.path);try{assert.deepEqual(readPaymentEvidence(s,p.id,p.evidence[0].id).buffer,png);}finally{s.close();}
  const z=await JSZip.loadAsync(bytes),rel=paymentEvidencePath(p.evidence[0]),manifest=JSON.parse(await z.file('manifest.json').async('string'));z.remove(rel);delete manifest.files[rel];z.file('manifest.json',JSON.stringify(manifest));await assert.rejects(restoreBackup(await z.generateAsync({type:'nodebuffer'}),f.dir),/缺少已引用原件/);
 }finally{f.close();}
});
test('无效图片、过量上传和事务失败不留下付款或孤立图片',()=>{
 const f=fixture();try{const b=f.s.createBill(bill(),f.sources());assert.throws(()=>savePaymentWithEvidence(f.s,b.id,input(b),[image({buffer:Buffer.from('<svg onload="alert(1)"/>')})]),/图片/);assert.throws(()=>savePaymentWithEvidence(f.s,b.id,input(b),Array(7).fill(image())),/6/);
  const exec=f.s.db.exec;let fail=true;f.s.db.exec=(sql,...args)=>{if(sql==='COMMIT'&&fail){fail=false;throw Error('模拟磁盘提交失败');}return exec(sql,...args);};assert.throws(()=>savePaymentWithEvidence(f.s,b.id,input(b),[image()]),/模拟磁盘/);f.s.db.exec=exec;
  assert.equal(f.s.payments().length,0);assert.equal(fs.readdirSync(path.join(f.s.dir,'originals')).length,0);assert.throws(()=>paymentEvidencePath({id:'../secret',mime:'image/png'}),/凭证/);
 }finally{f.close();}
});
test('multipart付款API可上传并查看图片，原JSON付款仍兼容',async()=>{
 const f=fixture(),a=createApp({dataDir:path.join(f.dir,'api-evidence'),sources:f.paths}),server=a.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{const b=a.store.createBill(bill(),f.sources()),boot=await fetch(base+'/api/bootstrap').then(r=>r.json()),fd=new FormData();fd.set('data',JSON.stringify(input(b)));fd.append('images',new Blob([png],{type:'image/png'}),'payment.png');const r=await fetch(base+'/api/bills/'+b.id+'/payments',{method:'POST',headers:{'X-Overview-Token':boot.token},body:fd});assert.equal(r.status,200);const p=await r.json();const original=await fetch(base+'/api/payments/'+p.id+'/evidence/'+p.evidence[0].id);assert.equal(original.status,200);assert.equal(original.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await original.arrayBuffer()),png);
  const plain=await fetch(base+'/api/bills/'+b.id+'/payments',{method:'POST',headers:{'X-Overview-Token':boot.token,'Content-Type':'application/json'},body:JSON.stringify({...input(a.store.bill(b.id)),reference:'PAY-JSON'})});assert.equal(plain.status,200);assert.equal(a.store.payments().length,2);
 }finally{await new Promise(resolve=>server.close(resolve));await a.cainiao.close();a.store.close();f.close();}
});
