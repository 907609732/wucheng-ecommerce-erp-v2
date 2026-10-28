// Local service protocol v1. Mirrored in the independently installed desks.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import express from 'express';
import {installWorkbenchModule} from './workbench-module.mjs';

export const integrationHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
export const integrationError=(message,status=400,code='INTEGRATION_ERROR')=>Object.assign(Error(message),{status,code});
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function installLocalIntegration(app,{id,version,root,dataDir,busy=()=>false,capabilities=[],activate=async()=>{},open=async()=>{}}){
  const router=express.Router(),sessions=new Map();
  fs.mkdirSync(dataDir,{recursive:true});
  const keyFile=path.join(dataDir,'.integration-key');
  if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  const key=fs.readFileSync(keyFile,'utf8').trim();
  const profile=integrationHash(path.resolve(dataDir).toLowerCase());
  const state={id,apiVersion:1,version,root:path.resolve(root),dataDir:path.resolve(dataDir),profile,pid:process.pid,capabilities};
  const module={'purchase-desk':'purchase','lingtu-purchase-desk':'purchase','wucheng-sales-desk':'sales','lingtu-business-overview':'overview'}[id]||'purchase';
  const workbench=installWorkbenchModule(app,router,{module,dataDir,root,state});
  const maintenanceFile=path.join(dataDir,'.workbench-maintenance.json');
  let maintenanceOwner=null,nativeMaintenance=process.env.LINGTU_MAINTENANCE==='1';
  let writes=0,server,stopping=false,maintenance=nativeMaintenance;
  const refreshMaintenance=()=>{if(fs.existsSync(maintenanceFile)){try{maintenanceOwner=JSON.parse(fs.readFileSync(maintenanceFile,'utf8'));}catch{maintenanceOwner={maintenance:true,corrupt:true};}maintenance=true;}else{maintenanceOwner=null;maintenance=nativeMaintenance;}return maintenance;};refreshMaintenance();
  app.use((req,res,next)=>{
    if(api.agentBusy?.()&&!req.path.startsWith('/api/integration/v1/agent/'))return res.status(503).json({error:'正在原子提交 Agent 业务，请稍后重试',code:'AGENT_COMMIT_BUSY'});
    refreshMaintenance();
    if(stopping&&req.path!=='/api/integration/v1/capabilities')return res.status(503).json({error:'服务正在停止，请稍后重试'});
    if(maintenance&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!['/api/integration/v1/stop','/api/integration/v1/maintenance/activate'].includes(req.path)&&!req.path.startsWith('/api/integration/v1/workbench/migration/'))return res.status(503).json({error:'模块正在安装检查中，暂不允许修改账本',code:'MODULE_MAINTENANCE'});
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){writes++;let done=false;const finish=()=>{if(!done){done=true;writes--;}};res.once('finish',finish);res.once('close',finish);}
    next();
  });
  router.use((req,res,next)=>{
    const host=req.headers.host||'',origin=req.headers.origin,remote=req.socket.remoteAddress;
    if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))return res.status(403).json({error:'仅允许本机调用'});
    if(origin&&origin!==`http://${host}`)return res.status(403).json({error:'调用来源不符'});
    if(req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'调用来源不符'});
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    next();
  });
  router.get('/capabilities',(_q,r)=>r.json({...state,busy:busy()||writes>0,stopping,maintenance}));
  router.get('/review-session',(q,r)=>{
    if(q.workbenchActor?(q.workbenchActor.channel!=='ui'||q.workbenchActor.role==='viewer'):(q.headers['sec-fetch-site']!=='same-origin'||(q.headers.referer&&!String(q.headers.referer).startsWith(`http://${q.headers.host}/`))))throw integrationError('请从核对页面打开',403);
    for(const[k,s]of sessions)if(s.expires<Date.now())sessions.delete(k);
    if(sessions.size>100)throw integrationError('核对页面过多，请关闭后重试',429);
    const sid=randomBytes(24).toString('hex'),nonce=randomBytes(32).toString('hex');
    sessions.set(sid,{nonce,expires:Date.now()+3600000,actorId:q.workbenchActor?.id,actorSession:q.workbenchActor?.sessionId});
    r.setHeader('Set-Cookie',`integration_review=${sid}; Path=/api/integration/v1; HttpOnly; SameSite=Strict`);
    r.json({nonce});
  });
  router.use((q,r,next)=>{
    if(q.path.startsWith('/agent/')&&q.workbenchActor){q.integration={role:'agent',actor:q.workbenchActor};return next();}
    const sid=String(q.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('integration_review='))?.slice(19);
    const s=sessions.get(sid);
    if(s&&s.expires>Date.now()&&equal(q.headers['x-review-token'],s.nonce)&&(!q.workbenchActor?!s.actorId:q.workbenchActor.channel==='ui'&&s.actorId===q.workbenchActor.id&&s.actorSession===q.workbenchActor.sessionId)){q.integration={role:'ui',session:sid,actor:q.workbenchActor};return next();}
    if(equal(q.headers.authorization,`Bearer ${key}`)){q.integration={role:'agent',actor:q.workbenchActor};return next();}
    r.status(401).json({error:'本机连接已过期，请重新打开核对页面',code:'INTEGRATION_AUTH'});
  });
  router.use(express.json({limit:'160mb'}));
  const requireReview=(q,_r,next)=>{if(q.integration.role!=='ui'||q.workbenchActor&&(q.workbenchActor.channel!=='ui'||q.workbenchActor.role==='viewer'))throw integrationError('此操作必须在核对页面由你确认',403,'UI_CONFIRMATION_REQUIRED');next();};
  router.post('/maintenance/activate',async(q,r)=>{
    if(q.integration.role!=='agent'||q.body.confirm!==true)throw integrationError('仅允许启动台完成模块激活',403);
    if(maintenanceOwner?.migrationId)throw integrationError('迁移维护窗口仍由协调器持有，不能通过模块激活解除',409,'MAINTENANCE_OWNED');
    if(maintenanceOwner?.corrupt)throw integrationError('维护所有者标记损坏，需要在主机核对',409,'MAINTENANCE_OWNED');
    await activate();maintenance=false;nativeMaintenance=false;maintenanceOwner=null;fs.rmSync(maintenanceFile,{force:true});r.json({ok:true});
  });
  router.post('/open',async(q,r)=>{
    if(q.integration.role!=='agent'||q.body.confirm!==true||maintenance)throw integrationError('模块尚未完成激活',403);
    await open();r.json({ok:true});
  });
  router.post('/stop',(q,r)=>{
    if(q.body.confirm!==true)throw integrationError('停止服务需要明确确认');
    if(busy()||writes>1)throw integrationError('有任务或保存请求正在执行，请稍后停止',409,'SERVICE_BUSY');
    stopping=true;r.json({ok:true});setTimeout(()=>{if(api.onStop)api.onStop();else server?.close();},100).unref();
  });
  app.use('/api/integration/v1',router);
  const api={router,requireReview,state,workbench,maintenance:refreshMaintenance,maintenanceOwner:()=>{refreshMaintenance();return maintenanceOwner;},setMaintenance(value,{actor,migrationId}={}){
    refreshMaintenance();if(maintenanceOwner?.corrupt)throw integrationError('维护所有者标记损坏，需要在主机核对',409,'MAINTENANCE_OWNED');
    if(maintenanceOwner?.migrationId&&maintenanceOwner.migrationId!==migrationId)throw integrationError('维护窗口由其他迁移批次持有，不能抢占或解除',409,'MAINTENANCE_OWNED');
    if(maintenanceOwner?.migrationId&&(!actor||actor.role!=='admin'))throw integrationError('解除迁移维护需要签名管理员身份',403,'MAINTENANCE_OWNED');
    if(actor&&(!migrationId||typeof migrationId!=='string'||migrationId.length>200||!/^[-\w]+$/.test(migrationId)))throw integrationError('维护操作缺少有效迁移批次',400,'MIGRATION_ID_REQUIRED');
    if(value&&(busy()||writes>1))throw integrationError('有任务或保存正在执行，请稍后维护',409,'SERVICE_BUSY');maintenance=!!value;
    if(maintenance){maintenanceOwner={maintenance:true,actor:maintenanceOwner?.actor||actor?.id||null,lastActor:actor?.id||null,migrationId:migrationId||null,createdAt:maintenanceOwner?.createdAt||new Date().toISOString()};fs.writeFileSync(maintenanceFile,JSON.stringify(maintenanceOwner));}
    else{nativeMaintenance=false;maintenanceOwner=null;fs.rmSync(maintenanceFile,{force:true});}return {maintenance,owner:maintenanceOwner};
  },onStop:null,attach(s){
    server=s;
    s.on('listening',()=>{const port=s.address().port;state.url=`http://127.0.0.1:${port}`;fs.writeFileSync(path.join(dataDir,'.integration-runtime.json'),JSON.stringify(state,null,2));});
    s.on('close',()=>{const f=path.join(dataDir,'.integration-runtime.json');try{if(JSON.parse(fs.readFileSync(f,'utf8')).pid===process.pid)fs.unlinkSync(f);}catch{}});
  },finish(){
    router.use((e,_q,r,_next)=>r.status(e.status||400).json({error:e.message,code:e.code||'INTEGRATION_ERROR',...(e.details?{details:e.details}:{})}));
  }};
  return api;
}
