import {checkRange} from '../core/values';
import {createPlan} from '../core/extraction-plan';
import {installExporterAgentRoutes} from './agent-routes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '../core/store';
import type {Task,PlatformId,StartInput,ExportInput} from '../shared/types';
import {platforms,platformById} from '../shared/platforms';
import {transferSnapshot} from '../core/order-transfer';
import {provisionWorkbenchKey,verifyWorkbenchActor,type WorkbenchActor} from './workbench-auth.mjs';
import {remoteHtml,remoteScript,remoteStyles} from './workbench-ui.mjs';

type FileResult={path:string;count:number;missing:number};
export interface WorkbenchHandlers {
  invoke:(name:string,...args:unknown[])=>any;
  exportFile:(input:ExportInput,directory:string)=>Promise<FileResult>;
  transfer:(id:string,actor:WorkbenchActor)=>Promise<unknown>;
  busy:()=>boolean;
  changed:()=>void;
}
const fail=(message:string,status=400,code='WORKBENCH_ERROR')=>Object.assign(Error(message),{status,code});
function cleanTask(task:Task){
  const {accountCookie:_cookie,cursor:_cursor,exportedPath:_path,detailExport:_detail,...safe}=task;
  return {...safe,executionLocation:'server',state:task.status==='needs_login'?'waiting-host-action':task.status,hostAction:task.status==='needs_login'?'请在主服务器完成登录、验证码或平台授权，再继续任务':undefined};
}
function revision(store:Store){return createHash('sha256').update(JSON.stringify(store.tasks().map(t=>[t.id,t.updatedAt,t.count,t.status]))).digest('hex');}

