import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {createWorkbenchGateway} from '../server/gateway/gateway.mjs';
const api='/api/workbench/v1',prefix='/app/wuchengerp';
const tail={host:'erp.example.test','tailscale-user-login':'a@example.test'},fn={host:'nas.example.test','x-trim-userid':'1000','x-trim-username':'person'};
async function setup(t,{enabled=true,tcpEnabled=true,novncHtml='UPSTREAM noVNC'}={}){
 const {registerNativeBrowserRoutes}=await import('../server/fnos-native/browser-routes.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'browser-auth-'));fs.chmodSync(dir,0o700);
 const root=path.join(dir,'novnc');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'vnc.html'),novncHtml);fs.mkdirSync(path.join(root,'core'));fs.writeFileSync(path.join(root,'core/rfb.js'),'upstream module');
 const seen=[],upstreams=[];for(const id of ['sales','overview']){const server=http.createServer(),wss=new WebSocketServer({server});wss.on('connection',(ws,req)=>{ws.on('error',()=>{});seen.push({id,url:req.url,headers:req.headers});ws.on('message',(data,binary)=>ws.send(data,{binary}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));upstreams.push({server,wss});}
 const config={native:{dataRoot:dir,browser:{enabled,novncRoot:root,instances:{sales:{cdpPort:20222,vncPort:upstreams[0].server.address().port,display:222},overview:{cdpPort:20223,vncPort:upstreams[1].server.address().port,display:223}}}}};
 const gateway=await createWorkbenchGateway({services:{config:()=>({}),capabilities:async()=>null},storeDir:path.join(dir,'gateway'),publicOrigin:'https://erp.example.test',port:0,tcpEnabled,nativeBrowserEnabled:enabled,fnos:{enabled:true,instanceId:'auth',socketPath:path.join(dir,'app.sock'),basePrefix:prefix,allowedOrigins:['https://nas.example.test'],allowedUids:['1000']},registerRoutes:async(app,context)=>registerNativeBrowserRoutes(app,context,config)});
 await gateway.start();
 t.after(async()=>{await gateway.stop();for(const {server,wss} of upstreams){for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}fs.rmSync(dir,{recursive:true,force:true});});
 const port=gateway.app.server.address()?.port||0;
 return {gateway,seen,dir,port};
}
function get(port,headers,url=api+'/session',socketPath){return new Promise((resolve,reject)=>{http.get({...socketPath?{socketPath}:{host:'127.0.0.1',port},path:(socketPath?prefix:'')+url,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers,cookie:res.headers['set-cookie']?.[0].split(';')[0]}));}).on('error',reject);});}
function rawUpgrade(port,headers,url){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:url,headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==','sec-websocket-version':'13',...headers}});req.on('upgrade',(_res,socket)=>{socket.destroy();resolve(101);});req.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',error=>error.code==='ECONNRESET'?resolve(0):reject(error));req.setTimeout(3000,()=>req.destroy(Error('raw upgrade timeout '+url)));req.end();});}
function wsConnect(port,headers,url=api+'/native-browser/sales/websockify',socketPath){return new Promise((resolve,reject)=>{
 const ws=new WebSocket('ws://127.0.0.1:'+port+(socketPath?prefix:'')+url,['binary'],{headers,...socketPath?{createConnection:()=>net.createConnection(socketPath)}:{}});
 const timer=setTimeout(()=>{ws.terminate();reject(Error('upgrade timed out '+url+' '+JSON.stringify(headers)));},3000);
 ws.on('unexpected-response',(_req,res)=>{clearTimeout(timer);res.resume();resolve({status:res.statusCode});});ws.on('error',error=>{clearTimeout(timer);reject(Object.assign(error,{message:error.message+' '+url+' '+JSON.stringify(headers)}));});
 ws.on('open',()=>{ws.send(Buffer.from([0,1,2,255]));});ws.on('message',(data,binary)=>{clearTimeout(timer);ws.close();resolve({status:101,data:Buffer.from(data),binary});});
});}
test('real TCP upgrade requires bound session, single Origin and fixed registered path',async t=>{
 const {port,seen}=await setup(t),s=await get(port,tail),auth={...tail,cookie:s.cookie,origin:'https://erp.example.test'};
 assert.equal((await wsConnect(port,{...tail,origin:auth.origin})).status,401);
 for(const [patch,status] of [[{origin:'https://evil.test'},403],[{origin:''},403],[{origin:['https://erp.example.test','https://erp.example.test']},403],[{'x-trim-userid':'1000'},400],[{'x-workbench-prefix':prefix},400],[{'tailscale-user-login':'other@example.test'},401],[{'x-forwarded-host':'nas.example.test',origin:'https://nas.example.test'},403]])assert.equal((await wsConnect(port,{...auth,...patch})).status,status);
 for(const suffix of ['?target=ws://evil.test','/extra','/../../overview/websockify','/%2e%2e/overview/websockify'])assert.notEqual(await rawUpgrade(port,auth,api+'/native-browser/sales/websockify'+suffix),101);
 assert.equal(seen.length,0);const r=await wsConnect(port,auth);assert.equal(r.status,101);assert.deepEqual(r.data,Buffer.from([0,1,2,255]));assert.equal(r.binary,true);assert.equal(seen.length,1);assert.equal(seen[0].id,'sales');assert.equal(seen[0].url,'/websockify');assert.equal(seen[0].headers.cookie,undefined);assert.equal(seen[0].headers['tailscale-user-login'],undefined);
 assert.equal((await wsConnect(port,auth,api+'/native-browser/overview/websockify')).status,101);assert.equal(seen[1].id,'overview');assert.notEqual(await rawUpgrade(port,auth,api+'/native-browser/other/websockify'),101);assert.equal(seen.length,2);
});
test('real Unix upgrade carries private fnOS context once and cannot reuse Tailscale cookie',{skip:process.platform==='win32'},async t=>{
 const {port,dir,seen}=await setup(t),socketPath=path.join(dir,'app.sock'),s=await get(port,fn,api+'/session',socketPath),auth={...fn,cookie:s.cookie,origin:'https://nas.example.test'};
 assert.equal(s.status,200);const r=await wsConnect(port,auth,undefined,socketPath);assert.equal(r.status,101);assert.equal(seen[0].url,'/websockify');
 const tailSession=await get(port,tail);for(const [patch,status] of [[{cookie:tailSession.cookie},401],[{cookie:''},401],[{'x-trim-userid':'1001'},403],[{origin:'https://erp.example.test'},403],[{host:'evil.test'},421],[{'x-workbench-api-base':'/fake'},400]])assert.equal((await wsConnect(port,{...auth,...patch},undefined,socketPath)).status,status);
 const page=await get(port,auth,'/web/native-browser.html',socketPath);assert.equal(page.status,200);assert.match(page.body,/\/app\/wuchengerp\/web\/native-browser.js/);assert.equal((await get(port,auth,'/web/novnc/vnc.html',socketPath)).body,'UPSTREAM noVNC');
 assert.equal(seen.length,1);
});
test('real Unix-only listener upgrades and shuts down authenticated browsers without opening TCP',{skip:process.platform==='win32'},async t=>{
 const {port,dir,gateway}=await setup(t,{tcpEnabled:false}),socketPath=path.join(dir,'app.sock');assert.equal(port,0);const s=await get(0,fn,api+'/session',socketPath);assert.equal((await wsConnect(0,{...fn,cookie:s.cookie,origin:'https://nas.example.test'},undefined,socketPath)).status,101);await gateway.stop();assert.equal(gateway.app.server.listening,false);
});
test('native browser disabled exposes no login page, assets, upgrade endpoint or feature flag',async t=>{
 const {port}=await setup(t,{enabled:false}),s=await get(port,tail),auth={...tail,cookie:s.cookie,origin:'https://erp.example.test'};assert.equal(JSON.parse(s.body).nativeBrowser,undefined);for(const url of ['/web/native-browser.html','/web/novnc/vnc.html',api+'/native-browser/sales/websockify'])assert.equal((await get(port,auth,url)).status,404);
});
test('chooser and unmodified upstream noVNC assets require session and preserve public prefix',async t=>{
 const {port}=await setup(t);assert.equal((await get(port,tail,'/web/native-browser.html')).status,401);const s=await get(port,tail),h={...tail,cookie:s.cookie};
 const page=await get(port,h,'/web/native-browser.html?module=sales');assert.equal(page.status,200);assert.match(page.body,/native-browser.js/);assert.equal((await get(port,h,'/web/novnc/vnc.html')).body,'UPSTREAM noVNC');assert.notEqual((await get(port,h,'/web/novnc/%2e%2e/package.json')).status,200);assert.equal((await get(port,h,'/web/novnc/core/rfb.js')).body,'upstream module');
});
test('browser chooser opens upstream vnc.html with the actual public entry and only selected module path',async()=>{
 const view={},message={},links=['sales','overview'].map(id=>({dataset:{module:id},setAttribute(name,value){this[name]=value;}})),calls=[];
 vm.runInNewContext(fs.readFileSync(new URL('../server/public/native-browser.js',import.meta.url),'utf8'),{URL,URLSearchParams,document:{currentScript:{src:'https://nas.example.test/app/wuchengerp/web/native-browser.js'},querySelector:s=>s==='#browser-view'?view:message,querySelectorAll:()=>links},location:{search:'?module=overview',origin:'https://nas.example.test',hostname:'nas.example.test',port:'',protocol:'https:'},fetch:async url=>{calls.push(url);return {ok:true,json:async()=>({actor:{}})};}});
 await new Promise(resolve=>setImmediate(resolve));const target=new URL(view.src);assert.equal(target.pathname,prefix+'/web/novnc/vnc.html');assert.equal(target.searchParams.get('path'),'app/wuchengerp'+api+'/native-browser/overview/websockify');assert.equal(target.searchParams.get('encrypt'),'true');assert.equal(target.searchParams.get('host'),'nas.example.test');assert.equal(calls[0],prefix+api+'/session');assert.equal(links[1]['aria-current'],'page');assert.equal(view.hidden,false);
});
test('CSP authorizes the exact noVNC v1.6.0 inline bootstrap only on upstream vnc.html',async t=>{
 const upstream=fs.readFileSync(new URL('./fixtures/novnc-v1.6.0-vnc.html',import.meta.url),'utf8'),bootstrap=upstream.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g,'\n');
 assert.match(bootstrap,/import UI from "\.\/app\/ui.js"/);assert.match(bootstrap,/UI\.start\(/);
 const hash="'sha256-"+createHash('sha256').update(bootstrap).digest('base64')+"'";
 assert.equal(hash,"'sha256-/9PPJp0RDtPobChVxkPiMU+aOqJaic/KxxORSdYVFHE='");
 const {port}=await setup(t,{novncHtml:upstream}),s=await get(port,tail),h={...tail,cookie:s.cookie},page=await get(port,h,'/web/novnc/vnc.html');
 assert.equal(page.status,200);assert.equal(page.body,upstream,'upstream HTML remains unchanged');
 const sources=response=>response.headers['content-security-policy'].match(/(?:^|;)\s*script-src\s+([^;]+)/)[1].trim().split(/\s+/);
 assert.deepEqual(sources(page),["'self'",hash]);
 const changed="'sha256-"+createHash('sha256').update(bootstrap.replace('UI.start','unexpected.start')).digest('base64')+"'";assert(!sources(page).includes(changed),'a modified bootstrap is not authorized');
 for(const url of ['/web/native-browser.html','/web/native-browser.js','/web/novnc/core/rfb.js'])assert.deepEqual(sources(await get(port,h,url)),["'self'"],url+' must not inherit inline authorization');
 assert.equal((await get(port,tail,'/web/novnc/vnc.html')).status,401);
});
