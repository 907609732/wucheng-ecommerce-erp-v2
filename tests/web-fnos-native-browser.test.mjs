import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {WebSocketServer} from 'ws';
import http from 'node:http';

test('CDP readiness saves the unique loopback browser URL and refuses a different port',async t=>{
 const {probeNativeBrowserReady}=await import('../server/fnos-native/browsers.mjs');let endpoint;
 const server=http.createServer((req,res)=>res.end(JSON.stringify({webSocketDebuggerUrl:endpoint})));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const spec={cdpPort:server.address().port,cdpEndpoint:'http://127.0.0.1:'+server.address().port};endpoint='ws://127.0.0.1:'+spec.cdpPort+'/devtools/browser/01234567-89ab-cdef-0123-456789abcdef';
 assert.equal(await probeNativeBrowserReady('cdp',spec),true);assert.equal(spec.browserWebSocketUrl,endpoint);
 endpoint=endpoint.replace(':'+spec.cdpPort+'/',':1/');assert.equal(await probeNativeBrowserReady('cdp',{...spec}),false);
});

async function closeEndpoint(t,respond){
 const server=new WebSocketServer({host:'127.0.0.1',port:0}),requests=[],commands=[];
 await new Promise(r=>server.once('listening',r));
 t.after(()=>{for(const client of server.clients)client.terminate();return new Promise(r=>server.close(r));});
 server.on('connection',(socket,request)=>{requests.push(request.url);socket.on('message',data=>{const message=JSON.parse(data);commands.push(message);if(message.method!=='Browser.close')socket.send(JSON.stringify({id:message.id,error:{code:-32601,message:'Only Browser.close is supported; page initialization must be skipped'}}));else respond(socket,message);});});
 const cdpPort=server.address().port,browserWebSocketUrl='ws://127.0.0.1:'+cdpPort+'/devtools/browser/01234567-89ab-cdef-0123-456789abcdef';
 return {spec:{cdpPort,browserWebSocketUrl},requests,commands,config:{modules:{sales:{root:path.resolve(import.meta.dirname,'../apps/sales')}}}};
}
test('graceful close sends only Browser.close to the saved socket without initializing stalled pages',async t=>{
 const {closeNativeBrowser}=await import('../server/fnos-native/browsers.mjs');
 const f=await closeEndpoint(t,(s,m)=>s.send(JSON.stringify({id:m.id,result:{}})));
 await closeNativeBrowser(f.config,f.spec);
 assert.deepEqual(f.commands,[{id:1,method:'Browser.close'}]);assert.deepEqual(f.requests,['/devtools/browser/01234567-89ab-cdef-0123-456789abcdef']);
});
test('graceful close allows a loaded browser longer than the former 1.5 second attach cap',async t=>{
 const {closeNativeBrowser}=await import('../server/fnos-native/browsers.mjs');
 const f=await closeEndpoint(t,(s,m)=>{const timer=setTimeout(()=>s.send(JSON.stringify({id:m.id,result:{}})),1800);t.after(()=>clearTimeout(timer));});
 await closeNativeBrowser(f.config,f.spec);assert.equal(f.commands.length,1);
});
test('graceful close refuses foreign endpoints and bounds a silent browser response',async t=>{
 const {closeNativeBrowser}=await import('../server/fnos-native/browsers.mjs'),f=await closeEndpoint(t,()=>{});
 for(const browserWebSocketUrl of [f.spec.browserWebSocketUrl.replace('127.0.0.1','example.com'),f.spec.browserWebSocketUrl.replace(':'+f.spec.cdpPort+'/',':1/'),f.spec.browserWebSocketUrl+'?other=1'])await assert.rejects(closeNativeBrowser(f.config,{...f.spec,browserWebSocketUrl}),/唯一调试地址/);
 assert.equal(f.requests.length,0);await assert.rejects(closeNativeBrowser(f.config,f.spec,{timeoutMs:40}),/timeout|超时/);
 const unrelated=await closeEndpoint(t,s=>s.send(JSON.stringify({id:2,result:{}})));await assert.rejects(closeNativeBrowser(unrelated.config,unrelated.spec,{timeoutMs:40}),/timeout|超时/);
});
test('graceful close reports rejected commands and disconnected sockets instead of success',async t=>{
 const {closeNativeBrowser}=await import('../server/fnos-native/browsers.mjs');
 const rejected=await closeEndpoint(t,(s,m)=>s.send(JSON.stringify({id:m.id,error:{message:'fixture refused'}})));
 await assert.rejects(closeNativeBrowser(rejected.config,rejected.spec),/rejected|拒绝/);
 const disconnected=await closeEndpoint(t,s=>s.terminate());await assert.rejects(closeNativeBrowser(disconnected.config,disconnected.spec),/closed|关闭/);
 for(const body of ['null','[]']){const malformed=await closeEndpoint(t,s=>s.send(body));await assert.rejects(closeNativeBrowser(malformed.config,malformed.spec),/响应无效/);}
});
test('graceful close bounds a stalled handshake and never follows an HTTP redirect',async t=>{
 const {closeNativeBrowser}=await import('../server/fnos-native/browsers.mjs'),target=await closeEndpoint(t,()=>{}),sockets=new Set();let redirect=false;
 const server=http.createServer();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('upgrade',(_request,socket)=>{if(redirect)socket.end('HTTP/1.1 302 Found\r\nLocation: '+target.spec.browserWebSocketUrl+'\r\nConnection: close\r\n\r\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const socket of sockets)socket.destroy();return new Promise(r=>server.close(r));});
 const cdpPort=server.address().port,spec={cdpPort,browserWebSocketUrl:target.spec.browserWebSocketUrl.replace(':'+target.spec.cdpPort+'/',':'+cdpPort+'/')};
 await assert.rejects(closeNativeBrowser({},spec,{timeoutMs:40}),/timeout|超时|timed out/);redirect=true;
 await assert.rejects(closeNativeBrowser({},spec),/302/);assert.equal(target.requests.length,0);
});

test('native VNC readiness sends the Origin required by LibVNCServer',async t=>{
 const {probeNativeBrowserReady}=await import('../server/fnos-native/browsers.mjs');
 assert.equal(typeof probeNativeBrowserReady,'function');let expected,seen;
 const server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient:info=>{seen=info.origin;return info.origin===expected;}});
 await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 expected='http://127.0.0.1:'+server.address().port;
 assert.equal(await probeNativeBrowserReady('vnc',{vncEndpoint:expected}),true);
 assert.equal(seen,expected);
});

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-browser-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const runtimeRoot=path.join(root,'runtime');
 for(const file of ['sysroot/usr/bin/Xvfb','sysroot/usr/bin/x11vnc','sysroot/usr/bin/xauth','chromium/chrome','chromium/libvulkan.so.1','chromium/libvk_swiftshader.so','chromium/vk_swiftshader_icd.json','sysroot/usr/lib/x86_64-linux-gnu/gio/modules/libdconfsettings.so','novnc/vnc.html']){const p=path.join(runtimeRoot,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'fixture');}
 fs.writeFileSync(path.join(runtimeRoot,'chromium/vk_swiftshader_icd.json'),JSON.stringify({ICD:{library_path:'./libvk_swiftshader.so'}}));
 return {native:{dataRoot:path.join(root,'data'),browser:{enabled:true,runtimeRoot,chromiumPath:path.join(runtimeRoot,'chromium/chrome'),novncRoot:path.join(runtimeRoot,'novnc')}},stateDir:path.join(root,'data/state')};
}
function processes({fail}={}){
 const calls=[];let count=100;
 const spawnProcess=(file,args,options)=>{
  const child=new EventEmitter();child.pid=++count;child.exitCode=null;child.signalCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.kill=signal=>{child.signalCode=signal;child.emit('exit',null,signal);return true;};calls.push({file,args,options,child});
  queueMicrotask(()=>{if(args.includes('--version')){child.stdout.emit('data','Chromium 130.0.1.2\n');child.exitCode=0;child.emit('exit',0);}else if(path.basename(file)==='xauth'){child.exitCode=0;child.emit('exit',0);}else if(fail===path.basename(file)){child.exitCode=1;child.emit('exit',1);}});
  return child;
 };return {calls,spawnProcess};
}
test('explicit shared mode aliases module endpoints and owns one physical browser without touching overview profile',async t=>{
 const {createNativeBrowsers,nativeBrowserSpecs}=await import('../server/fnos-native/browsers.mjs'),c=fixture(t),p=processes();c.native.browser.shared=true;
 const old=path.join(c.native.dataRoot,'browser-profiles/overview');fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'Last Version'),'999.0.0.0');fs.writeFileSync(path.join(old,'Cookies'),'OVERVIEW RETAINED');
 const specs=nativeBrowserSpecs(c);assert.equal(specs.sales.physicalId,'sales');assert.equal(specs.overview.physicalId,'sales');assert.equal(specs.overview.cdpEndpoint,specs.sales.cdpEndpoint);assert.equal(specs.overview.vncEndpoint,specs.sales.vncEndpoint);assert.equal(specs.overview.profile,specs.sales.profile);
 const m=createNativeBrowsers(c,{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>m.stop());await m.start();
 assert.equal(p.calls.filter(v=>v.file===c.native.browser.chromiumPath&&!v.args.includes('--version')).length,1);assert.equal(p.calls.filter(v=>path.basename(v.file)==='Xvfb').length,1);assert.equal(p.calls.filter(v=>path.basename(v.file)==='x11vnc').length,1);
 assert.equal(fs.readFileSync(path.join(old,'Cookies'),'utf8'),'OVERVIEW RETAINED');assert.equal(fs.readFileSync(path.join(old,'Last Version'),'utf8'),'999.0.0.0');assert.equal(fs.readdirSync(path.dirname(old)).filter(n=>n.startsWith('overview.retained-')).length,0);
 assert.equal(m.status().browsers.sales.cdpEndpoint,m.status().browsers.overview.cdpEndpoint);p.calls.find(v=>v.args.includes('--remote-debugging-port=19222')).child.kill('SIGTERM');assert.equal(m.status().browsers.sales.ready,false);assert.equal(m.status().browsers.overview.ready,false);
});
test('shared mode retains controlled sales overrides and validates legacy overview configuration',async t=>{
 const {nativeBrowserSpecs}=await import('../server/fnos-native/browsers.mjs'),c=fixture(t);c.native.browser.shared=true;c.native.browser.instances={sales:{cdpPort:23222,vncPort:23322,display:422},overview:{cdpPort:23223,vncPort:23323,display:423}};
 const specs=nativeBrowserSpecs(c);assert.deepEqual([specs.overview.cdpPort,specs.overview.vncPort,specs.overview.display],[23222,23322,422]);
 c.native.browser.instances.overview={host:'foreign'};assert.throws(()=>nativeBrowserSpecs(c),/受控/);c.native.browser.instances.overview={display:0};assert.throws(()=>nativeBrowserSpecs(c),/display/);c.native.browser.instances.overview={};c.native.browser.shared='true';assert.throws(()=>nativeBrowserSpecs(c),/shared|共享/);
});
test('shared collector exports one endpoint and explicit coordination flag',async t=>{
 const {startNativeCollector}=await import('../server/fnos-native/supervisor.mjs'),c=fixture(t),release=path.resolve(import.meta.dirname,'..');c.native.browser.shared=true;c.modules=Object.fromEntries(['sales','overview'].map(id=>[id,{root:path.join(release,'apps',id),dataDir:path.join(c.native.dataRoot,'data',id)}]));
 const keys=['LINGTU_WEB_COLLECTOR','LINGTU_SHARED_BROWSER','LINGTU_SALES_CDP_ENDPOINT','LINGTU_OVERVIEW_CDP_ENDPOINT'],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let helper;
 try{helper=await startNativeCollector(c);assert.equal(process.env.LINGTU_SHARED_BROWSER,'1');assert.equal(process.env.LINGTU_SALES_CDP_ENDPOINT,process.env.LINGTU_OVERVIEW_CDP_ENDPOINT);}finally{await helper?.stop();for(const k of keys)if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
});
test('native browser manager owns two private loopback profiles and stops only its children',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs');const config=fixture(t),p=processes();
 const manager=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>manager.stop());
 await manager.start();const state=manager.status();assert.equal(state.ready,true);assert.equal(state.browsers.sales.cdpEndpoint,'http://127.0.0.1:19222');assert.equal(state.browsers.overview.cdpEndpoint,'http://127.0.0.1:19223');assert.equal(state.browsers.sales.login,'unknown');
 const chrome=p.calls.filter(c=>c.file===config.native.browser.chromiumPath&&!c.args.includes('--version'));assert.equal(chrome.length,2);
 assert.notEqual(chrome[0].options.env.DISPLAY,chrome[1].options.env.DISPLAY);
 for(const c of chrome)assert(c.options.env.LD_LIBRARY_PATH.includes(path.join(config.native.browser.runtimeRoot,'sysroot/usr/lib/x86_64-linux-gnu/pulseaudio')),'libpulsecommon RUNPATH must resolve from private payload');
 for(const c of chrome){assert(c.args.includes('--remote-debugging-address=127.0.0.1'));assert(!c.args.includes('--no-sandbox'));assert(c.args.some(a=>a.startsWith('--user-data-dir='+path.join(config.native.dataRoot,'browser-profiles'))));assert(c.options.env.LD_LIBRARY_PATH.includes('sysroot'));assert(c.options.env.XAUTHORITY);assert.equal(c.options.env.LIBGL_DRIVERS_PATH,path.join(config.native.browser.runtimeRoot,'sysroot/usr/lib/x86_64-linux-gnu/dri'));assert.equal(c.options.env.__EGL_VENDOR_LIBRARY_DIRS,path.join(config.native.browser.runtimeRoot,'sysroot/usr/share/glvnd/egl_vendor.d'));}
 for(const c of p.calls.filter(c=>path.basename(c.file)==='Xvfb')){assert(c.args.includes('-auth'));assert(c.args.includes('-nolisten'));assert(!c.args.includes('-ac'));}
 for(const c of p.calls.filter(c=>path.basename(c.file)==='x11vnc')){assert(c.args.includes('127.0.0.1'));assert(c.args.includes('-no6'));assert(c.args.includes('-rfbport'));for(const disabled of ['-nosel','-noprimary','-nosetprimary','-nosetclipboard'])assert(!c.args.includes(disabled),'authenticated clipboard must remain usable inside private Xvfb');}
 await manager.stop();assert.equal(manager.status().ready,false);assert(p.calls.every(c=>c.child.exitCode!==null||c.child.signalCode!==null));
});

