import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createWorkbenchGateway} from '../server/gateway/gateway.mjs';
const prefix='/app/wuchengerp';
const config=dir=>({enabled:true,instanceId:'nas1',socketPath:path.join(dir,'app.sock'),basePrefix:prefix,allowedOrigins:['http://192.168.1.100:5666','https://nas.example.test'],allowedUids:['1000']});
async function gateway(t,fnosPatch={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-'));const g=await createWorkbenchGateway({services:{config:()=>({}),capabilities:async()=>null},storeDir:path.join(dir,'store'),publicOrigin:'https://erp.example.test',port:0,fnos:{...config(dir),...fnosPatch},registerRoutes:async(app,context)=>{app.post('/test-write',{preHandler:context.requireSession},async req=>({id:req.workbenchActor.id}));app.get('/test-actor',{preHandler:context.requireSession},async req=>req.workbenchActor);}});t.after(async()=>{await g.stop();fs.rmSync(dir,{recursive:true,force:true});});return {g,dir};}
function unix(socketPath,url=prefix+'/api/workbench/v1/session',headers={}){return new Promise((resolve,reject)=>{const req=http.get({socketPath,path:url,headers:{host:'192.168.1.100','X-Trim-Userid':'1000','X-Trim-Username':'907609732',...headers}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({statusCode:res.statusCode,headers:res.headers,body,json:()=>JSON.parse(body)}));});req.on('error',reject);});}
test('TCP never accepts fnOS gateway identity',async t=>{const {g}=await gateway(t);const r=await g.app.inject({url:'/api/workbench/v1/session',headers:{host:'erp.example.test','tailscale-user-login':'user@example.test','x-trim-userid':'1000'}});assert.equal(r.statusCode,400);});
test('fnOS requires explicit UID allowlist and secure external origins',async()=>{for(const patch of [{allowedUids:[]},{allowedOrigins:['http://external.example.test']},{instanceId:''},{basePrefix:'/bad'}]){await assert.rejects(createWorkbenchGateway({services:{},storeDir:'unused',publicOrigin:'https://erp.example.test',fnos:{...config(os.tmpdir()),...patch}}));}});
test('real Unix and TCP share owner; identity stable across rename, no fallback, prefix and socket safety',{skip:process.platform==='win32'},async t=>{const {g,dir}=await gateway(t);await g.start();assert.equal(fs.statSync(path.join(dir,'app.sock')).mode&0o777,0o600);const a=await unix(path.join(dir,'app.sock'));assert.equal(a.statusCode,200,a.body);assert.equal(a.json().actor.id,'fnos:nas1:1000');assert.equal(a.json().actor.publicPrefix,prefix);assert.match(a.headers['set-cookie'][0],/Path=\/app\/wuchengerp/);assert.doesNotMatch(a.headers['set-cookie'][0],/; Secure/);const b=await unix(path.join(dir,'app.sock'),undefined,{'x-trim-username':'renamed',cookie:a.headers['set-cookie'][0].split(';')[0]});assert.equal(b.json().sessionId,a.json().sessionId);assert.equal(b.json().actor.label,'renamed');for(const headers of [{'x-trim-userid':'1001'},{'x-trim-userid':['1000','1000']},{'x-trim-userid':'','tailscale-user-login':'admin@example.test'},{origin:'https://evil.test'},{host:'evil.test'}])assert.notEqual((await unix(path.join(dir,'app.sock'),undefined,headers)).statusCode,200);assert.equal((await unix(path.join(dir,'app.sock'),'/api/workbench/v1/session')).statusCode,400);const tcp=await g.app.inject({url:'/api/workbench/v1/session',headers:{host:'erp.example.test','tailscale-user-login':'a@example.test'}});assert.equal(tcp.json().serverId,a.json().serverId);assert.equal(tcp.json().dataSetId,a.json().dataSetId);});
test('Unix startup refuses existing files without replacing them',{skip:process.platform==='win32'},async t=>{const {g,dir}=await gateway(t);const file=path.join(dir,'app.sock');fs.writeFileSync(file,'keep');await g.start();assert.equal(g.fnosStatus().state,'degraded');assert.equal((await g.app.inject({url:'/api/workbench/v1/session',headers:{host:'erp.example.test','tailscale-user-login':'backup@example.test'}})).statusCode,200);assert.equal(fs.readFileSync(file,'utf8'),'keep');});
import {fnosIdentity,validateFnos,createFnosListener} from '../server/gateway/fnos.mjs';
import {createGatewayStore,digest} from '../server/gateway/store.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readCompanyMembers} from '../server/gateway/company-access.mjs';
function identity(headers={}){const h={host:'192.168.1.100','x-trim-userid':'1000','x-trim-username':'907609732',...headers};return {headers:h,raw:{rawHeaders:Object.entries(h).flat()}};}
test('fnOS header parser preserves UID and disambiguates only configured origins',()=>{const c=validateFnos(config(os.tmpdir()));const a=fnosIdentity(identity(),c),b=fnosIdentity(identity({'x-trim-username':'renamed'}),c);assert.equal(a.id,b.id);assert.equal(b.label,'renamed');assert.equal(a.origin,'http://192.168.1.100:5666');assert.equal(a.secure,false);const secure=fnosIdentity(identity({host:'nas.example.test',origin:'https://nas.example.test'}),c);assert.equal(secure.secure,true);assert.notEqual(a.cookie,secure.cookie);for(const headers of [{origin:'http://192.168.1.100:1234'},{host:'192.168.1.100.evil.test'},{'x-trim-userid':'01000'},{'x-trim-userid':'1000,1000'},{'x-trim-userid':'1001'},{'x-trim-username':'bad\nname'}])assert.throws(()=>fnosIdentity(identity(headers),c));const duplicate=identity();duplicate.raw.rawHeaders.push('X-Trim-Userid','1000');assert.throws(()=>fnosIdentity(duplicate,c));});
test('session migration retains old Tailscale identity and provider members stay distinct',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const old=new DatabaseSync(path.join(dir,'gateway.sqlite'));old.exec('CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL,login TEXT NOT NULL,channel TEXT NOT NULL,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);CREATE TABLE company_members(login TEXT PRIMARY KEY,label TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL);');old.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(digest('old-token'),'old-session','907609732','ui','csrf',Date.now()+60000);old.prepare('INSERT INTO company_members VALUES(?,?,?,?)').run('907609732','old label',1,2);old.close();const store=createGatewayStore(dir);try{assert.equal(store.session('old-token').actor_id,'tailscale:907609732');store.observeIdentity({id:'fnos:nas1:1000',provider:'fnos',login:'907609732',label:'907609732'});store.observeIdentity({id:'fnos:nas1:1000',provider:'fnos',login:'renamed',label:'renamed'});const members=readCompanyMembers(dir);assert.deepEqual(members.map(m=>m.id),['tailscale:907609732','fnos:nas1:1000']);assert.equal(members[0].label,'old label');assert.equal(members[1].label,'renamed');assert.throws(()=>createGatewayStore(dir),{code:'GATEWAY_STORE_BUSY'});}finally{store.close();}const reopened=createGatewayStore(dir);reopened.close();});

