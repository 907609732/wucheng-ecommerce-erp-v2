import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {provisionWorkbenchKey,verifyWorkbenchActor} from '../workbench/actor.mjs';
import {warehouseHtml,warehouseScript,warehouseStyles,warehouseAdapter,createWorkbenchMigration} from '../workbench/warehouse-adapter.mjs';
import {createWarehouseAgentRequestHandler,WAREHOUSE_AGENT_ROUTES} from '../workbench/warehouse-agent-api.mjs';

export async function startCloudControl({root, dataDir, version, busy, activate, open, stop, business, migration}) {
  const maintenanceFile=path.join(dataDir,'.workbench-maintenance.json');
  let installationMaintenance = process.env.LINGTU_MAINTENANCE === '1', stopping = false,exportedMigration,activeBusinessWrites=0;
  const maintenanceOwner=()=>{if(!fs.existsSync(maintenanceFile))return null;try{const owner=JSON.parse(fs.readFileSync(maintenanceFile,'utf8'));return owner&&typeof owner==='object'?owner:{legacy:true};}catch{return {invalid:true};}};
  const maintenance=()=>installationMaintenance||fs.existsSync(maintenanceFile);
  const isBusy=()=>busy()||activeBusinessWrites>0;
  const keyFile = path.join(dataDir, '.integration-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), {flag:'wx', mode:0o600});
  const token = 'Bearer ' + fs.readFileSync(keyFile, 'utf8').trim();
  const workbenchKey=provisionWorkbenchKey(dataDir);
  const workbenchDb=new DatabaseSync(path.join(dataDir,'workbench-cloud.sqlite'));
  workbenchDb.exec(`CREATE TABLE IF NOT EXISTS requests(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,route TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,channel TEXT NOT NULL,operation TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const runtimeFile = path.join(dataDir, '.integration-runtime-cloud.json');
  const state = {id:'lingtu-warehouse',apiVersion:1,root,dataDir,version,pid:process.pid,capabilities:['warehouse.read','warehouse.run','warehouse.daily','module.lifecycle'],workbench:{...warehouseAdapter,protocolVersion:1}};
  const sanitize=value=>Array.isArray(value)?value.map(sanitize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:path|directory|^root$|^pid$|secret|cookie|password|token)/i.test(key)).map(([key,v])=>[key,sanitize(v)])):value;
  const audit=(actor,operation,result)=>workbenchDb.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(),actor.id,actor.sessionId,actor.channel,operation,result,new Date().toISOString());
  const taskPayload=body=>{
    if(!['sync','monthly-sales','monthly-backfill'].includes(body.type))throw Object.assign(Error('不支持的云仓任务类型'),{status:400});
    if(body.type==='monthly-sales'&&!/^\d{4}-\d{2}$/.test(String(body.month||'')))throw Object.assign(Error('月份无效'),{status:400});
    if(body.type==='monthly-backfill'&&(!/^\d{4}-\d{2}$/.test(String(body.from||''))||!/^\d{4}-\d{2}$/.test(String(body.to||''))||body.from>body.to))throw Object.assign(Error('月份范围无效'),{status:400});
    return {type:body.type,options:body.type==='monthly-sales'?{month:body.month}:body.type==='monthly-backfill'?{from:body.from,to:body.to}:{}};
  };
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const validMigrationPermit=(actor,plan,permit)=>{
    if(!maintenance()||!plan?.migrationId||maintenanceOwner()?.migrationId!==plan.migrationId||!permit||typeof permit.signature!=='string'||!/^[a-f0-9]{64}$/.test(permit.signature)||!Number.isSafeInteger(permit.expiresAt)||permit.expiresAt<=Date.now()||permit.expiresAt>Date.now()+60000)return false;
    const digest=createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');if(digest!==permit.digest)return false;
    const expected=createHmac('sha256',workbenchKey).update('workbench-migration/v1:'+digest+':'+permit.expiresAt+':'+actor.sessionId).digest('hex');return timingSafeEqual(Buffer.from(expected),Buffer.from(permit.signature));
  };
  const migrationFactory=permit=>createWorkbenchMigration({...migration,dataDir:migration?.dataDir||dataDir,canCommit:(actor,plan)=>validMigrationPermit(actor,plan,permit),resolveFile:(_id,file)=>{
    if(!/^[-\w]{1,100}$/.test(file.stagingId||''))throw Object.assign(Error('附件缺少受控暂存标识'),{status:409});return fs.readFileSync(path.join(dataDir,'workbench-migration-staging',file.stagingId));
  }});
  const getDataSetIdentity=()=>{
    if(!migration?.databasePath||!fs.existsSync(migration.databasePath))return {dataSetId:null,revision:null,dataAvailable:false};
    const adapter=migrationFactory();try{return adapter.getDataSetIdentity();}finally{adapter.close();}
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try {
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
          !/^127\.0\.0\.1:\d+$/.test(req.headers.host||'') || req.headers.origin) return send(403,{error:'仅允许本机授权调用'});
      if (req.method === 'GET' && req.url === '/api/integration/v1/capabilities') return send(200,{...state,...getDataSetIdentity(),busy:isBusy(),maintenance:maintenance(),maintenanceOwner:maintenanceOwner(),stopping});
      if(stopping)return send(503,{error:'云仓服务正在停止',code:'SERVICE_STOPPING'});
      const auth = Buffer.from(String(req.headers.authorization||'')), expected = Buffer.from(token);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401,{error:'本机授权无效'});
      if(req.url.startsWith('/api/integration/v1/agent/')||req.url.startsWith('/api/integration/v1/workbench/agent-files/')){
        const actor=verifyWorkbenchActor(req.headers,workbenchKey,{module:'warehouse',method:req.method,path:req.url});
        if(!business?.getAgentAdapter)return send(503,{error:'云仓Agent接口尚未启用',code:'WAREHOUSE_AGENT_DISABLED'});
        const url=new URL(req.url,'http://127.0.0.1');
        if(maintenance())return send(409,{error:'模块正在安装或迁移检查',code:'MODULE_MAINTENANCE'});
        let body={};if(req.method==='GET'){const payload=url.searchParams.get('payload')||'{}';if(payload.length>1024*1024)return send(413,{error:'请求过大'});body=JSON.parse(payload);}else{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024)return send(413,{error:'请求过大'});}body=JSON.parse(raw||'{}');}
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.hasOwn(body,'actor')||Object.hasOwn(body,'approval'))return send(400,{error:'不能通过请求正文提供身份或审批凭据'});
        if(typeof body.taskId!=='string'||!/^[-\w:.]{1,160}$/.test(body.taskId))return send(400,{error:'缺少可信任务标识',code:'WAREHOUSE_TASK_CONTEXT_REQUIRED'});
        getDataSetIdentity(); // Initialize only the existing ledger's identity.
        const adapter=await business.getAgentAdapter(workbenchKey),controller=new AbortController();
        res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        const ctx={actor,taskId:body.taskId,idempotencyKey:String(req.headers['idempotency-key']||''),signal:controller.signal};
        if(req.headers['x-erp-agent-approval'])try{ctx.approval=JSON.parse(Buffer.from(req.headers['x-erp-agent-approval'],'base64url').toString('utf8'));}catch{return send(403,{error:'审批凭据格式无效'});}
        if(url.pathname.startsWith('/api/integration/v1/workbench/agent-files/')){
          if(req.method!=='GET')return send(405,{error:'下载只支持GET'});
          const id=decodeURIComponent(url.pathname.slice('/api/integration/v1/workbench/agent-files/'.length));
          if(!/^[a-f0-9-]{36}$/i.test(id))return send(400,{error:'原件标识无效'});
          const file=adapter.download(id,ctx);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,'Content-Disposition':'attachment; filename="'+file.name+'"','X-Content-SHA256':file.sha256,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});file.stream.on('error',()=>res.destroy());return file.stream.pipe(res);
        }
        const route=WAREHOUSE_AGENT_ROUTES.find(r=>r.path===url.pathname&&r.method===req.method);if(!route)return send(404,{error:'未知云仓Agent接口'});
        if(route.action==='commit'&&(!ctx.approval||!ctx.idempotencyKey))return send(403,{error:'提交需要中央结果确认凭据',code:'WAREHOUSE_APPROVAL_REQUIRED'});
        if(['prepare','commit'].includes(route.action)){if(isBusy()&&!(route.action==='prepare'&&body.capabilityId==='collection.cancel'))return send(409,{error:'其他云仓任务正在运行',code:'SERVICE_BUSY'});activeBusinessWrites++;}
        try{const value=await createWarehouseAgentRequestHandler(adapter)(route.action,body,ctx);audit(actor,'agent.'+route.action,value?.receipt?.status||'completed');return send(200,value);}finally{if(['prepare','commit'].includes(route.action))activeBusinessWrites--;}
      }
      if(req.url.startsWith('/api/integration/v1/workbench/')){
        const actor=verifyWorkbenchActor(req.headers,workbenchKey,{module:'warehouse',method:req.method,path:req.url});
        const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname.slice('/api/integration/v1/workbench'.length);
        if(route.startsWith('/migration/')){
          if(actor.role!=='admin'||actor.channel!=='ui')return send(403,{error:'只允许主机迁移协调器操作',code:'MIGRATION_CONFIRMATION_REQUIRED'});
          if(!migration?.databasePath)return send(503,{error:'云仓迁移接口尚未配置',code:'MODULE_UNAVAILABLE'});
          let body={};if(req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>50*1024*1024)return send(413,{error:'迁移清单过大'});}body=JSON.parse(raw||'{}');}
          if(req.method==='POST'&&route==='/migration/maintenance'){
            if(typeof body.enabled!=='boolean'||typeof body.migrationId!=='string'||!/^[-\w]{1,200}$/.test(body.migrationId))return send(400,{error:'维护操作缺少有效迁移批次',code:'MIGRATION_ID_REQUIRED'});
            const held=maintenanceOwner();if(held&&held.migrationId!==body.migrationId)return send(409,{error:'维护窗口由其他迁移批次持有，不能抢占或解除',code:'MAINTENANCE_OWNED'});if(isBusy())return send(409,{error:'有云仓任务正在运行',code:'SERVICE_BUSY'});
            let owner=null;if(body.enabled){owner={maintenance:true,actor:held?.actor||actor.id,migrationId:body.migrationId,createdAt:held?.createdAt||new Date().toISOString(),lastActor:actor.id};fs.writeFileSync(maintenanceFile,JSON.stringify(owner),{flag:held?'w':'wx',mode:0o600});}else if(held)fs.unlinkSync(maintenanceFile);audit(actor,'migration.maintenance',String(body.enabled));return send(200,{ok:true,maintenance:maintenance(),owner});
          }
          const adapter=migrationFactory(body.permit);
          try{
            if(req.method==='GET'&&route==='/migration/export')return send(200,exportedMigration=adapter.exportSnapshot());
            if(req.method==='GET'&&route.startsWith('/migration/files/')){
              const snapshot=exportedMigration||adapter.exportSnapshot(),id=decodeURIComponent(route.slice('/migration/files/'.length)),file=snapshot.records.flatMap(r=>r.files).find(file=>file.id===id);
              if(!file)return send(404,{error:'导出原件不存在'});const source=path.resolve(file.sourcePath);if(!source.startsWith(path.resolve(migration.dataDir||dataDir)+path.sep))return send(403,{error:'原件路径越界'});const bytes=fs.readFileSync(source);if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)return send(409,{error:'导出原件已变化'});res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'});return res.end(bytes);
            }
            if(req.method==='POST'&&route==='/migration/preview')return send(200,adapter.preview(body.bundle));
            if(req.method==='POST'&&route==='/migration/backup'){
              if(!maintenance()||!fs.existsSync(maintenanceFile))return send(409,{error:'请先进入维护窗口'});activeBusinessWrites++;try{const folder=path.join(dataDir,'backups');fs.mkdirSync(folder,{recursive:true});const destination=path.join(folder,'workbench-'+randomUUID()+'.sqlite');await backup(adapter.database,destination);const bytes=fs.readFileSync(destination);return send(200,{path:destination,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),dataDir,requiresStoppedRestore:true});}finally{activeBusinessWrites--;}
            }
            if(req.method==='POST'&&route==='/migration/restore')return send(409,{error:'恢复备份必须停止云仓服务，由本机协调器校验摘要后恢复',code:'RESTORE_REQUIRES_STOPPED_SERVICE'});
            if(req.method==='POST'&&route==='/migration/commit'){
              if(!validMigrationPermit(actor,body.plan,body.permit))return send(409,{error:'迁移确认凭据无效或已过期',code:'MIGRATION_CONFIRMATION_REQUIRED'});if(isBusy())return send(409,{error:'云仓任务正在运行'});activeBusinessWrites++;try{const result=await adapter.commit(body.plan,actor);audit(actor,'migration.commit',result.migrationId);return send(200,result);}finally{activeBusinessWrites--;}
            }
            if(req.method==='GET'&&route.startsWith('/migration/verify/'))return send(200,adapter.verify(decodeURIComponent(route.slice('/migration/verify/'.length))));
            return send(404,{error:'未知迁移接口'});
          }finally{adapter.close();}
        }
        if(!business)return send(503,{error:'云仓业务接口尚未就绪',code:'MODULE_UNAVAILABLE'});
        if(business.agentManaged&&req.method!=='GET')return send(409,{error:'Agent管理模式须通过中央结果页复核，不再接受旧写入入口',code:'AGENT_REVIEW_REQUIRED'});
        if(req.method==='GET'){
          if(route.startsWith('/requests/')){const id=decodeURIComponent(route.slice('/requests/'.length)),record=workbenchDb.prepare('SELECT result FROM requests WHERE actor_id=? AND request_id=?').get(actor.id,id);return send(record?200:404,record?{requestId:id,result:JSON.parse(record.result)}:{error:'请求结果不存在'});}
          if(['/ui','/ui/app.js','/ui/app.css'].includes(route)){res.writeHead(200,{'Content-Type':route==='/ui'?'text/html; charset=utf-8':route.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(route==='/ui'?warehouseHtml:route.endsWith('.js')?warehouseScript:warehouseStyles);}
          if(route==='/state')return send(200,{version,busy:isBusy(),maintenance:maintenance(),executionLocation:'server',permissions:{read:true,runTasks:actor.role!=='viewer'&&(actor.role==='admin'||actor.canRunTasks)},...(business.getState?sanitize(await business.getState(actor)): {}),...getDataSetIdentity()});
          if(route==='/inventory')return send(200,sanitize(await business.getInventory(actor)));
          if(route==='/daily'){
            if(!business.getDailyStatus)return send(503,{error:'签到服务尚未就绪'});
            return send(200,sanitize(await business.getDailyStatus(actor)));
          }
          if(route==='/monthly-sales')return send(200,sanitize(await business.getMonthlySales(Object.fromEntries(['year','selectedMonth','scope','seriesMode','sku'].map(key=>[key,String(url.searchParams.get(key)||'')])),actor)));
          if(route==='/task')return send(200,sanitize(await business.getTaskState(actor)));
          if(route==='/logs'){const state=sanitize(await business.getTaskState(actor)),limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit'))||30));return send(200,{logs:(Array.isArray(state.logs)?state.logs:[]).slice(-limit)});}
          return send(404,{error:'未知云仓业务接口'});
        }
        const dailyRoute=['/daily/action','/daily/config','/daily/remind'].includes(route);
        if(req.method!=='POST'||!['/jobs','/jobs/stop','/host-action','/send-latest-valid','/daily/action','/daily/config','/daily/remind'].includes(route))return send(404,{error:'未知云仓业务接口'});
        if(maintenance())return send(409,{error:'模块正在安装或迁移检查',code:'MODULE_MAINTENANCE'});
        if(actor.role==='viewer'||(!dailyRoute&&!(actor.role==='admin'||actor.canRunTasks)))return send(403,{error:'未获授权执行此操作',code:'TASK_PERMISSION_REQUIRED'});
        if(dailyRoute&&actor.channel!=='ui')return send(403,{error:'签到及催办必须在工作台界面操作'});
        if(['/daily/config','/daily/remind'].includes(route)&&actor.role!=='admin')return send(403,{error:'需要管理员权限'});
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>(dailyRoute?524288:65536))return send(413,{error:'请求过大'});}
        const body=JSON.parse(raw||'{}'),hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const old=workbenchDb.prepare('SELECT * FROM requests WHERE actor_id=? AND request_id=?').get(actor.id,actor.requestId);
        if(old){if(old.route!==req.url||old.payload_hash!==hash)return send(409,{error:'重复请求内容发生变化',code:'IDEMPOTENCY_CONFLICT'});const result=JSON.parse(old.result);return send(result.error?result.status||400:200,result);}
        workbenchDb.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(actor.id,actor.requestId,req.url,hash,JSON.stringify({state:'processing',requestId:actor.requestId}));
        activeBusinessWrites++;
        try{
          const task=route==='/jobs'?taskPayload(body):null;
          const owner={...actor,requestedBy:actor.login,executionLocation:'server'};
          let value;
          if(dailyRoute){
            const handler=route==='/daily/action'?business.dailyAction:route==='/daily/config'?business.saveDailyConfig:business.remindDaily;
            if(typeof handler!=='function')throw Object.assign(Error('签到服务尚未配置'),{status:503});
            value=await handler(owner,body);
          }else if(route==='/host-action'){
            if(typeof business.requestLogin!=='function')throw Object.assign(Error('主机登录接口尚未配置'),{status:503});
            value={state:'waiting-host-action',message:'已请求主服务器打开菜鸟登录页，请由主机操作人完成登录、扫码或验证码。',task:await business.requestLogin(owner)};
          }else if(route==='/send-latest-valid'){
            if(body.confirmSend!==true)throw Object.assign(Error('发送钉钉报告需要本次明确确认'),{status:400,code:'SEND_CONFIRMATION_REQUIRED'});
            if(typeof business.sendLatestValid!=='function')throw Object.assign(Error('主服务器最近有效快照发送接口尚未配置'),{status:503});value=await business.sendLatestValid(owner);
          }else value=task?await business.startTask(task.type,'tailscale',task.options,owner):await business.stopTask(owner);
          const result=sanitize(value);
          workbenchDb.prepare('UPDATE requests SET result=? WHERE actor_id=? AND request_id=?').run(JSON.stringify(result??{ok:true}),actor.id,actor.requestId);audit(actor,route,'completed');return send(200,result??{ok:true});
        }catch(error){const result={error:error.message||'云仓任务失败',status:error.status||error.statusCode||400,code:error.code||'WAREHOUSE_TASK_FAILED'};workbenchDb.prepare('UPDATE requests SET result=? WHERE actor_id=? AND request_id=?').run(JSON.stringify(result),actor.id,actor.requestId);audit(actor,route,'failed');return send(result.status,result);}finally{activeBusinessWrites--;}
      }
      if (req.method !== 'POST') return send(405,{error:'操作不支持'});
      let body = '';
      for await (const chunk of req) {body += chunk;if(body.length>1024)return send(413,{error:'请求过大'});}
      if (JSON.parse(body||'{}').confirm !== true) return send(400,{error:'需要明确操作'});
      if (req.url === '/api/integration/v1/maintenance/activate') {
        if(fs.existsSync(maintenanceFile))return send(409,{error:'迁移维护窗口尚未结束',code:'MODULE_MAINTENANCE'});
        await activate();installationMaintenance=false;return send(200,{ok:true});
      }
      if (req.url === '/api/integration/v1/open') {
        if(maintenance())return send(409,{error:'模块尚未完成安装检查'});
        await open();return send(200,{ok:true});
      }
      if (req.url === '/api/integration/v1/stop') {
        if(isBusy())return send(409,{error:'云仓任务正在执行'});
        stopping=true;send(200,{ok:true});setTimeout(stop,100);return;
      }
      send(404,{error:'未知接口'});
    } catch(error) { if(!res.headersSent)send(error.status||error.statusCode||400,{error:error.message||'操作失败，请检查模块状态',code:error.code||'CLOUD_CONTROL_ERROR'}); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  state.url='http://127.0.0.1:'+server.address().port;
  fs.writeFileSync(runtimeFile,JSON.stringify(state));
  return {close(){try{if(JSON.parse(fs.readFileSync(runtimeFile,'utf8')).pid===process.pid)fs.unlinkSync(runtimeFile);}catch{}return new Promise(resolve=>server.close(()=>{workbenchDb.close();resolve();}));}};
}
