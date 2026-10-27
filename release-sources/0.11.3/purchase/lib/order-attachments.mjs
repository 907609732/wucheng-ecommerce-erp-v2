import {MAX_FILES,validateUploadLimits} from '../public/upload-limits.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';

const error=(message,status=400)=>Object.assign(Error(message),{status});
const IMAGE_RE=/^image\/(jpeg|png|webp|gif)$/;
const extFor=(filename,mime)=>{
 const e=path.extname(filename||'').toLowerCase();
 if(e&&e.length<=10&&!e.includes('/'))return e;
 const map={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','application/pdf':'.pdf','text/plain':'.txt'};
 return map[mime]||'.bin';
};

// 订单附件：图片 / PDF / 文档等任意文件。先暂存（order_id 为空），订单保存时绑定。
export function openOrderAttachments(store){
 const {db,dir}=store,folder=path.join(dir,'attachments');fs.mkdirSync(folder,{recursive:true});
 db.exec(`CREATE TABLE IF NOT EXISTS order_attachments(id TEXT PRIMARY KEY,order_id TEXT,filename TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,file_path TEXT NOT NULL,thumb_path TEXT,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS order_attachments_order ON order_attachments(order_id);`);
 if(!db.prepare('PRAGMA table_info(order_attachments)').all().some(c=>c.name==='active'))db.exec('ALTER TABLE order_attachments ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
 const safeFile=relative=>{const absolute=path.resolve(dir,relative);if(!absolute.startsWith(path.resolve(dir)+path.sep))throw error('附件路径无效');return absolute;};
 async function stash(buffer,filename,mime){
  if(!Buffer.isBuffer(buffer)||!buffer.length)throw error('附件内容为空');
  validateUploadLimits([{size:buffer.length,name:filename}]);
  const id=randomUUID(),ext=extFor(filename,mime),filePath=`attachments/${id}${ext}`;
  let thumbPath=null;
  if(IMAGE_RE.test(mime||'')){
   try{const tb=await sharp(buffer,{limitInputPixels:40000000,failOn:'warning'}).rotate().resize(320,240,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();thumbPath=`attachments/${id}.thumb.webp`;fs.writeFileSync(safeFile(thumbPath),tb);}catch{}
  }
  fs.writeFileSync(safeFile(filePath),buffer);
  const name=filename||('附件'+ext);
  db.prepare('INSERT INTO order_attachments(id,order_id,filename,mime,bytes,file_path,thumb_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,null,name,mime||'application/octet-stream',buffer.length,filePath,thumbPath,new Date().toISOString());
  return {id,filename:name,mime:mime||'application/octet-stream',bytes:buffer.length,thumbUrl:thumbPath?`/api/attachments/${id}?size=thumb`:null,downloadUrl:`/api/attachments/${id}`};
 }
 const ids=orderId=>db.prepare('SELECT id FROM order_attachments WHERE order_id=? AND active=1 ORDER BY created_at,id').all(orderId).map(r=>r.id);
 function validate(orderId,values){
  if(!Array.isArray(values)||values.length>MAX_FILES||values.some(id=>typeof id!=='string'||!id||id.length>64))throw error('每单最多 20 个附件，附件列表必须有效');
  const unique=[...new Set(values)];
  const files=[];
  for(const id of unique){
   const row=db.prepare('SELECT * FROM order_attachments WHERE id=?').get(id);
   if(!row||row.order_id&&row.order_id!==orderId)throw error('附件不存在或已属于其他订单：'+id,409);
   files.push(row);
   if(!fs.existsSync(safeFile(row.file_path)))throw error('附件原文件缺失，请重新上传',409);
  }
  validateUploadLimits(files);
  return unique;
 }
 // Called inside the order transaction. Inactive, previously bound files stay available for audit/redo.
 function setActive(orderId,values){
  const selected=validate(orderId,values);
  db.prepare('UPDATE order_attachments SET active=0 WHERE order_id=?').run(orderId);
  for(const id of selected)db.prepare('UPDATE order_attachments SET order_id=?,active=1 WHERE id=?').run(orderId,id);
 }
 function bind(orderId,values){
  const order=store.get(orderId);if(!order)throw error('订单不存在',404);
  if(store.update)return store.update(orderId,{...order,attachmentIds:values});
  return store.transaction(()=>setActive(orderId,[...new Set([...ids(orderId),...values])]));
 }
 function remove(id){
  const row=db.prepare('SELECT * FROM order_attachments WHERE id=?').get(id);
  if(!row)throw error('附件不存在',404);
  if(row.order_id)throw error('已保存到订单的附件不可删除',409);
  try{fs.rmSync(safeFile(row.file_path),{force:true});}catch{}
  if(row.thumb_path)try{fs.rmSync(safeFile(row.thumb_path),{force:true});}catch{}
  db.prepare('DELETE FROM order_attachments WHERE id=?').run(id);
 }
 // 清理孤立附件：超 24 小时仍未绑定的暂存行，以及目录中无任何行引用的残留文件。
 function sweepOrphans(maxAgeMs=24*3600*1000){
  const cutoff=new Date(Date.now()-maxAgeMs).toISOString();
  const stale=db.prepare('SELECT * FROM order_attachments WHERE order_id IS NULL AND created_at<?').all(cutoff);
  for(const row of stale){
   try{fs.rmSync(safeFile(row.file_path),{force:true});}catch{}
   if(row.thumb_path)try{fs.rmSync(safeFile(row.thumb_path),{force:true});}catch{}
   db.prepare('DELETE FROM order_attachments WHERE id=?').run(row.id);
  }
  const referenced=new Set(db.prepare('SELECT file_path,thumb_path FROM order_attachments').all().flatMap(r=>[r.file_path,r.thumb_path]).filter(Boolean));
  let files=0;
  for(const name of fs.readdirSync(folder)){
   if(referenced.has(`attachments/${name}`))continue;
   try{fs.rmSync(path.join(folder,name),{force:true});files++;}catch{}
  }
  return {rows:stale.length,files};
 }
 function list(orderId){return db.prepare('SELECT id,filename,mime,bytes,thumb_path,created_at FROM order_attachments WHERE order_id=? AND active=1 ORDER BY created_at,id').all(orderId).map(r=>({id:r.id,filename:r.filename,mime:r.mime,bytes:r.bytes,createdAt:r.created_at,thumbUrl:r.thumb_path?`/api/attachments/${r.id}?size=thumb`:null,downloadUrl:`/api/attachments/${r.id}`}));}
 function resource(id,size){
  const row=db.prepare('SELECT * FROM order_attachments WHERE id=?').get(id);if(!row)throw error('附件不存在',404);
  if(size==='thumb'){if(!row.thumb_path)throw error('该附件无缩略图',404);return {path:safeFile(row.thumb_path),mime:'image/webp',filename:row.filename};}
  return {path:safeFile(row.file_path),mime:row.mime,filename:row.filename};
 }
 return {stash,bind,ids,validate,setActive,remove,list,resource,sweepOrphans,folder};
}