// All HTTP operations dispatch to the same functions as the standalone Electron UI.
// The local integration token and a request-bound gateway signature are both required.
export function installExporterWorkbench(router:any,store:Store,options:{dataDir:string;version:string;handlers:WorkbenchHandlers;getDataSetIdentity?:()=>{dataSetId:string;revision:string;dataAvailable:boolean}}){
  const key=provisionWorkbenchKey(options.dataDir),{handlers}=options;
  const dataSet=()=>options.getDataSetIdentity?.()||{revision:revision(store)};
  store.db.exec(`CREATE TABLE IF NOT EXISTS workbench_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,channel TEXT NOT NULL,operation TEXT NOT NULL,task_id TEXT,result TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workbench_requests(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,route TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE IF NOT EXISTS workbench_files(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,filename TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const audit=(actor:WorkbenchActor,operation:string,taskId:string,result:string)=>store.db.prepare('INSERT INTO workbench_audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),actor.id,actor.sessionId,actor.channel,operation,taskId,result,new Date().toISOString());
  const guard=(kind:'read'|'write'|'task'|'admin'='read')=>(q:any,_r:any,next:any)=>{
    try{
      if(q.integration?.role!=='agent')throw fail('仅允许工作台网关调用',403);
      const actor=verifyWorkbenchActor(q.headers,key,{module:'exporter',method:q.method,path:q.originalUrl});
      if(kind==='admin'&&actor.channel!=='ui')throw fail('此操作需要管理员在页面确认',403,'UI_CONFIRMATION_REQUIRED');
      q.workbenchActor=actor;next();
    }catch(error){next(error);}
  };
  const mutate=(operation:string,fn:(q:any)=>Promise<any>|any)=>async(q:any,r:any,next:any)=>{
    const actor=q.workbenchActor as WorkbenchActor,hash=createHash('sha256').update(JSON.stringify(q.body||{})).digest('hex');
    const old=store.db.prepare('SELECT * FROM workbench_requests WHERE actor_id=? AND request_id=?').get(actor.id,actor.requestId) as any;
    if(old){if(old.route!==q.originalUrl||old.payload_hash!==hash)return next(fail('重复请求内容发生变化',409,'IDEMPOTENCY_CONFLICT'));const result=JSON.parse(old.result);return result.error?r.status(result.status||400).json(result):r.json(result);}
    // Reserve before dispatch. A disconnected/crashed caller can query the same
    // request without accidentally starting another collection or transfer.
    store.db.prepare('INSERT INTO workbench_requests VALUES(?,?,?,?,?)').run(actor.id,actor.requestId,q.originalUrl,hash,JSON.stringify({state:'processing',requestId:actor.requestId}));
    try{
      const result=await fn(q);
      store.db.prepare('UPDATE workbench_requests SET result=? WHERE actor_id=? AND request_id=?').run(JSON.stringify(result??{ok:true}),actor.id,actor.requestId);
      audit(actor,operation,String(q.params?.id||result?.id||''),'completed');r.json(result??{ok:true});
    }catch(error){const e=error as any;store.db.prepare('UPDATE workbench_requests SET result=? WHERE actor_id=? AND request_id=?').run(JSON.stringify({error:e.message||'操作失败',status:e.status||400,code:e.code||'WORKBENCH_ERROR'}),actor.id,actor.requestId);audit(actor,operation,String(q.params?.id||''),'failed');next(error);}
  };
  router.get('/workbench/ui',guard(),(_q:any,r:any)=>r.type('html').send(remoteHtml));
  router.get('/workbench/ui/app.js',guard(),(_q:any,r:any)=>r.type('js').send(remoteScript));
  router.get('/workbench/ui/app.css',guard(),(_q:any,r:any)=>r.type('css').send(remoteStyles));
  router.get('/workbench/state',guard(),(q:any,r:any)=>r.json({version:options.version,platforms:platforms.map(({id,name,mode})=>({id,name,mode})),tasks:store.tasks().map(cleanTask),...dataSet(),busy:handlers.busy(),executionLocation:'server',permissions:{read:true,write:q.workbenchActor.role!=='viewer',runTasks:q.workbenchActor.role!=='viewer'&&(q.workbenchActor.role==='admin'||q.workbenchActor.canRunTasks),clear:q.workbenchActor.role==='admin'&&q.workbenchActor.channel==='ui'}}));
  router.get('/workbench/requests/:id',guard(),(q:any,r:any)=>{const record=store.db.prepare('SELECT result FROM workbench_requests WHERE actor_id=? AND request_id=?').get(q.workbenchActor.id,q.params.id) as any;r.status(record?200:404).json(record?{requestId:q.params.id,result:JSON.parse(record.result)}:{error:'请求结果不存在'});});
  router.get('/workbench/tasks/:id',guard(),(q:any,r:any)=>r.json(cleanTask(store.get(q.params.id))));
  router.get('/workbench/tasks/:id/orders',guard(),(q:any,r:any)=>r.json({task:cleanTask(store.get(q.params.id)),orders:store.orders(q.params.id)}));
  router.get('/workbench/tasks/:id/snapshot',guard(),(q:any,r:any)=>r.json(transferSnapshot(store.get(q.params.id),store.orders(q.params.id))));
  router.get('/workbench/logs/:platform',guard(),async(q:any,r:any,next:any)=>{try{r.json(await handlers.invoke('executionLogs',platformById(q.params.platform).id));}catch(error){next(error);}});
  router.post('/workbench/tasks',guard('task'),mutate('task.start',async q=>{
    const input=q.body as StartInput;platformById(input.platform);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.from)||!/^\d{4}-\d{2}-\d{2}$/.test(input.to))throw fail('日期范围无效');
    return cleanTask(await handlers.invoke('start',{platform:input.platform,from:input.from,to:input.to,...(input.plan?{plan:input.plan}:{})}));
  }));
  for(const action of ['pause','resume','retry','finish','enrichDetails'])router.post('/workbench/tasks/:id/'+action,guard('task'),mutate('task.'+action,async q=>{store.get(q.params.id);await handlers.invoke(action,q.params.id);return cleanTask(store.get(q.params.id));}));
  router.post('/workbench/host-action',guard('task'),mutate('host-action.request',async q=>{
    const platform=platformById(String(q.body.platform)).id;
    if(q.body.taskId&&store.get(String(q.body.taskId)).platform!==platform)throw fail('任务平台不符');
    await handlers.invoke(q.body.orderId?'openOrder':'login',...(q.body.orderId?[String(q.body.taskId),String(q.body.orderId)]:[platform]));
    return {state:'waiting-host-action',platform,taskId:q.body.taskId||null,message:'已在主服务器打开平台页面，请由主机操作人完成登录、验证码或授权。客户端不会接收登录凭据。'};
  }));
  router.post('/workbench/tasks/:id/export',guard(),mutate('file.export',async q=>{
    const format=q.body.format;if(!['csv','xlsx'].includes(format))throw fail('不支持的导出格式');
    const folder=path.join(options.dataDir,'workbench-exports');fs.mkdirSync(folder,{recursive:true});
    // Each result has an opaque ID; no server path is returned to a client.
    const directory=path.join(folder,randomUUID());fs.mkdirSync(directory);
    const result=await handlers.exportFile({taskId:q.params.id,format,images:q.body.images===true},directory);
    const fileId=randomUUID(),filename=path.basename(result.path);
    store.db.prepare('INSERT INTO workbench_files VALUES(?,?,?,?,?)').run(fileId,q.workbenchActor.id,filename,result.path,new Date().toISOString());
    return {fileId,filename,count:result.count,missing:result.missing,downloadUrl:'/api/workbench/v1/modules/exporter/files/'+fileId};
  }));
  router.get('/workbench/files/:id',guard(),(q:any,r:any,next:any)=>{
    const record=store.db.prepare('SELECT * FROM workbench_files WHERE id=?').get(q.params.id) as any;
    if(!record||!q.workbenchActor.id)return next(fail('文件不存在或无权读取',404));
    const root=path.resolve(options.dataDir,'workbench-exports')+path.sep,file=path.resolve(record.path);
    if(!file.startsWith(root)||!fs.existsSync(file)||!fs.statSync(file).isFile())return next(fail('导出文件已不可用，请重新导出',404));
    r.download(file,record.filename);
  });
  router.post('/workbench/tasks/:id/transfer',guard('write'),mutate('transfer.prepare',q=>handlers.transfer(q.params.id,q.workbenchActor)));
  router.post('/workbench/platforms/:platform/clear',guard('admin'),mutate('history.clear',q=>{
    if(q.body.confirm!==true||q.body.revision!==dataSet().revision)throw fail('采集历史已变化，请重新核对后确认清理',409,'REVISION_CHANGED');
    if(handlers.busy())throw fail('任务正在运行，不能清理',409,'SERVICE_BUSY');
    store.clear(platformById(q.params.platform).id as PlatformId);handlers.changed();return {ok:true,revision:dataSet().revision};
  }));
  installExporterAgentRoutes(router,{store,handlers,key,binding:dataSet,guard,cleanTask,platformById,transferSnapshot,platforms,validateStart:(input:StartInput)=>{checkRange(input.from,input.to);if(input.plan)createPlan(input.platform,input.from,input.to,input.plan);},dataDir:options.dataDir});
  return {protocolVersion:1};
}
