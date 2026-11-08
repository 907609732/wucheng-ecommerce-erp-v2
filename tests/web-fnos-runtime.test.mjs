import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {developmentConfig} from '../server/config.mjs';
import {createWebRuntime} from '../server/runtime.mjs';
async function availablePorts(){for(let p=40500;p<45000;p+=5){const sockets=[];try{for(let n=0;n<5;n++){const s=net.createServer();sockets.push(s);await new Promise((resolve,reject)=>s.once('error',reject).listen(p+n,'127.0.0.1',resolve));}return p;}catch{}finally{await Promise.all(sockets.map(s=>new Promise(r=>s.close(r))));}}throw Error('ports unavailable');}
function unix(socketPath,url){return new Promise((resolve,reject)=>{http.get({socketPath,path:url,headers:{host:'192.168.1.100','x-trim-userid':'1000','x-trim-username':'907609732'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({statusCode:res.statusCode,headers:res.headers,body}));}).on('error',reject);});}
test('real Unix fnOS shell permits same-origin desktop iframe while TCP shell keeps original CSP',{skip:process.platform==='win32'},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-ui-')),config=developmentConfig({stateDir:path.join(dir,'state'),port:await availablePorts()});
  config.fnos={enabled:true,instanceId:'nas1',socketPath:path.join(dir,'app.sock'),basePrefix:'/app/wuchengerp',allowedOrigins:['http://192.168.1.100:5666'],allowedUids:['1000']};
  const runtime=await createWebRuntime(config,{watch:false,superviseMs:3000});
  t.after(async()=>{await runtime.stop();fs.rmSync(dir,{recursive:true,force:true});});await runtime.start();
  const fn=await unix(config.fnos.socketPath,'/app/wuchengerp/');assert.equal(fn.statusCode,200);assert.match(fn.headers['content-security-policy'],/frame-ancestors 'self'/);assert.match(fn.body,/\/app\/wuchengerp\/web\/shell\.js/);
  const tail=await runtime.gateway.app.inject({url:'/',headers:{host:new URL(config.publicOrigin).host}});assert.equal(tail.statusCode,200);assert.match(tail.headers['content-security-policy'],/frame-ancestors 'none'/);assert.doesNotMatch(tail.body,/\/app\/wuchengerp\/web\/shell\.js/);
});
