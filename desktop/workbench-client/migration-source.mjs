import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {signWorkbenchActor} from '../workbench/actor.mjs';
import {backupLocalLedgers,inspectLocalLedgers} from './inventory.mjs';
import {digest} from '../workbench-migration/coordinator.mjs';
import {createServiceMigrationAdapter} from '../workbench-migration/service-adapter.mjs';
async function localRead(services,module,route,clientId,binary=false){
  const cap=await services.ensure(module),cfg=services.config(module),requestPath='/api/integration/v1/workbench/migration/'+route;
  const key=fs.readFileSync(path.join(cfg.dataDir,'.workbench-key'),'utf8').trim(),token=fs.readFileSync(path.join(cfg.dataDir,cfg.keyFile||'.integration-key'),'utf8').trim();
  const actor={v:1,id:'local-migration:'+clientId,login:'local-migration',role:'admin',modules:[module],canRunTasks:false,sessionId:clientId,channel:'ui',requestId:crypto.randomUUID(),issuedAt:Date.now(),expiresAt:Date.now()+30000,module,method:'GET',path:requestPath};
  const res=await fetch(cap.url+requestPath,{redirect:'error',headers:{...signWorkbenchActor(actor,key),Authorization:'Bearer '+token},signal:AbortSignal.timeout(60000)});
  if(!res.ok)throw Error('本机 '+module+' 资料导出失败，请核对模块版本与服务状态');
  if(binary){const n=Number(res.headers.get('content-length'));if(n>128*1024*1024)throw Error('单个原件超过迁移上限');const data=Buffer.from(await res.arrayBuffer());if(data.length>128*1024*1024)throw Error('单个原件超过迁移上限');return data;}
  return res.json();
}
export async function collectMigrationSource({services,connection,profile,transport}){
  const state=connection.read(),baseline=await backupLocalLedgers(services,profile),modules=baseline.inventory.filter(r=>r.present).map(r=>r.module),bundles=[],sourceRevisions={},uploaded=new Set();
  for(const module of modules){
    const bundle=await localRead(services,module,'export',state.clientId);sourceRevisions[module]=digest(bundle);
    for(const record of bundle.records)for(const file of record.files||[]){
      if(!file.filename&&file.sourcePath)file.filename=path.basename(file.sourcePath);
      if(!uploaded.has(file.sha256)){
        const buffer=await localRead(services,module,'files/'+encodeURIComponent(file.id),state.clientId,true);
        if(buffer.length!==file.bytes||crypto.createHash('sha256').update(buffer).digest('hex')!==file.sha256)throw Error('来源原件已变化，请重新准备本批资料');
        await transport.request('/migrations/assets/'+file.sha256,{method:'POST',rawBody:buffer,migration:true});uploaded.add(file.sha256);
      }
      delete file.sourcePath;
    }
    bundles.push(bundle);
  }
  if(!bundles.length)throw Error('没有需要迁移的本机业务记录');
  const sourceDigest=digest(sourceRevisions);connection.recordMigrationSource({sourceDigest,sourceRevisions});
  return transport.request('/migrations',{method:'POST',body:{clientId:state.clientId,sourceDigest,bundles},migration:true});
}
export async function validateMigrationSource(services,connection){
  const state=connection.read();
  for(const [module,expected]of Object.entries(state.migration.sourceRevisions||{}))if(digest(await localRead(services,module,'export',state.clientId))!==expected)throw Error('迁移后本机旧账本仍有变化，请重新准备并核对，当前不能封存');
  if(!Object.keys(state.migration.sourceRevisions||{}).length)throw Error('缺少本机来源账本核对清单');
}
export async function freezeMigrationSource(services,connection,profile){
  const state=connection.read(),modules=Object.keys(state.migration.sourceRevisions||{}),actor={v:1,id:'local-migration:'+state.clientId,login:'local-migration',role:'admin',modules,canRunTasks:false,sessionId:state.clientId,channel:'ui'};
  const present=inspectLocalLedgers(services).filter(r=>r.present).map(r=>r.module);
  if(present.some(id=>!modules.includes(id)))throw Error('准备期间出现了新的本机账本，请重新准备资料后再封存');
  for(const id of modules){
    const marker=path.join(services.config(id).dataDir,'.workbench-maintenance.json');
    if(fs.existsSync(marker)){
      const held=JSON.parse(fs.readFileSync(marker,'utf8'));if(held.actor!==actor.id&&held.actor?.id!==actor.id)throw Error('来源账本已有其他维护任务，请先在本机处理');
      continue;
    }
    const adapter=createServiceMigrationAdapter({services,id,backupRoot:path.join(profile,'client-ledger-archives')});
    await adapter.maintenance(true,actor,'source-archive-'+state.clientId);
  }
  await validateMigrationSource(services,connection);
}
export async function releaseMigrationSource(services,connection,profile){
  const state=connection.read();if(state.migration.state==='archived')throw Error('旧账本已经封存，不能直接恢复独立写入；请先由管理员核对新的迁移安排');
  const modules=Object.keys(state.migration.sourceRevisions||{}),actor={id:'local-migration:'+state.clientId,login:'local-migration',role:'admin',modules,canRunTasks:false,sessionId:state.clientId,channel:'ui'};
  for(const id of modules){const file=path.join(services.config(id).dataDir,'.workbench-maintenance.json');if(!fs.existsSync(file))continue;const held=JSON.parse(fs.readFileSync(file,'utf8'));if(held.actor!==actor.id||held.migrationId!=='source-archive-'+state.clientId)throw Error('此维护窗口由其他任务持有，不能取消');await createServiceMigrationAdapter({services,id,backupRoot:path.join(profile,'client-ledger-archives')}).maintenance(false,actor,held.migrationId);}
  return {ok:true};
}
