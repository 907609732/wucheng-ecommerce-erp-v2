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
test('thin FPK registers only the official authenticated Unix gateway',()=>{
 const manifest=read('manifest');
 assert.match(manifest,/^appname\s*=\s*wuchengerp$/m);
 assert.match(manifest,/^os_min_version\s*=\s*1\.1\.3100$/m);
 assert.doesNotMatch(manifest,/service_port|install_dep_apps/);
 const entry=JSON.parse(read('app/ui/config'))['.url']['wuchengerp.main'];
 assert.equal(entry.gatewayPrefix,'/app/wuchengerp');assert.equal(entry.gatewaySocket,'app.sock');assert.equal(entry.url,'/app/wuchengerp/');
 assert.equal(JSON.parse(read('config/privilege')).defaults['run-as'],'package');
 assert.deepEqual(JSON.parse(read('config/resource')),{});
});
test('lifecycle is shell-only, read-only and cannot manage ERP or data',()=>{
 const main=read('cmd/main');
 assert.doesNotMatch(main,/\b(?:docker|python[23]?|curl|wget|kill|rm|mkdir|touch|chmod|chown|eval|source)\b|>>|\/var\/run/);
 assert.match(main,/\/proc\/net\/unix/);assert.match(main,/00010000/);assert.match(main,/\[ -S "\$SOCKET" \]/);
 for(const name of fs.readdirSync(path.join(pkg,'cmd'))){
  if(name==='main')continue;
  assert.match(read('cmd/'+name),/^#!\/bin\/sh\n(?:#[^\n]*\n)*exit 0\n$/);
 }
});
test('missing socket start/status fail clearly, stop leaves all files untouched',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-thin-package-'));
 try{
  const env={...process.env,TRIM_APPDEST:unixPath(dir)};
  const run=action=>spawnSync(bash,[unixPath(path.join(pkg,'cmd/main')),action],{env,encoding:'utf8'});
  let r=run('start');assert.equal(r.status,1);assert.match(r.stderr,/socket|ERP/i);
  r=run('status');assert.equal(r.status,3);
  fs.writeFileSync(path.join(dir,'app.sock'),'DO NOT DELETE');
  assert.equal(run('start').status,1);assert.equal(run('status').status,3);
  assert.equal(run('stop').status,0);assert.equal(fs.readFileSync(path.join(dir,'app.sock'),'utf8'),'DO NOT DELETE');
  assert.equal(run('arbitrary-command').status,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('packager delegates to official CLI and stages an explicit source allowlist',()=>{
 const script=fs.readFileSync(path.join(root,'deploy/fnos/build.ps1'),'utf8');
 assert.match(script,/fnpack\.exe/);assert.match(script,/build/);assert.match(script,/--directory/);
 assert.doesNotMatch(script,/Compress-Archive|tar\.exe|Start-Process|Invoke-Expression/);
 assert.match(script,/loading-logo\.png/);assert.match(script,/SHA256/);
 assert.match(script,/manifest/);assert.match(script,/config\/privilege/);
});

test('Linux: active Unix listener succeeds; stale socket and symlink do not', {skip:process.platform!=='linux'}, async()=>{
 const net=await import('node:net');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-package-unix-'));
 const socket=path.join(dir,'app.sock');
 const server=net.createServer();
 const run=action=>spawnSync(bash,[path.join(pkg,'cmd/main'),action],{env:{...process.env,TRIM_APPDEST:dir},encoding:'utf8'});
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  fs.chmodSync(socket,0o600);
  assert.equal(run('start').status,0);assert.equal(run('status').status,0);
  assert.equal(run('stop').status,0);assert.ok(server.listening);assert.ok(fs.statSync(socket).isSocket());
  const alias=path.join(dir,'alias');fs.mkdirSync(alias);fs.symlinkSync(socket,path.join(alias,'app.sock'));
  assert.equal(spawnSync(bash,[path.join(pkg,'cmd/main'),'status'],{env:{...process.env,TRIM_APPDEST:alias}}).status,3);
 }finally{
  await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});
 }
});
