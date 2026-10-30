import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installWorkbenchModule as sales} from '../lib/workbench-module.mjs';
import {installWorkbenchModule as overview} from '../../overview/lib/workbench-module.mjs';
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
  const r={statusCode:200,set(){},status(n){this.statusCode=n;return this;},json(v){this.value=v;return this;},once(_event,fn){this.finish=fn;},sendFile(file){this.html=fs.readFileSync(file,'utf8');return this;},type(){return this;},send(html){this.html=html;return this;}};
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
