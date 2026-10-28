import {openPurchasePersonnel} from './lib/purchase-personnel.mjs';
import {createPurchaseAgentService,installPurchaseAgentRoutes} from './lib/agent-service.mjs';
import {purchaseAgentOperations} from './lib/agent-operations.mjs';
import {openTaskAssignment} from './lib/task-assignment.mjs';
import {openTaskCenter} from './lib/task-center.mjs';
import {MAX_FILES,MAX_FILE_BYTES,MAX_TOTAL_BYTES,MAX_OCR_PAGES,validateUploadLimits} from './public/upload-limits.mjs';
import {installLocalIntegration} from './lib/local-integration.mjs';
import {installWorkbenchMigration} from './lib/workbench-migration-routes.mjs';
import {createWorkbenchMigration} from './lib/workbench-migration.mjs';
import {installWorkbenchAudit} from './lib/workbench-module.mjs';
import {installPurchaseEdits} from './lib/integration-edits.mjs';
import {openOrderTransfers} from './lib/order-transfer.mjs';
import {registerTransferRoutes} from './lib/transfer-routes.mjs';
import {supplierSummary} from './lib/suppliers.mjs';
import {shipmentText} from './public/shipments.mjs';
import {includedInSpend,spendSettingLabel} from './public/order-attributes.mjs';
import {openOrderImages} from './lib/order-images.mjs';
import {allocations,classificationLabel,classificationDescription,unallocatedRefund,categories,contribution} from './public/classification.mjs';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import archiver from 'archiver';
import {readTable,normalizeTable,validateOrder,fields,extractText} from './lib/importer.mjs';
import {openStore,summarize} from './lib/store.mjs';
import {modelDir} from './lib/ocr.mjs';
import {filterOrders,sortOrders,orderUploadDate} from './public/order-query.mjs';
import {platformMapping} from './lib/import-rules.mjs';
import {importRules} from './public/import-rules.mjs';
import {validateOcrFiles,OCR_MAX_FILES,OCR_MAX_FILE_BYTES} from './public/ocr-files.mjs';
import {reviewImportOrders,importReportDraft} from './lib/import-review.mjs';
import {appVersion,appBrand,appWebsite,appGithubRepo,appStatsEndpoint} from './lib/app-info.mjs';
import {openUsage,reportOpen} from './lib/usage.mjs';
import {checkForUpdate} from './lib/updater.mjs';
import {openAddresses,quickTags as addressQuickTags} from './lib/addresses.mjs';
import {createMobileAccess} from './lib/mobile-access.mjs';
import {openSupplierManagement} from './lib/supplier-management.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export function createApp({dataDir=process.env.PURCHASE_DATA_DIR||path.join(root,'data'),imageDownloader,mobileNow=Date.now,mobilePolicyFile}={}){
 const app=express(),store=openStore(dataDir),previews=new Map(),jobs=new Map();let ocrBusy=false,mobile;
 const taskCenter=openTaskCenter(store),personnel=openPurchasePersonnel(store),taskBoard=openTaskAssignment(store,taskCenter,personnel);
 const transfers=openOrderTransfers(store);
 const integration=installLocalIntegration(app,{id:'purchase-desk',version:appVersion,root,dataDir,busy:()=>ocrBusy||transfers.busy()||edits.busy()||mobile?.busy()||orderImages.busy(),capabilities:['orders.read','transfers.prepare','transfers.review-ui','transfers.verify','exporter.open','edits.prepare','edits.review-ui']});
 const edits=installPurchaseEdits(integration,store);
 registerTransferRoutes(integration,transfers,store);installWorkbenchMigration(integration,store,createWorkbenchMigration);installWorkbenchAudit(integration,store);integration.finish();
 const orderImages=openOrderImages(store,{downloader:imageDownloader});
 const attachments=store.attachments;
 const addresses=openAddresses(store);
 const supplierManagement=openSupplierManagement(store,addresses);
 const usage=openUsage(store.db);
 try{attachments.sweepOrphans();}catch{}
 const upgrade={state:'idle',current:appVersion,latest:null,hasUpdate:false,url:null,name:null,error:null,checkedAt:null};
 const runUpgradeCheck=async()=>{
  upgrade.state='checking';upgrade.checkedAt=new Date().toISOString();upgrade.error=null;
  const r=await checkForUpdate({repo:appGithubRepo,current:appVersion});
  if(r.skipped){upgrade.state='unconfigured';}
  else if(r.error){upgrade.state='error';upgrade.error=r.message||('HTTP '+r.status);}
  else{upgrade.state='ok';upgrade.latest=r.latest;upgrade.hasUpdate=r.hasUpdate;upgrade.url=r.url;upgrade.name=r.name;}
  return upgrade;
 };
 const token=randomBytes(32).toString('hex');
 // Locked orders cannot be modified through password headers; cancel confirmation first.
 const write=(req,fn)=>req.mobileSubmission?mobile.commit(req,fn):fn();
 app.disable('x-powered-by');
 app.use((req,res,next)=>{
  const host=req.headers.host?.split(':')[0];if(!['127.0.0.1','localhost','[::1]'].includes(host))return res.status(403).json({error:'仅支持本机访问'});
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'");
  if(req.path.startsWith('/api'))res.setHeader('Cache-Control','no-store');
  if(!req.workbenchActor&&!['GET','HEAD'].includes(req.method)&&req.headers['x-purchase-token']!==token)return res.status(403).json({error:'页面会话已更新，请刷新后重试'});
  next();
 });
 app.use(express.json({limit:'12mb'}));
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1}});
 const attachmentUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_FILE_BYTES,files:MAX_FILES}});
 const ocrUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:OCR_MAX_FILE_BYTES,files:OCR_MAX_FILES}});
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const cleanName=n=>{try{return Buffer.from(n,'latin1').toString('utf8').includes('\ufffd')?n:Buffer.from(n,'latin1').toString('utf8');}catch{return n;}};
 // 订单保存时一并绑定的暂存附件 ID；先暂存（order_id 为空），保存成功后 bind。
 const stash=(buffer,filename)=>{const id=randomUUID(),ext=path.extname(filename).toLowerCase();const filePath=`originals/${id}${ext}`;fs.writeFileSync(path.join(dataDir,filePath),buffer);return {id,filename,hash:hash(buffer),filePath};};
 const describe=p=>{
  let parsed;
  try{parsed=normalizeTable(p.table,p.options);}catch(e){parsed={orders:[],issues:[{row:p.table.headerRow,message:e.message}],lineCount:p.table.rows.length};}
  parsed.orders=reviewImportOrders(parsed.orders,store);
  p.parsed=parsed;
  const {orders,issues,lineCount}=parsed;
  return {id:p.id,filename:p.filename,options:p.options,fields,sheets:p.table.sheets,sheet:p.table.sheet,headers:p.table.headers,sample:p.table.rows.slice(0,3).map(r=>r.cells),mapping:p.options.mapping||p.table.mapping,lineCount,issues,orders:orders.map(({raw,...o})=>o),summary:{orders:orders.length,valid:orders.filter(o=>o.importStatus==='ready').length,duplicates:orders.filter(o=>o.importStatus==='duplicate').length,conflicts:orders.filter(o=>o.importStatus==='conflict').length,invalid:orders.filter(o=>o.importStatus==='invalid').length,locked:orders.filter(o=>o.importStatus==='locked').length,amountCents:orders.filter(o=>o.importStatus==='ready').reduce((s,o)=>s+o.amountCents,0)}};
 };
 app.get('/api/health',(req,res)=>res.json({ok:true,app:'purchase-desk',version:appVersion,features:['procurement-classification','monthly-confirmation','batch-order-attributes','order-audit-rollback','order-attachments','address-book','item-tracking','supplier-view','item-shipments','atomic-order-attributes','contact-snapshots','atomic-attachments','upload-limits-v2','monthly-task-center','assigned-task-board'],uploadLimits:{files:MAX_FILES,fileBytes:MAX_FILE_BYTES,totalBytes:MAX_TOTAL_BYTES,ocrPages:MAX_OCR_PAGES}}));
