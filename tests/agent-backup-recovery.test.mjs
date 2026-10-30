import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createAgentStore} from '../desktop/agent-runtime/store.mjs';
import {createAgentBackups} from '../desktop/agent-host/backups.mjs';

const allModules=['warehouse','purchase','sales','overview','exporter'];
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const local=fs.mkdtempSync(path.join(os.tmpdir(),'erp-backup-recovery-')),previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=local;
  const root=path.join(local,'WuchengAgentBeta'),profile=path.join(root,'profile'),data=path.join(root,'data'),storeDir=path.join(profile,'agent-runtime'),registryFile=path.join(root,'registry.json'),purchase=path.join(data,'purchase');
  fs.mkdirSync(purchase,{recursive:true});const ledger=new DatabaseSync(path.join(purchase,'purchases.sqlite'));ledger.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,amount_cents INTEGER); INSERT INTO orders VALUES(\'order\',12345)');ledger.close();
  fs.mkdirSync(path.join(profile,'workbench-server'),{recursive:true});fs.writeFileSync(path.join(profile,'workbench-server','access-policy.json'),JSON.stringify({schemaVersion:1,users:{}}));
  const registry={purchase:{dataDir:purchase,managed:true,allowInitialize:false}};fs.writeFileSync(registryFile,JSON.stringify(registry));
  const store=createAgentStore(storeDir),taskId='original-task',attachmentId='attachment-1',artifactId='artifact-1';
  const attachmentPath=path.join(storeDir,'attachments',attachmentId,'original.txt'),artifactPath=path.join(storeDir,'tasks',taskId,'generated.txt');
  fs.mkdirSync(path.dirname(attachmentPath),{recursive:true});fs.mkdirSync(path.dirname(artifactPath),{recursive:true});fs.writeFileSync(attachmentPath,'original source');fs.writeFileSync(artifactPath,'generated proof');
  store.insert('task',{id:taskId,ownerId:'owner',status:'running',review:{id:'old-review'},engineSession:{sessionId:'private-session'},scope:{modules:['purchase']}});
  store.insert('result',{id:'result-1',ownerId:'owner',taskId,prepared:[{commitData:{old:'draft'}}]});
  store.insert('attachment',{id:attachmentId,ownerId:'owner',name:'original.txt',path:attachmentPath,sha256:hash('original source')});
  store.insert('artifact',{id:artifactId,ownerId:'owner',taskId,name:'download name.txt',path:artifactPath,sha256:hash('generated proof')});
  store.insert('schedule',{id:'schedule-1',ownerId:'owner',enabled:true,nextRunAt:'2026-11-01T00:00:00Z'});
  let actor={id:'owner',enabled:true,role:'admin',canRunTasks:true,modules:allModules};
  const hooks=createAgentBackups({paths:{root,profile,data,registryFile},storeDir,services:{config:id=>registry[id]},resolveActor:async id=>id===actor.id?actor:null,getCompanyIdentity:async()=>({companyId:'company-fixture',dataSetId:'dataset-fixture'}),binding:async()=>({dataSetId:'purchase-fixture',revision:1})});
  const ctx={actor,taskId:'backup-task',registerArtifact:()=>({id:'manifest-artifact'})};
  t.after(()=>{store.close();if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;fs.rmSync(local,{recursive:true,force:true});});
  return {root,store,hooks,ctx,taskId,attachmentPath,artifactPath,setActor:value=>actor=value};
}

test('public backup and recovery copy preserve registered file bytes and revoke executable old state',async t=>{
  const f=fixture(t),backup=await f.hooks['backups.prepare']({modules:['purchase']},f.ctx),backupId=backup.evidence[0].id;
  const list=await f.hooks['backups.list']({},f.ctx);assert.equal(list.blocks[0].rows[0].status,'verified');
  const prepared=await f.hooks['backups.restore.prepare']({backupId},f.ctx),idempotencyKey=hash('restore-fixture'),ctx={...f.ctx,capabilityId:'backups.restore-copy',approval:{payload:'trusted-runtime-proof'},idempotencyKey};
  const done=await f.hooks['backups.restore.commit']({commitData:prepared.commitData},ctx),again=await f.hooks['backups.restore.commit']({commitData:prepared.commitData},ctx);
  assert.deepEqual(done,again);assert.equal(done.receipt.activated,false);assert.equal(done.receipt.verified,true);
  const copy=path.join(f.root,'recoveries','recovery-'+prepared.commitData.recoveryId),db=new DatabaseSync(path.join(copy,'shared','agent-tasks.sqlite'),{readOnly:true});
  try{
    const get=kind=>JSON.parse(db.prepare('SELECT json FROM entities WHERE kind=?').get(kind).json),task=get('task'),attachment=get('attachment'),artifact=get('artifact');
    assert.equal(task.status,'paused');assert.equal(task.review,null);assert.equal(task.engineSession,undefined);
    assert.equal(get('schedule').enabled,false);assert.equal(get('schedule').nextRunAt,null);assert.deepEqual(get('result').prepared,[]);
    assert(attachment.path.startsWith(copy+path.sep));assert(artifact.path.startsWith(copy+path.sep));
    assert.equal(fs.readFileSync(attachment.path,'utf8'),'original source');assert.equal(fs.readFileSync(artifact.path,'utf8'),'generated proof');
  }finally{db.close();}
  assert.equal(f.store.get('task',f.taskId).status,'running');assert.equal(fs.readFileSync(f.attachmentPath,'utf8'),'original source');
  const lookup=await f.hooks['backups.restore.receipt']({idempotencyKey},ctx);assert.equal(lookup.state,'completed');
});

