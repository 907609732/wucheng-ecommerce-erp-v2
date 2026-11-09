import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {developmentConfig,databases} from '../server/config.mjs';

const root=path.resolve(import.meta.dirname,'..'),cmd=path.join(root,'deploy/fnos/wuchengerp/cmd');
const shell=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/sh';
const unix=p=>p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(t,targetState='missing',retain=true){
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fnos-upgrade-hook-')));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target=path.join(dir,'target'),base=path.join(dir,'@wuchengerp-data'),data=path.join(base,'erp'),config=path.join(data,'config/web.json');
 const retained=path.join(base,'backups/prior/retained.txt');if(retain){fs.mkdirSync(path.dirname(retained),{recursive:true});fs.writeFileSync(retained,'prior backup remains private');}
 if(targetState==='dangling')fs.symlinkSync(path.join(dir,'absent-payload'),target,process.platform==='win32'?'junction':'dir');
 const env={...process.env,TRIM_APPDEST:unix(target),TRIM_APPDEST_VOL:unix(dir),TRIM_TEMP_LOGFILE:unix(path.join(dir,'error.log')),ERP_TEST_SECRET:'must-not-be-logged'};
 const run=(hook,action)=>spawnSync(shell,[unix(path.join(cmd,hook)),...(action?[action]:[])],{env,encoding:'utf8',timeout:30000});
 return {dir,target,base,data,config,retained,env,run};
}

for(const targetState of ['missing','dangling'])test('native inactive upgrade/stop/status tolerate '+targetState+' target without publishing data',t=>{
 const f=fixture(t,targetState),before=hash(f.retained);
 for(const [hook,action,status]of [['upgrade_init',undefined,0],['main','stop',0],['main','status',3]]){
  const r=f.run(hook,action);assert.equal(r.status,status,r.stderr);assert.doesNotMatch(r.stderr,/target 无法解析/);
 }
 assert.equal(f.run('main','start').status,1,'start must still refuse an uninitialized installation');
 assert.equal(fs.existsSync(f.data),false);assert.equal(hash(f.retained),before);
 assert.equal(fs.existsSync(f.target),false);if(targetState==='dangling')assert.ok(fs.lstatSync(f.target).isSymbolicLink());
});

for(const targetState of ['missing','dangling'])test('native configured upgrade/stop fail closed with '+targetState+' target',t=>{
 const f=fixture(t,targetState);fs.mkdirSync(path.dirname(f.config),{recursive:true});fs.writeFileSync(f.config,'{"retained":"original"}');
 const before=[hash(f.config),hash(f.retained)];
 for(const [hook,action]of [['upgrade_init'],['main','stop'],['main','status']]){
  const r=f.run(hook,action);assert.notEqual(r.status,0);assert.match(r.stderr,/target 无法解析/);
  assert.match(r.stderr,/uid=\d+/);assert.ok(r.stderr.includes('hook='+hook));assert.ok(r.stderr.includes(unix(f.target)));assert.doesNotMatch(r.stderr,/must-not-be-logged/);
 }
 assert.deepEqual([hash(f.config),hash(f.retained)],before);assert.deepEqual(fs.readdirSync(path.join(f.base,'backups')),['prior']);
});

for(const targetState of ['missing','dangling'])test('native install_init prepares only persistent base with '+targetState+' target',t=>{
 const f=fixture(t,targetState,false);let r=f.run('install_init');assert.equal(r.status,0,r.stderr);
 assert.ok(fs.statSync(f.base).isDirectory());assert.equal(fs.existsSync(f.data),false);assert.equal(fs.existsSync(f.target),false);
 if(targetState==='dangling')assert.ok(fs.lstatSync(f.target).isSymbolicLink());
 fs.mkdirSync(path.join(f.data,'data/purchase'),{recursive:true});const ledger=path.join(f.data,'data/purchase/retained');fs.writeFileSync(ledger,'original ledger bytes');
 r=f.run('install_init');assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(ledger,'utf8'),'original ledger bytes');assert.equal(fs.existsSync(f.config),false);
});

