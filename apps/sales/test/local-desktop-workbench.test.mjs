import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {installWorkbenchModule as sales} from '../lib/workbench-module.mjs';
import {installWorkbenchModule as overview} from '../../overview/lib/workbench-module.mjs';
import {createApp as createOverview} from '../../overview/server.mjs';
import {signWorkbenchActor} from '../lib/workbench-actor.mjs';

for(const [module,install] of [['sales',sales],['overview',overview]])test(module+' signed local desktop boundary',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'local-ui-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'public'));fs.writeFileSync(path.join(root,'public/index.html'),'<head></head><script src="/app.js"></script>');
 fs.writeFileSync(path.join(root,'workbench-manifest.json'),JSON.stringify({operations:[{method:'GET',path:'/api/bootstrap',remote:true},{method:'POST',path:'/api/save',remote:true}]}));
 let middleware;const object=()=>Object.fromEntries(['get','post','put','patch','delete','head','options'].map(m=>[m,()=>{}]));
 const app=object(),router=object();app.use=fn=>{middleware=fn;};
 const service=install(app,router,{module,root,dataDir:root,state:{}});
 app.get('/api/bootstrap',()=>{});app.post('/api/save',()=>{});app.post('/api/restore',()=>{});router.post('/workbench/migration/prepare',()=>{});
 function request(url='/api/bootstrap',claims={},headers={},method='GET'){
  const now=Date.now(),actor={v:1,id:'windows:test-user',login:'test-user',role:'editor',channel:'ui',modules:[module],module,canRunTasks:true,sessionId:'session',requestId:'request',issuedAt:now,expiresAt:now+30000,method,path:url,localDesktop:true,uiOrigin:'http://127.0.0.1:19999',...claims};
  const q={method,path:url,originalUrl:url,headers:{host:'127.0.0.1:19999',...signWorkbenchActor(actor,service.key),...headers},socket:{remoteAddress:'127.0.0.1',localPort:19999}};
  const r={statusCode:200,set(){},status(n){this.statusCode=n;return this;},json(v){this.value=v;return this;},once(_event,fn){this.finish=fn;},sendFile(file,options){this.html=fs.readFileSync(options?.root?path.join(options.root,file):file,'utf8');return this;},type(){return this;},send(html){this.html=html;return this;}};
  middleware(q,r,()=>{r.next=true;});return {q,r};
 }
 const local=request();assert.equal(local.r.next,true);local.r.json({url:'/api/freight/records',token:'secret',dataDir:'secret'});assert.deepEqual(local.r.value,{url:'/api/freight/records'});
 const sources=request();sources.r.json({sources:{sales:{url:'http://127.0.0.1:17870'},purchase:{url:'http://127.0.0.1:17868'}},filePath:'secret',link:'http://localhost:17890/api/overview?month=2026-09'});assert.deepEqual(sources.r.value,{sources:{sales:{target:{module:'sales'}},purchase:{target:{module:'purchase'}}},link:{module:'overview'}});
 const page=request('/');assert.match(page.r.html,/src="\/app.js"/);assert.doesNotMatch(page.r.html,/workbench-base/);
 const remote=request('/',{localDesktop:false});assert.match(remote.r.html,new RegExp('/apps/'+module+'/workbench-base'));
 for(const claims of [{channel:'mcp'},{id:'member:test'},{uiOrigin:'http://127.0.0.1:19998'}])assert.equal(request('/api/bootstrap',claims).r.statusCode,403);
 for(const origin of ['null','http://evil.test','http://127.0.0.1:19998'])assert.equal(request('/api/bootstrap',{}, {origin}).r.statusCode,403);
 assert.equal(request('/api/bootstrap',{}, {host:'127.0.0.1:19998'}).r.statusCode,403);
 assert.equal(request('/api/bootstrap',{}, {'x-workbench-actor-signature':'0'.repeat(64)}).r.statusCode,401);
 for(const url of ['/api/restore','/api/integration/v1/workbench/migration/prepare'])assert.equal(request(url,{}, {},'POST').r.statusCode,403);
 const audit=[];service.onAudit=entry=>audit.push(entry);const saved=request('/api/save',{}, {origin:'http://127.0.0.1:19999'},'POST');assert.equal(saved.r.next,true);saved.r.finish();assert.equal(audit[0].actor.id,'windows:test-user');assert.equal(audit[0].actor.requestId,'request');
});

