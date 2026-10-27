import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {signWorkbenchActor} from '../workbench/actor.mjs';
import {canonical,digest} from './coordinator.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function createServiceMigrationAdapter({services,id,backupRoot,assetRoot}){
  let activeMigration;
  async function request(route,body,actor){
    const cap=await services.ensure(id),cfg=services.config(id),upstream='/api/integration/v1/workbench/migration/'+route,method=body===undefined?'GET':'POST';
    const key=fs.readFileSync(path.join(cfg.dataDir,'.workbench-key'),'utf8').trim();
    const encoded=signWorkbenchActor({...actor,v:1,id:actor.id,login:actor.login,canRunTasks:!!actor.canRunTasks,sessionId:actor.sessionId,module:id,method,path:upstream,requestId:crypto.randomUUID(),issuedAt:Date.now(),expiresAt:Date.now()+30000},key);
    const token=fs.readFileSync(path.join(cfg.dataDir,cfg.keyFile||'.integration-key'),'utf8').trim();
    const response=await fetch(cap.url+upstream,{method,headers:{...encoded,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(120000)});
    const data=await response.json();if(!response.ok||data.ok===false)throw Object.assign(Error(data.error||data.message||'迁移模块请求失败'),{code:data.code});return data.data||data;
  }
  function registryMaintenance(value){const registry=fs.existsSync(services.registryFile)?JSON.parse(fs.readFileSync(services.registryFile,'utf8')):{};registry[id]={...services.config(id),maintenance:value};const temp=services.registryFile+'.migration.tmp';fs.writeFileSync(temp,JSON.stringify(registry,null,2));fs.renameSync(temp,services.registryFile);}
  const adapter={
    exportSnapshot:actor=>request('export',undefined,actor),
    preview:(bundle,actor,selections)=>request('preview',{bundle,selections},actor),
    async maintenance(enabled,actor,migrationId){
      if(enabled&&activeMigration&&activeMigration!==migrationId)throw Error('模块已被另一批迁移占用');
      if(enabled){const wasOwned=activeMigration===migrationId;activeMigration=migrationId;try{const cap=await services.ensure(id);if(cap.busy||cap.maintenance&&!wasOwned)throw Error('模块已有任务或维护窗口，已阻止迁移');await request('maintenance',{enabled:true,migrationId},actor);registryMaintenance(true);}catch(error){activeMigration=null;throw error;}}
      else{await request('maintenance',{enabled:false,migrationId},actor);registryMaintenance(false);activeMigration=null;}
    },
    async backup(actor,migrationId){
      const cfg=services.config(id),result=await request('backup',{migrationId},actor);
      const directory=path.join(backupRoot,migrationId,id);fs.mkdirSync(directory,{recursive:true});
      const database=result.path||result.file||result.backup?.path;
      if(!database||!path.isAbsolute(database)||!fs.existsSync(database))throw Error('模块未返回有效的一致性备份');
      const target=path.join(directory,'ledger.sqlite');fs.copyFileSync(database,target);
      if(result.sha256&&result.sha256!==hash(target))throw Error('账本备份摘要不符');
      const files=[];
      for(const prefix of ['attachments','originals','images','migration-evidence','workbench-migration-files']){
        const source=path.join(cfg.dataDir,prefix);if(!fs.existsSync(source))continue;
        const walk=(folder,relative)=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
          const file=path.join(folder,entry.name),rel=path.join(relative,entry.name);if(entry.isSymbolicLink())throw Error('附件备份不允许符号链接');
          if(entry.isDirectory())walk(file,rel);else{const dest=path.join(directory,'files',rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);files.push({relative:rel,sha256:hash(dest)});}
        }};walk(source,prefix);
      }
      return {directory,database:target,sha256:hash(target),files,dataDir:cfg.dataDir,db:cfg.db||'orders.sqlite'};
    },
    async commit(plan,actor){
      const staging=path.join(services.config(id).dataDir,'workbench-migration-staging');fs.mkdirSync(staging,{recursive:true});
      for(const record of plan.bundle.records)for(const descriptor of record.files||[]){
        if(!/^[a-f0-9]{64}$/.test(descriptor.sha256)||descriptor.stagingId!==descriptor.sha256)throw Error('附件缺少已校验的暂存标识');
        const source=path.join(assetRoot,descriptor.sha256);if(hash(source)!==descriptor.sha256||fs.statSync(source).size!==descriptor.bytes)throw Error('迁移原件摘要或大小已变化');
        const target=path.join(staging,descriptor.stagingId);if(!fs.existsSync(target))fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);else if(hash(target)!==descriptor.sha256)throw Error('附件暂存冲突');
      }
      const key=fs.readFileSync(path.join(services.config(id).dataDir,'.workbench-key'),'utf8').trim(),expiresAt=Date.now()+60000,planDigest=digest(plan);
      const signature=crypto.createHmac('sha256',key).update('workbench-migration/v1:'+planDigest+':'+expiresAt+':'+actor.sessionId).digest('hex');
      return request('commit',{plan,permit:{digest:planDigest,expiresAt,signature}},actor);
    },
    async verify(result,actor){
      if(result.verified!==true&&!result.verification?.ok)throw Error('模块没有返回逐项核对通过结果');
      // A second business read after commit must be possible before reopening writes.
      const report=await request('verify/'+encodeURIComponent(result.migrationId),undefined,actor);
      if(report.ok===false||report.verified===false||report.verification?.ok===false)throw Error('提交后再次核对发现差异');
    },
    async restore(backup,actor,migrationId){
      activeMigration=migrationId;
      const cfg=services.config(id);if(path.resolve(cfg.dataDir)!==path.resolve(backup.dataDir)||hash(backup.database)!==backup.sha256)throw Error('恢复目标或备份摘要不符');
      registryMaintenance(true);const beforeStop=await services.capabilities(id);await services.stop(id);
      let stopped=false;for(let i=0;i<150;i++){
        const cap=await services.capabilities(id);let processAlive=false;
        if(Number.isInteger(beforeStop?.pid)&&beforeStop.pid>0)try{process.kill(beforeStop.pid,0);processAlive=true;}catch{}
        if((!cap||!cap.url||cap.running===false)&&!processAlive){stopped=true;break;}await wait(100);
      }
      if(!stopped)throw Error('服务尚未停止，不能恢复账本');
      const database=path.resolve(cfg.dataDir,backup.db),root=path.resolve(cfg.dataDir)+path.sep;
      if(!database.startsWith(root))throw Error('恢复路径越界');
      fs.copyFileSync(backup.database,database);
      for(const suffix of ['-wal','-shm'])if(fs.existsSync(database+suffix))fs.unlinkSync(database+suffix);
      const keep=new Set(backup.files.map(f=>f.relative));
      for(const prefix of ['attachments','originals','images','migration-evidence','workbench-migration-files']){
        const walk=(dir,relative)=>{if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
          if(entry.isSymbolicLink())throw Error('恢复附件包含链接');const rel=path.join(relative,entry.name),file=path.join(dir,entry.name);
          if(entry.isDirectory())walk(file,rel);else if(!keep.has(rel))fs.unlinkSync(file);
        }};walk(path.join(cfg.dataDir,prefix),prefix);
      }
      for(const f of backup.files){const source=path.join(backup.directory,'files',f.relative);if(hash(source)!==f.sha256)throw Error('附件备份摘要不符');const target=path.join(cfg.dataDir,f.relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
      await services.ensure(id);await request('maintenance',{enabled:true,migrationId:activeMigration},actor);
    }
  };return adapter;
}
