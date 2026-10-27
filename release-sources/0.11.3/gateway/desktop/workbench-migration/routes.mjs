import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform,Readable} from 'node:stream';
import {MigrationCoordinator} from './coordinator.mjs';
import {createServiceMigrationAdapter} from './service-adapter.mjs';
export function migrationRoutes(services){return async(app,context)=>{
  const {storeDir,requireSession,requireAdmin,writeAudit,serverId,dataSetId}=context,root=path.join(storeDir,'migrations'),assetRoot=path.join(root,'assets');fs.mkdirSync(assetRoot,{recursive:true});
  const receiptPath=(actor,sha)=>path.join(root,'asset-receipts',crypto.createHash('sha256').update(actor.id+'\0'+actor.sessionId).digest('hex'),sha+'.json');
  const adapters=Object.fromEntries(['warehouse','purchase','sales','overview','exporter'].map(id=>[id,createServiceMigrationAdapter({services,id,assetRoot,backupRoot:path.join(root,'backups')})]));
  const coordinator=new MigrationCoordinator({root,adapters,serverId,dataSetId,audit:e=>writeAudit({actorId:e.actor,operation:e.type,outcome:e.status||'completed',details:e})});
  const base='/api/workbench/v1/migrations';
  const wrap=fn=>async(q,s)=>{try{return await fn(q,s);}catch(e){if(!e.statusCode)e.statusCode=e.code?.includes('PERMISSION')?403:409;throw e;}};
  app.get(base,{preHandler:requireAdmin},wrap(q=>({batches:coordinator.list(q.workbenchActor)})));
  app.post(base+'/assets/:sha256',{preHandler:requireSession,bodyLimit:128*1024*1024},wrap(async(q,s)=>{
    if(!['admin','editor'].includes(q.workbenchActor.role))return s.code(403).send({error:'没有迁移资料上传权限'});
    const hash=q.params.sha256;if(!/^[a-f0-9]{64}$/.test(hash))return s.code(400).send({error:'附件摘要无效'});
    const temp=path.join(assetRoot,crypto.randomUUID()+'.upload'),meter=crypto.createHash('sha256');let bytes=0;
    const count=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>128*1024*1024)return done(Error('附件过大'));meter.update(chunk);done(null,chunk);}});
    const body=q.body&&typeof q.body.pipe==='function'?q.body:Readable.from([q.body||Buffer.alloc(0)]);
    try{await pipeline(body,count,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));if(meter.digest('hex')!==hash)throw Error('附件摘要不符');const target=path.join(assetRoot,hash);if(fs.existsSync(target))fs.unlinkSync(temp);else fs.renameSync(temp,target);const receipt=receiptPath(q.workbenchActor,hash);fs.mkdirSync(path.dirname(receipt),{recursive:true});fs.writeFileSync(receipt,JSON.stringify({sha256:hash,bytes,actor:q.workbenchActor.id,session:q.workbenchActor.sessionId}),{mode:0o600});return {fileId:hash,sha256:hash,bytes};}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }));
  app.post(base,{preHandler:requireSession},wrap(async q=>{
    for(const bundle of q.body.bundles||[])for(const record of bundle.records||[])for(const f of record.files||[]){
      if(!/^[a-f0-9]{64}$/.test(f.sha256||'')||!Number.isSafeInteger(f.bytes)||f.bytes<0)throw Error('迁移附件清单无效');
      const receipt=receiptPath(q.workbenchActor,f.sha256);if(!fs.existsSync(receipt)||JSON.parse(fs.readFileSync(receipt,'utf8')).bytes!==f.bytes)throw Object.assign(Error('此原件尚未由本次成员会话上传'),{statusCode:403,code:'ASSET_SCOPE_DENIED'});
      const file=path.join(assetRoot,f.sha256);if(!fs.existsSync(file)||fs.statSync(file).size!==f.bytes)throw Error('请先上传全部迁移原件');f.stagingId=f.sha256;delete f.sourcePath;
    }
    return coordinator.stage(q.body,q.workbenchActor);
  }));
  app.get(base+'/:id',{preHandler:requireAdmin},wrap(q=>coordinator.preview(q.params.id,q.workbenchActor)));
  app.put(base+'/:id/selections',{preHandler:requireAdmin},wrap(q=>coordinator.select(q.params.id,q.body,q.workbenchActor)));
  app.post(base+'/:id/confirm',{preHandler:requireAdmin},wrap(q=>coordinator.confirm(q.params.id,q.body,q.workbenchActor)));
  app.post(base+'/:id/commit',{preHandler:requireAdmin},wrap(q=>coordinator.commit(q.params.id,q.body,q.workbenchActor)));
  app.post(base+'/:id/recover',{preHandler:requireAdmin},wrap(q=>coordinator.recover(q.params.id,q.workbenchActor)));
  app.get(base+'/:id/result',{preHandler:requireSession},wrap(q=>{
    const row=coordinator.read(q.params.id);if(row.createdBy!==q.workbenchActor.id&&q.workbenchActor.role!=='admin')throw Object.assign(Error('没有此迁移批次的权限'),{statusCode:403});return coordinator.public(row);
  }));
};}
