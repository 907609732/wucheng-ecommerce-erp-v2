import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {configureNative,sealStoppedSource} from '../server/fnos-native/configure.mjs';
import {databases,developmentConfig} from '../server/config.mjs';
import {openStore as salesStore} from '../apps/sales/lib/db.mjs';
import {scopedPreview,lockScope} from '../apps/sales/lib/scoped-locks.mjs';
import {freightAttachment,saveFreight} from '../apps/sales/lib/freight.mjs';
import {sourceOriginal} from '../apps/overview/lib/sources.mjs';
import {makeBackup,verifyBackup,restoreBackup} from '../apps/sales/lib/backup.mjs';
import {describeFile} from '../apps/sales/lib/workbench-migration-core.mjs';
import {createSalesAgentActions} from '../apps/sales/lib/agent-actions.mjs';
import {closePreview,lockMonth} from '../apps/sales/lib/close.mjs';
const releaseRoot=path.resolve(import.meta.dirname,'..'),origin='https://nas.example.com';
const options=dataRoot=>({mode:'fresh',releaseRoot,dataRoot,publicOrigin:origin,allowedOrigins:[origin],allowedUids:['1000']});
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function files(root,prefix=''){return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(e=>{const rel=path.join(prefix,e.name);return e.isDirectory()?files(root,rel):[[rel,hash(path.join(root,rel))]];}).sort();}
async function fixture(t,{capture=true,legacy=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnative-migrate-')),source=path.join(dir,'source');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const name of ['data','state','data-version','uvcs-home','config'])fs.mkdirSync(path.join(source,name),{recursive:true,mode:0o700});
 const config=developmentConfig({root:releaseRoot,stateDir:path.join(source,'state')});
 config.mode='production';config.publicOrigin=origin;config.releaseRoot=releaseRoot;config.native={dataRoot:source,home:path.join(source,'uvcs-home'),nodePath:process.execPath};
 config.fnos={enabled:true,instanceId:'retained-instance-id',allowedOrigins:[origin],allowedUids:['1000'],basePrefix:'/app/wuchengerp',socketPath:path.join(source,'socket','app.sock')};
 for(const [module,m]of Object.entries(config.modules))m.dataDir=path.join(source,'data',module);
 fs.writeFileSync(path.join(source,'config','web.json'),JSON.stringify(config));
 fs.mkdirSync(path.join(source,'state','gateway'),{recursive:true});fs.writeFileSync(path.join(source,'state','gateway','identity.json'),JSON.stringify({schemaVersion:1,serverId:'retained-server-id',dataSetId:'retained-dataset-id'}));
 const prior=process.env.LINGTU_DATA_VERSION_DIR,priorAdmin=process.env.LINGTU_MONTH_ADMIN_DIR;
 process.env.LINGTU_MONTH_ADMIN_DIR=path.join(source,'state','month-admin');if(capture)process.env.LINGTU_DATA_VERSION_DIR=path.join(source,'data-version');
 try{for(const module of ['purchase','sales','overview']){
  const {openStore}=await import('../apps/'+module+'/lib/'+(module==='sales'?'db.mjs':'store.mjs')),s=openStore(path.join(source,'data',module));
  try{
   const rel='originals/sample.txt',content=Buffer.from('Original bytes '+module),digest=createHash('sha256').update(content).digest('hex');fs.writeFileSync(path.join(s.dir,rel),content);
   if(module==='purchase')s.db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?)').run('i','sample.txt',digest,rel,'2026-01-01',1,0,1,'{}');
   else if(module==='overview')s.db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?)').run('i',digest,'sample.txt',rel,'{}','2026-01-01');
   else{
    const shop=s.shops()[0];
    for(const [id,month] of [['scoped','2026-01'],['whole','2026-02']])s.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)',id,shop.id,'ledger','sample.txt',digest,legacy?'originals\\sample.txt':rel,'2026-01-01','committed',JSON.stringify({month}),'{}');
    if(legacy){
     const record=saveFreight(s,{request_id:'legacy-freight',channel:'warehouse',entry_mode:'month',period:'2026-02',shipping:'5.00'});
     s.run('INSERT INTO freight_attachments VALUES(?,?,?,?,?,?,?,?,?)','legacy-attachment',record.id,'sample.txt','originals\\sample.txt',digest,content.length,'text/plain','2026-02-01',null);
     s.run('INSERT INTO platform_references VALUES(?,?,?,?,?)','legacy-evidence',shop.id,'2026-02',JSON.stringify({evidence_path:'originals\\sample.txt'}),'2026-02-01');
    }
    await s.monthAdmin.setPassword({password:'retained-password',confirmation:'retained-password'});
    const scope={kind:'sales',month:'2026-01',shop_id:shop.id},preview=scopedPreview(s,scope);
    await lockScope(s,{...scope,revision:preview.revision,confirmed:true,mode:'zero'});
    await lockMonth(s,{month:'2026-02',revision:closePreview(s,'2026-02').revision,confirmation:'锁定 2026-02'},{skipBackup:true});
    for(const id of ['scoped','whole'])assert.throws(()=>s.run('UPDATE imports SET original_path=original_path WHERE id=?',id),/MONTH_LOCKED/);
   }
  }finally{s.close();}
 }}finally{if(prior===undefined)delete process.env.LINGTU_DATA_VERSION_DIR;else process.env.LINGTU_DATA_VERSION_DIR=prior;if(priorAdmin===undefined)delete process.env.LINGTU_MONTH_ADMIN_DIR;else process.env.LINGTU_MONTH_ADMIN_DIR=priorAdmin;}
 return {dir,source};
}
test('real captured and scoped/whole-month locked ledgers migrate byte-for-byte with outbox, snapshots and originals',async t=>{
 const {dir,source}=await fixture(t),target=path.join(dir,'target');await sealStoppedSource(source);
 const before=files(source),business=before.filter(([p])=>p!==path.join('config','web.json')&&p!=='migration-manifest.json');
 assert.ok(business.some(([p])=>p.endsWith('snapshot.json')));
 const naked=new DatabaseSync(path.join(source,'data','purchase',databases.purchase));try{assert.throws(()=>naked.prepare('UPDATE imports SET file_path=file_path').run(),/data_version_write_allowed/);}finally{naked.close();}
 await configureNative({...options(target),mode:'migrate',sourceRoot:source});
 assert.deepEqual(files(source),before,'migration must not change source bytes');
 for(const [p,digest]of business)assert.equal(hash(path.join(target,p)),digest,p);
 for(const module of ['purchase','sales','overview'])assert.equal(fs.readFileSync(path.join(target,'data',module,'originals','sample.txt'),'utf8'),'Original bytes '+module);
 const prior=process.env.LINGTU_DATA_VERSION_DIR,priorAdmin=process.env.LINGTU_MONTH_ADMIN_DIR;process.env.LINGTU_DATA_VERSION_DIR=path.join(target,'data-version');process.env.LINGTU_MONTH_ADMIN_DIR=path.join(target,'state','month-admin');
 let s;try{s=salesStore(path.join(target,'data','sales'));assert.equal(await s.monthAdmin.verify('retained-password'),true);assert.equal(s.get('SELECT count(*) n FROM reconciliation_locks').n,1);assert.equal(s.get('SELECT count(*) n FROM month_locks').n,1);}finally{s?.close();if(prior===undefined)delete process.env.LINGTU_DATA_VERSION_DIR;else process.env.LINGTU_DATA_VERSION_DIR=prior;if(priorAdmin===undefined)delete process.env.LINGTU_MONTH_ADMIN_DIR;else process.env.LINGTU_MONTH_ADMIN_DIR=priorAdmin;}
});
for(const reference of ['/legacy/docker/originals/sample.txt','C:\\old\\originals\\sample.txt','../outside.txt','originals/missing.txt'])test('refuses unsupported or missing actual original before publication: '+reference,async t=>{
 const {dir,source}=await fixture(t,{capture:false}),db=new DatabaseSync(path.join(source,'data','purchase',databases.purchase));try{db.prepare('UPDATE imports SET file_path=?').run(reference);}finally{db.close();}
 await sealStoppedSource(source);const before=files(source),target=path.join(dir,'refused');
 await assert.rejects(configureNative({...options(target),mode:'migrate',sourceRoot:source}),/原件|引用|reference|绝对/);assert.equal(fs.existsSync(target),false);assert.deepEqual(files(source),before);
});
test('read-only preflight includes overview imports.path and sales embedded platform evidence',async t=>{
 const {dir,source}=await fixture(t,{capture:false}),overviewFile=path.join(source,'data','overview',databases.overview);
 let db=new DatabaseSync(overviewFile);try{db.prepare('UPDATE imports SET path=?').run('/legacy/overview/original.txt');}finally{db.close();}
 await sealStoppedSource(source);await assert.rejects(configureNative({...options(path.join(dir,'overview-refused')),mode:'migrate',sourceRoot:source}),/overview.*原件引用/);
 db=new DatabaseSync(overviewFile);try{db.prepare('UPDATE imports SET path=?').run('originals/sample.txt');}finally{db.close();}
 db=new DatabaseSync(path.join(source,'data','sales',databases.sales));try{const shop=db.prepare('SELECT id FROM shops LIMIT 1').get();db.prepare('INSERT INTO platform_references VALUES(?,?,?,?,?)').run('evidence',shop.id,'2026-03',JSON.stringify({evidence_path:'/legacy/evidence.png'}),'2026-04-01');}finally{db.close();}
 await sealStoppedSource(source);await assert.rejects(configureNative({...options(path.join(dir,'evidence-refused')),mode:'migrate',sourceRoot:source}),/sales.*原件引用/);
});
test('killed initializer releases its OS lock; retry preserves abandoned staging and publishes a new instance',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnative-killed-')),target=path.join(dir,'data'),marker=path.join(dir,'marker');let child;
 t.after(()=>{child?.kill();fs.rmSync(dir,{recursive:true,force:true});});
 const script=`import fs from 'node:fs';import {configureNative} from ${JSON.stringify(pathToFileURL(path.join(releaseRoot,'server/fnos-native/configure.mjs')).href)};const mkdir=fs.mkdirSync;fs.mkdirSync=function(p,...args){const r=mkdir.call(this,p,...args);if(String(p).startsWith(${JSON.stringify(target+'.staging-')})){fs.writeFileSync(${JSON.stringify(marker)},p);while(true)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}return r;};await configureNative(${JSON.stringify(options(target))});`;
 child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:'ignore'});const closed=new Promise(r=>child.once('close',r));
 const end=Date.now()+10000;while(!fs.existsSync(marker)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.ok(fs.existsSync(marker));const abandoned=fs.readFileSync(marker,'utf8');fs.writeFileSync(path.join(abandoned,'preserve'),'abandoned copy');child.kill('SIGKILL');await closed;
 await configureNative(options(target));assert.equal(fs.readFileSync(path.join(abandoned,'preserve'),'utf8'),'abandoned copy');assert.ok(fs.existsSync(path.join(target,'config','web.json')));
});
test('Linux changed-UID retained-data recovery integration',{skip:process.platform!=='linux'},()=>{
 const python='/usr/bin/python3',script=path.join(releaseRoot,'tests','fnos-native-retained-recovery.py');
 const result=process.getuid()===0?spawnSync(python,[script],{encoding:'utf8'}):spawnSync('sudo',['-n',python,script],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
});

test('legacy relative originals survive locked real-store migration, reads and canonical backup without SQL rewrites',async t=>{
 const {dir,source}=await fixture(t,{legacy:true}),target=path.join(dir,'legacy');await sealStoppedSource(source);
 const before=files(source);await configureNative({...options(target),mode:'migrate',sourceRoot:source});
 assert.deepEqual(files(source),before);
 for(const [p,digest]of before.filter(([p])=>p!==path.join('config','web.json')&&p!=='migration-manifest.json'))assert.equal(hash(path.join(target,p)),digest,p);
 const prior=process.env.LINGTU_MONTH_ADMIN_DIR,priorVersion=process.env.LINGTU_DATA_VERSION_DIR;process.env.LINGTU_DATA_VERSION_DIR=path.join(target,'data-version');process.env.LINGTU_MONTH_ADMIN_DIR=path.join(target,'state','month-admin');
 const s=salesStore(path.join(target,'data','sales'));
 try{
  const row=s.get('SELECT * FROM imports WHERE id=?','whole');assert.equal(row.original_path,'originals\\sample.txt');
  assert.equal(await s.monthAdmin.verify('retained-password'),true);
  assert.throws(()=>s.run('UPDATE imports SET original_path=original_path WHERE id=?','whole'),/MONTH_LOCKED/);
  const att=freightAttachment(s,'legacy-attachment');assert.equal(fs.readFileSync(att.absolute,'utf8'),'Original bytes sales');
  const src=sourceOriginal({sales:[{id:'row',batch_id:'whole'}],imports:[row],paths:{sales:path.join(s.dir,'sales.sqlite')}},'sales','row');assert.equal(fs.readFileSync(src.file,'utf8'),'Original bytes sales');
  const actions=createSalesAgentActions({store:s,personnel:{},cainiao:{}});assert.equal((await actions.query('original',{id:'whole'},{})).bytes.toString(),'Original bytes sales');
  assert.equal(describeFile(s.dir,row.original_path).bytes,20);
  const backup=await makeBackup(s);assert.equal(verifyBackup(s,backup.name).ok,true);
  const manifest=JSON.parse(fs.readFileSync(path.join(s.dir,'backups',backup.name,'manifest.json')));assert.equal(manifest.files.filter(f=>f.path==='originals/sample.txt').length,1);
  const restored=path.join(dir,'restored');restoreBackup(s,backup.name,restored);assert.equal(fs.readFileSync(path.join(restored,'originals/sample.txt'),'utf8'),'Original bytes sales');
 }finally{s.close();if(priorVersion===undefined)delete process.env.LINGTU_DATA_VERSION_DIR;else process.env.LINGTU_DATA_VERSION_DIR=priorVersion;if(prior===undefined)delete process.env.LINGTU_MONTH_ADMIN_DIR;else process.env.LINGTU_MONTH_ADMIN_DIR=prior;}
});

test('enabled migration requires trusted identity, registers only final workspace and existing retry preserves data',async t=>{
 const {uvcsFixture,expected}=await import('./fnos-native-uvcs-fixture.mjs');const fake=uvcsFixture(t),{source,dir}=await fixture(t,{capture:false});
 const configFile=path.join(source,'config','web.json'),c=JSON.parse(fs.readFileSync(configFile));c.dataVersion={...c.dataVersion,enabled:true,dir:path.join(source,'data-version'),workspace:path.join(source,'data-version','workspace'),cmPath:fake.c.dataVersion.cmPath,repository:expected.repository};
 fs.cpSync(fake.workspace,c.dataVersion.workspace,{recursive:true});const queue=new DatabaseSync(path.join(c.dataVersion.dir,'queue.sqlite'));queue.exec('CREATE TABLE data_version_queue(id TEXT PRIMARY KEY,status TEXT,changeset TEXT)');queue.close();fs.writeFileSync(configFile,JSON.stringify(c));
 await assert.rejects(sealStoppedSource(source),/IDENTITY/);
 await sealStoppedSource(source,{workspaceIdentity:expected});const before=files(source),target=path.join(dir,'published');
 fs.writeFileSync(path.join(source,'uvcs-home','mode'),'error');await sealStoppedSource(source,{workspaceIdentity:expected});
 // Version failure is prepublication; registration failure is tested below with
 // wrong-id, whose version command succeeds but final identity cannot pass.
 fs.writeFileSync(path.join(source,'uvcs-home','mode'),'wrong-id');await sealStoppedSource(source,{workspaceIdentity:expected});
 await assert.rejects(configureNative({...options(target),mode:'migrate',sourceRoot:source}),/UVCS_REGISTRATION/);
 assert.ok(fs.existsSync(path.join(target,'config','web.json')));assert.ok(fs.existsSync(path.join(target,'data','sales','sales.sqlite')));
 const {nativeLifecycle}=await import('../server/fnos-native/lifecycle.mjs');await assert.rejects(nativeLifecycle('start',path.join(target,'config','web.json')),/UVCS_REGISTRATION_NOT_PREPARED/);
 if(process.platform!=='linux'||process.getuid()!==0){const {runSupervisor}=await import('../server/fnos-native/supervisor.mjs');await assert.rejects(runSupervisor(path.join(target,'config','web.json'),{createRuntime:()=>{throw Error('runtime must not start');}}),/UVCS_REGISTRATION_NOT_PREPARED/);}
 fs.unlinkSync(path.join(target,'uvcs-home','mode'));await configureNative({...options(target),mode:'existing'});
 const current=JSON.parse(fs.readFileSync(path.join(target,'config','web.json')));const {assertNativeUvcsPrepared,metadataFingerprint}=await import('../server/fnos-native/uvcs-registration.mjs');assertNativeUvcsPrepared(current);
 fs.appendFileSync(path.join(current.dataVersion.workspace,'.plastic','plastic.wktree'),'next legitimate commit');assertNativeUvcsPrepared(current);
 const {backupNative}=await import('../server/fnos-native/configure.mjs');const backup=path.join(dir,'later-backup');await backupNative(target,backup);
 const manifest=JSON.parse(fs.readFileSync(path.join(backup,'migration-manifest.json')));assert.deepEqual(manifest.uvcs.identity,expected);assert.equal(manifest.uvcs.metadataSha256,metadataFingerprint(current.dataVersion.workspace));
 for(const [p,digest]of before.filter(([p])=>p.startsWith('data'+path.sep)))assert.equal(hash(path.join(target,p)),digest,p);
});

test('migration persists official VAR runtime independently without changing readonly source logs or financial modes',async t=>{
 const {dir,source}=await fixture(t,{capture:false}),target=path.join(dir,'target'),runtimeDir=path.join(dir,'official-var/runtime');
 // Actual financial inputs already have owner-write; VAR routing must preserve
 // their modes while leaving historical readonly logs untouched.
 for(const [id,name]of Object.entries(databases))fs.chmodSync(path.join(source,'data',id,name),0o600);
 fs.chmodSync(path.join(source,'state/month-admin/month-admin.sqlite'),0o600);
 for(const id of Object.keys(databases)){const log=path.join(source,'data',id,'integration-service.log');fs.writeFileSync(log,'retained historical log\n');fs.chmodSync(log,0o400);}
 await sealStoppedSource(source);const before=files(source),modes=new Map(before.map(([p])=>[p,fs.statSync(path.join(source,p)).mode&0o777]));
 const file=await configureNative({...options(target),mode:'migrate',sourceRoot:source,runtimeDir}),config=JSON.parse(fs.readFileSync(file));
 assert.equal(config.native.runtimeDir,runtimeDir);assert.equal(config.stateDir,path.join(target,'state'));
 assert.deepEqual(files(source),before);
 for(const [p,digest]of before){assert.equal(fs.statSync(path.join(source,p)).mode&0o777,modes.get(p));if(p!==path.join('config','web.json')){assert.equal(hash(path.join(target,p)),digest);assert.equal(fs.statSync(path.join(target,p)).mode&0o777,modes.get(p));}}
 const next=path.join(dir,'replacement-var/runtime');await configureNative({...options(target),mode:'existing',runtimeDir:next});
 assert.equal(JSON.parse(fs.readFileSync(file)).native.runtimeDir,next);
 await configureNative({...options(target),mode:'existing'});assert.equal(JSON.parse(fs.readFileSync(file)).native.runtimeDir,next,'optional CLI retains configured path');
 const previous=process.env.ERP_NATIVE_RUNTIME_DIR,fromEnv=path.join(dir,'env-var/runtime');process.env.ERP_NATIVE_RUNTIME_DIR=fromEnv;
 try{const {main}=await import('../server/fnos-native/lifecycle.mjs');await main(['configure','--config',file]);assert.equal(JSON.parse(fs.readFileSync(file)).native.runtimeDir,fromEnv);}finally{if(previous===undefined)delete process.env.ERP_NATIVE_RUNTIME_DIR;else process.env.ERP_NATIVE_RUNTIME_DIR=previous;}
 const {validateConfig}=await import('../server/config.mjs');
 for(const invalid of ['relative',target,path.join(target,'state'),releaseRoot,path.join(releaseRoot,'runtime')])assert.throws(()=>validateConfig({...config,native:{...config.native,runtimeDir:invalid}}),/runtime|运行/);
 const linked=path.join(dir,'linked-var');fs.mkdirSync(runtimeDir,{recursive:true});fs.symlinkSync(path.dirname(runtimeDir),linked,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>validateConfig({...config,native:{...config.native,runtimeDir:path.join(linked,'runtime')}}),/runtime|运行/);
});

test('native runtime guard creates a private directory and refuses links before use',async t=>{
 const {ensureNativeRuntimeDirectory}=await import('../server/config.mjs');
 assert.equal(typeof ensureNativeRuntimeDirectory,'function');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-runtime-guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const runtimeDir=path.join(dir,'runtime'),config={native:{runtimeDir}};ensureNativeRuntimeDirectory(config);assert.ok(fs.statSync(runtimeDir).isDirectory());
 if(process.platform!=='win32')assert.equal(fs.statSync(runtimeDir).mode&0o777,0o700);
 fs.rmdirSync(runtimeDir);const outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,runtimeDir,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>ensureNativeRuntimeDirectory(config),/runtime/);assert.deepEqual(fs.readdirSync(outside),[]);
 ensureNativeRuntimeDirectory({});
});

