import fs from 'node:fs';
import path from 'node:path';
import {id,hash,fail} from './util.mjs';
const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
export function paymentEvidencePath(e){
 if(!e||!/^[a-f0-9-]{36}$/.test(e.id)||!extensions[e.mime])throw fail('付款凭证信息无效');
 return 'originals/payment-'+e.id+'.'+extensions[e.mime];
}
function imageType(buffer){
 if(buffer.length>=33&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&buffer.toString('ascii',12,16)==='IHDR')return 'image/png';
 if(buffer.length>=4&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255&&buffer.at(-2)===255&&buffer.at(-1)===217)return 'image/jpeg';
 if(buffer.length>=16&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return 'image/webp';
 throw fail('凭证图片只支持有效的 PNG、JPEG、WebP 文件');
}
function originalPath(dir,e){
 const folder=path.join(dir,'originals');
 if(fs.lstatSync(folder).isSymbolicLink())throw fail('付款凭证目录不能是链接');
 return path.join(dir,paymentEvidencePath(e));
}
export function paymentEvidenceReferences(db){
 return db.prepare('SELECT payload FROM payments').all().flatMap(row=>(JSON.parse(row.payload).evidence||[]).map(e=>{
  if(!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isSafeInteger(e.bytes)||e.bytes<=0)throw fail('付款凭证校验信息无效');
  return {path:paymentEvidencePath(e),sha256:e.sha256,filename:e.filename};
 }));
}
export function savePaymentWithEvidence(s,billId,input,files=[]){
 if(!Array.isArray(files)||files.length>6)throw fail('每次最多上传6张付款凭证');
 if(Object.hasOwn(input,'evidence'))throw fail('付款凭证须通过图片上传提交');
 const items=files.map(file=>{
  if(!Buffer.isBuffer(file.buffer)||!file.buffer.length||file.buffer.length>10*1024*1024)throw fail('每张凭证图片须在10MB以内');
  const meta={id:id(),mime:imageType(file.buffer),filename:path.win32.basename(path.posix.basename(String(file.originalname||'付款凭证'))).replace(/[\x00-\x1f]/g,'').slice(0,180),bytes:file.buffer.length,sha256:hash(file.buffer)};
  return {meta,buffer:file.buffer};
 });
 const created=[];
 try{return s.tx(()=>{
  const payment=s.addPayment(billId,input,{evidence:items.map(item=>item.meta)});
  for(const item of items){const file=originalPath(s.dir,item.meta),fd=fs.openSync(file,'wx');created.push(file);try{fs.writeFileSync(fd,item.buffer);}finally{fs.closeSync(fd);}}
  return payment;
 });}catch(error){for(const file of created)try{fs.unlinkSync(file);}catch{}throw error;}
}
export function readPaymentEvidence(s,paymentId,evidenceId){
 const payment=s.payments().find(p=>p.id===paymentId),e=payment?.evidence?.find(item=>item.id===evidenceId);
 if(!e)throw fail('付款凭证不存在',404);
 const file=originalPath(s.dir,e);
 if(!fs.existsSync(file))throw fail('付款凭证原件缺失',404);
 if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw fail('付款凭证原件无效');
 const buffer=fs.readFileSync(file);
 if(buffer.length!==e.bytes||hash(buffer)!==e.sha256)throw fail('付款凭证原件校验失败');
 return {...e,buffer};
}
