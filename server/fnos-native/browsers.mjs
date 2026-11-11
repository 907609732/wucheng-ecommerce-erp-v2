import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {ensureNativeRuntimeDirectory} from '../config.mjs';

const ids=['sales','overview'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const versionParts=value=>String(value).match(/\d+(?:\.\d+){1,3}/)?.[0].split('.').map(Number);
const newer=(left,right)=>{for(let i=0;i<4;i++){if((left[i]||0)!==(right[i]||0))return (left[i]||0)>(right[i]||0);}return false;};
export function nativeBrowserSpecs(config){
 const browser=config.native?.browser;if(!browser?.enabled)return {};
 const result={},ports=new Set(),displays=new Set();
 if(browser.instances&&Object.keys(browser.instances).some(id=>!ids.includes(id)))throw Error('原生浏览器目标未登记');
 for(const [index,id] of ids.entries()){
  const custom=browser.instances?.[id]||{};
  if(Object.keys(custom).some(k=>!['cdpPort','vncPort','display'].includes(k)))throw Error('浏览器仅允许受控端口和 display 配置');
  const trial=config.fnos?.basePrefix==='/app/wuchengerptrial',cdpPort=custom.cdpPort??(trial?31222:19222)+index,vncPort=custom.vncPort??(trial?31322:19322)+index,display=custom.display??(trial?322:122)+index;
  for(const port of [cdpPort,vncPort]){if(!Number.isInteger(port)||port<1024||port>65535||ports.has(port))throw Error('原生浏览器端口无效或冲突');ports.add(port);}
  if(!Number.isInteger(display)||display<100||display>999||displays.has(display))throw Error('原生浏览器 display 无效或冲突');displays.add(display);
  result[id]={id,display,cdpPort,vncPort,cdpEndpoint:'http://127.0.0.1:'+cdpPort,vncEndpoint:'http://127.0.0.1:'+vncPort,profile:path.join(config.native.dataRoot,'browser-profiles',id)};
 }
 return result;
}
function privateDir(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink())throw Error('浏览器私有目录不能是链接');fs.chmodSync(dir,0o700);}
async function available(port){
 const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},resolve);});await new Promise(resolve=>server.close(resolve));
}
function validBrowserSocket(value,port){
 try{const u=new URL(value);return u.protocol==='ws:'&&u.hostname==='127.0.0.1'&&Number(u.port)===port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/devtools\/browser\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(u.pathname);}catch{return false;}
}
export async function closeNativeBrowser(config,spec,{timeoutMs=10000}={}){
 if(!validBrowserSocket(spec.browserWebSocketUrl,spec.cdpPort))throw Error('缺少本代 Chromium 唯一调试地址，拒绝按端口重新发现');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('Chromium 关闭等待时间必须有界');
 // Browser.close is a browser-level CDP command. Attaching Playwright first
 // initializes every page and can stall before sending it on a loaded NAS.
 // Use the existing ws transport and saved generation UUID; never rediscover
 // by port or follow a redirect to an unrelated browser.
 await new Promise((resolve,reject)=>{
  const socket=new WebSocket(spec.browserWebSocketUrl,{handshakeTimeout:timeoutMs,maxPayload:65536,followRedirects:false,perMessageDeflate:false});let settled=false;
  const timer=setTimeout(()=>finish(Error('Chromium graceful close timeout')),timeoutMs);
  function finish(error){if(settled)return;settled=true;clearTimeout(timer);socket.terminate();error?reject(error):resolve();}
  socket.once('open',()=>socket.send(JSON.stringify({id:1,method:'Browser.close'}),error=>{if(error)finish(error);}));
  socket.on('message',data=>{let response;try{response=JSON.parse(data.toString());if(!response||typeof response!=='object'||Array.isArray(response))throw Error();}catch{finish(Error('Chromium 关闭响应无效'));return;}if(response.id===1)finish(response.error||!response.result||typeof response.result!=='object'||Array.isArray(response.result)?Error('Chromium graceful close rejected'):undefined);});
  socket.once('error',finish);socket.once('close',()=>finish(Error('Chromium closed before close acknowledgement')));
 });
}
export async function probeNativeBrowserReady(kind,spec){
 try{
  if(kind==='display')return fs.existsSync('/tmp/.X11-unix/X'+spec.display);
  if(kind==='cdp'){const response=await fetch(spec.cdpEndpoint+'/json/version',{signal:AbortSignal.timeout(1000)});const body=await response.json();if(!response.ok||!validBrowserSocket(body.webSocketDebuggerUrl,spec.cdpPort))return false;spec.browserWebSocketUrl=body.webSocketDebuggerUrl;return true;}
  // LibVNCServer requires Origin even for trusted loopback health checks. Node's
  // built-in browser-shaped WebSocket omits it; use the existing mature client.
  return await new Promise(resolve=>{const ws=new WebSocket(spec.vncEndpoint.replace('http:','ws:')+'/websockify',['binary'],{origin:spec.vncEndpoint});const timer=setTimeout(()=>{ws.close();resolve(false);},1000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true);};ws.onerror=()=>{clearTimeout(timer);resolve(false);};});
 }catch{return false;}
}
export function createNativeBrowsers(config,{logger,spawnProcess=spawn,probe=probeNativeBrowserReady,readinessTimeoutMs=20000,signal,gracefulClose}={}){
 const browser=config.native?.browser,specs=nativeBrowserSpecs(config),children=[],states={},owned={};
 let state='stopped',failure=null,starting,stopping,runDir,controller,startSignal;
 const checkCancellation=()=>startSignal?.throwIfAborted();
 const live=child=>child.exitCode===null&&child.signalCode===null&&!child.nativeExited;
 const closeBrowser=gracefulClose||(spawnProcess===spawn?spec=>closeNativeBrowser(config,spec):null);
 function groupMembers(child){
  if(spawnProcess!==spawn||process.platform!=='linux'||!child.nativeLong||!child.pid||!runDir)return [];
  const members=[];
  for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)))try{
   const file='/proc/'+name+'/stat',stat=fs.statSync(file),text=fs.readFileSync(file,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');
   // Detached children create a private session and group. The per-launch
   // runtime directory is an additional generation witness after leader exit.
   if(Number(fields[2])!==child.pid||Number(fields[3])!==child.pid||stat.uid!==process.getuid())continue;
   if(!fs.readFileSync('/proc/'+name+'/environ','utf8').split('\0').includes('XDG_RUNTIME_DIR='+runDir))continue;
   members.push({pid:Number(name),start:fields[19],uid:stat.uid});
  }catch{}
  return members;
 }
 function killOwnedMember(member,signal){try{
  const file='/proc/'+member.pid+'/stat',s=fs.readFileSync(file,'utf8'),fields=s.slice(s.lastIndexOf(')')+2).split(' ');
  if(fields[19]===member.start&&fs.statSync(file).uid===member.uid)process.kill(member.pid,signal);
 }catch{}}
 function stillOwnedChrome(child){
  if(!live(child)||!child.nativeBrowserSpec)return false;
  if(spawnProcess!==spawn)return true;
  try{return fs.realpathSync('/proc/'+child.pid+'/exe')===fs.realpathSync(browser.chromiumPath)&&groupMembers(child).some(m=>m.pid===child.pid&&m.start===child.nativeBrowserOwner?.start&&m.uid===child.nativeBrowserOwner.uid);}catch{return false;}
 }
 function launch(file,args,env,{short=false}={}){
  checkCancellation();
  const child=spawnProcess(file,args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:!short&&process.platform!=='win32'});children.push(child);
  child.nativeOutput='';child.nativeError=null;
  for(const stream of [child.stdout,child.stderr])stream?.on('data',chunk=>{child.nativeOutput=(child.nativeOutput+chunk).slice(-8192);});
  child.on('error',error=>{child.nativeError=error;child.nativeExited=true;});child.on('exit',()=>{child.nativeExited=true;});
  return child;
 }
 async function run(file,args,env){
  const child=launch(file,args,env,{short:true}),until=Date.now()+5000;
  while(live(child)&&Date.now()<until){checkCancellation();await sleep(10);}
  if(live(child)){child.kill('SIGKILL');throw Error(path.basename(file)+' 执行超时');}
  if(child.nativeError||child.exitCode!==0)throw Error(path.basename(file)+' 执行失败：'+(child.nativeError?.message||child.nativeOutput));
  return child.nativeOutput;
 }
 async function wait(kind,spec,child){
  const until=Date.now()+readinessTimeoutMs;
  do{
   checkCancellation();
   if(!live(child))throw Error(path.basename(kind==='cdp'?browser.chromiumPath:kind==='vnc'?'x11vnc':'Xvfb')+' 未就绪：'+(child.nativeError?.message||child.nativeOutput||'进程退出')+(kind==='cdp'?'；请核对 namespace sandbox 支持，禁止关闭 sandbox 绕过':''));
   const ready=await probe(kind,spec);checkCancellation();if(ready&&live(child))return;
   if(!live(child))throw Error(spec.id+' 浏览器 '+kind+' 未就绪：进程退出 '+child.nativeOutput);
   await sleep(25);
  }while(Date.now()<until);
  throw Error(spec.id+' 浏览器 '+kind+' readiness 就绪超时：'+(child.nativeError?.message||child.nativeOutput||'无子进程输出'));
 }
 async function stopChildren(){
  // Ask the owned browser to flush persistent cookies/storage before killing
  // renderer/network children or Xvfb. Only ready, still-owned leaders qualify.
  const chromes=children.filter(stillOwnedChrome);
  if(closeBrowser){
   await Promise.all(chromes.map(async child=>{try{await closeBrowser(child.nativeBrowserSpec);}catch(error){logger?.warn?.('Chromium 正常关闭失败，将仅清理本代自有进程：'+error.message);}}));
   const flushUntil=Date.now()+3000;while(chromes.some(live)&&Date.now()<flushUntil)await sleep(25);
  }
  for(const child of [...children].reverse()){
   const members=groupMembers(child);for(const member of members)killOwnedMember(member,'SIGTERM');
   if(live(child))child.kill('SIGTERM');
  }
  const pending=()=>children.some(live)||children.some(child=>groupMembers(child).length);
  const until=Date.now()+3000;while(pending()&&Date.now()<until)await sleep(50);
  for(const child of [...children].reverse()){
   for(const member of groupMembers(child))killOwnedMember(member,'SIGKILL');
   if(live(child))child.kill('SIGKILL');
  }
  const deadline=Date.now()+1000;while(pending()&&Date.now()<deadline)await sleep(50);
  if(pending())throw Error('自有浏览器进程未能停止');
  if(runDir)fs.rmSync(runDir,{recursive:true,force:true});
 }
 const status=()=>{
  const failed=state==='running'&&children.some(c=>c.nativeLong&&!live(c));
  const browsers=structuredClone(states);for(const [id,value] of Object.entries(browsers))value.ready=state==='running'&&owned[id]?.every(live)===true;
  return {enabled:!!browser?.enabled,state:failed?'degraded':state,ready:state==='running'&&!failed,error:failure,browsers};
 };
 return {status,
  async start(){
   if(starting)return starting;if(state==='running')return status();
   starting=(async()=>{
    if(!browser?.enabled){state='disabled';return status();}
    state='starting';failure=null;children.length=0;for(const id of Object.keys(states))delete states[id];controller=new AbortController();startSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try{
     checkCancellation();
     ensureNativeRuntimeDirectory(config);
     for(const name of ['runtimeRoot','chromiumPath','novncRoot'])if(!path.isAbsolute(browser[name]||''))throw Error('原生浏览器缺少绝对路径 '+name);
     const sysroot=path.join(browser.runtimeRoot,'sysroot'),bin=path.join(sysroot,'usr/bin'),chromiumDir=path.dirname(browser.chromiumPath),vulkanIcd=path.join(chromiumDir,'vk_swiftshader_icd.json'),gioModules=path.join(sysroot,'usr/lib/x86_64-linux-gnu/gio/modules');
     for(const file of [browser.chromiumPath,...['Xvfb','x11vnc','xauth'].map(n=>path.join(bin,n)),path.join(browser.novncRoot,'vnc.html'),...['libvulkan.so.1','libvk_swiftshader.so','vk_swiftshader_icd.json'].map(n=>path.join(chromiumDir,n)),path.join(gioModules,'libdconfsettings.so')])if(!fs.statSync(file).isFile())throw Error('原生浏览器缺少运行文件 '+file);
     const icdLibrary=JSON.parse(fs.readFileSync(vulkanIcd,'utf8')).ICD?.library_path;
     if(typeof icdLibrary!=='string'||path.resolve(chromiumDir,icdLibrary)!==path.join(chromiumDir,'libvk_swiftshader.so'))throw Error('SwiftShader ICD 必须指向同包私有库');
     for(const s of Object.values(specs)){await available(s.cdpPort);await available(s.vncPort);if(fs.existsSync('/tmp/.X'+s.display+'-lock')||fs.existsSync('/tmp/.X11-unix/X'+s.display))throw Error('原生 display 已占用，拒绝接管');}
     const launchRoot=path.join(config.native.runtimeDir||config.stateDir,'native-browser');
     privateDir(path.join(config.native.dataRoot,'browser-profiles'));privateDir(launchRoot);
     runDir=path.join(launchRoot,randomUUID());privateDir(runDir);
     const vulkanLayers=path.join(runDir,'vulkan-layers');privateDir(vulkanLayers);
     const fontConfig=path.join(runDir,'fonts.conf');fs.writeFileSync(fontConfig,'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>'+xml(path.join(sysroot,'usr/share/fonts'))+'</dir><cachedir>'+xml(path.join(runDir,'font-cache'))+'</cachedir><include ignore_missing="yes">'+xml(path.join(sysroot,'etc/fonts/conf.d'))+'</include></fontconfig>',{mode:0o600});
     const baseEnv={...process.env,LD_LIBRARY_PATH:[...['usr/lib/x86_64-linux-gnu/pulseaudio','lib/x86_64-linux-gnu/pulseaudio','usr/lib/x86_64-linux-gnu','lib/x86_64-linux-gnu','usr/lib','lib'].map(p=>path.join(sysroot,p)),chromiumDir].join(':'),XKB_CONFIG_ROOT:path.join(sysroot,'usr/share/X11/xkb'),FONTCONFIG_FILE:fontConfig,FONTCONFIG_PATH:path.join(sysroot,'etc/fonts'),LIBGL_DRIVERS_PATH:path.join(sysroot,'usr/lib/x86_64-linux-gnu/dri'),__EGL_VENDOR_LIBRARY_DIRS:path.join(sysroot,'usr/share/glvnd/egl_vendor.d'),XDG_RUNTIME_DIR:runDir,GIO_MODULE_DIR:gioModules,GIO_USE_VFS:'local',VK_DRIVER_FILES:vulkanIcd,VK_ICD_FILENAMES:vulkanIcd,VK_LAYER_PATH:vulkanLayers,VK_IMPLICIT_LAYER_PATH:vulkanLayers,LIBVA_DRIVERS_PATH:path.join(sysroot,'usr/lib/x86_64-linux-gnu/dri')};
     // Optional modules are discovered independently of ELF DT_NEEDED. Keep
     // inherited desktop/plugin overrides from reopening host search paths.
     for(const key of ['GIO_EXTRA_MODULES','VK_ADD_DRIVER_FILES','VK_ADD_LAYER_PATH','VK_ADD_IMPLICIT_LAYER_PATH','VK_INSTANCE_LAYERS','VK_LOADER_LAYERS_ENABLE','VK_LOADER_LAYERS_ALLOW','LIBVA_DRIVER_NAME'])delete baseEnv[key];
     const version=versionParts(await run(browser.chromiumPath,['--version'],baseEnv));if(!version)throw Error('无法确认 Chromium 版本');
     for(const s of Object.values(specs)){
      let retainedProfile=null,login='unknown';
      if(fs.existsSync(s.profile)){
       if(fs.lstatSync(s.profile).isSymbolicLink())throw Error('浏览器 profile 不能是链接');
       const last=path.join(s.profile,'Last Version');if(fs.existsSync(last)){const previous=versionParts(fs.readFileSync(last,'utf8'));if(!previous)throw Error(s.id+' profile 版本无法确认，拒绝原地修改');if(newer(previous,version)){retainedProfile=s.profile+'.retained-'+randomUUID();fs.renameSync(s.profile,retainedProfile);login='need-login';logger?.warn?.(s.id+' 原 profile 来自更新 Chromium，已保留完整归档，请重新登录');}}
      }
      privateDir(s.profile);const auth=path.join(runDir,s.id+'.Xauthority');fs.writeFileSync(auth,'',{mode:0o600});
      const env={...baseEnv,DISPLAY:':'+s.display,XAUTHORITY:auth};await run(path.join(bin,'xauth'),['-f',auth,'add',env.DISPLAY,'.',randomBytes(16).toString('hex')],env);
      const xvfb=launch(path.join(bin,'Xvfb'),[env.DISPLAY,'-screen','0','1440x900x24','-nolisten','tcp','-auth',auth,'-noreset','-xkbdir',env.XKB_CONFIG_ROOT,'-fp',path.join(sysroot,'usr/share/fonts/X11/misc')],env);xvfb.nativeLong=true;await wait('display',s,xvfb);
      const chrome=launch(browser.chromiumPath,['--user-data-dir='+s.profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+s.cdpPort,'--no-first-run','--no-default-browser-check','--password-store=basic','--disable-dev-shm-usage','--window-size=1440,900','https://b.cainiao.com/cf_seller/workbench'],env);chrome.nativeLong=true;await wait('cdp',s,chrome);
      chrome.nativeBrowserSpec={...s};
      if(spawnProcess===spawn){chrome.nativeBrowserOwner=groupMembers(chrome).find(m=>m.pid===chrome.pid);if(!chrome.nativeBrowserOwner||!stillOwnedChrome(chrome))throw Error('无法确认本代 Chromium 进程身份');}
      const vnc=launch(path.join(bin,'x11vnc'),['-display',env.DISPLAY,'-auth',auth,'-listen','127.0.0.1','-localhost','-no6','-rfbport',String(s.vncPort),'-forever','-shared','-nopw','-noxdamage','-norc'],env);vnc.nativeLong=true;await wait('vnc',s,vnc);
      owned[s.id]=[xvfb,chrome,vnc];states[s.id]={cdpEndpoint:s.cdpEndpoint,display:s.display,login,retainedProfile,ready:true};
     }
     state='running';return status();
    }catch(error){failure=error.message;state='failed';await stopChildren();throw error;}
   })();try{return await starting;}finally{starting=null;}
  },
  async stop(){if(stopping)return stopping;if(starting)controller?.abort(Error('原生浏览器启动已取消'));stopping=(async()=>{await starting?.catch(()=>{});await stopChildren();if(state!=='failed')state='stopped';for(const s of Object.values(states))s.ready=false;})();try{await stopping;}finally{stopping=null;}}
 };
}