test('native browser launch overrides inherited host GIO, Vulkan and VA discovery with the private payload',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),config=fixture(t),p=processes();
 const poisoned={GIO_MODULE_DIR:'/host/gio',GIO_EXTRA_MODULES:'/host/extra-gio',VK_DRIVER_FILES:'/host/driver.json',VK_ICD_FILENAMES:'/host/old-driver.json',VK_ADD_DRIVER_FILES:'/host/add-driver.json',VK_LAYER_PATH:'/host/layers',VK_IMPLICIT_LAYER_PATH:'/host/implicit',VK_ADD_LAYER_PATH:'/host/add-layers',VK_ADD_IMPLICIT_LAYER_PATH:'/host/add-implicit',VK_INSTANCE_LAYERS:'host-layer',VK_LOADER_LAYERS_ENABLE:'host-layer',VK_LOADER_LAYERS_ALLOW:'host-layer',LIBVA_DRIVERS_PATH:'/host/dri',LIBVA_DRIVER_NAME:'host-driver'};
 const previous=Object.fromEntries(Object.keys(poisoned).map(key=>[key,process.env[key]]));Object.assign(process.env,poisoned);
 const manager=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true});
 try{
  await manager.start();const runtime=config.native.browser.runtimeRoot,sysroot=path.join(runtime,'sysroot');
  for(const {options:{env}} of p.calls){
   assert.ok(env.LD_LIBRARY_PATH.endsWith(':'+path.join(runtime,'chromium')),'private Vulkan loader follows sysroot Mesa but precedes default host search');
   assert.equal(env.GIO_MODULE_DIR,path.join(sysroot,'usr/lib/x86_64-linux-gnu/gio/modules'));
   assert.equal(env.GIO_EXTRA_MODULES,undefined);assert.equal(env.GIO_USE_VFS,'local');
   assert.equal(env.VK_DRIVER_FILES,path.join(runtime,'chromium/vk_swiftshader_icd.json'));assert.equal(env.VK_ICD_FILENAMES,env.VK_DRIVER_FILES);
   for(const key of ['VK_ADD_DRIVER_FILES','VK_ADD_LAYER_PATH','VK_ADD_IMPLICIT_LAYER_PATH','VK_INSTANCE_LAYERS','VK_LOADER_LAYERS_ENABLE','VK_LOADER_LAYERS_ALLOW','LIBVA_DRIVER_NAME'])assert.equal(env[key],undefined,key);
   assert.equal(env.VK_LAYER_PATH,env.VK_IMPLICIT_LAYER_PATH);assert.ok(env.VK_LAYER_PATH.startsWith(config.stateDir+path.sep));assert.deepEqual(fs.readdirSync(env.VK_LAYER_PATH),[]);
   assert.equal(env.LIBVA_DRIVERS_PATH,path.join(sysroot,'usr/lib/x86_64-linux-gnu/dri'));
  }
 }finally{await manager.stop();for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
test('native browser refuses a SwiftShader manifest pointing outside its Chromium payload',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),config=fixture(t),p=processes();
 fs.writeFileSync(path.join(config.native.browser.runtimeRoot,'chromium/vk_swiftshader_icd.json'),JSON.stringify({ICD:{library_path:'/host/libvulkan.so'}}));
 const manager=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>manager.stop());
 await assert.rejects(manager.start(),/SwiftShader/);assert.equal(p.calls.length,0);
});