app.get('/api/app-info',(req,res)=>res.json({brand:appBrand,website:appWebsite,version:appVersion,upgrade,usage:usage.stats()}));
app.post('/api/upgrade/check',async(req,res)=>res.json(await runUpgradeCheck()));
 app.get('/api/bootstrap',(req,res)=>res.json({token,orders:store.list(),imports:store.imports(),pendingEditsCount:Number(store.db.prepare("SELECT count(*) AS n FROM integration_edit_drafts WHERE state='draft'").get().n),personnel:personnel.current(req),adminConfigured:store.monthLocks.configured(),monthConfirmations:store.monthLocks.confirmations(),ocrReady:['eng','chi_sim'].every(l=>fs.existsSync(path.join(modelDir,l+'.traineddata')))}));
 app.get('/api/personnel/session',(req,res)=>res.json(personnel.current(req)));
 app.post('/api/personnel/session',(req,res)=>res.json(personnel.select(req,res,req.body)));
 app.get('/api/personnel',(req,res)=>res.json({staff:personnel.list(req)}));
 app.post('/api/personnel',(req,res)=>{const saved=personnel.save(req,req.body);res.json({saved,staff:personnel.list(req)});});
 app.get('/api/task-board',(req,res)=>res.json(taskBoard.overview(req,req.query.month)));
 app.post('/api/task-board/action',(req,res)=>res.json(taskBoard.act(req,req.body)));
 // Task submission and monthly financial confirmation are separate responsibilities.
 app.use((req,res,next)=>{
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&(/^\/api\/tasks(?:\/|$)/.test(req.path)||/^\/api\/month-confirmations(?:\/|$)/.test(req.path)||req.path==='/api/admin/password')){
   const identity=personnel.current(req);
   if(identity.readOnly||identity.role==='employee'||!identity.selected&&String(req.headers.cookie||'').split(';').some(part=>part.trim().startsWith('purchase_personnel=')))return res.status(403).json({error:'请由老板验收或处理月度确认；员工请在自己的任务中提交资料',code:'PURCHASE_BOSS_REQUIRED'});
  }
  next();
 });
 app.get('/api/tasks',(req,res)=>res.json(taskCenter.overview(req.query.month)));
 app.post('/api/tasks',(req,res)=>res.json(taskCenter.update(req.body)));
 app.get('/api/month-confirmations',(req,res)=>res.json(store.monthLocks.overview(req.query.month)));
 app.get('/api/month-confirmations/preview',(req,res)=>res.json(store.monthLocks.preview(req.query.month,req.query.platform)));
 app.get('/api/month-confirmations/history',(req,res)=>res.json(store.monthLocks.history(req.query.month,req.query.platform)));
 app.post('/api/month-confirmations',(req,res)=>res.json(store.monthLocks.confirm(req.body)));
 app.post('/api/month-confirmations/confirm-batch',(req,res)=>res.json(store.monthLocks.confirmBatch(req.body)));
 app.post('/api/month-confirmations/cancel',async(req,res)=>res.json(await store.monthLocks.cancel(req.body)));
 app.post('/api/month-confirmations/cancel-batch',async(req,res)=>res.json(await store.monthLocks.cancelBatch(req.body)));
 app.post('/api/admin/password',async(req,res)=>res.json(await store.monthLocks.setPassword(req.body)));
 app.get('/api/dashboard',(req,res)=>res.json(summarize(store.list(),req.query.year||new Date().getFullYear(),req.query.basis||'paid',req.query.platform||'全部',req.query.category||'',req.query.month||'')));
 app.post('/api/import/preview',upload.single('file'),async(req,res)=>{
  if(!req.file)throw Error('请选择表格');if(previews.size>=15)previews.delete(previews.keys().next().value);
  const filename=cleanName(req.file.originalname),table=await readTable(req.file.buffer,filename),id=randomUUID();
  const platform=req.body.platform;
  const mapping=platformMapping(table,platform);
  const options={platform,account:req.body.account||importRules[platform].account,amountMode:'order',mapping};
  const p={id,filename,buffer:req.file.buffer,table,options};previews.set(id,p);res.json(describe(p));
 });
 app.post('/api/import/:id/remap',async(req,res)=>{
  const p=previews.get(req.params.id);if(!p)throw Error('预览已过期，请重新选择文件');
  if(req.body.platform&&req.body.platform!==p.options.platform)throw Error('切换平台后请重新上传文件');
  const table=req.body.sheet&&req.body.sheet!==p.table.sheet?await readTable(p.buffer,p.filename,req.body.sheet):p.table;
  const detected=platformMapping(table,p.options.platform);
  const mapping=table!==p.table?detected:{...(req.body.mapping||p.options.mapping)};
  mapping.platform='';
  if(req.body.amountMode&&!['order','line'].includes(req.body.amountMode))throw Error('无效金额含义');
  p.table=table;p.options={...p.options,mapping,...Object.fromEntries(['account','amountMode'].filter(k=>req.body[k]).map(k=>[k,req.body[k]]))};res.json(describe(p));
 });
 app.post('/api/import/:id/commit',async(req,res)=>{
  const p=previews.get(req.params.id);if(!p)throw Error('预览已过期，请重新选择文件');
  if(!Array.isArray(req.body.indices)||!req.body.indices.length)throw Error('请勾选需要入库的订单');
  const indices=[...new Set(req.body.indices)],fresh=describe(p);
  if(indices.some(i=>!Number.isInteger(i)||i<0||i>=p.parsed.orders.length))throw Error('订单选择无效，请重新核对预览');
  const selected=indices.map(i=>p.parsed.orders[i]);
  if(selected.some(o=>o.importStatus!=='ready')){
   const locked=selected.some(o=>o.importStatus==='locked');
   throw Object.assign(Error(locked?'本批次 0 笔入库：所选订单包含已锁定月份，请核对未导入清单后重新选择。':'本批次 0 笔入库：所选订单包含重复、冲突或无效数据，请重新核对预览。'),{status:locked?423:409,code:locked?'MONTH_LOCKED':'IMPORT_REVIEW_CHANGED',preview:fresh,report:importReportDraft(p.filename,p.parsed.orders,p.parsed.issues,indices,{aborted:true})});
  }
  const orders=selected.map(o=>({index:o.index,order:validateOrder(o),original:{headers:p.table.headers,rows:o.raw,normalized:o}}));
  let source,result;
  try{
   result=await write(req,()=>{
    store.monthLocks.assertWritable(orders.filter(e=>!store.find(e.order)).map(e=>e.order));
    source=stash(p.buffer,p.filename);
    return store.importBatch(orders,{...source,lineCount:p.parsed.lineCount,metadata:{sheet:p.table.sheet,...p.options,issues:p.parsed.issues,selected:indices.length,importReport:importReportDraft(p.filename,p.parsed.orders,p.parsed.issues,indices)}});
   });
  }catch(e){
   if(source)fs.unlinkSync(path.join(dataDir,source.filePath));
   if(e.code==='MONTH_LOCKED'||e.message==='MONTH_LOCKED')Object.assign(e,{status:423,code:'MONTH_LOCKED',message:'本批次 0 笔入库：月份已锁定，请核对未导入清单后重新选择。',preview:describe(p),report:importReportDraft(p.filename,p.parsed.orders,p.parsed.issues,indices,{aborted:true})});
   throw e;
  }
  previews.delete(p.id);res.json(result);
 });
 const saveOrder=async(req,res)=>{
  const o=validateOrder(req.body);if(store.find(o))throw Error('同一平台、账号和订单号已存在');
  const job=req.body.ocrJobId?jobs.get(req.body.ocrJobId):null;
  if(req.body.ocrJobId&&(!job||job.status!=='done'))throw Error('识别结果已过期，请重新识别');
  if(job){
   let buffer=job.files[0].buffer,filename=job.files[0].filename;
   if(job.files.length>1){
    buffer=await new Promise((resolve,reject)=>{const chunks=[],archive=archiver('zip',{zlib:{level:6}});archive.on('data',c=>chunks.push(c));archive.on('end',()=>resolve(Buffer.concat(chunks)));archive.on('error',reject);job.files.forEach((f,i)=>archive.append(f.buffer,{name:`${String(i+1).padStart(2,'0')}-${path.basename(f.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')}`}));archive.finalize().catch(reject);});
    filename='采购单原始附件.zip';
   }
  let source,result;try{result=await write(req,()=>{store.monthLocks.assertWritable([o]);source=stash(buffer,filename);return store.importBatch([{order:o,original:{recognizedText:job.result.text,recognized:job.result.order,documents:job.result.documents}}],{...source,lineCount:job.files.length,metadata:{method:'ocr',files:job.files.map(f=>({filename:f.filename,hash:hash(f.buffer)}))}});});}catch(e){if(source)fs.unlinkSync(path.join(dataDir,source.filePath));throw e;}const order=store.find(o);return res.json({ok:true,...result,order,classification:o.classification});
 }
 const created=await write(req,()=>store.insert(o,null,req.body));res.json(created);
};
 app.post('/api/orders',saveOrder);
 app.get('/api/order-logs',(req,res)=>res.json(store.auditLog.list(req.query)));
 app.get('/api/order-logs/:id',(req,res)=>res.json(store.auditLog.detail(req.params.id)));
 app.post('/api/order-logs/rollback-preview',(req,res)=>res.json(store.auditLog.preview(req.body)));
 app.post('/api/order-logs/rollback',(req,res)=>res.json(store.auditLog.rollback(req.body)));
 app.get('/api/suppliers',(req,res)=>res.json(supplierSummary(store.list(),req.query)));
 app.get('/api/supplier-management',(_req,res)=>res.json(supplierManagement.list(_req.query)));
 app.get('/api/supplier-management/choices',(_req,res)=>res.json(supplierManagement.profiles()));
 app.get('/api/supplier-management/:id/history',(req,res)=>res.json(supplierManagement.history(req.params.id)));
 app.post('/api/supplier-management',(req,res)=>res.json(supplierManagement.save(null,req.body)));
 app.put('/api/supplier-management/:id',(req,res)=>res.json(supplierManagement.save(req.params.id,req.body)));
 app.get('/api/orders',(req,res)=>res.json(filterOrders(store.list(),req.query,req.query.basis)));
 app.get('/api/orders/:id',(req,res)=>{const order=store.get(req.params.id);if(!order)return res.status(404).json({error:'订单不存在'});res.json(order);});
 app.patch('/api/orders/:id/classification',async(req,res)=>{if(!req.body.classification)throw Error('请提交采购分类');res.json(await write(req,()=>store.classify(req.params.id,req.body)));});
 app.post('/api/orders/attributes/batch',async(req,res)=>res.json(await write(req,()=>store.attributesBatch(req.body))));
 app.post('/api/orders/classification/batch',async(req,res)=>res.json(await write(req,()=>store.classifyBatch(req.body))));
 app.put('/api/orders/:id',async(req,res)=>res.json(await write(req,()=>store.update(req.params.id,req.body))));
 app.patch('/api/orders/:id/note',async(req,res)=>{
  const o=store.get(req.params.id);if(!o)throw Error('订单不存在');
  if(typeof req.body.note!=='string')throw Error('备注必须为文字');
  res.json(await write(req,()=>store.update(o.id,{...o,note:req.body.note,updatedAt:req.body.updatedAt})));
 });
 app.post('/api/orders/:id/images/prepare',async(req,res)=>res.json(await orderImages.prepare(req.params.id)));
 app.post('/api/orders/:id/images/:imageId/cache',async(req,res)=>res.json(await orderImages.cache(req.params.id,req.params.imageId)));
 app.get('/api/images/:assetId',(req,res,next)=>{const image=orderImages.resource(req.params.assetId,req.query.size||'full');res.type(image.mime);res.setHeader('Cache-Control','private, max-age=86400');res.sendFile(path.basename(image.path),{root:path.dirname(image.path)},err=>{if(err){res.removeHeader('Content-Type');res.setHeader('Cache-Control','no-store');next(err);}});});
