import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {CainiaoAuthorization,normalizeAuthorization} from '../lib/cainiao-auth.mjs';
import {CainiaoBrowser} from '../lib/cainiao-browser.mjs';
import {createApp} from '../server.mjs';
import {makeBackup,restoreBackup} from '../lib/files.mjs';
import {fixture} from './helpers.mjs';

test('Windows 授权：真实 DPAPI 加密持久化，不保存明文，损坏时明确拒绝', {skip:process.platform!=='win32'},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cn-auth-test-')),secret=randomUUID(),a=new CainiaoAuthorization(dir);
 try{assert.equal(a.has(),false);await a.save(secret);assert.equal(a.has(),true);assert.ok(!fs.readFileSync(a.file,'utf8').includes(secret));assert.equal(await new CainiaoAuthorization(dir).load(),secret);
  assert.equal(normalizeAuthorization('PLAYWRIGHT_MCP_EXTENSION_TOKEN="'+secret+'"'),secret);assert.throws(()=>normalizeAuthorization('wrong\nvalue'));assert.throws(()=>normalizeAuthorization('x'.repeat(1025)));
  fs.writeFileSync(a.file,'{"version":1,"blob":"corrupt"}');await assert.rejects(a.load(),/失效|不可读取/);a.forget();assert.equal(a.has(),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('授权接口：必须本机会话及明确同意，响应不含令牌，备份恢复不携带浏览器授权', {skip:process.platform!=='win32'},async()=>{
 const f=fixture(),dir=path.join(f.dir,'api'),browser=new CainiaoBrowser(dir),a=createApp({dataDir:dir,sources:f.paths,cainiaoOptions:{browser}}),server=a.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port,secret=randomUUID();
 try{
  const boot=await fetch(base+'/api/bootstrap').then(r=>r.json()),post=(body,token=boot.token,origin)=>fetch(base+'/api/cainiao/authorization',{method:'POST',headers:{'Content-Type':'application/json','X-Overview-Token':token,...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  assert.equal((await post({action:'save',token:secret,consent:true},'')).status,403);assert.equal((await post({action:'save',token:secret,consent:true},boot.token,'https://example.com')).status,403);
  assert.equal((await post({action:'save',token:secret})).status,400);assert.equal(browser.authorization.has(),false);
  const saved=await post({action:'save',token:secret,consent:true});assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{saved:true});
  const status=await fetch(base+'/api/cainiao/connection').then(r=>r.text());assert.ok(!status.includes(secret));assert.equal(JSON.parse(status).authorizationSaved,true);assert.equal(await new CainiaoAuthorization(dir).load(),secret);
  const backup=await makeBackup(a.store),bytes=fs.readFileSync(path.join(dir,'backups',backup.name)),zip=await JSZip.loadAsync(bytes);assert.ok(!Object.keys(zip.files).some(n=>/authorization|dpapi|staging/.test(n)));
  const restored=await restoreBackup(bytes,path.join(f.dir,'restore'));assert.equal(new CainiaoAuthorization(restored.path).has(),false);
  assert.deepEqual(await (await post({action:'forget'})).json(),{saved:false});assert.equal(browser.authorization.has(),false);assert.equal(browser.status().status,'disconnected');
 }finally{await a.cainiao.close();await new Promise(r=>server.close(r));a.store.close();f.close();}
});