test('backup recovery rejects path parameters, changed manifests and unregistered files',async t=>{
  const f=fixture(t),backup=await f.hooks['backups.prepare']({modules:['purchase']},f.ctx),backupId=backup.evidence[0].id,prepared=await f.hooks['backups.restore.prepare']({backupId},f.ctx),directory=path.join(f.root,'backups','backup-'+backupId);
  await assert.rejects(()=>f.hooks['backups.verify']({backupId:'../outside'},f.ctx),{code:'BACKUP_ID_INVALID'});
  await assert.rejects(()=>f.hooks['backups.verify']({backupId,path:'outside'},f.ctx),{code:'BACKUP_INPUT_INVALID'});
  fs.appendFileSync(path.join(directory,'backup.json'),'\n');
  await assert.rejects(()=>f.hooks['backups.restore.commit']({commitData:prepared.commitData},{...f.ctx,capabilityId:'backups.restore-copy',approval:{payload:'trusted-runtime-proof'},idempotencyKey:hash('changed-manifest')}),{code:'BACKUP_MANIFEST_CHANGED'});
  fs.writeFileSync(path.join(directory,'unexpected.txt'),'extra');await assert.rejects(()=>f.hooks['backups.verify']({backupId},f.ctx),{code:'BACKUP_EXTRA_FILE'});
});

test('a restricted administrator cannot export or restore shared data belonging to other modules',async t=>{
  const f=fixture(t);f.setActor({...f.ctx.actor,modules:['purchase']});
  await assert.rejects(()=>f.hooks['backups.prepare']({modules:['purchase']},f.ctx),/全部模块权限/);
  await assert.rejects(()=>f.hooks['backups.list']({},f.ctx),{code:'BACKUP_ADMIN_REQUIRED'});
  await assert.rejects(()=>f.hooks['backups.restore.prepare']({backupId:'00000000-0000-0000-0000-000000000000'},f.ctx),{code:'BACKUP_ADMIN_REQUIRED'});
});

test('restored domain references point at copied originals and never at the live Beta ledger',async t=>{
  const f=fixture(t),purchase=path.join(f.root,'data','purchase'),original=path.join(purchase,'originals','invoice.pdf');
  fs.mkdirSync(path.dirname(original),{recursive:true});fs.writeFileSync(original,'synthetic original');
  const ledger=new DatabaseSync(path.join(purchase,'purchases.sqlite'));ledger.exec('CREATE TABLE imports(id TEXT PRIMARY KEY,file_path TEXT)');ledger.prepare('INSERT INTO imports VALUES(?,?)').run('import-1',original);ledger.close();
  const backup=await f.hooks['backups.prepare']({modules:['purchase']},f.ctx),prepared=await f.hooks['backups.restore.prepare']({backupId:backup.evidence[0].id},f.ctx),ctx={...f.ctx,capabilityId:'backups.restore-copy',approval:{payload:'trusted-runtime-proof'},idempotencyKey:hash('rewrite-domain-path')};
  const done=await f.hooks['backups.restore.commit']({commitData:prepared.commitData},ctx),copy=path.join(f.root,'recoveries','recovery-'+prepared.commitData.recoveryId),restored=new DatabaseSync(path.join(copy,'purchase','purchases.sqlite'),{readOnly:true});
  try{const value=restored.prepare('SELECT file_path FROM imports').get().file_path;assert.equal(value,path.join(copy,'purchase','originals','invoice.pdf'));assert.equal(fs.readFileSync(value,'utf8'),'synthetic original');assert.equal(restored.prepare('SELECT amount_cents FROM orders').get().amount_cents,12345);}finally{restored.close();}
  assert.equal(done.receipt.transformCount,1);const record=JSON.parse(fs.readFileSync(path.join(copy,'recovery.json'),'utf8'));assert.equal(record.transforms[0].kind,'path-remapped');assert.equal(record.transforms[0].before,undefined);assert.equal(record.transforms[0].after,undefined);assert(record.files.find(item=>item.relative==='purchase/purchases.sqlite').sourceSha256);
  const source=new DatabaseSync(path.join(purchase,'purchases.sqlite'),{readOnly:true});try{assert.equal(source.prepare('SELECT file_path FROM imports').get().file_path,original);}finally{source.close();}
});