test('native install_init rejects invalid volumes and linked retained directories',t=>{
 const f=fixture(t);const before=hash(f.retained),file=path.join(f.dir,'not-volume');fs.writeFileSync(file,'not a volume');
 for(const volume of ['',unix(path.join(f.dir,'absent-volume')),unix(file)]){
  f.env.TRIM_APPDEST_VOL=volume;const r=f.run('install_init');assert.equal(r.status,1);assert.match(r.stderr,/存储卷/);
 }
 f.env.TRIM_APPDEST_VOL=unix(f.dir);const outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'unrelated bytes');
 fs.symlinkSync(outside,f.data,process.platform==='win32'?'junction':'dir');let r=f.run('install_init');assert.equal(r.status,1);assert.match(r.stderr,/持久目录不能是符号链接/);fs.unlinkSync(f.data);
 const saved=f.base+'-saved';fs.renameSync(f.base,saved);fs.symlinkSync(saved,f.base,process.platform==='win32'?'junction':'dir');r=f.run('install_init');assert.equal(r.status,1);assert.match(r.stderr,/持久目录不能是符号链接/);
 assert.equal(hash(f.retained),before);assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'unrelated bytes');assert.equal(fs.existsSync(f.target),false);
});

test('native installation/configuration callbacks still require their payload',t=>{
 const f=fixture(t);
 for(const hook of ['install_callback','upgrade_callback','config_init','config_callback','uninstall_init']){
  const r=f.run(hook);assert.equal(r.status,1,hook);assert.match(r.stderr,/target 无法解析/,hook);
 }
 assert.equal(fs.existsSync(f.data),false);assert.equal(fs.readFileSync(f.retained,'utf8'),'prior backup remains private');
});

test('native upgrade invokes real stop and sealed backup before allowing package replacement',t=>{
 const f=fixture(t);for(const p of ['config','state/gateway','data-version','uvcs-home'])fs.mkdirSync(path.join(f.data,p),{recursive:true});
 const c=developmentConfig({root,stateDir:path.join(f.data,'state')});c.mode='production';c.publicOrigin='https://nas.example.test';c.releaseRoot=root;c.native={dataRoot:f.data,home:path.join(f.data,'uvcs-home'),nodePath:process.execPath};
 for(const [id,m]of Object.entries(c.modules)){
  m.dataDir=path.join(f.data,'data',id);fs.mkdirSync(m.dataDir,{recursive:true});const db=new DatabaseSync(path.join(m.dataDir,databases[id]));try{db.exec('CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES(\'original ledger bytes\')');}finally{db.close();}
 }
 fs.writeFileSync(f.config,JSON.stringify(c));fs.writeFileSync(path.join(c.stateDir,'gateway/identity.json'),JSON.stringify({schemaVersion:1,serverId:'original-server-id',dataSetId:'original-dataset-id'}));
 const lifecycle=path.join(f.target,'erp/server/fnos-native/lifecycle.mjs'),node=path.join(f.target,'runtime/node/bin/node');fs.mkdirSync(path.dirname(lifecycle),{recursive:true});fs.mkdirSync(path.dirname(node),{recursive:true});fs.writeFileSync(lifecycle,'');
 // Substitute only the bundled executable location; run the actual lifecycle CLI.
 const trace=path.join(f.dir,'trace');f.env.ERP_TEST_TRACE=unix(trace);
 fs.writeFileSync(node,`#!/bin/sh\nprintf '%s\\n' "$2" >> "$ERP_TEST_TRACE"\nshift\nexec ${quote(unix(process.execPath))} ${quote(unix(path.join(root,'server/fnos-native/lifecycle.mjs')))} "$@"\n`);fs.chmodSync(node,0o755);
 const before=Object.entries(c.modules).map(([id,m])=>[id,hash(path.join(m.dataDir,databases[id]))]);
 let r=f.run('upgrade_init');assert.equal(r.status,0,r.stderr);assert.deepEqual(fs.readFileSync(trace,'utf8').trim().split('\n'),['stop','backup']);
 const backups=fs.readdirSync(path.join(f.base,'backups')).filter(p=>p.startsWith('before-upgrade-'));assert.equal(backups.length,1);
 const backup=path.join(f.base,'backups',backups[0]),manifest=JSON.parse(fs.readFileSync(path.join(backup,'migration-manifest.json')));assert.equal(manifest.stopped,true);
 for(const [id,digest]of before){assert.equal(hash(path.join(c.modules[id].dataDir,databases[id])),digest);assert.equal(hash(path.join(backup,'data',id,databases[id])),digest);assert.ok(manifest.files.some(p=>p.path==='data/'+id+'/'+databases[id]));}
 assert.equal(fs.readFileSync(path.join(backup,'config/web.json'),'utf8'),fs.readFileSync(f.config,'utf8'));assert.equal(fs.readFileSync(f.retained,'utf8'),'prior backup remains private');
 // A record that cannot pass the production ownership contract must prevent backup.
 fs.writeFileSync(path.join(c.stateDir,'native-supervisor.json'),'{}');fs.writeFileSync(trace,'');r=f.run('upgrade_init');assert.equal(r.status,1);assert.match(r.stderr,/未能安全停写/);assert.deepEqual(fs.readFileSync(trace,'utf8').trim().split('\n'),['stop']);assert.equal(fs.readdirSync(path.join(f.base,'backups')).length,2);
 fs.unlinkSync(path.join(c.stateDir,'native-supervisor.json'));
 // Real SQLite backup verification failure must also prevent package replacement.
 fs.writeFileSync(path.join(c.modules.purchase.dataDir,databases.purchase),'not a SQLite database');fs.writeFileSync(trace,'');r=f.run('upgrade_init');assert.equal(r.status,1);assert.match(r.stderr,/备份或恢复校验失败/);assert.deepEqual(fs.readFileSync(trace,'utf8').trim().split('\n'),['stop','backup']);assert.equal(fs.readFileSync(path.join(c.modules.purchase.dataDir,databases.purchase),'utf8'),'not a SQLite database');
});

