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

test('graceful close uses the saved unique browser socket and disconnects on bounded command failure',async()=>{
 const {closeNativeBrowser}=await import('../server/fnos-native/browsers.mjs');const endpoint='ws://127.0.0.1:19222/devtools/browser/01234567-89ab-cdef-0123-456789abcdef';let connected,command,closed=0;
 const connect=async (url,options)=>{connected=url;assert.equal(options.noDefaults,true);return {newBrowserCDPSession:async()=>({send:async name=>{command=name;}}),close:async()=>{closed++;}};};
 await closeNativeBrowser({}, {cdpPort:19222,browserWebSocketUrl:endpoint},{connect});assert.equal(connected,endpoint);assert.equal(command,'Browser.close');assert.equal(closed,1);
 await assert.rejects(closeNativeBrowser({}, {cdpPort:19222,browserWebSocketUrl:endpoint},{timeoutMs:20,connect:async()=>({newBrowserCDPSession:async()=>({send:()=>new Promise(()=>{})}),close:async()=>{closed++;}})}),/timeout|超时/);assert.equal(closed,2);
 const completed=await Promise.race([closeNativeBrowser({}, {cdpPort:19222,browserWebSocketUrl:endpoint},{connect:async()=>({newBrowserCDPSession:async()=>({send:async()=>{}}),close:()=>new Promise(()=>{})})}).then(()=>true),new Promise(r=>setTimeout(()=>r(false),300))]);assert.equal(completed,true,'disconnect handshake must not block owned-process cleanup');
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
  events.push('close:'+spec.id);const c=p.calls.find(c=>c.args.includes('--remote-debugging-port='+spec.cdpPort));c.child.exitCode=0;c.child.emit('exit',0);
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
