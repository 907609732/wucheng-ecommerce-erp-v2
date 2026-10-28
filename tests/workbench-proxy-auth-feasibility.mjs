import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {_electron as electron} from 'playwright';

const hostname='proxy-auth-fixture.test-tail.ts.net',authority=hostname+':8443',origin='https://'+authority;
const reportFile=path.resolve('dist/module-verification/workbench-proxy-auth-feasibility-44.4.5.json');
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('Electron authenticated CONNECT shares only the dedicated Session across main fetch, native view, XHR and download',{timeout:180000},async t=>{
  const created=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-auth-proxy-')),dir=fs.realpathSync.native(created),profile=path.join(dir,'profile');
  const user='workbench',password=randomBytes(24).toString('hex'),realm='LingtuTailnet/'+randomBytes(16).toString('hex'),authorization='Basic '+Buffer.from(user+':'+password).toString('base64'),cookie=randomBytes(24).toString('hex'),downloadBytes=Buffer.from('synthetic authenticated CONNECT download\r\n');
  const sockets=new Set(),proxyEvents=[],originEvents=[],strategies=[];let desktop,proxy,target,phase='setup',closed=false;
  const cleanup=async()=>{
    if(closed)return;closed=true;
    if(desktop){let timer;try{await Promise.race([desktop.close(),new Promise((_r,j)=>{timer=setTimeout(()=>j(Error('owned fixture close timeout')),10000);})]);}catch{const child=desktop.process();if(child.exitCode===null)child.kill();}finally{clearTimeout(timer);}}
    for(const socket of sockets)socket.destroy();
    for(const server of [proxy,target])if(server)await new Promise(r=>{server.closeAllConnections?.();server.close(r);});
    assert(path.basename(dir).startsWith('workbench-auth-proxy-'));assert.equal(fs.realpathSync.native(dir),dir);fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  };
  t.after(cleanup);
  const key=path.join(dir,'fixture.key'),cert=path.join(dir,'fixture.crt'),openssl=process.env.OPENSSL_PATH||'C:/Program Files/Git/usr/bin/openssl.exe';
  assert.equal(spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN='+hostname,'-days','1','-addext','subjectAltName=DNS:'+hostname],{windowsHide:true,stdio:'ignore'}).status,0);
  target=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(q,s)=>{
    const url=new URL(q.url,origin),hasCookie=String(q.headers.cookie||'').split(/;\s*/).includes('__Host-proxy-fixture='+cookie),leaked=!!q.headers['proxy-authorization'];
    originEvents.push({path:url.pathname,phase,hasCookie,proxyCredentialHeaderPresent:leaked});
    if(url.pathname==='/api/workbench/v1/health'){s.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});s.end(JSON.stringify({ok:true,service:'wucheng-workbench',protocolVersion:1}));return;}
    if(url.pathname==='/session'){s.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':'__Host-proxy-fixture='+cookie+'; Path=/; HttpOnly; Secure; SameSite=Strict'});s.end(JSON.stringify({ok:true,hasCookie,proxyCredentialHeaderPresent:leaked}));return;}
    if(!hasCookie){s.writeHead(401,{'Content-Type':'application/json'});s.end(JSON.stringify({ok:false,hasCookie:false}));return;}
    if(url.pathname==='/page'){s.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'"});s.end('<!doctype html><title>Isolated authenticated proxy</title><h1 id="ready">Authenticated private view</h1><a id="download" href="/download">Download fixture</a>');return;}
    if(url.pathname==='/download'){s.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="proxy-fixture.txt"','Content-Length':downloadBytes.length});s.end(downloadBytes);return;}
    s.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});s.end(JSON.stringify({ok:true,hasCookie,proxyCredentialHeaderPresent:leaked}));
  });
  target.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((r,j)=>{target.once('error',j);target.listen(0,'127.0.0.1',r);});
  proxy=http.createServer((_q,s)=>{s.writeHead(403);s.end('CONNECT-only fixture');});
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  proxy.on('connect',(q,client,head)=>{
    const auth=q.headers['proxy-authorization'],valid=auth===authorization,allowed=q.url===authority;
    proxyEvents.push({phase,allowedTarget:allowed,authentication:!auth?'missing':valid?'valid':'bad'});
    if(!allowed){client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    if(!valid){client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="'+realm+'"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    const upstream=net.connect(target.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
    sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
  });
  await new Promise((r,j)=>{proxy.once('error',j);proxy.listen(0,'127.0.0.1',r);});
  const proxyPort=proxy.address().port;
  async function rawProbe(auth,targetAuthority=authority){
    return new Promise((resolve,reject)=>{const c=net.connect(proxyPort,'127.0.0.1',()=>c.write('CONNECT '+targetAuthority+' HTTP/1.1\r\nHost: '+targetAuthority+'\r\n'+(auth?'Proxy-Authorization: '+auth+'\r\n':'')+'\r\n'));let text='';c.setTimeout(3000,()=>{c.destroy();reject(Error('raw probe timeout'));});c.on('error',reject);c.on('data',b=>{text+=b.toString();if(text.includes('\r\n')){const status=Number(text.split(' ')[1]);c.destroy();resolve(status);}});});
  }
  assert.equal(await rawProbe(),407);assert.equal(await rawProbe('Basic '+Buffer.from('bad:bad').toString('base64')),407);assert.equal(await rawProbe(authorization),200);assert.equal(await rawProbe(authorization,'unlisted.test-tail.ts.net:8443'),403);
  const entry=path.join(dir,'main.cjs');fs.mkdirSync(profile);fs.writeFileSync(entry,"const {app,BrowserWindow}=require('electron');globalThis.__productionEmbeddedSession=import(process.env.PROXY_FIXTURE_HELPER_URL);app.setPath('userData',process.env.PROXY_FIXTURE_PROFILE);app.whenReady().then(()=>{globalThis.__fixtureWindow=new BrowserWindow({width:860,height:640,title:'隔离 CONNECT 认证测试（请勿操作）',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});globalThis.__fixtureWindow.loadURL('data:text/html,<h2>Isolated proxy authentication fixture</h2>');});app.on('window-all-closed',()=>app.quit());");
  const env={...process.env,PROXY_FIXTURE_PROFILE:profile,PROXY_FIXTURE_HELPER_URL:pathToFileURL(path.resolve('desktop/workbench-client/embedded-session.mjs')).href};delete env.ELECTRON_RUN_AS_NODE;
  desktop=await electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[entry,'--user-data-dir='+profile,'--ignore-certificate-errors','--proxy-server=http://127.0.0.1:'+proxyPort],env});
  await desktop.firstWindow();assert.equal(await desktop.evaluate(()=>process.versions.electron),'44.4.5');
  for(const strategy of ['app-login','session-webRequest','net-request-bootstrap','production-helper']){
    phase=strategy;const downloadPath=path.join(dir,'download-'+strategy+'.txt');
    const result=await desktop.evaluate(async({app,session,WebContentsView,net},o)=>{
      const s=session.fromPartition('private-'+o.strategy),ordinary=session.fromPartition('ordinary-'+o.strategy),events=[],win=globalThis.__fixtureWindow;
      await s.setProxy({mode:'fixed_servers',proxyRules:'http=127.0.0.1:'+o.proxyPort+';https=127.0.0.1:'+o.proxyPort,proxyBypassRules:'<-loopback>'});
      await ordinary.setProxy({mode:'fixed_servers',proxyRules:'http=127.0.0.1:'+o.proxyPort+';https=127.0.0.1:'+o.proxyPort,proxyBypassRules:'<-loopback>'});
      const exact=url=>{try{return new URL(url).origin===o.origin;}catch{return false;}};
      const onLogin=(event,wc,details,auth,callback)=>{
        event.preventDefault();const eligible=o.strategy==='app-login'&&!!wc&&wc.session===s&&exact(details.url)&&auth.isProxy&&auth.host==='127.0.0.1'&&auth.port===o.proxyPort&&auth.scheme==='basic'&&auth.realm===o.realm;
        events.push({event:'app-login',isProxy:!!auth.isProxy,hasWebContents:!!wc,eligible,hasDedicatedSession:!!wc&&wc.session===s,exactOrigin:exact(details.url),proxyHostExpected:auth.host==='127.0.0.1',proxyPortExpected:auth.port===o.proxyPort});if(eligible)callback(o.user,o.password);else callback();
      };
      app.on('login',onLogin);
      s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,cb)=>cb({cancel:!exact(d.url)}));
      if(o.strategy==='session-webRequest')s.webRequest.onBeforeSendHeaders({urls:[o.origin+'/*']},(d,cb)=>{events.push({event:'before-send-headers',exactOrigin:exact(d.url)});cb({requestHeaders:{...d.requestHeaders,'Proxy-Authorization':o.authorization}});});
      const fetchResult=async(ses,route)=>{try{const r=await ses.fetch(o.origin+route,{credentials:'include',redirect:'error',signal:AbortSignal.timeout(6500)});let data;try{data=await r.json();}catch{}return{ok:r.status===200&&data?.ok===true,status:r.status,hasCookie:!!data?.hasCookie,proxyCredentialHeaderPresent:!!data?.proxyCredentialHeaderPresent};}catch(e){return{ok:false,error:e.message};}};
      const netBootstrap=()=>new Promise(resolve=>{
        const request=net.request({url:o.origin+'/session?bootstrap=net-request',session:s,useSessionCookies:true}),timer=setTimeout(()=>{request.abort();resolve({ok:false,error:'net.request bootstrap timeout'});},6500);
        request.on('login',(auth,callback)=>{const eligible=auth.isProxy&&auth.host==='127.0.0.1'&&auth.port===o.proxyPort&&auth.scheme==='basic'&&auth.realm===o.realm;events.push({event:'net-request-login',eligible});if(eligible)callback(o.user,o.password);else callback();});
        request.on('response',r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>{clearTimeout(timer);resolve({ok:r.statusCode===200,status:r.statusCode});});});request.on('error',e=>{clearTimeout(timer);resolve({ok:false,error:e.message});});request.end();
      });
      const view=new WebContentsView({webPreferences:{session:s,contextIsolation:true,nodeIntegration:false,sandbox:true}});win.contentView.addChildView(view);view.setBounds({x:12,y:80,width:810,height:480});
      const navigate=async(wc,url)=>{let timer;try{return await Promise.race([wc.loadURL(url),new Promise((_r,reject)=>{timer=setTimeout(()=>{wc.stop();reject(Error('fixture navigation timeout'));},7000);})]);}finally{clearTimeout(timer);}};
      const prefs=view.webContents.getLastWebPreferences();
      const result={strategy:o.strategy,sameNativeSession:view.webContents.session===s,nativePermissionsIsolated:prefs.sandbox===true&&prefs.contextIsolation===true&&prefs.nodeIntegration===false,events};
      try{
        if(o.strategy==='net-request-bootstrap')result.netRequestBootstrap=await netBootstrap();
        if(o.strategy==='production-helper'){
          const {prepareEmbeddedSession}=await globalThis.__productionEmbeddedSession;
          try{await prepareEmbeddedSession(s,{origin:o.origin,proxyURL:'http://127.0.0.1:'+o.proxyPort,proxyUsername:o.user,proxyPassword:o.password,proxyRealm:o.realm,brokerId:'isolated-fixture-child'},{requestImpl:options=>net.request(options),timeoutMs:6500});result.productionBootstrap={ok:true};}catch(e){result.productionBootstrap={ok:false,code:e.code};}
        }
        result.coldMainFetch=await fetchResult(s,'/session?main=cold');
        if(!result.coldMainFetch.ok&&o.strategy==='app-login'){
          try{await navigate(view.webContents,o.origin+'/session?bootstrap=native-view');result.nativeBootstrap={ok:true};}catch(e){result.nativeBootstrap={ok:false,error:e.message};}
          result.warmMainFetch=await fetchResult(s,'/session?main=warm');
        }
        await s.closeAllConnections();
        try{await navigate(view.webContents,o.origin+'/page');result.nativeNavigation={ok:await view.webContents.executeJavaScript('!!document.querySelector("#ready")')};}catch(e){result.nativeNavigation={ok:false,error:e.message};}
        if(result.nativeNavigation.ok){
          await s.closeAllConnections();
          result.rendererXHR=await view.webContents.executeJavaScript(`new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET','/api/xhr');x.withCredentials=true;x.timeout=6500;x.onload=()=>{try{const data=JSON.parse(x.responseText);resolve({ok:x.status===200&&data.hasCookie===true,status:x.status,hasCookie:data.hasCookie,proxyCredentialHeaderPresent:!!data.proxyCredentialHeaderPresent});}catch{resolve({ok:false,status:x.status});}};x.onerror=()=>resolve({ok:false,error:'xhr error'});x.ontimeout=()=>resolve({ok:false,error:'xhr timeout'});x.send();})`);
          await s.closeAllConnections();
          const downloaded=new Promise(resolve=>{const timer=setTimeout(()=>resolve({ok:false,error:'download timeout'}),10000);const handler=(event,item,wc)=>{if(!exact(item.getURL())||wc!==view.webContents){event.preventDefault();clearTimeout(timer);s.removeListener('will-download',handler);resolve({ok:false,error:'unexpected download owner'});return;}item.setSavePath(o.downloadPath);item.once('done',(_event,state)=>{clearTimeout(timer);s.removeListener('will-download',handler);resolve({ok:state==='completed',state});});};s.on('will-download',handler);});
          await view.webContents.executeJavaScript('document.querySelector("#download").click();true');result.download=await downloaded;
        }
        await s.closeAllConnections();
        result.mainFetchAfterView=await fetchResult(s,'/api/main-after-view');
        const cookies=await s.cookies.get({url:o.origin});result.secureHttpOnlyCookie=cookies.some(c=>c.name==='__Host-proxy-fixture'&&c.secure&&c.httpOnly);result.cookieNotVisibleToRenderer=result.nativeNavigation.ok?await view.webContents.executeJavaScript('!document.cookie.includes("__Host-proxy-fixture")'):false;
        result.ordinaryMainFetch=await fetchResult(ordinary,'/ordinary/'+o.strategy);
        const other=new WebContentsView({webPreferences:{session:ordinary,contextIsolation:true,nodeIntegration:false,sandbox:true}});win.contentView.addChildView(other);
        try{await navigate(other.webContents,o.origin+'/ordinary/'+o.strategy);result.ordinaryNavigation={ok:true};}catch(e){result.ordinaryNavigation={ok:false,error:e.message};}finally{other.webContents.close();win.contentView.removeChildView(other);}
        result.ordinaryCookieCount=(await ordinary.cookies.get({url:o.origin})).length;
      }finally{
        app.removeListener('login',onLogin);s.webRequest.onBeforeRequest(null);if(o.strategy==='session-webRequest')s.webRequest.onBeforeSendHeaders(null);view.webContents.close();win.contentView.removeChildView(view);await s.closeAllConnections();await ordinary.closeAllConnections();
      }
      return result;
    },{strategy,proxyPort,origin,user,password,realm,authorization,downloadPath});
    result.downloadBytesMatch=result.download?.ok&&fs.existsSync(downloadPath)&&fs.readFileSync(downloadPath).equals(downloadBytes);
    result.ordinaryCredentialIsolation=!result.ordinaryMainFetch?.ok&&!result.ordinaryNavigation?.ok&&result.ordinaryCookieCount===0&&!originEvents.some(e=>e.path==='/ordinary/'+strategy);
    result.proxyCredentialsNotForwardedToOrigin=!originEvents.some(e=>e.phase===strategy&&e.proxyCredentialHeaderPresent);
    result.firstSessionFetchAfterRequestAuthenticationBootstrap=['net-request-bootstrap','production-helper'].includes(strategy);
    result.requestBootstrapDidNotNeedGlobalLoginCredentials=!['net-request-bootstrap','production-helper'].includes(strategy)||!result.events.some(e=>e.event==='app-login'&&e.eligible);
    result.fullSharedSessionSuccess=!!(result.sameNativeSession&&result.nativePermissionsIsolated&&result.nativeNavigation?.ok&&result.rendererXHR?.ok&&result.mainFetchAfterView?.ok&&result.mainFetchAfterView.hasCookie&&result.downloadBytesMatch&&result.secureHttpOnlyCookie&&result.cookieNotVisibleToRenderer&&result.ordinaryCredentialIsolation&&result.proxyCredentialsNotForwardedToOrigin&&result.requestBootstrapDidNotNeedGlobalLoginCredentials);
    strategies.push(result);t.diagnostic(JSON.stringify({strategy,coldMainFetch:result.coldMainFetch?.ok,bootstrap:result.productionBootstrap?.ok||result.netRequestBootstrap?.ok||result.nativeBootstrap?.ok||false,sharedSessionSuccess:result.fullSharedSessionSuccess,ordinaryCredentialIsolation:result.ordinaryCredentialIsolation}));
  }
  const supported=strategies.filter(s=>s.fullSharedSessionSuccess);
  const report={schemaVersion:1,checkedAt:new Date().toISOString(),electronVersion:'44.4.5',scope:'Synthetic exact-canonical ts.net HTTPS origin through mandatory authenticated loopback CONNECT; isolated native profile only, not real Tailnet or real business data',ok:supported.length>0,proxy:{mandatoryAuthentication:true,missingCredentialsRejected:true,badCredentialsRejected:true,unlistedTargetRejected:true,unauthenticatedTunnelAllowed:false},canonicalOrigin:origin,strategies,supportedStrategies:supported.map(s=>s.strategy),proxySummary:{connects:proxyEvents.length,missing:proxyEvents.filter(e=>e.authentication==='missing').length,bad:proxyEvents.filter(e=>e.authentication==='bad').length,authenticated:proxyEvents.filter(e=>e.authentication==='valid'&&e.allowedTarget).length,unlisted:proxyEvents.filter(e=>!e.allowedTarget).length},originRequestCount:originEvents.length,credentialsOrCookieValuesIncluded:false,systemProxyModified:false,realProfileAccessed:false,certificateException:'Only the isolated Electron test process --ignore-certificate-errors; no OS trust changes',references:['https://github.com/electron/electron/issues/44249','https://github.com/electron/electron/pull/49226'],cleanup:{ownedWindowClosed:false,ownedPortsClosed:false,temporaryProfileAndCertificateRemoved:false}};
  const production=strategies.find(s=>s.strategy==='production-helper');
  report.ok=!!(production?.productionBootstrap?.ok&&production.fullSharedSessionSuccess);
  report.interpretation={coldSessionFetchAloneAuthenticatesProxy:false,webRequestProxyAuthorizationAloneAuthenticatesCONNECT:false,recommendedSupportedMethod:'The production embedded-session.mjs helper uses a request-bound net.request login callback after exact loopback host/port/Basic/random-realm validation. Subsequent Session.fetch, WebContentsView, XMLHttpRequest and download reuse the dedicated Session auth cache and cookie jar.',productionHelper:'desktop/workbench-client/embedded-session.mjs',productionHelperNativeVerified:report.ok,requestBootstrapReliedOnGlobalLoginCredentials:false,mainFetchAfterViewForcedFreshTCP:true,bootstrapIsReadOnlyHealthGET:true,sessionFetchAfterBootstrapIsNotAColdProxyAuthenticationTest:true};
  await cleanup();report.cleanup={ownedWindowClosed:true,ownedPortsClosed:true,temporaryProfileAndCertificateRemoved:true};fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
  assert(supported.length>0,'No authenticated Session strategy passed; see '+reportFile);
  assert(strategies.find(s=>s.strategy==='production-helper')?.productionBootstrap?.ok,'Production helper bootstrap did not pass');
  assert(strategies.find(s=>s.strategy==='production-helper')?.fullSharedSessionSuccess,'Production helper did not share authenticated connections safely');
});
