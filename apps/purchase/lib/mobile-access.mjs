import {provisionWorkbenchKey} from './workbench-actor.mjs';
import {requireDelivery} from '../public/delivery-required.mjs';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {randomBytes,randomUUID,randomInt,createHash,timingSafeEqual} from 'node:crypto';
import {extractText,validateOrder} from './importer.mjs';
import {importRules} from '../public/import-rules.mjs';
import {createTailscale} from './tailscale.mjs';
import {filterOrders,sortOrders,orderSearchValues} from '../public/order-query.mjs';
import {MAX_FILES,validateUploadLimits} from '../public/upload-limits.mjs';
import {normalizeAddress} from './addresses.mjs';
import {mobileWorkbenchIdentity,mobileBusinessWrite,mobilePolicyPath} from './mobile-workbench-policy.mjs';

const digest=v=>createHash('sha256').update(v).digest('hex');
const secret=()=>randomBytes(32).toString('hex');
const fail=(status,message)=>Object.assign(Error(message),{status});
export function createMobileAccess({store,addresses,supplierManagement,jobs,saveOrder,recognize,ocrUpload,attachmentUpload,root,desktopApp,now=Date.now,policyFile,isMaintenance=()=>false,agentManaged=process.env.LINGTU_AGENT_MANAGED==='1'}){
 const db=store.db,app=express(),mobileRoutes=[],workbenchKey=agentManaged?provisionWorkbenchKey(store.dir):undefined;
 for(const method of ['get','post','put','delete']){const register=app[method].bind(app);app[method]=(route,...handlers)=>{if(typeof route==='string'&&route.startsWith('/api/mobile')&&handlers.length)mobileRoutes.push({method,route});return register(route,...handlers);};}
 db.exec(`CREATE TABLE IF NOT EXISTS mobile_sessions(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS mobile_requests(id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id), created_at INTEGER NOT NULL);`);
 db.exec(`CREATE TABLE IF NOT EXISTS mobile_upload_history(id TEXT PRIMARY KEY,filenames TEXT NOT NULL,created_at TEXT NOT NULL,order_id TEXT,session_id TEXT NOT NULL);`);
 db.exec('CREATE TABLE IF NOT EXISTS mobile_attachment_owners(attachment_id TEXT PRIMARY KEY,session_id TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS mobile_order_edits(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,order_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
 if(!db.prepare('PRAGMA table_info(mobile_sessions)').all().some(c=>c.name==='workbench_actor'))db.exec("ALTER TABLE mobile_sessions ADD COLUMN workbench_actor TEXT NOT NULL DEFAULT ''");
 let activeWrites=0;
 const configFile=path.join(store.dir,'mobile-config.json');
 let config={enabled:false,origin:''};try{config={...config,...JSON.parse(fs.readFileSync(configFile,'utf8'))};}catch{}
 let pairing=null,attempts=0,blockedUntil=0;
 const ownedJobs=new Map();
 const configure=input=>{
  if(typeof input.enabled!=='boolean')throw fail(400,'请明确开启或关闭手机访问');
  const origin=String(input.origin||config.origin);
  if(input.enabled&&!/^https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net$/.test(origin))throw fail(400,'请输入 Tailscale Serve 的 HTTPS 地址，不含路径和端口');
  pairing=null;
  config={enabled:input.enabled,origin};fs.writeFileSync(configFile,JSON.stringify(config,null,2));
  if(!config.enabled){db.exec('DELETE FROM mobile_sessions');pairing=null;ownedJobs.clear();}
  return config;
 };
 desktopApp.get('/phone',(_req,res)=>res.sendFile('mobile-admin.html',{root:path.join(root,'public')}));
 const admin=express.Router();
 const tailscale=createTailscale();
 admin.get('/tailscale/status',async(_req,res)=>res.json({...await tailscale.status(config.origin),mobileEnabled:config.enabled}));
 admin.post('/tailscale/open',async(_req,res)=>res.json(await tailscale.open()));
 admin.get('/',(_req,res)=>res.json({...config,pairingExpiresAt:pairing?.expires>now()?pairing.expires:null,sessions:db.prepare('SELECT id,created_at,expires_at FROM mobile_sessions WHERE expires_at>?').all(now())}));
 admin.post('/config',(req,res)=>res.json(configure(req.body)));
 admin.post('/qrcode',async(_req,res)=>{
  if(!config.enabled)throw fail(400,'请先配置并开启手机访问');
  const origin=config.origin,value=secret(),expiresAt=now()+300000;
  pairing={hash:digest(value),expires:expiresAt};
  const image=await QRCode.toDataURL(origin+'/#pair='+value,{width:288,margin:4,errorCorrectionLevel:'M'});
  res.json({origin,image,expiresAt});
 });
 admin.post('/pairing',(_req,res)=>{
  if(!config.enabled)throw fail(400,'请先配置并开启手机访问');
  const code=String(randomInt(10000000,100000000));pairing={hash:digest(code),expires:now()+300000};
  res.json({code,expiresAt:pairing.expires,origin:config.origin});
 });
 admin.post('/revoke',(req,res)=>{db.prepare('DELETE FROM mobile_sessions WHERE id=?').run(String(req.body.id));res.json({ok:true});});
 desktopApp.use('/api/mobile-admin',admin);
 desktopApp.use('/api/mobile-admin',(err,req,res,next)=>res.status(err.status||400).json({error:err.message}));

 app.disable('x-powered-by');
 app.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  if(!agentManaged&&!config.enabled)return res.status(503).json({error:'手机入口未开启'});
  if(!agentManaged&&req.headers.host!==new URL(config.origin).host)return res.status(403).json({error:'访问地址不正确'});
  if(!agentManaged&&!['GET','HEAD'].includes(req.method)&&req.headers.origin!==config.origin)return res.status(403).json({error:'请求来源不正确'});
  try{req.workbenchActor=mobileWorkbenchIdentity(req,{policyFile:agentManaged?undefined:mobilePolicyPath(policyFile),origin:config.origin,managed:agentManaged,workbenchKey});}catch(e){return res.status(e.status||403).json({error:e.message});}
  if(mobileBusinessWrite(req)&&isMaintenance())return res.status(503).json({error:'采购台正在维护，请稍后再保存',code:'MODULE_MAINTENANCE'});
  if(mobileBusinessWrite(req)){activeWrites++;let finished=false;const done=()=>{if(finished)return;finished=true;activeWrites--;if(req.workbenchActor)try{db.prepare('INSERT INTO workbench_request_audit(actor,method,path,status,created_at) VALUES(?,?,?,?,?)').run(JSON.stringify(req.workbenchActor),req.method,req.path,res.statusCode,new Date().toISOString());}catch{}};res.once('finish',done);res.once('close',done);}
  next();
 });
 app.use(express.json({limit:'1mb'}));
 app.get('/',(_req,res)=>res.sendFile('mobile.html',{root:path.join(root,'public')}));
 for(const name of ['delivery-required.mjs','order-query.mjs','order-attributes.mjs','classification.mjs','order-number.mjs','mobile.js','mobile-query.js','mobile.css','surface-theme.css','upload-limits.mjs','supplier-picker.js','order-form-view.js','shipments.mjs','address-parse.mjs'])app.get('/'+name,(_req,res)=>res.sendFile(name,{root:path.join(root,'public')}));
 app.post('/api/mobile/pair',(req,res)=>{
  if(now()<blockedUntil)throw fail(429,'尝试过多，请十分钟后重试');
  if(!agentManaged){
  const value=digest(String(req.body.code||'').trim());
  if(!pairing||pairing.expires<=now()||!timingSafeEqual(Buffer.from(value),Buffer.from(pairing.hash))){
   if(++attempts>=5){blockedUntil=now()+600000;attempts=0;}
   throw fail(401,'配对码错误或已过期，请在电脑重新生成');
  }
  }
  pairing=null;attempts=0;const id=randomUUID(),valueSecret=secret(),csrf=secret();
  db.prepare('INSERT INTO mobile_sessions(id,secret_hash,csrf,created_at,expires_at) VALUES (?,?,?,?,?)').run(id,digest(valueSecret),csrf,now(),now()+30*86400000);
  if(req.workbenchActor)db.prepare('UPDATE mobile_sessions SET workbench_actor=? WHERE id=?').run(req.workbenchActor.id,id);
  res.setHeader('Set-Cookie',`purchase_mobile=${id}.${valueSecret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`);
  res.json({csrf});
 });
 app.use('/api/mobile',(req,res,next)=>{
  const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('purchase_mobile='))?.slice(16)||'';
  const [id,value]=raw.split('.'),session=id&&db.prepare('SELECT * FROM mobile_sessions WHERE id=? AND expires_at>?').get(id,now());
  if(!session||digest(value||'')!==session.secret_hash)return res.status(401).json({error:'请先在电脑上配对手机'});
  if(agentManaged&&!session.workbench_actor)return res.status(401).json({error:'此旧手机会话尚未绑定真实登录，请重新从共享工作台进入'});
  if(req.workbenchActor){if(session.workbench_actor&&session.workbench_actor!==req.workbenchActor.id)return res.status(403).json({error:'手机配对会话属于其他 Tailscale 用户，请重新配对'});if(!session.workbench_actor)db.prepare('UPDATE mobile_sessions SET workbench_actor=? WHERE id=?').run(req.workbenchActor.id,id);}
  if(!['GET','HEAD'].includes(req.method)&&(req.headers['x-mobile-csrf']||(agentManaged?req.headers['x-review-token']:undefined))!==session.csrf)return res.status(403).json({error:'会话校验失败，请刷新页面'});
  req.mobileSession=session;next();
 });
 if(!db.prepare('PRAGMA table_info(mobile_sessions)').all().some(c=>c.name==='username'))db.exec("ALTER TABLE mobile_sessions ADD COLUMN username TEXT NOT NULL DEFAULT ''");
 db.exec("INSERT OR IGNORE INTO order_origins(order_id,channel,username) SELECT order_id,'mobile','' FROM mobile_requests");
 app.get('/api/mobile/session',(req,res)=>res.json({csrf:req.mobileSession.csrf,username:req.mobileSession.username,managed:agentManaged}));
 app.post('/api/mobile/username',(req,res)=>{
  const username=typeof req.body.username==='string'?req.body.username.trim():'';
  if(!username||username.length>40||/[\x00-\x1f]/.test(username))throw fail(400,'请填写1至40字的录入人姓名');
  db.prepare('UPDATE mobile_sessions SET username=? WHERE id=?').run(username,req.mobileSession.id);res.json({username});
 });
 app.get('/vendor/address-parse.js',(_req,res)=>res.sendFile('bundle.js',{root:path.join(root,'node_modules/address-parse/dist')}));
 app.get('/api/mobile/addresses',(_req,res)=>res.json(addresses.list({tag:'收货地址'}).filter(a=>!a.supplier)));
 app.post('/api/mobile/addresses',(req,res)=>{
  const value=normalizeAddress({name:req.body.name,phone:req.body.phone,address:req.body.address,tags:['收货地址']});
  if(!value.phone||!value.address)throw fail(400,'请填写收货人、联系电话和收货地址');
  const existing=addresses.list({tag:'收货地址'}).find(a=>!a.supplier&&a.name===value.name&&a.phone===value.phone&&a.address===value.address);
  res.json(existing||addresses.create(value));
 });
 app.get('/api/mobile/form-options',(_req,res)=>res.json({platforms:Object.keys(importRules),orders:store.list().map(({platform,supplier,account,supplierContact,date,updatedAt})=>({platform,supplier,account,supplierContact,date,updatedAt})),addresses:addresses.list().filter(a=>a.supplier||a.tags?.includes('供应商地址')),supplierProfiles:supplierManagement.profiles().map(({name,contact,phone,shops,addresses})=>({name,contact,phone,shops,addresses}))}));
 app.post('/api/mobile/logout',(req,res)=>{db.prepare('DELETE FROM mobile_sessions WHERE id=?').run(req.mobileSession.id);res.setHeader('Set-Cookie','purchase_mobile=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');res.json({ok:true});});
 app.get('/api/mobile/orders',(req,res)=>{
  const page=Math.max(1,Math.min(1000000,Math.floor(Number(req.query.page)||1))),basis=req.query.basis==='created'?'created':'paid';
  const sorts={'uploaded-desc':[{field:'createdAt',dir:'desc'}],'uploaded-asc':[{field:'createdAt',dir:'asc'}],'purchase-desc':[{field:'purchaseDate',dir:'desc'}],'purchase-asc':[{field:'purchaseDate',dir:'asc'}]};
  const all=sortOrders(filterOrders(store.list(),{...req.query,q:String(req.query.q||'').slice(0,200)},basis),sorts[req.query.sortBy]||sorts['purchase-desc'],basis);
  res.json({total:all.length,page,orders:all.slice((page-1)*30,page*30).map(o=>({id:o.id,orderNo:o.orderNo,date:o.date,supplier:o.supplier,amountCents:o.amountCents,status:o.status,fields:orderSearchValues(o)}))});
 });
 app.get('/api/mobile/orders/recent',(req,res)=>{
  const page=Math.max(1,Math.min(1000000,Math.floor(Number(req.query.page)||1)));
  const records=db.prepare('SELECT order_id FROM mobile_requests r JOIN orders o ON o.id=r.order_id ORDER BY r.created_at DESC,r.rowid DESC').all();
  res.json({total:records.length,page,orders:records.slice((page-1)*30,page*30).map(r=>store.get(r.order_id)).map(o=>({id:o.id,orderNo:o.orderNo,supplier:o.supplier,platform:o.platform,status:o.status,amountCents:o.amountCents,createdAt:o.createdAt,product:o.items.map(i=>i.title).join('；')}))});
 });
 app.get('/api/mobile/orders/latest',(_req,res)=>{
  const latest=db.prepare('SELECT order_id FROM mobile_requests ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
  const order=latest?store.get(latest.order_id):store.list().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
  res.json({order:order||null});
 });
 app.get('/api/mobile/orders/:id',(req,res)=>{const o=store.get(req.params.id);if(!o)throw fail(404,'订单不存在');res.json(o);});
 app.put('/api/mobile/orders/:id',(req,res)=>{
  const requestId=req.headers['x-request-id']||(agentManaged?req.headers['idempotency-key']:undefined);
  if(typeof requestId!=='string'||!/^[0-9a-f-]{36}$/i.test(requestId))throw fail(400,'缺少有效的提交编号');
  const allowed=['platform','account','orderNo','date','paidAt','supplier','supplierContact','amountCents','refundCents','shippingCents','status','note','items','recipient','address','phone','logisticsCompany','trackingNo','classification','attachmentIds','updatedAt'];
  const input=Object.fromEntries(allowed.filter(k=>Object.hasOwn(req.body,k)).map(k=>[k,req.body[k]]));
  const hash=digest(JSON.stringify({orderId:req.params.id,input}));
  const result=store.transaction(()=>{
   const prior=db.prepare('SELECT * FROM mobile_order_edits WHERE id=?').get(requestId);
   if(prior){if(prior.payload_hash!==hash)throw fail(409,'此提交编号已经用于其他修改');return {order:store.get(prior.order_id),replayed:true};}
   const before=store.get(req.params.id);if(!before)throw fail(404,'订单不存在');
   if(input.updatedAt!==before.updatedAt)throw fail(409,'订单已被修改，请重新打开订单后编辑');
   if(input.attachmentIds!==undefined){
    if(!Array.isArray(input.attachmentIds)||input.attachmentIds.length>MAX_FILES||input.attachmentIds.some(id=>typeof id!=='string'||!id||id.length>64))throw fail(400,'附件列表无效，每单最多20个');
    for(const id of input.attachmentIds)if(!before.attachmentIds.includes(id)&&db.prepare('SELECT session_id FROM mobile_attachment_owners WHERE attachment_id=?').get(id)?.session_id!==req.mobileSession.id)throw fail(403,'不能使用其他会话或电脑上传的附件');
   }
   requireDelivery({...before,...input});
   const order=store.update(before.id,{...before,...input});
   db.prepare('INSERT INTO mobile_order_edits VALUES(?,?,?,?)').run(requestId,hash,order.id,now());
   return {order,replayed:false};
  });res.json(result);
 });
 const orderRefs=ids=>ids.map(id=>store.get(id)).filter(Boolean).map(({id,orderNo,supplier})=>({id,orderNo,supplier}));
 const history=()=>{
  const orders=store.list(),sourceRows=store.imports().map(s=>({id:s.id,kind:'source',filename:s.filename,filenames:s.metadata?.files?.map(f=>f.filename)||[],createdAt:s.created_at,status:'saved',orders:orderRefs([...new Set([...orders.filter(o=>o.sourceId===s.id).map(o=>o.id),...db.prepare('SELECT order_id FROM order_supplements WHERE source_id=?').all(s.id).map(r=>r.order_id)])]),downloadUrl:'/api/mobile/uploads/source/'+s.id}));
  const attachmentRows=db.prepare('SELECT id,order_id,filename,created_at FROM order_attachments WHERE order_id IS NOT NULL AND active=1 ORDER BY created_at DESC').all().map(a=>({id:a.id,kind:'attachment',filename:a.filename,createdAt:a.created_at,status:'saved',orders:orderRefs([a.order_id]),downloadUrl:'/api/mobile/uploads/attachment/'+a.id}));
  const pending=db.prepare('SELECT * FROM mobile_upload_history WHERE order_id IS NULL').all().map(a=>{const job=jobs.get(a.id),filenames=JSON.parse(a.filenames);return {id:a.id,kind:'attempt',filename:filenames.join('、'),createdAt:a.created_at,status:job?.status||'expired',error:job?.error||'',orders:[],downloadUrl:null};});
  return [...sourceRows,...attachmentRows,...pending].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
 };
 app.get('/api/mobile/uploads',(req,res)=>{
  const q=String(req.query.q||'').trim().toLocaleLowerCase(),page=Math.max(1,Math.min(1000000,Math.floor(Number(req.query.page)||1)));
  const rows=history().filter(r=>(!req.query.kind||r.kind===req.query.kind)&&(!req.query.from||r.createdAt.slice(0,10)>=req.query.from)&&(!req.query.to||r.createdAt.slice(0,10)<=req.query.to)&&(!q||[r.filename,...r.filenames||[],...r.orders.flatMap(o=>[o.orderNo,o.supplier])].join(' ').toLocaleLowerCase().includes(q)));
  res.json({total:rows.length,page,uploads:rows.slice((page-1)*30,page*30)});
 });
 app.get('/api/mobile/uploads/source/:id',(req,res)=>{const s=db.prepare('SELECT file_path,filename FROM imports WHERE id=?').get(req.params.id);if(!s?.file_path)throw fail(404,'原件不存在');const file=path.resolve(store.dir,s.file_path);if(!file.startsWith(path.resolve(store.dir,'originals')+path.sep))throw fail(403,'原件路径无效');res.download(file,s.filename,{cacheControl:false});});
 app.get('/api/mobile/uploads/attachment/:id',(req,res)=>{const a=db.prepare('SELECT order_id,filename FROM order_attachments WHERE id=? AND active=1').get(req.params.id);if(!a?.order_id||!store.get(a.order_id))throw fail(404,'附件不存在');const resource=store.attachments.resource(req.params.id,'full');res.download(resource.path,a.filename,{cacheControl:false});});
 app.post('/api/mobile/text',(req,res)=>res.json({order:extractText(String(req.body.text||'').slice(0,100000),req.body.platform||'其他')}));
 app.post('/api/mobile/attachments',attachmentUpload.array('files',MAX_FILES),async(req,res)=>{
  if(!req.files?.length)throw fail(400,'请选择附件图片或文件');
  validateUploadLimits(req.files.map(f=>({name:f.originalname,size:f.size})));
  const saved=[];
  try{
   for(const file of req.files){
    const name=Buffer.from(file.originalname,'latin1').toString('utf8');
    const attachment=await store.attachments.stash(file.buffer,path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_'),file.mimetype);
    saved.push(attachment);db.prepare('INSERT INTO mobile_attachment_owners VALUES(?,?)').run(attachment.id,req.mobileSession.id);
   }
  }catch(e){for(const a of saved){db.prepare('DELETE FROM mobile_attachment_owners WHERE attachment_id=?').run(a.id);store.attachments.remove(a.id);}throw e;}
  res.json(saved.map(({id,filename,bytes})=>({id,filename,bytes})));
 });
 app.get('/api/mobile/orders/:id/attachments',(req,res)=>{
  if(!store.get(req.params.id))throw fail(404,'订单不存在');
  res.json(store.attachments.list(req.params.id).map(a=>({...a,thumbUrl:null,downloadUrl:'/api/mobile/uploads/attachment/'+a.id})));
 });
 app.post('/api/mobile/ocr',ocrUpload.array('file',20),async(req,res)=>{
  for(const id of ownedJobs.keys())if(!jobs.has(id))ownedJobs.delete(id);
  const json=res.json.bind(res);res.json=data=>{if(data.id){ownedJobs.set(data.id,req.mobileSession.id);const job=jobs.get(data.id);db.prepare('INSERT INTO mobile_upload_history VALUES(?,?,?,?,?)').run(data.id,JSON.stringify(job?.files?.map(f=>f.filename)||[]),new Date(now()).toISOString(),null,req.mobileSession.id);}return json(data);};
  await recognize(req,res);
 });
 app.get('/api/mobile/ocr/:id',(req,res)=>{
  const job=jobs.get(req.params.id);if(!job||ownedJobs.get(job.id)!==req.mobileSession.id)throw fail(404,'识别任务已过期，请重新上传');
  res.json({id:job.id,status:job.status,progress:job.progress,result:job.result,error:job.error});
 });
 const lookup=(id,hash)=>{
  const record=db.prepare('SELECT * FROM mobile_requests WHERE id=?').get(id);
  if(record&&record.payload_hash!==hash)throw fail(409,'此提交编号已经用于其他内容，请重新核对');
  return record&&store.get(record.order_id);
 };
 app.post('/api/mobile/orders',async(req,res)=>{
  const id=req.headers['x-request-id']||(agentManaged?req.headers['idempotency-key']:undefined);if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))throw fail(400,'缺少有效的提交编号');
  // Only attachments uploaded by this mobile session may be bound to a new order.
  const allowed=['platform','account','orderNo','date','paidAt','supplier','supplierContact','amountCents','refundCents','shippingCents','status','note','items','recipient','address','phone','logisticsCompany','trackingNo','classification','ocrJobId','recognizedText','attachmentIds'];
  req.body=Object.fromEntries(allowed.filter(k=>Object.hasOwn(req.body,k)).map(k=>[k,req.body[k]]));
  const hash=digest(JSON.stringify(req.body)),old=lookup(id,hash);if(old)return res.json({order:old,replayed:true});
  if(req.body.attachmentIds!==undefined){
   const ids=req.body.attachmentIds;
   if(!Array.isArray(ids)||ids.length>MAX_FILES||ids.some(id=>typeof id!=='string'||!id||id.length>64))throw fail(400,'附件列表无效，每单最多20个');
   for(const attachment of ids)if(db.prepare('SELECT session_id FROM mobile_attachment_owners WHERE attachment_id=?').get(attachment)?.session_id!==req.mobileSession.id)throw fail(403,'不能使用其他会话或电脑上传的附件');
   store.attachments.validate(null,ids);
  }
  if(req.body.ocrJobId&&ownedJobs.get(req.body.ocrJobId)!==req.mobileSession.id)throw fail(403,'不能使用其他会话的识别任务');
  requireDelivery(req.body);
  if(!req.mobileSession.username)throw fail(400,'请先设置录入人姓名');
  req.mobileSubmission={id,hash};const json=res.json.bind(res);
  res.json=()=>json({order:store.find(validateOrder(req.body)),replayed:false});
  await saveOrder(req,res);
 });
 app.use((_req,res)=>res.status(404).json({error:'手机端不支持此操作'}));
 app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.status||400).json({error:err.code==='MONTH_LOCKED'?'该月份已锁定，请在电脑处理':err.message||'操作失败'});});
 if(agentManaged)for(const {method,route}of mobileRoutes)desktopApp[method](route,(q,r,next)=>app.handle(q,r,next));
 return {app,configure,busy:()=>activeWrites>0,commit(req,fn){return store.transaction(()=>{
  const {id,hash}=req.mobileSubmission,old=lookup(id,hash);if(old)return old;
  const result=fn(),order=store.find(validateOrder(req.body));
  if(!order)throw Error('采购未保存');
  db.prepare("INSERT INTO order_origins(order_id,channel,username) VALUES (?,'mobile',?)").run(order.id,req.workbenchActor?req.workbenchActor.id+' · '+req.mobileSession.username:req.mobileSession.username);
  db.prepare("UPDATE audit SET after_json=? WHERE order_id=? AND action='create'").run(JSON.stringify(store.get(order.id)),order.id);
  db.prepare('INSERT INTO mobile_requests VALUES (?,?,?,?)').run(id,hash,order.id,now());if(req.body.ocrJobId)db.prepare('UPDATE mobile_upload_history SET order_id=? WHERE id=?').run(order.id,req.body.ocrJobId);return result;
 });}};
}
