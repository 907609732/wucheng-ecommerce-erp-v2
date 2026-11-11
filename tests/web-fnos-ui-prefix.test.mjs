import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
for(const module of ['purchase','sales','overview'])test(`${module} binds public URLs to signed prefix only`,async t=>{
 const {installWorkbenchModule}=await import(`../apps/${module}/lib/workbench-module.mjs`),{signWorkbenchActor}=await import(`../apps/${module}/lib/workbench-actor.mjs`);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prefix-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let middleware;const object=()=>Object.fromEntries(['get','post','put','patch','delete','head','options'].map(k=>[k,()=>{}]));const app={...object(),use(fn){middleware=fn;}},router=object();
 const service=installWorkbenchModule(app,router,{module,dataDir:dir,root:dir,state:{}});
 for(const prefix of ['', '/app/wuchengerp','/app/wuchengerptrial','/evil','/app/wuchengerpevil','/app/wuchengerptrials','/app/wuchengerp/../evil','/app/wuchengerptrial/../evil']){
 const now=Date.now(),actor={v:1,id:'fnos:nas:1000',login:'user',role:'admin',modules:[module],module,canRunTasks:false,channel:'ui',sessionId:'one',requestId:'request',issuedAt:now,expiresAt:now+30000,method:'GET',path:'/',publicPrefix:prefix};
 let result;const q={headers:{host:'127.0.0.1:1234',...signWorkbenchActor(actor,service.key),'x-workbench-prefix':'/evil'},socket:{remoteAddress:'127.0.0.1'},method:'GET',originalUrl:'/',path:'/'};
 const r={set(){},json(v){result=v;},sendFile(){},status(){return this;}};
 middleware(q,r,()=>r.json({legacy:'http://127.0.0.1:17890',download:'/api/download/file',asset:'/asset.png',ready:prefix+'/apps/'+module+'/',sources:{purchase:{url:'http://127.0.0.1:17868'},sales:{url:'http://127.0.0.1:17870'}}}));
 if(!['','/app/wuchengerp','/app/wuchengerptrial'].includes(prefix)){assert.equal(result.code,'WORKBENCH_AUTH');continue;}
 assert.equal(result.legacy,prefix+'/apps/overview/');assert.equal(result.download,prefix+'/apps/'+module+'/api/download/file');assert.equal(result.asset,prefix+'/apps/'+module+'/asset.png');assert.equal(result.sources.purchase.url,prefix+'/apps/purchase/');assert.equal(result.sources.sales.url,prefix+'/apps/sales/');assert.equal(result.ready,prefix+'/apps/'+module+'/');
 }
});
for(const module of ['purchase','sales','overview'])for(const prefix of ['','/app/wuchengerp','/app/wuchengerptrial'])test(`${module} browser transport retains ${prefix||'root'} for CSRF and cross module links`,async()=>{
 const calls=[];class Element {setAttribute(){}};class Node extends Element{};
 const context={location:{pathname:prefix+'/apps/'+module+'/'},window:{fetch:async(url,init)=>{calls.push({url,init});return{ok:true,json:async()=>({csrfToken:'token'})};},open:url=>url},Element,HTMLImageElement:Node,HTMLScriptElement:Node,HTMLLinkElement:Node,HTMLAnchorElement:Node,HTMLFormElement:Node,HTMLIFrameElement:Node,MutationObserver:class{observe(){}},document:{documentElement:{},addEventListener(){}},Request,Headers,crypto};
 vm.runInNewContext(fs.readFileSync('apps/'+module+'/public/workbench-base.js','utf8'),context);
 assert.ok(context.window.workbenchTransport);const transport=context.window.workbenchTransport;
 assert.equal(transport.resolve('/apps/purchase/'),prefix+'/apps/purchase/');assert.equal(transport.resolve('/api/workbench/v1/session'),prefix+'/api/workbench/v1/session');if(prefix)assert.equal(transport.resolve(prefix+'/apps/'+module+'/'),prefix+'/apps/'+module+'/');
 await context.window.fetch('/api/orders',{method:'POST'});assert.equal(calls[0].url,prefix+'/api/workbench/v1/session');assert.equal(calls[1].url,prefix+'/apps/'+module+'/api/orders');assert.equal(calls[1].init.headers.get('X-Workbench-CSRF'),'token');
});
for(const prefix of ['','/app/wuchengerp','/app/wuchengerptrial'])test(`shell session, hosting and navigation stay under ${prefix||'root'}`,async()=>{
 const nodes=new Map(),calls=[];const node=()=>({hidden:false,classList:{toggle(){},add(){}},addEventListener(){},setAttribute(k,v){this[k]=v;},getAttribute(k){return this[k];}});const get=k=>{if(!nodes.has(k))nodes.set(k,node());return nodes.get(k);};
 const context={URL,document:{currentScript:{src:'https://nas.example'+prefix+'/web/shell.js'},hidden:false,querySelector:get,querySelectorAll:()=>[],addEventListener(){}},location:{hash:'#freight'},window:{addEventListener(){}},fetch:async url=>{calls.push(url);return{ok:true,json:async()=>url.endsWith('/session')?{actor:{login:'user',label:'飞牛用户'}}:{enabled:false}};},setTimeout:()=>1,clearTimeout(){},AbortController};
 vm.runInNewContext(fs.readFileSync('server/public/shell.js','utf8'),context);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls[0],prefix+'/api/workbench/v1/session');assert.ok(calls.includes(prefix+'/api/workbench/v1/data-versions/summary'));assert.equal(nodes.get('#workspace').src,prefix+'/apps/sales/?workspace=freight#freight?section=center');
});
for(const prefix of ['','/app/wuchengerp','/app/wuchengerptrial'])test(`data versions requests retain ${prefix||'root'}`,async()=>{
 const requests=[],nodes=new Map();const get=key=>{if(!nodes.has(key))nodes.set(key,{classList:{toggle(){},remove(){}},addEventListener(){}});return nodes.get(key);};
 const source=fs.readFileSync('server/public/data-versions.js','utf8').replace(/^export /gm,'');
 vm.runInNewContext(source,{location:{pathname:prefix+'/web/data-versions.html'},document:{hidden:false,querySelector:get,addEventListener(){}},window:{addEventListener(){}},URLSearchParams,AbortController,setTimeout:()=>1,clearTimeout(){},fetch:async url=>{requests.push(url);return{ok:true,json:async()=>url.includes('/summary')?{enabled:false}:{items:[],total:0}};}});
 await new Promise(resolve=>setImmediate(resolve));assert.ok(requests.length);assert.ok(requests.every(url=>url.startsWith(prefix+'/api/workbench/v1/data-versions')));
});

for(const prefix of ['','/app/wuchengerp','/app/wuchengerptrial'])test(`native browser session and websocket retain ${prefix||'root'}`,async()=>{
 const calls=[],nodes=new Map(),get=key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);};
 vm.runInNewContext(fs.readFileSync('server/public/native-browser.js','utf8'),{URL,URLSearchParams,document:{currentScript:{src:'https://nas.example'+prefix+'/web/native-browser.js'},querySelector:get,querySelectorAll:()=>[]},location:{search:'?module=overview',origin:'https://nas.example',hostname:'nas.example',port:'',protocol:'https:'},fetch:async url=>{calls.push(url);return{ok:true,json:async()=>({})};}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls[0],prefix+'/api/workbench/v1/session');
 const target=new URL(nodes.get('#browser-view').src);assert.equal(target.pathname,prefix+'/web/novnc/vnc.html');assert.equal(target.searchParams.get('path'),(prefix+'/api/workbench/v1/native-browser/overview/websockify').replace(/^\//,''));
});