test('native stop closes owned Chromium before terminating its storage children and X display',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs');const config=fixture(t),p=processes(),events=[];
 const manager=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true,gracefulClose:async spec=>{
  assert(p.calls.filter(c=>path.basename(c.file)==='Xvfb').every(c=>c.child.signalCode===null),'keep X displays alive while browsers flush');
  events.push('close:'+spec.id);const c=p.calls.find(c=>c.args.includes('--remote-debugging-port='+spec.cdpPort));setTimeout(()=>{assert(p.calls.filter(c=>path.basename(c.file)==='Xvfb').every(c=>c.child.signalCode===null),'a close ACK is not process exit; keep X alive until storage flush finishes');c.child.exitCode=0;c.child.emit('exit',0);},40);
 }});t.after(()=>manager.stop());await manager.start();
 for(const c of p.calls){const kill=c.child.kill;c.child.kill=signal=>{events.push('kill:'+path.basename(c.file));return kill(signal);};}
 await manager.stop();assert.deepEqual(events.slice(0,2).sort(),['close:overview','close:sales']);assert.equal(manager.status().ready,false);assert(p.calls.every(c=>c.child.exitCode!==null||c.child.signalCode!==null));
});

test('stop skips exited Chrome even when its old port has been claimed by a foreign service',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),config=fixture(t),p=processes(),closed=[];let requests=0;
 const foreign=http.createServer((req,res)=>{requests++;res.end('{}');});await new Promise(r=>foreign.listen(0,'127.0.0.1',r));const port=foreign.address().port;await new Promise(r=>foreign.close(r));
 config.native.browser.instances={sales:{cdpPort:port}};
 const manager=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true,gracefulClose:async spec=>{closed.push(spec.id);const c=p.calls.find(c=>c.args.includes('--remote-debugging-port='+spec.cdpPort));c.child.exitCode=0;c.child.emit('exit',0);}});t.after(()=>manager.stop());await manager.start();
 p.calls.find(c=>c.args.includes('--remote-debugging-port='+port)).child.kill('SIGTERM');await new Promise(r=>foreign.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>foreign.close(r)));
 await manager.stop();assert.deepEqual(closed,['overview']);assert.equal(requests,0);assert.equal(foreign.listening,true);
});
test('failed readiness cleans partial children and never reports a logged-out browser as a process failure',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs');const p=processes(),m=createNativeBrowsers(fixture(t),{spawnProcess:p.spawnProcess,probe:async()=>false,readinessTimeoutMs:15});
 await assert.rejects(m.start(),/就绪|readiness/);assert.equal(m.status().state,'failed');assert(p.calls.every(c=>c.child.exitCode!==null||c.child.signalCode!==null));
});
test('older Chromium retains imported profile archive and opens a clean need-login profile',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs');const config=fixture(t),profile=path.join(config.native.dataRoot,'browser-profiles/sales');fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'Last Version'),'150.0.0.1');fs.writeFileSync(path.join(profile,'Cookies'),'RETAIN');const p=processes(),m=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>m.stop());await m.start();const s=m.status().browsers.sales;assert.equal(s.login,'need-login');assert.equal(fs.readFileSync(path.join(s.retainedProfile,'Cookies'),'utf8'),'RETAIN');assert.equal(fs.existsSync(path.join(profile,'Cookies')),false);
});
test('profile downgrade protection compares full Chromium versions, including same-major patches',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),config=fixture(t),profile=path.join(config.native.dataRoot,'browser-profiles/sales');fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'Last Version'),'130.0.1.3');fs.writeFileSync(path.join(profile,'Cookies'),'RETAIN PATCH');const p=processes(),m=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>m.stop());await m.start();const s=m.status().browsers.sales;assert.equal(s.login,'need-login');assert.equal(fs.readFileSync(path.join(s.retainedProfile,'Cookies'),'utf8'),'RETAIN PATCH');
});
test('trusted fixture ports propagate and invalid or colliding browser targets fail closed',async t=>{
 const {nativeBrowserSpecs}=await import('../server/fnos-native/browsers.mjs');const c=fixture(t);c.native.browser.instances={sales:{cdpPort:20222,vncPort:20322,display:222},overview:{cdpPort:20223,vncPort:20323,display:223}};assert.equal(nativeBrowserSpecs(c).sales.cdpEndpoint,'http://127.0.0.1:20222');
 for(const patch of [{vncPort:80},{display:0},{cdpPort:20223},{host:'evil.test'}]){c.native.browser.instances.sales={cdpPort:20222,vncPort:20322,display:222,...patch};assert.throws(()=>nativeBrowserSpecs(c));}
});
test('trial prefix selects its own fixed browser ports and display while primary defaults stay stable',async t=>{
 const {nativeBrowserSpecs}=await import('../server/fnos-native/browsers.mjs');const c=fixture(t),main=nativeBrowserSpecs(c);assert.deepEqual([main.sales.cdpPort,main.sales.vncPort,main.sales.display,main.overview.cdpPort,main.overview.vncPort,main.overview.display],[19222,19322,122,19223,19323,123]);
 c.fnos={enabled:true,basePrefix:'/app/wuchengerptrial'};const trial=nativeBrowserSpecs(c);assert.deepEqual([trial.sales.cdpPort,trial.sales.vncPort,trial.sales.display,trial.overview.cdpPort,trial.overview.vncPort,trial.overview.display],[31222,31322,322,31223,31323,323]);
});
test('browser manager can restart after stopping and refuses a crashed x11vnc',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),p=processes(),m=createNativeBrowsers(fixture(t),{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>m.stop());await m.start();await m.stop();await m.start();assert.equal(m.status().ready,true);
 const q=processes({fail:'x11vnc'}),bad=createNativeBrowsers(fixture(t),{spawnProcess:q.spawnProcess,probe:async()=>true,readinessTimeoutMs:20});await assert.rejects(bad.start(),/未就绪/);assert.equal(bad.status().state,'failed');
});
test('process readiness drops immediately when a browser exits, independently from login',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),c=fixture(t),p=processes(),m=createNativeBrowsers(c,{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>m.stop());await m.start();p.calls.find(call=>call.file===c.native.browser.chromiumPath&&call.args.some(arg=>arg.includes('--remote-debugging-port=19222'))).child.kill('SIGTERM');const s=m.status();assert.equal(s.ready,false);assert.equal(s.state,'degraded');assert.equal(s.browsers.sales.ready,false);assert.equal(s.browsers.overview.ready,true);
});
test('trusted selected CDP ports reach the actual native collector adapter environment',async t=>{
 const {startNativeCollector}=await import('../server/fnos-native/supervisor.mjs'),{collectorConnection}=await import('../server/collector-browser-connection.mjs'),c=fixture(t),release=path.resolve(import.meta.dirname,'..');
 c.native.browser.instances={sales:{cdpPort:21222,vncPort:21322,display:322},overview:{cdpPort:21223,vncPort:21323,display:323}};c.modules=Object.fromEntries(['sales','overview'].map(id=>[id,{root:path.join(release,'apps',id),dataDir:path.join(c.native.dataRoot,'data',id)}]));
 const keys=['LINGTU_WEB_COLLECTOR','LINGTU_SALES_CDP_ENDPOINT','LINGTU_OVERVIEW_CDP_ENDPOINT'],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let collector;
 try{collector=await startNativeCollector(c);assert.equal(process.env.LINGTU_SALES_CDP_ENDPOINT,'http://127.0.0.1:21222');assert.equal(process.env.LINGTU_OVERVIEW_CDP_ENDPOINT,'http://127.0.0.1:21223');assert(collectorConnection('sales',{platform:'linux'}).args.includes('http://127.0.0.1:21222'));}
 finally{await collector?.stop();for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});
test('cancelling startup stops owned acquisitions before another browser launch',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),p=processes(),controller=new AbortController(),m=createNativeBrowsers(fixture(t),{spawnProcess:p.spawnProcess,probe:async()=>false,readinessTimeoutMs:500,signal:controller.signal}),started=m.start();setTimeout(()=>controller.abort(Error('fixture cancel')),30);const now=Date.now();await assert.rejects(started,/fixture cancel/);assert(Date.now()-now<250);assert(p.calls.every(c=>!c.args.some(a=>a.startsWith('--remote-debugging-port='))));assert(p.calls.every(c=>c.child.exitCode!==null||c.child.signalCode!==null));
});

test('official VAR contains browser launch files while persistent profiles remain in DATA',async t=>{
 const {createNativeBrowsers}=await import('../server/fnos-native/browsers.mjs'),config=fixture(t),p=processes();
 config.native.runtimeDir=path.join(path.dirname(config.native.dataRoot),'official-var/runtime');
 const manager=createNativeBrowsers(config,{spawnProcess:p.spawnProcess,probe:async()=>true});t.after(()=>manager.stop());await manager.start();
 for(const call of p.calls.filter(c=>c.args.some(a=>a.startsWith('--user-data-dir=')))){assert.ok(call.options.env.XDG_RUNTIME_DIR.startsWith(config.native.runtimeDir+path.sep));assert.ok(call.args.includes('--user-data-dir='+path.join(config.native.dataRoot,'browser-profiles',call.args.find(a=>a.startsWith('--user-data-dir=')).endsWith('sales')?'sales':'overview')));}
 assert.equal(fs.existsSync(path.join(config.stateDir,'native-browser')),false);await manager.stop();
});