test('official VAR logical path is resolved once and private runtime is prepared only after payload exists',t=>{
 const f=fixture(t),physical=path.join(f.dir,'appdata'),logical=path.join(f.dir,'var-link');fs.mkdirSync(physical);fs.symlinkSync(physical,logical,process.platform==='win32'?'junction':'dir');f.env.TRIM_PKGVAR=unix(logical);
 assert.equal(f.run('install_init').status,0);assert.equal(fs.existsSync(path.join(physical,'runtime')),false);
 fs.mkdirSync(path.join(f.target,'erp'),{recursive:true});
 const invoke=()=>spawnSync(shell,['-c',`set -eu; . ${quote(unix(path.join(cmd,'native_env')))}; resolve_payload; prepare_runtime; printf '%s' "$ERP_NATIVE_RUNTIME_DIR"`],{env:f.env,encoding:'utf8',timeout:30000});
 let r=invoke();assert.equal(r.status,0,r.stderr);const actual=process.platform==='win32'?spawnSync(shell,['-c','cygpath -w "$1"','sh',r.stdout],{encoding:'utf8'}).stdout.trim():r.stdout;assert.equal(fs.realpathSync.native(actual),path.join(fs.realpathSync.native(physical),'runtime'));
 const runtime=path.join(physical,'runtime');assert.ok(fs.statSync(runtime).isDirectory());if(process.platform!=='win32')assert.equal(fs.statSync(runtime).mode&0o777,0o700);
 fs.rmdirSync(runtime);const outside=path.join(f.dir,'outside-runtime');fs.mkdirSync(outside);fs.symlinkSync(outside,runtime,process.platform==='win32'?'junction':'dir');
 r=invoke();assert.notEqual(r.status,0);assert.match(r.stderr,/runtime/);assert.deepEqual(fs.readdirSync(outside),[]);
});
