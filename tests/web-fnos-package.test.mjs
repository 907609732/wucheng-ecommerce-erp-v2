import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=path.join(root,'deploy/fnos/wuchengerp');
const read=p=>fs.readFileSync(path.join(pkg,p),'utf8');
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
const unixPath=p=>p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
test('native FPK registers only the official authenticated Unix gateway',()=>{
 const manifest=read('manifest');
 assert.match(manifest,/^appname\s*=\s*wuchengerp$/m);
 assert.match(manifest,/^os_min_version\s*=\s*1\.1\.3100$/m);
 assert.doesNotMatch(manifest,/service_port|install_dep_apps/);
 const entry=JSON.parse(read('app/ui/config'))['.url']['wuchengerp.main'];
 assert.equal(entry.gatewayPrefix,'/app/wuchengerp');assert.equal(entry.gatewaySocket,'app.sock');assert.equal(entry.url,'/app/wuchengerp/');
 assert.equal(JSON.parse(read('config/privilege')).defaults['run-as'],'root');
 assert.deepEqual(JSON.parse(read('config/resource')),{});
});
test('native hooks launch bundled lifecycle with explicit config and surface failures',()=>{
 // Match the hook's physical path when Windows TEMP contains an 8.3 alias.
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fnos-native-package-')));
 try{
  for(const p of ['app/runtime/node/bin','app/erp/server/fnos-native','@wuchengerp-data/erp/config','target','var'])fs.mkdirSync(path.join(dir,p),{recursive:true});
  fs.writeFileSync(path.join(dir,'app/erp/server/fnos-native/lifecycle.mjs'),'');
  fs.writeFileSync(path.join(dir,'@wuchengerp-data/erp/config/web.json'),'{}');
  const node=path.join(dir,'app/runtime/node/bin/node');fs.writeFileSync(node,'#!/bin/sh\nprintf "%s\\n" "$@" > "$ERP_TEST_ARGS"\nexit "${ERP_TEST_STATUS:-0}"\n');fs.chmodSync(node,0o755);
  const args=path.join(dir,'args'),log=path.join(dir,'error.log');
  const env={...process.env,TRIM_APPDEST:unixPath(path.join(dir,'target')),TRIM_APPDEST_VOL:unixPath(dir),TRIM_PKGVAR:unixPath(path.join(dir,'var')),TRIM_TEMP_LOGFILE:unixPath(log),ERP_TEST_ARGS:unixPath(args)};
  fs.renameSync(path.join(dir,'app'),path.join(dir,'target','app'));
  const run=action=>spawnSync(bash,[unixPath(path.join(pkg,'cmd/main')),action],{env,encoding:'utf8'});
  for(const action of ['start','status','stop']){const r=run(action);assert.equal(r.status,0,r.stderr);const argv=fs.readFileSync(args,'utf8').trim().split('\n');assert.equal(argv[1],action);assert.equal(argv[2],'--config');assert.equal(argv[3],unixPath(path.join(dir,'@wuchengerp-data/erp/config/web.json')));}
  env.ERP_TEST_STATUS='1';assert.equal(run('start').status,1);assert.match(fs.readFileSync(log,'utf8'),/ERP|日志/);
  env.ERP_TEST_STATUS='3';assert.equal(run('status').status,3);
  assert.equal(run('arbitrary-command').status,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing installation start/status fail clearly, stop leaves retained data untouched',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-thin-package-'));
 try{
  fs.mkdirSync(path.join(dir,'target'));const env={...process.env,TRIM_APPDEST:unixPath(path.join(dir,'target')),TRIM_APPDEST_VOL:unixPath(dir)};
  const run=action=>spawnSync(bash,[unixPath(path.join(pkg,'cmd/main')),action],{env,encoding:'utf8'});
  let r=run('start');assert.equal(r.status,1);assert.match(r.stderr,/socket|ERP/i);
  r=run('status');assert.equal(r.status,3);
  fs.writeFileSync(path.join(dir,'app.sock'),'DO NOT DELETE');
  assert.equal(run('start').status,1);assert.equal(run('status').status,3);
  assert.equal(run('stop').status,0);assert.equal(fs.readFileSync(path.join(dir,'app.sock'),'utf8'),'DO NOT DELETE');
  assert.equal(run('arbitrary-command').status,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('marker parser rejects traversal, multiple lines and noncanonical UUID basenames',()=>{
 const program=read('cmd/listener_check').match(/BASENAME=\$\(LC_ALL=C awk '([^']+)' "\$MARKER"\)/)?.[1];assert.ok(program);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-marker-parser-')),file=path.join(dir,'app.listener');
 const parse=value=>{fs.writeFileSync(file,value);return spawnSync(bash,['-c','LC_ALL=C awk "$1" "$2"','marker-test',program,unixPath(file)],{encoding:'utf8'});};
 try{
  const valid='.erp-01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(parse(valid+'\n').stdout,valid+'\n');assert.equal(parse(valid+'\n').status,0);
  for(const invalid of ['../'+valid+'\n','/tmp/'+valid+'\n',valid+'\nextra\n',valid+'\n\n',valid.toUpperCase()+'\n',valid+'x\n','.erp-1-2-3-4-5\n','$(touch INJECTED)\n',...(process.platform==='win32'?[]:[valid+'\r\n'])])assert.notEqual(parse(invalid).status,0,JSON.stringify(invalid));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('packager delegates to official CLI and stages an explicit source allowlist',()=>{
 const script=fs.readFileSync(path.join(root,'deploy/fnos/build.ps1'),'utf8');
 assert.match(script,/fnpack\.exe/);assert.match(script,/build/);assert.match(script,/--directory/);
 assert.doesNotMatch(script,/Compress-Archive|tar\.exe|Start-Process|Invoke-Expression/);
 assert.match(script,/loading-logo\.png/);assert.match(script,/SHA256/);
 assert.match(script,/manifest/);assert.match(script,/config\/privilege/);
});

test('Linux: real backend listener and read-only diagnostics share the private socket contract', {skip:process.platform!=='linux'}, async()=>{
 const {createFnosListener}=await import('../server/gateway/fnos.mjs');
 const http=await import('node:http');
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fnos-package-unix-')));
 const socket=path.join(dir,'app.sock'),marker=path.join(dir,'app.listener');
 let privateSocket;
 const alias=dir+'-installed-target';
 const listener=createFnosListener({routing(_req,res){res.end('ready');}},{enabled:true,socketPath:socket,basePrefix:'/app/wuchengerp'});
 const run=(action,target=dir)=>spawnSync(bash,[path.join(pkg,'cmd/listener_check'),action],{env:{...process.env,TRIM_APPDEST:target},encoding:'utf8'});
 const get=()=>new Promise((resolve,reject)=>{const request=http.get({socketPath:socket,path:'/app/wuchengerp/'},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(text));});request.on('error',reject);});
 try{
  await listener.start();
  const basename=fs.readFileSync(marker,'utf8').trim();
  assert.match(basename,/^\.erp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  privateSocket=path.join(dir,basename);
  assert.equal(fs.statSync(marker).mode&0o777,0o644);
  assert.ok(fs.statSync(privateSocket).isSocket());assert.equal(fs.statSync(socket).ino,fs.statSync(privateSocket).ino);
  assert.equal(fs.statSync(socket).mode&0o777,0o600);
  assert.equal(run('start').status,0);assert.equal(run('status').status,0);
  fs.symlinkSync(dir,alias);assert.equal(run('start',alias).status,0);assert.equal(run('status',alias).status,0);
  assert.equal(run('stop').status,0);assert.equal(await get(),'ready');
  await listener.stop();assert.equal(run('status').status,3);
  await listener.start();assert.equal(run('status').status,0);
  const validMarker=fs.readFileSync(marker,'utf8');
  assert.notEqual(validMarker.trim(),basename,'restart publishes a new generation');
  privateSocket=path.join(dir,validMarker.trim());
  for(const forged of ['../app.sock\n','/tmp/foreign.sock\n',validMarker+'extra\n',validMarker+'\n',validMarker.toUpperCase(),'.erp-00000000-0000-0000-0000-000000000000\n']){
   fs.writeFileSync(marker,forged);assert.equal(run('status').status,3,'reject forged/multiline/missing generation marker');
  }
  fs.writeFileSync(marker,validMarker);assert.equal(run('status').status,0);
  const markerCopy=path.join(dir,'marker-copy');fs.writeFileSync(markerCopy,validMarker);
  fs.unlinkSync(marker);fs.symlinkSync(markerCopy,marker);assert.equal(run('status').status,3,'reject linked marker');
  fs.unlinkSync(marker);fs.renameSync(markerCopy,marker);
  assert.equal(run('status').status,0);
  // A replacement generation name cannot stand in for the bound private listener.
  const privateBackup=privateSocket+'-backup';fs.renameSync(privateSocket,privateBackup);
  fs.symlinkSync(privateBackup,privateSocket);assert.equal(run('status').status,3);
  fs.unlinkSync(privateSocket);fs.renameSync(privateBackup,privateSocket);
  // Publishing a different inode or a symlink must not make a package appear ready.
  fs.unlinkSync(socket);fs.symlinkSync(privateSocket,socket);assert.equal(run('status').status,3);
  fs.unlinkSync(socket);fs.writeFileSync(socket,'foreign replacement');assert.equal(run('status').status,3);
  await listener.stop();assert.equal(fs.readFileSync(socket,'utf8'),'foreign replacement');assert.equal(run('status').status,3);
 }finally{
  await listener.stop();if(fs.existsSync(alias))fs.unlinkSync(alias);fs.rmSync(dir,{recursive:true,force:true});
 }
});