test('real Unix write CSRF, provider cookies and genuine TCP spoof boundary',{skip:process.platform==='win32'},async t=>{
  const {g,dir}=await gateway(t);await g.start();const socketPath=path.join(dir,'app.sock');const session=await unix(socketPath);const cookie=session.headers['set-cookie'][0].split(';')[0];
  const write=headers=>new Promise((resolve,reject)=>{const req=http.request({socketPath,path:prefix+'/test-write',method:'POST',headers:{host:'192.168.1.100','x-trim-userid':'1000','x-trim-username':'907609732',cookie,...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(await write({}),403);assert.equal(await write({origin:'http://192.168.1.100:5666','x-workbench-csrf':session.json().csrfToken}),200);assert.equal(await write({origin:'http://192.168.1.100:5667','x-workbench-csrf':session.json().csrfToken}),403);
  const tcp=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:g.app.server.address().port,path:'/api/workbench/v1/session',headers:{host:'erp.example.test','tailscale-user-login':'907609732','x-trim-userid':'1000'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject);});assert.equal(tcp,400);
  const tail=await g.app.inject({url:'/api/workbench/v1/session',headers:{host:'erp.example.test','tailscale-user-login':'907609732'}});const tailCookie=tail.headers['set-cookie'].split(';')[0];assert.equal((await unix(socketPath,prefix+'/test-actor',{cookie:tailCookie})).statusCode,401);
  const r=await g.app.inject({url:'/test-actor',headers:{host:'erp.example.test','tailscale-user-login':'907609732',cookie}});assert.equal(r.statusCode,401);
});

test('shutdown leaves a replacement socket path untouched',{skip:process.platform==='win32'},async t=>{const {g,dir}=await gateway(t);await g.start();const file=path.join(dir,'app.sock');fs.unlinkSync(file);fs.writeFileSync(file,'new owner');await g.stop();assert.equal(fs.readFileSync(file,'utf8'),'new owner');});

test('fnOS bind failure preserves TCP backup and one owner',async t=>{const {g,dir}=await gateway(t);if(process.platform!=='win32')fs.writeFileSync(path.join(dir,'app.sock'),'keep');await g.start();assert.equal(g.fnosStatus().state,'degraded');const r=await g.app.inject({url:'/api/workbench/v1/session',headers:{host:'erp.example.test','tailscale-user-login':'backup@example.test'}});assert.equal(r.statusCode,200);assert.throws(()=>createGatewayStore(path.join(dir,'store')),{code:'GATEWAY_STORE_BUSY'});});
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
test('SIGKILL stale owned socket pair restarts and publishes unique readiness inode',{skip:process.platform==='win32'},async t=>{
  const {g,dir}=await gateway(t),publicPath=path.join(dir,'app.sock'),boundPath=path.join(dir,'.erp-11111111-1111-4111-8111-111111111111');
  const source=`const fs=require('node:fs'),net=require('node:net');const [bound,pub]=process.argv.slice(1);const s=net.createServer(c=>c.destroy());s.listen(bound,()=>{fs.chmodSync(bound,0o600);fs.linkSync(bound,pub);fs.writeFileSync(require('node:path').join(require('node:path').dirname(pub),'app.listener'),require('node:path').basename(bound)+'\\n');console.log('ready');});`;
  const child=spawn(process.execPath,['-e',source,boundPath,publicPath],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('socket fixture exited '+code)));});
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  assert.equal(fs.lstatSync(publicPath).isSocket(),true);assert.equal(fs.lstatSync(boundPath).isSocket(),true);
  await g.start();assert.equal(g.fnosStatus().state,'ready');assert.notEqual(g.fnosStatus().boundPath,boundPath);assert.equal(fs.existsSync(boundPath),false);const currentBound=g.fnosStatus().boundPath;
  assert.equal(fs.readFileSync(path.join(dir,'app.listener'),'utf8'),path.basename(currentBound)+'\n');assert.equal(fs.statSync(path.join(dir,'app.listener')).mode&0o777,0o644);
  const a=fs.lstatSync(publicPath),b=fs.lstatSync(currentBound);assert.equal(a.ino,b.ino);assert.equal(a.dev,b.dev);
  assert(fs.readFileSync('/proc/net/unix','utf8').split('\n').some(line=>line.trim().endsWith(' '+currentBound)));
  assert.equal((await unix(publicPath)).statusCode,200);
});
test('active public or private socket is never removed and TCP remains available',{skip:process.platform==='win32'},async t=>{
  for(const name of ['app.sock','.erp-11111111-1111-4111-8111-111111111111'])await t.test(name,async sub=>{
    const {g,dir}=await gateway(sub),file=path.join(dir,name),server=net.createServer(c=>c.destroy());
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
    sub.after(()=>new Promise(resolve=>server.close(resolve)));if(name.startsWith('.erp-'))fs.writeFileSync(path.join(dir,'app.listener'),name+'\n');const inode=fs.lstatSync(file).ino;
    await g.start();assert.equal(g.fnosStatus().state,'degraded');assert.equal(fs.lstatSync(file).ino,inode);assert.equal(server.listening,true);
    assert.equal((await g.app.inject({url:'/api/workbench/v1/session',headers:{host:'erp.example.test','tailscale-user-login':'backup@example.test'}})).statusCode,200);
  });
});