test('Linux native runtime guard rejects broad permissions and foreign ownership without repairing it',{skip:process.platform!=='linux'||process.getuid?.()===0},async t=>{
 const {ensureNativeRuntimeDirectory,validateConfig}=await import('../server/config.mjs');
 const {dir:base,source}=await fixture(t,{capture:false}),dir=path.join(base,'runtime');fs.mkdirSync(dir,{mode:0o700});
 const config=JSON.parse(fs.readFileSync(path.join(source,'config/web.json')));config.native.runtimeDir=dir;
 for(const mode of [0o777,0o770,0o755]){fs.chmodSync(dir,mode);assert.throws(()=>validateConfig(config),/runtime/);assert.throws(()=>ensureNativeRuntimeDirectory(config),/runtime/);assert.equal(fs.statSync(dir).mode&0o777,mode);assert.deepEqual(fs.readdirSync(dir),[]);}
 // /root is a real foreign-owned 0700 directory on the Linux CI host; no write
 // or traversal into it is needed to establish the ownership rejection.
 const foreign='/root',before=fs.lstatSync(foreign);assert.notEqual(before.uid,process.getuid());
 config.native.runtimeDir=foreign;assert.throws(()=>validateConfig(config),/runtime/);assert.throws(()=>ensureNativeRuntimeDirectory(config),/runtime/);assert.equal(fs.lstatSync(foreign).mode,before.mode);
});

