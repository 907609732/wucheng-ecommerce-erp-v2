import fs from 'node:fs';
import path from 'node:path';
import {provisionWorkbenchKey,verifyWorkbenchActor} from './workbench-actor.mjs';
import {migrationInstance} from './workbench-migration-core.mjs';
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const safe=new Set(['GET','HEAD','OPTIONS']);
const localOnly=/\/(?:backups?|restore|mobile-admin|phone|settings\/secrets|settings\/password|admin\/password|admin-password|upgrades?|updates?|stop|maintenance|workbench\/migration)(?:\/|$)|\/integration\/v1\/(?:open|stop|maintenance)|\/api\/(?:settings|data-dir|filesystem)(?:\/|$)/;
const task=/\/(?:jobs|download-jobs|run|sync|start|collect|retry|resume)(?:\/|$)/;
const confirmation=/\/(?:review-session|review|confirm|commit|rollback|lock|unlock|void)(?:\/|$)/;
const download=/\/(?:export|[^/]*-export|template|templates|original|source|attachments|images|evidence)(?:\/|$)/;
const matcher=route=>new RegExp('^'+route.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/:[A-Za-z0-9_]+/g,'[^/]+')+'/?$');
export function installWorkbenchModule(app,router,{module,dataDir,root,state}){
 const key=provisionWorkbenchKey(dataDir),operations=[],patterns=[];
 const service={key,operations,module,onAudit:null};
 let approved=new Set();try{approved=new Set(JSON.parse(fs.readFileSync(path.join(root,'workbench-manifest.json'),'utf8')).operations.filter(o=>o.remote===true).map(o=>o.method+' '+o.path));}catch{}
 const manifestBuild=process.env.LINGTU_WORKBENCH_MANIFEST_BUILD==='1';
 const agentPaths=new Set(['/api/integration/v1/agent/binding','/api/integration/v1/agent/query','/api/integration/v1/agent/prepare','/api/integration/v1/agent/commit','/api/integration/v1/agent/receipts/:key','/api/integration/v1/agent/files/:id','/api/integration/v1/agent/files/upload/start','/api/integration/v1/agent/files/upload/part','/api/integration/v1/agent/files/upload/finish']);
 state.workbench={protocolVersion:1,operations};
 const register=(method,route)=>{const write=!safe.has(method),blocked=localOnly.test(route)||route==='/api/integration/v1/capabilities'||route==='/api/cainiao/authorization'||route.endsWith('/open-folder')||method!=='GET'&&route==='/api/cainiao/connection',kind=!route.startsWith('/api/')?'ui':confirmation.test(route)?'confirmation':download.test(route)&&method==='GET'?'download':write&&/import|upload|attachment|image/.test(route)?'upload':write?'write':'read';const operation={module,method,path:route,kind,remote:!blocked&&(agentPaths.has(route)||kind==='ui'||manifestBuild||approved.has(method+' '+route)),uiOnly:!agentPaths.has(route)&&(route.endsWith('/review-session')||write&&!/\/integration\/v1\/(?:transfers|edits)$/.test(route)),operationId:module+':'+method+':'+route};if(operations.some(x=>x.method===method&&x.path===route))return;operations.push(operation);patterns.push({operation,re:matcher(route)});};
 const publicRoot=path.join(root,'public');const visit=(dir,relative='')=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const rel=relative+'/'+entry.name;if(entry.isDirectory())visit(path.join(dir,entry.name),rel);else if(entry.isFile())register('GET',rel);}};if(fs.existsSync(publicRoot))visit(publicRoot);register('GET','/');
 if(module==='sales')for(const [url,folder]of [['/vendor/chart','chart.js/dist'],['/vendor/tabulator','tabulator-tables/dist']]){const directory=path.join(root,'node_modules',folder);if(fs.existsSync(directory))visit(directory,url);}
 for(const [object,prefix]of [[app,''],[router,'/api/integration/v1']])for(const method of ['get','post','put','patch','delete','head','options']){const original=object[method].bind(object);object[method]=function(route,...handlers){if(typeof route==='string'&&handlers.length)register(method.toUpperCase(),prefix+route);return original(route,...handlers);};}
 app.use((q,r,next)=>{
  if(!q.headers['x-workbench-actor']&&!q.headers['x-workbench-actor-signature'])return next();
  try{
   if(!loopback.has(q.socket.remoteAddress)||! /^(?:127\.0\.0\.1|localhost):\d+$/.test(q.headers.host||''))throw Error('工作台代理必须通过本机回环调用');
   const actor=verifyWorkbenchActor(q.headers,key,{module,method:q.method,path:q.originalUrl});
   const localDesktop=actor.localDesktop===true;
   if(localDesktop){
    const expectedOrigin='http://'+q.headers.host,hostPort=Number(q.headers.host.split(':').at(-1));
    if(actor.channel!=='ui'||!actor.id.startsWith('windows:')||actor.id.length<=8||actor.uiOrigin!==expectedOrigin||hostPort!==q.socket.localPort||(q.headers.origin!==undefined&&q.headers.origin!==expectedOrigin))throw Object.assign(Error('本机工作台身份或页面来源无效'),{status:403});
   }
   q.workbenchActor=actor;
   if(!safe.has(q.method))r.once('finish',()=>{try{service.onAudit?.({actor,method:q.method,path:q.path,status:r.statusCode});}catch{}});
   r.set('X-Content-Type-Options','nosniff');r.set('Referrer-Policy','same-origin');r.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'self'");
   const ui=localDesktop?'/':'/apps/'+module+'/',api=localDesktop?'':'/apps/'+module;
   // Never trust unbound forwarded prefix/header values.
   q.workbench={module,uiPrefix:ui,apiBase:api,localDesktop};
   if(q.path.startsWith('/api/')){
    const found=patterns.find(p=>p.operation.method===(q.method==='HEAD'?'GET':q.method)&&p.re.test(q.path));
    const coordinator=!localDesktop&&q.path.startsWith('/api/integration/v1/workbench/migration/')&&actor.channel==='ui';
    if(localDesktop&&localOnly.test(q.path))throw Object.assign(Error('本机业务页面不能执行主机维护操作'),{status:403});
    if(!found||!found.operation.remote&&!coordinator)throw Object.assign(Error('此接口仅允许主机本地管理'),{status:403});
    if(found.operation.uiOnly&&actor.channel!=='ui')throw Object.assign(Error('当前身份不能执行此操作'),{status:403});
   }else if(!safe.has(q.method))throw Object.assign(Error('不允许此页面操作'),{status:403});
   const upstreamPath=q.path,json=r.json.bind(r);r.json=value=>json(upstreamPath.startsWith('/api/integration/v1/agent/')||upstreamPath.startsWith('/api/integration/v1/workbench/migration/')||upstreamPath==='/api/integration/v1/workbench/operations'?value:remoteValue(value,{module,ui,api}));
   const sendFile=r.sendFile.bind(r);r.sendFile=(file,...args)=>{if(!localDesktop&&path.extname(file)==='.html'){
    let html=fs.readFileSync(file,'utf8');html=html.replace(/(<(?:script|link|img|a|iframe|form)\b[^>]*?\b(?:src|href|action)=['"])\/(?!\/)/gi,(_,start)=>start+ui);html=html.replace(/<head([^>]*)>/i,'<head$1><script src="'+ui+'workbench-base.js"></script>');r.type('html');return r.send(html);
   }return sendFile(file,...args);};
   // express.static uses sendFile internally, so serve protected HTML explicitly.
   if(q.method==='GET'&&(q.path==='/'||q.path.endsWith('.html'))){const relative=q.path==='/'?'index.html':q.path.slice(1);if(!relative.includes('..')){const file=path.join(root,'public',relative);if(fs.existsSync(file))return r.sendFile(file);}}
   next();
  }catch(e){r.status(e.status||e.statusCode||401).json({error:e.message,code:e.code||'WORKBENCH_AUTH'});}
 });
 router.get('/workbench/operations',(_q,r)=>r.json({schemaVersion:1,module,operations}));
 return service;
}
export function installWorkbenchAudit(integration,store){
 const {db}=store,module=integration.workbench.module;migrationInstance(store,module);const revisionKey='revision:'+module;db.prepare('INSERT OR IGNORE INTO workbench_identity(key,value) VALUES(?,?)').run(revisionKey,'0');
 Object.defineProperties(integration.state,{dataSetId:{enumerable:true,get:()=>db.prepare('SELECT value FROM workbench_identity WHERE key=?').get('ledger:'+module).value},revision:{enumerable:true,get:()=>db.prepare('SELECT value FROM workbench_identity WHERE key=?').get(revisionKey).value}});
 db.exec('CREATE TABLE IF NOT EXISTS workbench_request_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,status INTEGER NOT NULL,created_at TEXT NOT NULL)');integration.workbench.onAudit=entry=>db.prepare('INSERT INTO workbench_request_audit(actor,method,path,status,created_at) VALUES(?,?,?,?,?)').run(JSON.stringify(entry.actor),entry.method,entry.path,entry.status,new Date().toISOString());
 // Database triggers include standalone scripts and the original phone app. The
 // counter participates in the business transaction, so failed writes roll back.
 integration.workbench.finalize=()=>{for(const {name}of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()){if(!/^[a-z_]+$/.test(name)||name.startsWith('sqlite_')||name.startsWith('workbench_')||name.startsWith('agent_')||['settings','mutex','mobile_sessions','mobile_attachment_owners','integration_edit_drafts'].includes(name))continue;for(const event of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS workbench_revision_${name}_${event.toLowerCase()} AFTER ${event} ON ${name} BEGIN UPDATE workbench_identity SET value=CAST(value AS INTEGER)+1 WHERE key='${revisionKey}';END;`);}};
 integration.workbench.finalize();
}
function remoteValue(value,{module,ui,api}){
 if(Array.isArray(value))return value.map(v=>remoteValue(v,{module,ui,api}));
 if(value&&typeof value==='object'){const result=Object.fromEntries(Object.entries(value).filter(([k])=>!['token','integrationKey','workbenchKey','dataDir','root','pid','keyFile','nodePath','exe','filePath','profileDir','ledgerPath','sqlitePath','file_path','original_path','evidence_path'].includes(k)).map(([k,v])=>[k,k==='path'&&typeof v==='string'&&(/^[A-Z]:[\\/]/i.test(v)||v.startsWith('\\\\'))?'':remoteValue(v,{module,ui,api})]));if(result.sources)for(const id of ['purchase','sales'])if(result.sources[id]?.url)result.sources[id].url='/apps/'+id+'/';return result;}
 if(typeof value==='string'){
  if(/^[A-Z]:[\\/]/i.test(value)||value.startsWith('\\\\'))return '[仅主机本地可用]';
  if(/[A-Z]:[\\/]/i.test(value))return value.replace(/[A-Z]:[\\/][^\r\n"'<>|]*/gi,'[主机路径]');
  if(value.startsWith('/api/'))return api+value;
  if(value.startsWith('/')&&!value.startsWith('//'))return ui+value.slice(1);
  if(/^http:\/\/127\.0\.0\.1:17868\/?$/.test(value))return '/apps/purchase/';
  if(/^http:\/\/127\.0\.0\.1:178(?:70|90)\/?$/.test(value))return value.includes('17890')?'/apps/overview/':'/apps/sales/';
 }
 return value;
}