test('old generation shutdown never removes successor publication or unique binding',{skip:process.platform==='win32'},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-generation-')),c=config(dir),app={routing(_req,res){res.end('ok');}},a=createFnosListener(app,c),b=createFnosListener(app,c);
 t.after(async()=>{await a.stop();await b.stop();fs.rmSync(dir,{recursive:true,force:true});});
 await a.start();const first=a.status().boundPath;fs.unlinkSync(c.socketPath);
 const blocked=createFnosListener(app,c);await assert.rejects(blocked.start());assert.equal(fs.existsSync(first),true);
 // Simulate a deliberate publication handover after removing A's marker.
 fs.unlinkSync(path.join(dir,'app.listener'));await b.start();const second=b.status().boundPath;assert.notEqual(first,second);
 const pub=fs.statSync(c.socketPath),marker=fs.readFileSync(path.join(dir,'app.listener'),'utf8');await a.stop();
 assert.equal(fs.statSync(second).ino,pub.ino);assert.equal(fs.statSync(c.socketPath).ino,pub.ino);assert.equal(fs.readFileSync(path.join(dir,'app.listener'),'utf8'),marker);assert.equal((await unix(c.socketPath)).statusCode,200);
});
test('invalid or symlink listener markers cannot remove existing publication',{skip:process.platform==='win32'},async t=>{
 for(const variant of ['invalid','symlink'])await t.test(variant,async sub=>{
   const {g,dir}=await gateway(sub),marker=path.join(dir,'app.listener'),sentinel=path.join(dir,'sentinel');fs.writeFileSync(sentinel,'KEEP');
   if(variant==='invalid')fs.writeFileSync(marker,'../sentinel\n');else fs.symlinkSync(sentinel,marker);
   await g.start();assert.equal(g.fnosStatus().state,'degraded');assert.equal(fs.readFileSync(sentinel,'utf8'),'KEEP');assert.equal(fs.lstatSync(marker).isSymbolicLink(),variant==='symlink');
 });
});
test('relay Host aliases are explicit and fix the allowed origin without forwarding-header trust',async t=>{
 const base=config(os.tmpdir());assert.deepEqual(validateFnos(base).hostAliases,{});assert.throws(()=>fnosIdentity(identity({host:'localhost'}),validateFnos(base)),{code:'INVALID_HOST'});
 const c=validateFnos({...base,hostAliases:{localhost:'https://nas.example.test'}});
 const relay=fnosIdentity(identity({host:'localhost'}),c);assert.equal(relay.origin,'https://nas.example.test');assert.equal(relay.secure,true);
 assert.equal(fnosIdentity(identity({host:'localhost',origin:'https://nas.example.test'}),c).id,'fnos:nas1:1000');
 assert.throws(()=>fnosIdentity(identity({host:'localhost',origin:'http://192.168.1.100:5666'}),c),{code:'ORIGIN_DENIED'});
 assert.throws(()=>fnosIdentity(identity({host:'unknown','x-forwarded-host':'localhost','x-forwarded-proto':'https'}),c),{code:'INVALID_HOST'});
 for(const hostAliases of [{localhost:'https://unknown.example.test'},{'*.example.test':'https://nas.example.test'},{'https://localhost':'https://nas.example.test'},{'localhost/path':'https://nas.example.test'},{'user@localhost':'https://nas.example.test'},{'local\nhost':'https://nas.example.test'},[],null])assert.throws(()=>validateFnos({...base,hostAliases}));
 const {g}=await gateway(t,{hostAliases:{localhost:'https://nas.example.test'}});assert.equal((await g.app.inject({url:'/api/workbench/v1/session',headers:{host:'localhost','tailscale-user-login':'person@example.test','x-trim-userid':'1000'}})).statusCode,400);
});
