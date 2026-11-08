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
import {closePreview,lockMonth} from '../apps/sales/lib/close.mjs';
const releaseRoot=path.resolve(import.meta.dirname,'..'),origin='https://nas.example.com';
const options=dataRoot=>({mode:'fresh',releaseRoot,dataRoot,publicOrigin:origin,allowedOrigins:[origin],allowedUids:['1000']});
const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function files(root,prefix=''){return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(e=>{const rel=path.join(prefix,e.name);return e.isDirectory()?files(root,rel):[[rel,hash(path.join(root,rel))]];}).sort();}
async function fixture(t,{capture=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnative-migrate-')),source=path.join(dir,'source');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const name of ['data','state','data-version','uvcs-home','config'])fs.mkdirSync(path.join(source,name),{recursive:true});
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
    for(const [id,month] of [['scoped','2026-01'],['whole','2026-02']])s.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)',id,shop.id,'ledger','sample.txt',digest,rel,'2026-01-01','committed',JSON.stringify({month}),'{}');
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
