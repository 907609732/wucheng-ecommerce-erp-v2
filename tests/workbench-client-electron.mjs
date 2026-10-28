import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {_electron as electron} from 'playwright';
import {createWorkbenchGateway} from '../desktop/workbench/gateway.mjs';
import {startCloudControl} from '../desktop/modules/cloud-control.mjs';

const projects=process.env.LINGTU_MODULE_TEST_ROOT||path.join(os.homedir(),'Documents','ChatGPT');
const roots={purchase:path.join(projects,'采购'),sales:path.join(projects,'销售台'),overview:path.join(projects,'采购','采购台和销售额台聚合')};
const available=Object.values(roots).every(root=>fs.existsSync(path.join(root,'server.mjs')));
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function eventually(read,predicate,{timeout=15000,label='condition'}={}){const until=Date.now()+timeout;let value;while(Date.now()<until){value=await read();if(predicate(value))return value;await delay(100);}throw Error(label+' timed out: '+JSON.stringify(value));}

test('native Electron client shares secure module session and encrypted readonly offline snapshots',{skip:!available||process.platform!=='win32',timeout:240000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-client-native-')),profile=path.join(dir,'profile'),live={},servers=[],tunnels=new Set(),network=[],fixtureErrors=[];let gateway,cloud,desktop,bridge,bridgeClosed=false;
 fs.mkdirSync(profile,{recursive:true});
 t.after(async()=>{await desktop?.close();for(const socket of tunnels)socket.destroy();await gateway?.stop();for(const s of servers){if(s===bridge&&bridgeClosed)continue;await new Promise(r=>{s.closeAllConnections?.();s.close(r);});}await cloud?.close();for(const m of Object.values(live)){await m.cainiao?.close();m.store.close();}fs.rmSync(dir,{recursive:true,force:true});});
 const probe=net.createServer();try{await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(8443,'127.0.0.1',resolve);});}catch(error){if(error.code==='EADDRINUSE'){t.skip('FIXTURE_PORT_BUSY_8443: existing listener preserved; native client fixture was not run');return;}throw error;}await new Promise(r=>probe.close(r));
 for(const id of ['purchase','sales','overview']){
  const {createApp}=await import(pathToFileURL(path.join(roots[id],'server.mjs')).href),port=await freePort(),dataDir=path.join(dir,'server',id);
  const m=createApp({dataDir,port,...(id==='overview'?{sources:{purchase:path.join(dir,'server','purchase','purchases.sqlite'),sales:path.join(dir,'server','sales','sales.sqlite')}}:{})});live[id]=m;
  const s=m.app.listen(port,'127.0.0.1');servers.push(s);m.integration.attach(s);await new Promise((resolve,reject)=>{s.once('listening',resolve);s.once('error',reject);});
 }
 const {validateOrder}=await import(pathToFileURL(path.join(roots.purchase,'lib','importer.mjs')).href);
 const orderNo='native-DPAPI-proof-123456789012345678901';live.purchase.store.insert(validateOrder({platform:'淘宝',account:'隔离真实账号',orderNo,date:'2026-10-01',paidAt:'2026-10-01',supplier:'仅原服务器的隔离供应商',status:'已完成',amountCents:1099,refundCents:0,items:[{title:'隔离缓存测试',qty:1,unitPriceCents:1099}]}));
 const warehouseDir=path.join(dir,'server','warehouse');fs.mkdirSync(warehouseDir,{recursive:true});
 const warehouseDatabase=path.join(warehouseDir,'erp.sqlite'),warehouseStore=new DatabaseSync(warehouseDatabase);warehouseStore.exec('CREATE TABLE isolated_fixture(id INTEGER PRIMARY KEY)');warehouseStore.close();
 cloud=await startCloudControl({root:path.resolve('.'),dataDir:warehouseDir,version:'1.0.0-fixture',busy:()=>false,activate:async()=>{},open:async()=>{},stop:async()=>{},migration:{databasePath:warehouseDatabase,dataDir:warehouseDir},business:{getState:async()=>({}),getInventory:async()=>({items:[{sku:'native-fixture-sku',name:'隔离库存',quantity:1}],available:true}),getMonthlySales:async()=>({available:false,message:'隔离测试未采集平台数据'}),getTaskState:async()=>({running:false,status:'空闲',logs:[]}),run:async()=>{throw Error('fixture never runs collection');},stop:async()=>({ok:true})}});
 const cloudCap=JSON.parse(fs.readFileSync(path.join(warehouseDir,'.integration-runtime-cloud.json'),'utf8'));
 const login='native-fixture@example.test',publicOrigin='https://isolated.test-tail.ts.net:8443',moduleIds=['warehouse','purchase','sales','overview'];
 const currentCapabilities=async id=>id==='warehouse'?(await fetch(cloudCap.url+'/api/integration/v1/capabilities')).json():live[id].integration.state;
 const services={config:id=>({root:id==='warehouse'?path.resolve('.'):roots[id],dataDir:id==='warehouse'?warehouseDir:path.join(dir,'server',id)}),capabilities:currentCapabilities,ensure:currentCapabilities};
 gateway=await createWorkbenchGateway({services,storeDir:path.join(dir,'gateway'),publicOrigin,port:0,accessPolicy:{schemaVersion:1,users:{[login]:{enabled:true,role:'editor',modules:moduleIds,canRunTasks:false}}}});const gatewayUrl=await gateway.start();
 const key=path.join(dir,'fixture.key'),cert=path.join(dir,'fixture.crt'),openssl=process.env.OPENSSL_PATH||'C:/Program Files/Git/usr/bin/openssl.exe';
 assert.equal(spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=isolated.test-tail.ts.net','-days','1','-addext','subjectAltName=DNS:isolated.test-tail.ts.net'],{windowsHide:true,stdio:'ignore'}).status,0);
 let bridgeHits=0;bridge=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(q,s)=>{
  bridgeHits++;const upstream=http.request(gatewayUrl+q.url,{method:q.method,headers:{...q.headers,'tailscale-user-login':login}},r=>{s.writeHead(r.statusCode,r.headers);r.pipe(s);});upstream.once('error',e=>{fixtureErrors.push(e.message);if(!s.headersSent)s.writeHead(502);s.end();});q.pipe(upstream);
 });servers.push(bridge);bridge.on('tlsClientError',e=>fixtureErrors.push('tls:'+e.message));await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(8443,'127.0.0.1',resolve);});
 // Force only this isolated Electron process through a rejecting proxy. A normal
 // Session must hit the trap; the production Tailnet Session must go direct.
 let tailnetProxyHits=0;
 const proxyTrap=http.createServer((_q,s)=>{s.writeHead(502);s.end('isolated proxy trap');});proxyTrap.on('connect',(q,client)=>{
  if(q.url==='isolated.test-tail.ts.net:8443')tailnetProxyHits++;
  tunnels.add(client);client.once('close',()=>tunnels.delete(client));client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
 });servers.push(proxyTrap);await new Promise(r=>proxyTrap.listen(0,'127.0.0.1',r));
 const registry=path.join(dir,'client-registry.json');fs.writeFileSync(registry,JSON.stringify(Object.fromEntries(['warehouse','purchase','sales','overview','exporter'].map(id=>[id,{managed:true,root:path.join(profile,'local-programs',id),dataDir:path.join(profile,'local-ledgers',id),exe:path.join(profile,'local-programs',id,'missing.exe')}]))));
 fs.writeFileSync(path.join(profile,'workbench-connection.json'),JSON.stringify({schemaVersion:1,mode:'client',clientId:randomUUID(),serverUrl:publicOrigin,pins:null,migration:{state:'empty'}}));
 const partition='persist:workbench-'+createHash('sha256').update(publicOrigin).digest('hex').slice(0,24),env={...process.env,LINGTU_REGISTRY_PATH:registry};delete env.ELECTRON_RUN_AS_NODE;
 desktop=await electron.launch({executablePath:path.resolve(process.env.LAUNCHER_TEST_EXE||'node_modules/electron/dist/electron.exe'),args:[...(process.env.LAUNCHER_TEST_EXE?[]:[path.resolve('desktop/launcher')]),'--user-data-dir='+profile,'--ignore-certificate-errors','--proxy-server=127.0.0.1:'+proxyTrap.address().port,'--proxy-bypass-list=<-loopback>','--host-resolver-rules=MAP isolated.test-tail.ts.net 127.0.0.1'],env});
 const page=await desktop.firstWindow(),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await desktop.evaluate(({session},{partition})=>{session.fromPartition(partition).webRequest.onCompleted(d=>{globalThis.__workbenchFixtureNetwork??=[];globalThis.__workbenchFixtureNetwork.push({url:d.url,status:d.statusCode});});},{partition});
 const normalProxy=await desktop.evaluate(async({session},{origin})=>{const normal=session.fromPartition('normal-public-proxy-control'),resolved=await normal.resolveProxy(origin);let error;try{await normal.fetch(origin+'/api/workbench/v1/health');}catch(e){error=e.message;}return {resolved,error};},{origin:publicOrigin});
 assert.match(normalProxy.resolved,/PROXY 127\.0\.0\.1:/);assert(normalProxy.error,'normal Session unexpectedly bypassed the rejecting proxy');assert(tailnetProxyHits>0,'proxy negative control was not exercised');
 const proxyHitsBeforeClient=tailnetProxyHits;
 const status=await page.evaluate(async()=>{try{return await window.launcher.checkConnection();}catch(e){return {error:e.message};}});
 assert.equal(await desktop.evaluate(({session},{partition,origin})=>session.fromPartition(partition).resolveProxy(origin),{partition,origin:publicOrigin}),'DIRECT');
 assert.equal(status.error,undefined,JSON.stringify({status,bridgeHits,fixtureErrors}));assert.equal(status.actor.login,login);await page.reload();await page.locator('#cards [data-module=purchase] button').waitFor();
 assert.deepEqual(await page.locator('#cards .card h3').allTextContents(),['菜鸟云仓同步','经营收支总览','销售台','采购台']);assert.deepEqual(await page.locator('.workflowHeading h2').allTextContents(),['每天使用','每月填写']);assert.match(await page.locator('.monthly .workflowHeading p').innerText(),/15/);
 const views=()=>desktop.evaluate(({BrowserWindow,session},{origin,partition})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents?.getURL().startsWith(origin+'/apps/')).map(v=>({id:v.webContents.id,url:v.webContents.getURL(),sameSession:v.webContents.session===session.fromPartition(partition),preferences:v.webContents.getLastWebPreferences()})),{origin:publicOrigin,partition});
 const execute=(id,source)=>desktop.evaluate(async({BrowserWindow},{id,source})=>{const v=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.getURL().includes('/apps/'+id+'/'));if(!v)throw Error('missing native view '+id);return v.webContents.executeJavaScript(source);},{id,source});
 for(const id of ['warehouse','purchase','sales']){await page.locator('#home').click();await page.locator('[data-module='+id+'] button').first().click();await eventually(views,rows=>rows.some(r=>r.url.startsWith(publicOrigin+'/apps/'+id+'/')),{label:'native '+id});await eventually(()=>execute(id,'!!window.workbenchTransport||'+JSON.stringify(id==='warehouse')),Boolean,{label:'module shim '+id});}
 let rows=await views();assert(rows.every(v=>v.sameSession));assert(rows.every(v=>v.preferences.contextIsolation===true&&v.preferences.nodeIntegration===false&&v.preferences.sandbox===true));
 // Overview now has its own monthly home entry. Exercise the same production
 // cross-module navigation boundary without relying on the removed sales button.
 const sales=rows.find(v=>v.url.includes('/apps/sales/'));await execute('sales','window.__nativePreservedState="sales-original";location.assign("/apps/overview/");true');await eventually(views,rows=>rows.some(r=>r.url.startsWith(publicOrigin+'/apps/overview/')),{label:'cross module native overview'});
 await page.locator('#home').click();await page.locator('[data-module=sales] button').first().click();assert.equal((await views()).find(v=>v.url.includes('/apps/sales/')).id,sales.id);assert.equal(await execute('sales','window.__nativePreservedState'),'sales-original');
 const cookieInfo=await desktop.evaluate(async({session},{partition,origin})=>{const cookies=await session.fromPartition(partition).cookies.get({url:origin});return cookies.map(c=>({name:c.name,secure:c.secure,httpOnly:c.httpOnly}));},{partition,origin:publicOrigin});assert(cookieInfo.some(c=>c.name==='__Host-workbench-session'&&c.secure&&c.httpOnly));
 const blocked=await page.evaluate(async()=>{const out=[];for(const fn of [()=>window.launcher.install('purchase'),()=>window.launcher.stop('purchase'),()=>window.launcher.openData('purchase')])try{await fn();out.push('allowed');}catch(e){out.push(e.message);}return out;});assert(blocked.every(s=>/主服务器|主机/.test(s)),JSON.stringify(blocked));
 const connectionFile=path.join(profile,'workbench-connection.json'),connected=JSON.parse(fs.readFileSync(connectionFile,'utf8'));fs.writeFileSync(connectionFile,JSON.stringify({...connected,migration:{state:'pending'}}));
 const pendingWrite=await execute('purchase',`fetch('/apps/purchase/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:'淘宝',account:'隔离真实账号',orderNo:'pending-migration-must-not-write',date:'2026-10-01',paidAt:'2026-10-01',supplier:'隔离供应商',status:'已完成',amountCents:100,refundCents:0,items:[{title:'测试',qty:1,unitPriceCents:100}]})}).then(r=>({status:r.status})).catch(()=>({blocked:true}))`);assert.equal(pendingWrite.blocked,true,JSON.stringify(pendingWrite));assert.equal(live.purchase.store.list().length,1);fs.writeFileSync(connectionFile,JSON.stringify(connected));
 await eventually(()=>page.evaluate(()=>window.launcher.cached('purchase')),r=>!!r?.data,{label:'authenticated DPAPI snapshot'});const cacheFiles=fs.readdirSync(path.join(profile,'client-cache')).filter(f=>f.endsWith('.dpapi'));assert(cacheFiles.length>0);for(const name of cacheFiles)assert(!fs.readFileSync(path.join(profile,'client-cache',name)).includes(Buffer.from(orderNo)),'plaintext snapshot');
 assert.equal(await desktop.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable()),true);
 network.push(...await desktop.evaluate(()=>globalThis.__workbenchFixtureNetwork||[]));assert(!network.some(row=>/^https?:\/\/(?:127\.0\.0\.1|localhost)/.test(row.url)),JSON.stringify(network.filter(r=>r.url.includes('127.0.0.1'))));assert(!fs.existsSync(path.join(profile,'local-ledgers')),'client created local business data');
 await page.locator('#home').click();bridge.closeAllConnections();await new Promise(r=>bridge.close(r));bridgeClosed=true;for(const socket of tunnels)socket.destroy();
 await page.locator('[data-module=purchase] button').first().click();await page.locator('#cachePanel').waitFor({state:'visible',timeout:30000});assert.match(await page.locator('#cacheStatus').innerText(),/更新时间/);assert.match(await page.locator('#cacheData').innerText(),new RegExp(orderNo));assert.equal(await page.locator('#cachePanel input,#cachePanel textarea,#cachePanel form').count(),0);
 assert.deepEqual(pageErrors,[]);assert.equal(live.purchase.store.list().length,1);assert(!fs.existsSync(path.join(profile,'local-ledgers')));
 assert.equal(tailnetProxyHits,proxyHitsBeforeClient,'Tailnet requests or views reached the rejecting system-proxy trap');
 assert.match(await desktop.evaluate(({session},{origin})=>session.fromPartition('normal-public-proxy-control').resolveProxy(origin),{origin:publicOrigin}),/PROXY 127\.0\.0\.1:/,'production code changed the normal/public Session proxy');
 t.diagnostic(JSON.stringify({scope:'isolated native client; not real Tailnet',homeEntries:4,nativeModules:4,sharedCookieSession:true,salesViewPreserved:true,localSystemOperations:'denied',localBusinessService:'not started',pendingMigration:'embedded UI write blocked by native session',cache:'Windows DPAPI authenticated snapshot + visible readonly offline panel',tailnetSessionProxy:'production direct; rejecting proxy control preserved for ordinary Sessions',fixtureProxyFallback:false}));
});