// 采购单附件：先暂存（order_id 为空），订单保存时绑定；已绑定附件不可删除。
app.post('/api/attachments',attachmentUpload.array('files',MAX_FILES),async(req,res)=>{
 if(!req.files?.length)throw Error('请选择要上传的附件');
 validateUploadLimits(req.files.map(f=>({name:cleanName(f.originalname),size:f.size})));
 const saved=[];
 try{for(const f of req.files)saved.push(await attachments.stash(f.buffer,cleanName(f.originalname),f.mimetype));}catch(e){for(const a of saved)attachments.remove(a.id);throw e;}
 res.json(saved);
});
app.delete('/api/attachments/:id',(req,res)=>{attachments.remove(req.params.id);res.json({ok:true});});
app.get('/api/orders/:id/attachments',(req,res)=>{if(!store.get(req.params.id))return res.status(404).json({error:'订单不存在'});res.json(attachments.list(req.params.id));});
app.get('/api/attachments/:id/thumb',(req,res)=>{const a=attachments.resource(req.params.id,'thumb');res.type(a.mime).sendFile(a.path);});
app.get('/api/attachments/:id',(req,res,next)=>{
 const a=attachments.resource(req.params.id,req.query.size==='thumb'?'thumb':'full'),thumb=req.query.size==='thumb';
 res.type(a.mime);res.setHeader('Cache-Control','private, max-age=86400');
 res.setHeader('Content-Disposition',(thumb||req.query.preview==='1'&&/^image\/(png|jpeg|webp|gif)$/.test(a.mime)?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(a.filename));
 res.sendFile(path.basename(a.path),{root:path.dirname(a.path)},err=>{if(err)next(err);});
});
// 地址库：收货地址与供应商地址二合一，自由标签筛选；与订单无外键，删除不影响订单。
app.get('/api/addresses',(req,res)=>res.json(addresses.list({q:req.query.q,tag:req.query.tag})));
app.post('/api/addresses',(req,res)=>res.json(addresses.create(req.body)));
app.put('/api/addresses/:id',(req,res)=>res.json(addresses.update(req.params.id,req.body)));
app.delete('/api/addresses/:id',(req,res)=>res.json(addresses.remove(req.params.id,req.body)));
 app.get('/api/orders/:id/history',(req,res)=>res.json(store.history(req.params.id)));
 app.get('/api/orders/:id/supplements',(req,res)=>res.json(store.supplements(req.params.id)));
 app.get('/api/source/:id',(req,res)=>{
  const row=store.db.prepare('SELECT file_path,filename FROM imports WHERE id=?').get(req.params.id);if(!row?.file_path)return res.status(404).json({error:'原始文件不存在'});res.download(path.join(dataDir,row.file_path),row.filename);
 });
 app.post('/api/ocr/text',(req,res)=>{const text=String(req.body.text||'').slice(0,100000);if(!text.trim())throw Error('请先粘贴订单文字');res.json({text,order:extractText(text,req.body.platform||'其他')});});
 const recognize=async(req,res)=>{
  const files=(req.files||[]).map(f=>({filename:cleanName(f.originalname),buffer:f.buffer}));
  validateOcrFiles(files.map(f=>({name:f.filename,size:f.buffer.length})));
  if(ocrBusy)return res.status(409).json({error:'正在识别另一批采购单，请稍后重试'});
  if(jobs.size>=10)jobs.delete(jobs.keys().next().value);
  const id=randomUUID(),job={id,filename:files[0].filename,files,status:'running',progress:0};jobs.set(id,job);ocrBusy=true;res.json({id});
  const worker=fork(path.join(root,'lib/ocr-worker.mjs'),[],{silent:true,windowsHide:true});
  const timeout=setTimeout(()=>{job.status='failed';job.error='识别超时，请缩小图片或分批处理';worker.kill();},300000);
  worker.on('message',m=>{if(job.status!=='running')return;if(m.progress!=null)job.progress=m.progress;if(m.result){job.status='done';job.result=m.result;}if(m.error){job.status='failed';job.error=m.error;job.code=m.code;}});
  worker.on('error',()=>{job.status='failed';job.error='无法启动本地识别程序，请重试';});
  worker.on('exit',()=>{clearTimeout(timeout);ocrBusy=false;if(job.status==='running'){job.status='failed';job.error='此文件识别失败，请另存为清晰图片后重试';}});
  worker.send({files:files.map(f=>({data:f.buffer.toString('base64'),filename:f.filename}))});
 };
 app.post('/api/ocr',ocrUpload.array('file',OCR_MAX_FILES),recognize);
 app.get('/api/ocr/:id',(req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:'识别任务已过期'});res.json({id:job.id,filename:job.filename,fileCount:job.files.length,status:job.status,progress:job.progress,result:job.result,error:job.error,code:job.code});});
 const csv=(rows)=>'\uFEFF'+rows.map(row=>row.map(v=>{const s=String(v??'');return '"'+(typeof v!=='number'&&/^[=+@\-\t\r]/.test(s)||/^\d{16,}$/.test(s)?"'":'')+s.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');
 app.get('/api/export',(req,res)=>{
  let sorters=[];try{sorters=JSON.parse(req.query.sorters||'[]');}catch{throw Error('排序参数无效');}if(!Array.isArray(sorters))throw Error('排序参数无效');
  const orders=sortOrders(filterOrders(store.list(),req.query,req.query.basis),sorters,req.query.basis);
  res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent('采购订单.csv'));res.type('text/csv').send(csv([['采购平台','账号','订单编号','下单日期','付款日期','供应商','实付金额','已退款金额','运费','订单状态','商品名称','商品规格','单价(元)','数量','单位','商品行运单号','商品行物流公司','收货人姓名','收货地址','联系手机','物流公司','运单号','备注','采购类别','分类金额分配','待分配退款','支出归属','筛选类别实付','筛选类别已分配退款','筛选类别净支出','支出统计设置','计入看板','计入采购净支出','上传日期','数据来源','录入人'],...orders.map(o=>[o.platform,o.account,o.orderNo,o.date,o.paidAt,o.supplier,(o.amountCents/100).toFixed(2),(o.refundCents/100).toFixed(2),(o.shippingCents/100).toFixed(2),o.status,o.items.map(i=>`${i.title} × ${i.qty}${i.unit||''}`).join('；'),...['spec','unitPriceCents','qty','unit','trackingNo','logisticsCompany'].map(k=>o.items.map((i,n)=>(o.items.length>1?`${n+1}. `:'')+(k==='unitPriceCents'?(i[k]==null?'':(i[k]/100).toFixed(2)):(['trackingNo','logisticsCompany'].includes(k)?shipmentText(i,k):String(i[k]??'')))).join('\n')),o.recipient,o.address,o.phone,o.logisticsCompany,o.trackingNo,o.note,classificationLabel(o),classificationDescription(o),(unallocatedRefund(o)/100).toFixed(2),'公司共用',...(req.query.category?Object.values(contribution(o,req.query.category)).map(v=>(v/100).toFixed(2)):['','','']),spendSettingLabel(o),includedInSpend(o)?'是':'否',((includedInSpend(o)?contribution(o,req.query.category).netCents:0)/100).toFixed(2),orderUploadDate(o.createdAt),o.sourceLabel,o.uploadedBy])]));
 });
 app.get('/api/classification-export',(req,res)=>{
  const orders=filterOrders(store.list(),req.query,req.query.basis),rows=[];
  for(const o of orders){
   const common=[o.id,o.platform,o.account,o.orderNo,o.date,o.paidAt,o.supplier,o.status,includedInSpend(o)?'是':'否','公司共用'];
   for(const p of allocations(o).filter(p=>!req.query.category||p.category===req.query.category))rows.push([...common,categories[p.category],(p.amountCents/100).toFixed(2),(p.refundCents/100).toFixed(2),'0.00',((p.amountCents-p.refundCents)/100).toFixed(2),o.note,spendSettingLabel(o),((includedInSpend(o)?p.amountCents-p.refundCents:0)/100).toFixed(2)]);
   if(!req.query.category&&unallocatedRefund(o))rows.push([...common,'待分配退款','0.00','0.00',(unallocatedRefund(o)/100).toFixed(2),Number((-unallocatedRefund(o)/100).toFixed(2)),'退款类别待核对',spendSettingLabel(o),Number(((includedInSpend(o)?-unallocatedRefund(o):0)/100).toFixed(2))]);
  }
  res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent('采购支出分类明细.csv'));res.type('text/csv').send(csv([['订单ID','采购平台','账号','订单编号','下单日期','付款日期','供应商','订单状态','计入看板','支出归属','采购类别','分类实付','已分配退款','待分配退款','净支出调整','备注','支出统计设置','计入采购净支出'],...rows]));
 });
 app.get('/api/monthly-export',(req,res)=>{const year=req.query.year||2026,s=summarize(store.list(),year,req.query.basis||'paid',req.query.platform||'全部',req.query.category||'');res.setHeader('Content-Disposition',`attachment; filename="monthly-${year}.csv"`);res.type('text/csv').send(csv([['月份','有效采购实付','已记录退款','净采购支出','有效订单数'],...s.months.map(m=>[`${year}-${String(m.month).padStart(2,'0')}`,(m.amountCents/100).toFixed(2),(m.refundCents/100).toFixed(2),(m.netCents/100).toFixed(2),m.count])]));});
 app.get('/api/template',(req,res)=>{res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent('采购导入模板.csv'));res.type('text/csv').send(csv([['采购平台','采购账号','订单编号','下单日期','付款日期','供应商','商品名称','规格型号','数量','单位','单价','实付金额','已退款金额','运费','订单状态','收货人姓名','收货地址','联系手机','物流公司','运单号','备注']]));});
 app.post('/api/backup',async(req,res)=>{
  const stamp=new Date().toISOString().replace(/[:.]/g,'-'),filename=`purchase-backup-${stamp}.zip`,dbPath=path.join(dataDir,'backups',stamp+'.sqlite'),zipPath=path.join(dataDir,'backups',filename);await store.backup(dbPath);
  await new Promise((resolve,reject)=>{const out=fs.createWriteStream(zipPath),archive=archiver('zip',{zlib:{level:6}});out.on('close',resolve);out.on('error',reject);archive.on('error',reject);archive.pipe(out);archive.file(dbPath,{name:'purchases.sqlite'});archive.directory(path.join(dataDir,'originals'),'originals');archive.directory(path.join(dataDir,'attachments'),'attachments');for(const name of fs.readdirSync(path.join(dataDir,'images')).filter(n=>/^[a-f0-9]{64}(?:\.thumb)?\.(jpg|png|webp|gif|avif)$/.test(n)))archive.file(path.join(dataDir,'images',name),{name:'images/'+name});archive.append(JSON.stringify({version:1,createdAt:new Date().toISOString(),orders:store.list().length},null,2),{name:'manifest.json'});archive.finalize();});fs.unlinkSync(dbPath);res.json({filename,url:'/api/backup/'+filename});
 });
 app.get('/api/backup/:file',(req,res)=>{if(!/^purchase-backup-[\dTZ-]+\.zip$/.test(req.params.file))throw Error('无效备份文件');res.download(path.join(dataDir,'backups',req.params.file));});
 app.get('/vendor/address-parse.js',(req,res)=>res.sendFile(path.join(root,'node_modules/address-parse/dist/bundle.js')));
 app.get('/vendor/chart.js',(req,res)=>res.sendFile(path.join(root,'node_modules/chart.js/dist/chart.umd.js')));
 app.get('/vendor/tabulator.js',(req,res)=>res.sendFile(path.join(root,'node_modules/tabulator-tables/dist/js/tabulator.min.js')));
 app.get('/vendor/tabulator.css',(req,res)=>res.sendFile(path.join(root,'node_modules/tabulator-tables/dist/css/tabulator.min.css')));
 app.use(express.static(path.join(root,'public')));
 app.use((err,req,res,next)=>{if(res.headersSent)return next(err);let message=err.message||'操作失败';if(message.includes('UNIQUE constraint'))message='该平台、账号下的订单号已存在';if(err.code==='LIMIT_FILE_SIZE')message=['/api/attachments','/api/ocr'].includes(req.path)?'单个文件超过限制，最多 50 MB，请缩小后重试':'文件不能超过 25 MB';if(err.code==='LIMIT_FILE_COUNT'||err.code==='LIMIT_UNEXPECTED_FILE')message='一次最多上传 20 个文件，请减少后重试';if(message==='MONTH_LOCKED'){err.status=423;err.code='MONTH_LOCKED';message='该月份的平台采购数据已锁定，请先到「月度确认」取消确认后再修改。';}res.status(err.status||400).json({error:message,code:err.code,conflicts:err.conflicts,locks:err.locks,availableOn:err.availableOn,availableAt:err.availableAt,preview:err.preview,report:err.report});});
 mobile=createMobileAccess({store,addresses,supplierManagement,jobs,saveOrder,recognize,ocrUpload,attachmentUpload,root,desktopApp:app,now:mobileNow,policyFile:mobilePolicyFile,isMaintenance:integration.maintenance});
 const agentOperations=purchaseAgentOperations({store,taskBoard,taskCenter,supplierManagement,addresses,attachments,jobs});
 agentOperations['image.prepare']={async:true,prepare:i=>({summary:'提取订单原件图片索引',evidence:[store.get(i.id)],commitData:{}}),commit:i=>orderImages.prepare(i.id)};
 agentOperations['image.cache']={async:true,prepare:i=>({summary:'缓存订单凭证图片',evidence:[store.get(i.id),orderImages.list(i.id)],commitData:{}}),commit:i=>orderImages.cache(i.id,i.imageId)};
 agentOperations['import.preview']={query:input=>{const p=previews.get(input.previewId);if(!p)throw Error('导入预览已过期');return describe(p);}};
 agentOperations['import.commit']={prepare:input=>{
  const p=previews.get(input.previewId);if(!p)throw Error('导入预览已过期');const preview=describe(p),indices=[...new Set(input.indices||[])];
  if(!indices.length||indices.some(i=>!Number.isInteger(i)||!p.parsed.orders[i]||p.parsed.orders[i].importStatus!=='ready'))throw Error('所选订单包含重复、冲突、无效或锁定数据');
  const orders=indices.map(i=>p.parsed.orders[i]);
  return {summary:`导入 ${orders.length} 笔采购订单`,scope:{platform:p.options.platform,account:p.options.account},evidence:[{filename:p.filename,sha256:hash(p.buffer),summary:preview.summary}],blocks:[{type:'table',rows:orders.map(({raw,...o})=>o)}],changes:orders.map(o=>({action:'add',orderNo:o.orderNo,amountCents:o.amountCents,refundCents:o.refundCents})),commitData:{filename:p.filename,buffer:p.buffer.toString('base64'),orders:orders.map(o=>({index:o.index,order:validateOrder(o),original:{headers:p.table.headers,rows:o.raw,normalized:o}})),lineCount:p.parsed.lineCount,metadata:{sheet:p.table.sheet,...p.options,issues:p.parsed.issues,selected:indices.length,importReport:importReportDraft(p.filename,p.parsed.orders,p.parsed.issues,indices)}}};
 },commit:(_input,data)=>{const buffer=Buffer.from(data.buffer,'base64'),source=stash(buffer,data.filename);try{return store.importBatch(data.orders,{...source,lineCount:data.lineCount,metadata:data.metadata});}catch(e){fs.unlinkSync(path.join(dataDir,source.filePath));throw e;}}};
 const agentService=createPurchaseAgentService({store,key:integration.workbench.key,binding:()=>({dataSetId:integration.state.dataSetId,revision:integration.state.revision}),operations:agentOperations});
 installPurchaseAgentRoutes(integration.router,agentService);
 integration.workbench.finalize();
 return {app,store,usage,runUpgradeCheck,mobile,integration,transfers};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {app,store,usage,runUpgradeCheck,mobile,integration}=createApp();const port=Number(process.env.PORT||17868);const server=app.listen(port,'127.0.0.1',()=>console.log(`灵兔采购台已启动：http://127.0.0.1:${port}`));integration.attach(server);
 const mobileServer=mobile.app.listen(Number(process.env.PURCHASE_MOBILE_PORT||17869),'127.0.0.1',()=>console.log('手机配对管理：http://127.0.0.1:'+port+'/phone'));
 mobileServer.on('error',err=>console.error('手机入口未启动：'+err.message));
 // 记录本次打开（日活/使用次数）；后台检查更新、预留上报，均不阻塞启动。
 let installId='';
 try{installId=usage.recordOpen().installId;}catch(e){console.error('记录使用次数失败：',e.message);}
 if(appStatsEndpoint)reportOpen(appStatsEndpoint,installId).catch(err=>console.error('日活上报失败：',err.message));
 runUpgradeCheck().catch(err=>console.error('检查更新失败：',err.message));
 server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'端口已占用，请打开现有灵兔采购台。':err.message);store.close();process.exit(1);});
 const shutdown=()=>{mobileServer.close();server.close(()=>{store.close();process.exit(0);});};integration.onStop=shutdown;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
}