test('migration restores readonly month administrator only in private stage and purchase starts twice with retained password and locks',async t=>{
 const {dir,source}=await fixture(t),target=path.join(dir,'target'),runtimeDir=path.join(dir,'var/runtime'),adminRelative='state/month-admin/month-admin.sqlite';
 const retained=[adminRelative,'state/gateway/identity.json','data/purchase/originals/sample.txt'];
 for(const id of Object.keys(databases)){const relative='data/'+id+'/integration-service.log';fs.writeFileSync(path.join(source,relative),'retained readonly log');retained.push(relative);}
 for(const relative of retained)fs.chmodSync(path.join(source,relative),0o400);
 await sealStoppedSource(source);const before=files(source),modes=new Map(before.map(([p])=>[p,fs.statSync(path.join(source,p)).mode&0o777]));
 const configFile=await configureNative({...options(target),mode:'migrate',sourceRoot:source,runtimeDir}),config=JSON.parse(fs.readFileSync(configFile));
 for(const [relative,digest]of before)if(relative!==path.join('config','web.json'))assert.equal(hash(path.join(target,relative)),digest,'pre-start bytes '+relative);
 const net=await import('node:net'),reservations=[];
 try{for(let i=0;i<2;i++){const socket=net.createServer();reservations.push(socket);await new Promise((resolve,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',resolve));}config.modules.purchase.port=reservations[0].address().port;config.modules.purchase.mobilePort=reservations[1].address().port;}
 finally{await Promise.all(reservations.map(socket=>new Promise(resolve=>socket.close(resolve))));}
 const {createSourceServices}=await import('../server/services.mjs'),pids=[];
 for(let start=0;start<2;start++){
  const services=await createSourceServices(config);
  try{let cap;try{cap=await services.ensure('purchase');}catch(error){throw new Error(error.message+'\n'+fs.readFileSync(path.join(runtimeDir,'logs/purchase-integration-service.log'),'utf8').slice(-5000),{cause:error});}pids.push(cap.pid);assert.equal(cap.dataDir,path.join(target,'data/purchase'));assert.equal(cap.root,config.modules.purchase.root);}
  finally{await services.stopOwned();}
  assert.equal(await services.capabilities('purchase'),null);
 }
 assert.notEqual(pids[0],pids[1]);assert.ok(fs.statSync(path.join(target,adminRelative)).mode&0o200);
 const {openMonthAdmin}=await import('../shared/month-admin.mjs'),admin=openMonthAdmin({dataDir:path.join(target,'state/month-admin')});try{assert.equal(await admin.verify('retained-password'),true);}finally{admin.close();}
 const db=new DatabaseSync(path.join(target,'data/sales/sales.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM reconciliation_locks').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM month_locks').get().n,1);}finally{db.close();}
 for(const [relative,digest]of before)if(relative.includes('events'+path.sep)||relative.includes('blobs'+path.sep)||retained.includes(relative.replaceAll(path.sep,'/'))&&relative!==path.normalize(adminRelative)){assert.equal(hash(path.join(target,relative)),digest);assert.equal(fs.statSync(path.join(target,relative)).mode&0o777,modes.get(relative));}
 assert.deepEqual(files(source),before);for(const [p,mode]of modes)assert.equal(fs.statSync(path.join(source,p)).mode&0o777,mode,'source mode '+p);
 fs.chmodSync(path.join(target,adminRelative),0o400);await configureNative({...options(target),mode:'existing'});assert.equal(fs.statSync(path.join(target,adminRelative)).mode&0o200,0,'existing reconfiguration must not silently repair database permissions');
});

test('migration restores only exact active SQLite and existing sidecars without changing bytes before SQLite validation',async t=>{
 const {dir,source}=await fixture(t),target=path.join(dir,'target');
 const active=[...Object.entries(databases).map(([id,name])=>'data/'+id+'/'+name),'state/gateway/gateway.sqlite','state/gateway/gateway-ownership.sqlite','state/month-admin/month-admin.sqlite','state/native-lifecycle.sqlite','state/native-ownership.sqlite','data-version/queue.sqlite'];
 const selected=[];
 for(const relative of active){const file=path.join(source,relative);fs.mkdirSync(path.dirname(file),{recursive:true});if(!fs.existsSync(file)){const db=new DatabaseSync(file);db.exec('CREATE TABLE retained(value TEXT)');db.close();}selected.push(relative);for(const suffix of ['-wal','-shm','-journal']){fs.writeFileSync(file+suffix,'');selected.push(relative+suffix);}}
 const decoys=['data/purchase/originals/month-admin.sqlite-wal','data-version/events/not-an-active-db.sqlite'];
 fs.writeFileSync(path.join(source,decoys[0]),'immutable filename lookalike');fs.copyFileSync(path.join(source,active[0]),path.join(source,decoys[1]));
 for(const relative of [...selected,...decoys])fs.chmodSync(path.join(source,relative),0o400);
 await sealStoppedSource(source);const before=files(source),modes=new Map(before.map(([p])=>[p,fs.statSync(path.join(source,p)).mode&0o777]));
 // Observe the private copy before SQLite can consume/recover its sidecars.
 // Empty sidecars exercise the path/mode policy, not WAL recovery semantics.
 const boundary=Error('private mode census complete'),read=fs.readFileSync;let checked=false;
 t.mock.method(fs,'readFileSync',(file,...args)=>{
  if(!checked&&String(file).startsWith(target+'.staging-')&&String(file).endsWith(path.join('config','web.json'))){
   checked=true;const stage=path.dirname(path.dirname(String(file)));
   for(const [relative,digest]of before)assert.equal(hash(path.join(stage,relative)),digest,relative);
   for(const relative of selected){const mode=fs.statSync(path.join(stage,relative)).mode&0o777;assert.ok(mode&0o200,relative);if(process.platform!=='win32')assert.equal(mode,0o600,relative);}
   for(const relative of decoys)assert.equal(fs.statSync(path.join(stage,relative)).mode&0o200,0,relative);
   throw boundary;
  }
  return read(file,...args);
 });
 await assert.rejects(configureNative({...options(target),mode:'migrate',sourceRoot:source}),error=>error===boundary);
 assert.equal(checked,true);assert.equal(fs.existsSync(target),false);
 assert.deepEqual(files(source),before);for(const [p,mode]of modes)assert.equal(fs.statSync(path.join(source,p)).mode&0o777,mode,p);
});

for(const attack of ['hardlink','symlink'])test('migration refuses a substituted stage SQLite '+attack+' without changing its source',async t=>{
 const {dir,source}=await fixture(t,{capture:false}),target=path.join(dir,'target'),relative='state/month-admin/month-admin.sqlite',input=path.join(source,relative);
 fs.chmodSync(input,0o400);await sealStoppedSource(source);const before=files(source),mode=fs.statSync(input).mode,copy=fs.cpSync;
 t.mock.method(fs,'cpSync',(from,to,options)=>{const result=copy(from,to,options);if(String(to).startsWith(target+'.staging-')){const selected=path.join(to,relative);fs.rmSync(selected,{force:true});if(attack==='hardlink')fs.linkSync(input,selected);else fs.symlinkSync(path.dirname(input),selected,process.platform==='win32'?'junction':'dir');}return result;});
 await assert.rejects(configureNative({...options(target),mode:'migrate',sourceRoot:source}),/SQLite|符号链接/);
 assert.equal(fs.existsSync(target),false);assert.equal(fs.statSync(input).mode,mode);assert.equal(fs.statSync(input).nlink,1);assert.deepEqual(files(source),before);
});