function readHttp(origin,route,headers={}){
 const target=new URL(origin);
 // Preserve the literal request path so the traversal assertions reach Express.
 return new Promise((resolve,reject)=>{const request=http.get({hostname:target.hostname,port:target.port,path:route,headers},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text}));});request.on('error',reject);});
}
function desktopHeaders(module,origin,route,key){
 const now=Date.now();return signWorkbenchActor({v:1,id:'windows:fixture-user',login:'fixture-user',role:'editor',channel:'ui',modules:[module],module,canRunTasks:true,sessionId:'source-http',requestId:'source-request',issuedAt:now,expiresAt:now+30000,method:'GET',path:route,localDesktop:true,uiOrigin:origin},key);
}

for(const [module,install]of [['sales',sales],['overview',overview]])test(module+' signed HTML works under a hidden source ancestor without exposing hidden files',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-source-http-')),root=path.join(temp,'.codex','source'),publicRoot=path.join(root,'public');
 fs.mkdirSync(path.join(publicRoot,'.private'),{recursive:true});
 fs.writeFileSync(path.join(publicRoot,'index.html'),'<head></head><main>source-business-page</main><script src="/app.js"></script>');
 fs.writeFileSync(path.join(publicRoot,'.env'),'hidden-file-marker');fs.writeFileSync(path.join(publicRoot,'.private','secret.html'),'hidden-page-marker');fs.writeFileSync(path.join(root,'outside.html'),'outside-public-marker');
 const app=express(),router=express.Router(),service=install(app,router,{module,root,dataDir:path.join(temp,'data'),state:{}});
 app.use(express.static(publicRoot));app.use((error,_q,r,_next)=>r.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const route of ['/','/index.html']){const response=await readHttp(origin,route,desktopHeaders(module,origin,route,service.key));assert.equal(response.status,200);assert.match(response.text,/source-business-page/);assert.doesNotMatch(response.text,/workbench-base/);}
 const remoteHeaders=desktopHeaders(module,origin,'/',service.key),remoteActor=JSON.parse(Buffer.from(remoteHeaders['x-workbench-actor'],'base64url').toString('utf8'));
 const remote=await readHttp(origin,'/',signWorkbenchActor({...remoteActor,localDesktop:false},service.key));assert.equal(remote.status,200);assert.match(remote.text,new RegExp('/apps/'+module+'/workbench-base'));
 for(const route of ['/.env','/.private/secret.html','/../outside.html','/%2e%2e/outside.html','/%2e%2e%2foutside.html']){const response=await readHttp(origin,route,desktopHeaders(module,origin,route,service.key));assert.ok([403,404].includes(response.status),route+' must remain blocked');assert.doesNotMatch(response.text,/hidden-file-marker|hidden-page-marker|outside-public-marker/);}
});

test('actual overview serves signed vendor assets with rooted paths',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'overview-vendor-http-'));
 const {app,store,cainiao,integration}=createOverview({dataDir:temp,sources:{purchase:path.join(temp,'no-purchase.sqlite'),sales:path.join(temp,'no-sales.sqlite')}}),server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await cainiao.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temp,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const route of ['/vendor/chart.js','/vendor/tabulator.js','/vendor/tabulator.css']){const response=await readHttp(origin,route,desktopHeaders('overview',origin,route,integration.workbench.key));assert.equal(response.status,200,route);assert.ok(response.text.length>1000,route+' must return the actual asset');assert.match(response.headers['content-type'],route.endsWith('.css')?/text\/css/:/javascript/);}
 for(const route of ['/vendor/../package.json','/vendor/%2e%2e/package.json','/vendor/.env']){const response=await readHttp(origin,route,desktopHeaders('overview',origin,route,integration.workbench.key));assert.ok([403,404].includes(response.status),route+' must remain blocked');}
});
