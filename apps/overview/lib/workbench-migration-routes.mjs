import fs from 'node:fs';
import path from 'node:path';
import {backup} from 'node:sqlite';
import {createHmac,randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {digest,migrationError} from './workbench-migration-core.mjs';
export function installWorkbenchMigration(integration,store,createAdapter,options={}){
 const {router:r,workbench}=integration;
 const authorize=(q,_s,next)=>{if(!q.workbenchActor||q.workbenchActor.channel!=='ui'||q.integration?.role!=='agent')throw migrationError('只允许主机迁移协调器操作');next();};
 const validPermit=(actor,plan,permit)=>{
  if(!integration.maintenance()||!plan?.migrationId||integration.maintenanceOwner?.()?.migrationId!==plan.migrationId||!permit||permit.digest!==digest(plan)||!Number.isSafeInteger(permit.expiresAt)||permit.expiresAt<=Date.now()||permit.expiresAt>Date.now()+60000||typeof permit.signature!=='string'||!/^\w{64}$/.test(permit.signature))return false;
  const expected=createHmac('sha256',workbench.key).update('workbench-migration/v1:'+permit.digest+':'+permit.expiresAt+':'+actor.sessionId).digest('hex');return timingSafeEqual(Buffer.from(expected),Buffer.from(permit.signature));
 };
 const stagingDir=options.stagingDir||path.join(store.dir,'workbench-migration-staging');
 const adapter=permit=>createAdapter(store,{...options,canCommit:(actor,plan)=>validPermit(actor,plan,permit),resolveFile:async(id,file)=>{
  // Staging ownership is a coordinator responsibility; only immutable bytes cross
  // this boundary. No source path supplied by a client is ever opened here.
  const staged=file.stagingId;if(!staged||!/^[-\w]{1,100}$/.test(staged))throw migrationError('附件缺少受控暂存标识');
  const filePath=path.join(stagingDir,staged);return fs.readFileSync(filePath);
 }});
 let exported;
 r.get('/workbench/migration/export',authorize,(q,s)=>s.json(exported=adapter().exportSnapshot()));
 r.get('/workbench/migration/files/:id',authorize,(q,s)=>{const snapshot=exported||adapter().exportSnapshot(),file=snapshot.records.flatMap(r=>r.files).find(f=>f.id===q.params.id);if(!file)throw migrationError('导出原件不存在');const full=path.resolve(store.dir,file.sourcePath);if(!full.startsWith(path.resolve(store.dir)+path.sep))throw migrationError('原件路径越界');const buffer=fs.readFileSync(full);if(buffer.length!==file.bytes||createHash('sha256').update(buffer).digest('hex')!==file.sha256)throw migrationError('导出原件已变化');s.type('application/octet-stream').send(buffer);});
 r.post('/workbench/migration/preview',authorize,(q,s)=>s.json(adapter().preview(q.body.bundle,{selections:q.body.selections||[]})));
 r.post('/workbench/migration/maintenance',authorize,(q,s)=>{if(typeof q.body.enabled!=='boolean')throw migrationError('维护模式必须明确指定');s.json(integration.setMaintenance(q.body.enabled,{actor:q.workbenchActor,migrationId:q.body.migrationId}));});
 r.post('/workbench/migration/backup',authorize,async(q,s)=>{if(!integration.maintenance())throw migrationError('请先进入维护窗口');const folder=path.join(store.dir,'backups');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'workbench-'+randomUUID()+'.sqlite');await backup(store.db,file);const bytes=fs.readFileSync(file);s.json({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),dataDir:store.dir,requiresStoppedRestore:true});});
 r.post('/workbench/migration/restore',authorize,(_q,s)=>s.status(409).json({error:'恢复一致性备份前必须停止所属服务，再由本机协调器验证摘要并恢复，不能覆盖正在打开的 SQLite 文件',code:'RESTORE_REQUIRES_STOPPED_SERVICE'}));
 r.post('/workbench/migration/commit',authorize,async(q,s)=>{if(!validPermit(q.workbenchActor,q.body.plan,q.body.permit))throw migrationError('迁移确认凭据无效或已过期','MIGRATION_CONFIRMATION_REQUIRED');s.json(await adapter(q.body.permit).commit(q.body.plan,q.workbenchActor));});
 r.get('/workbench/migration/verify/:id',authorize,(q,s)=>s.json(adapter().verify(q.params.id)));
 return {adapter};
}
