import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {readImageWorkbook,isImageHeader,imageLinks} from './source-images.mjs';
import {downloadImage,MAX_IMAGE_BYTES} from './image-download.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const clean=value=>String(value??'').trim();
const cleanSpec=value=>clean(value).replace(/^(商品规格|颜色分类|饰面颜色)\s*[:：]\s*/,'');
const itemKey=item=>JSON.stringify([clean(item.title),cleanSpec(item.spec)]);
const error=(message,status=400)=>Object.assign(Error(message),{status});
const formats={jpeg:['jpg','image/jpeg'],png:['png','image/png'],webp:['webp','image/webp'],gif:['gif','image/gif'],avif:['avif','image/avif'],heif:['avif','image/avif']};

export function openOrderImages(store,{downloader=downloadImage}={}){
 const {db,dir}=store,folder=path.join(dir,'images');fs.mkdirSync(folder,{recursive:true});
 db.exec(`CREATE TABLE IF NOT EXISTS image_assets(id TEXT PRIMARY KEY,file_path TEXT NOT NULL,thumb_path TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,bytes INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS order_images(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),source_id TEXT NOT NULL REFERENCES imports(id),source_hash TEXT NOT NULL,sheet TEXT NOT NULL,source_row INTEGER NOT NULL,source_column INTEGER NOT NULL,kind TEXT NOT NULL,source_ref TEXT NOT NULL,title TEXT NOT NULL,spec TEXT NOT NULL,needs_review INTEGER NOT NULL DEFAULT 0,asset_id TEXT REFERENCES image_assets(id),status TEXT NOT NULL DEFAULT 'pending',last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,cached_at TEXT);
 CREATE INDEX IF NOT EXISTS order_images_order ON order_images(order_id);
 CREATE INDEX IF NOT EXISTS order_images_source_ref ON order_images(kind,source_ref);`);
 const workbooks=new Map(),preparing=new Map(),caching=new Map(),assetWrites=new Map();
 let active=0;const waiting=[];
 const limited=async fn=>{if(active>=3)await new Promise(r=>waiting.push(r));else active++;try{return await fn();}finally{if(waiting.length)waiting.shift()();else active--;}};
 function safeFile(relative){const absolute=path.resolve(dir,relative);if(!absolute.startsWith(path.resolve(dir)+path.sep))throw error('图片文件路径无效');return absolute;}
 function asset(id){const row=db.prepare('SELECT * FROM image_assets WHERE id=?').get(id);return row&&fs.existsSync(safeFile(row.file_path))&&fs.existsSync(safeFile(row.thumb_path))?row:null;}
 async function workbook(source){
  const file=safeFile(source.file_path);if(!fs.existsSync(file))throw error('原始文件缺失，暂时无法读取图片');
  const stat=fs.statSync(file),key=JSON.stringify([source.id,source.hash,stat.size,stat.mtimeMs]);
  if(workbooks.has(key))return workbooks.get(key);
  if(stat.size>25*1024*1024)throw error('原表超过 25 MB，无法读取图片');
  const promise=(async()=>{const buffer=await fs.promises.readFile(file);if(hash(buffer)!==source.hash)throw error('原始文件内容已变化，图片来源需要核对');return readImageWorkbook(buffer);})();
  workbooks.set(key,promise);while(workbooks.size>3)workbooks.delete(workbooks.keys().next().value);
  try{return await promise;}catch(e){workbooks.delete(key);throw e;}
 }
 const requireOrder=id=>{const order=store.get(id);if(!order)throw error('订单不存在',404);return order;};
 const rows=id=>db.prepare('SELECT p.*,i.filename FROM order_images p JOIN imports i ON i.id=p.source_id WHERE p.order_id=? ORDER BY p.source_id,p.source_row,p.source_column,p.id').all(id);
 function list(id,warnings=[]){
  const order=requireOrder(id),groups=new Map();
  for(const row of rows(id)){
   const saved=row.asset_id?asset(row.asset_id):null,key=saved?.id||row.id;
   const matches=order.items.flatMap((item,index)=>itemKey(item)===itemKey(row)?[index]:[]);
   const binding={sourceId:row.source_id,filename:row.filename,sheet:row.sheet,row:row.source_row,column:row.source_column,kind:row.kind,title:row.title,itemIndex:matches.length===1?matches[0]:null};
   if(groups.has(key)){const group=groups.get(key);group.ids.push(row.id);group.bindings.push(binding);group.needsReview ||=!!row.needs_review;continue;}
   groups.set(key,{id:row.id,ids:[row.id],assetId:saved?.id||null,status:saved?'ready':row.status==='failed'?'failed':'pending',error:row.last_error,needsReview:!!row.needs_review,bindings:[binding],thumbUrl:saved?`/api/images/${saved.id}?size=thumb`:null,fullUrl:saved?`/api/images/${saved.id}?size=full`:null});
  }
  return {orderId:id,images:[...groups.values()],warnings};
 }
 async function prepare(id){
  requireOrder(id);if(preparing.has(id))return preparing.get(id);
  const run=(async()=>{
   const record=db.prepare('SELECT source_id,original FROM orders WHERE id=?').get(id),sources=[];
   if(record.source_id)sources.push({sourceId:record.source_id,original:JSON.parse(record.original)});
   for(const s of store.supplements(id))sources.push({sourceId:s.sourceId,original:s.original});
   const entries=[],warnings=[];
   for(const {sourceId,original} of sources){
    const source=db.prepare('SELECT * FROM imports WHERE id=?').get(sourceId);
    if(!source){warnings.push('原始来源记录缺失');continue;}
    const headers=original.headers||[],sourceRows=original.rows||[];if(!headers.length||!sourceRows.length)continue;
    const columns=headers.flatMap((h,i)=>isImageHeader(h)?[i+1]:[]);
    const metadata=JSON.parse(source.metadata),wantedSheet=original.sheet||metadata.sheet;let sheet=null;
    if(/\.xlsx$/i.test(source.filename)){
     try{
      const book=await workbook(source);sheet=book.sheets.find(s=>s.name===wantedSheet)||(!wantedSheet&&book.sheets.length===1?book.sheets[0]:null);
      if(!sheet)warnings.push(`${source.filename}：无法确定来源工作表，嵌入图片暂未关联`);
     }catch(e){warnings.push(`${source.filename}：${e.message}`);}
    }
    for(const row of sourceRows){
     if(!Number.isSafeInteger(row.row)||row.row<1)continue;
     const originalItem=original.normalized?.items?.find(i=>i.sourceRow===row.row);
     const title=clean(originalItem?.title??row.cells[headers.findIndex(h=>/^(商品名|商品名称|货品标题|商品标题|宝贝名称|宝贝标题)$/.test(h))]);
     const spec=clean(originalItem?.spec??row.cells[headers.findIndex(h=>/^(规格|商品规格|规格型号|型号款式)$/.test(h))]);
     const embedded=(sheet?.images||[]).filter(i=>i.row===row.row&&i.column>=1&&i.column<=headers.length);
     const distinct=[...new Map(embedded.map(i=>[i.entry,i])).values()];
     const add=(kind,ref,column)=>{const key=JSON.stringify([id,sourceId,source.hash,sheet?.name||wantedSheet||'CSV',row.row,column,kind,ref]);entries.push({id:hash(key),sourceId,sourceHash:source.hash,sheet:sheet?.name||wantedSheet||'CSV',row:row.row,column,kind,ref,title,spec,review:distinct.length>1?1:0});};
     for(const i of distinct)add('embedded',i.entry,i.column);
     const urls=new Map();
     for(const column of columns)for(const url of imageLinks(row.cells[column-1]))urls.set(url,column);
     for(const link of sheet?.links||[])if(link.row===row.row&&columns.includes(link.column))for(const url of imageLinks(link.url))urls.set(url,link.column);
     for(const [url,column] of urls)add('url',url,column);
    }
   }
   store.transaction(()=>{const insert=db.prepare('INSERT OR IGNORE INTO order_images(id,order_id,source_id,source_hash,sheet,source_row,source_column,kind,source_ref,title,spec,needs_review,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');for(const e of entries)insert.run(e.id,id,e.sourceId,e.sourceHash,e.sheet,e.row,e.column,e.kind,e.ref,e.title,e.spec,e.review,new Date().toISOString());});
   return list(id,[...new Set(warnings)]);
  })();preparing.set(id,run);try{return await run;}finally{preparing.delete(id);}
 }
 async function writeAsset(buffer){
  if(!Buffer.isBuffer(buffer)||!buffer.length)throw error('图片内容为空');if(buffer.length>MAX_IMAGE_BYTES)throw error('图片超过 10 MB，未保存');
  const id=hash(buffer),prior=asset(id);if(prior)return prior;if(assetWrites.has(id))return assetWrites.get(id);
  const run=(async()=>{
   let metadata,thumbnail;
   try{
    metadata=await sharp(buffer,{limitInputPixels:40000000,failOn:'warning'}).metadata();
    if(!formats[metadata.format]||(metadata.format==='heif'&&metadata.compression!=='av1')||metadata.width*metadata.height>40000000||metadata.width*metadata.height*(metadata.pages||1)>40000000)throw Error('unsupported');
    thumbnail=await sharp(buffer,{limitInputPixels:40000000,failOn:'warning'}).rotate().resize(320,240,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
   }catch{throw error('图片格式损坏、不支持或超过 4,000 万像素');}
   const [ext,mime]=formats[metadata.format],filePath=`images/${id}.${ext}`,thumbPath=`images/${id}.thumb.webp`,temporary=[];
   try{
    for(const [relative,bytes] of [[filePath,buffer],[thumbPath,thumbnail]]){const tmp=path.join(folder,randomUUID()+'.tmp');temporary.push(tmp);await fs.promises.writeFile(tmp,bytes,{flag:'wx'});await fs.promises.rename(tmp,safeFile(relative));}
    const result={id,file_path:filePath,thumb_path:thumbPath,mime,width:metadata.width,height:metadata.height,bytes:buffer.length,created_at:new Date().toISOString()};
    db.prepare('INSERT INTO image_assets(id,file_path,thumb_path,mime,width,height,bytes,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path,thumb_path=excluded.thumb_path,mime=excluded.mime,width=excluded.width,height=excluded.height,bytes=excluded.bytes').run(...Object.values(result));return result;
   }finally{for(const file of temporary)await fs.promises.rm(file,{force:true});}
  })();assetWrites.set(id,run);try{return await run;}finally{assetWrites.delete(id);}
 }
 async function cache(id,imageId){
  requireOrder(id);const row=db.prepare('SELECT * FROM order_images WHERE order_id=? AND id=?').get(id,imageId);if(!row)throw error('图片不属于当前订单',404);
  if(row.asset_id&&asset(row.asset_id))return list(id);if(caching.has(row.id))return caching.get(row.id);
  const run=limited(async()=>{
   try{
    let saved;
    const reused=db.prepare("SELECT asset_id FROM order_images WHERE kind=? AND source_ref=? AND asset_id IS NOT NULL AND (kind='url' OR source_hash=?)").all(row.kind,row.source_ref,row.source_hash).find(r=>asset(r.asset_id));
    if(reused)saved=asset(reused.asset_id);
    else{
     let buffer;
     if(row.kind==='url')buffer=await downloader(row.source_ref);
     else{const source=db.prepare('SELECT * FROM imports WHERE id=?').get(row.source_id);if(!source||source.hash!==row.source_hash)throw error('图片原始来源已变化');buffer=await(await workbook(source)).image(row.source_ref);}
     saved=await writeAsset(buffer);
    }
    db.prepare("UPDATE order_images SET asset_id=?,status='ready',last_error='',cached_at=? WHERE id=?").run(saved.id,new Date().toISOString(),row.id);
   }catch(e){db.prepare("UPDATE order_images SET status='failed',last_error=? WHERE id=?").run(e.message,row.id);throw e;}
   return list(id);
  });caching.set(row.id,run);try{return await run;}finally{caching.delete(row.id);}
 }
 function resource(id,size){if(!['thumb','full'].includes(size))throw error('图片尺寸参数无效');const saved=asset(id);if(!saved)throw error('图片尚未缓存或缓存文件缺失，请重新打开详情加载',404);return {path:safeFile(size==='thumb'?saved.thumb_path:saved.file_path),mime:size==='thumb'?'image/webp':saved.mime};}
 return {prepare,cache,list,resource,busy:()=>preparing.size>0||caching.size>0||assetWrites.size>0};
}
