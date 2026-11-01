import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {shell} from 'electron';
import {ServiceManager} from './service-manager.mjs';
import {installLocalIntegration} from './local-integration.mjs';
import {installExporterWorkbench,type WorkbenchHandlers} from './workbench-server';
import {provisionWorkbenchKey,signWorkbenchActor,verifyWorkbenchActor,type WorkbenchActor} from './workbench-auth.mjs';
import {createWorkbenchMigration} from './workbench-migration';
import {installWorkbenchMigration} from './workbench-migration-routes.mjs';
import {transferSnapshot} from '../core/order-transfer';
import type {Store} from '../core/store';
const require=createRequire(import.meta.url);
const manager=new ServiceManager();
export async function sendToProcurement(store:Store,taskId:string,actor?:WorkbenchActor){
  const source=transferSnapshot(store.get(taskId),store.orders(taskId));
  if(!source.orders.length)throw Error('本次任务没有可传递的订单');
  if(actor){
    if(actor.role==='viewer'||!actor.modules.includes('purchase'))throw Object.assign(Error('没有采购台草稿权限'),{status:403,code:'MODULE_PERMISSION_REQUIRED'});
    const cap=await manager.capabilities('purchase');
    if(!cap?.url||cap.maintenance)throw Object.assign(Error('主服务器采购台尚未就绪，请联系管理员'),{status:503,code:'MODULE_UNAVAILABLE'});
    const config=manager.config('purchase'),requestPath='/api/integration/v1/transfers',now=Date.now();
    const key=fs.readFileSync(path.join(config.dataDir,'.workbench-key'),'utf8').trim(),token=fs.readFileSync(path.join(config.dataDir,config.keyFile||'.integration-key'),'utf8').trim();
    const response=await fetch(cap.url+requestPath,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor({...actor,module:'purchase',method:'POST',path:requestPath,issuedAt:now,expiresAt:now+30000},key)},body:JSON.stringify(source),signal:AbortSignal.timeout(30000),redirect:'error'});
    const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'采购草稿创建失败'),{status:response.status});
    return {id:result.id,batchId:result.id,count:source.orders.length,state:result.state,route:'/apps/purchase/integration-review.html?batch='+encodeURIComponent(result.id),events:[{type:'purchase-transfer-prepared',batchId:result.id}]};
  }
  const cap=await manager.ensure('purchase');
  const result=await manager.request('purchase','/transfers',{method:'POST',body:source});
  const registryDir=path.dirname(manager.registryFile);
  let hosted=false;
  try{
    const host=JSON.parse(fs.readFileSync(path.join(registryDir,'host.json'),'utf8'));
    if(host.protocolVersion===2&&Number.isSafeInteger(host.pid)&&host.pid>0){try{process.kill(host.pid,0);hosted=true}catch(error:any){hosted=error.code==='EPERM'}}
    else hosted=host.updatedAt>Date.now()-15000;
  }catch{}
  if(hosted){
    fs.writeFileSync(path.join(registryDir,'open-request.json'),JSON.stringify({id:randomUUID(),batch:result.id,createdAt:Date.now()}));
  }else await shell.openExternal(cap.url+'/integration-review.html?batch='+encodeURIComponent(result.id));
  return {id:result.id,count:source.orders.length,state:result.state};
}
export function startOrderIntegration(store:Store,options:{root:string;dataDir:string;version:string;busy:()=>boolean;stop:()=>void;activate:()=>Promise<void>;open:()=>Promise<void>;workbench?:WorkbenchHandlers}){
  const express=require('express'),web=express();
  const migrationIdentity=createWorkbenchMigration(store,{dataDir:options.dataDir});
  const getDataSetIdentity=()=>migrationIdentity.getDataSetIdentity();
  const integration=installLocalIntegration(web,{id:'lingtu-order-export',...options,getDataSetIdentity,capabilities:['tasks.read','orders.read','transfer.prepare']});
  if(options.workbench)integration.state.workbench=installExporterWorkbench(integration.router,store,{dataDir:options.dataDir,version:options.version,handlers:options.workbench,getDataSetIdentity});
  installWorkbenchMigration(integration,{db:store.db,dir:options.dataDir},(_facade:any,migrationOptions:any)=>createWorkbenchMigration(store,migrationOptions),{sourceInstance:integration.state.profile,dataDir:options.dataDir});
  integration.router.get('/tasks',(_q:any,r:any)=>r.json({tasks:store.tasks().map(t=>({id:t.id,platform:t.platform,from:t.from,to:t.to,status:t.status,listOutcome:t.listOutcome||'pending',count:t.count,updatedAt:t.updatedAt}))}));
  integration.router.get('/tasks/:id/orders',(q:any,r:any)=>r.json(transferSnapshot(store.get(q.params.id),store.orders(q.params.id))));
  integration.router.post('/tasks/:id/transfer',async(q:any,r:any)=>r.json(await sendToProcurement(store,q.params.id)));
  integration.finish();const server=web.listen(0,'127.0.0.1');integration.attach(server);integration.onStop=options.stop;
  return server;
}
