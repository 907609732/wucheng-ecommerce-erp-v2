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
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createWorkbenchGateway} from '../desktop/workbench/gateway.mjs';

const projects=process.env.LINGTU_MODULE_TEST_ROOT||path.join(os.homedir(),'Documents','ChatGPT');
const roots={purchase:path.join(projects,'采购'),sales:path.join(projects,'销售台'),overview:path.join(projects,'采购','采购台和销售额台聚合')};
const available=Object.values(roots).every(root=>fs.existsSync(path.join(root,'server.mjs')));
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const fixtureRequest=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const q=http.request(url,{method,headers},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.once('error',reject);r.once('end',()=>{const data=Buffer.concat(chunks);resolve({status:r.statusCode,headers:r.headers,body:data,json:()=>JSON.parse(data.toString('utf8'))});});});q.once('error',reject);q.setTimeout(30000,()=>q.destroy(Error('fixture proxy timeout')));if(body)q.write(body);q.end();});

test('isolated browser business flows across actual gateway and three desks',{skip:!available,timeout:180000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-business-e2e-')),live={},servers=[],errors=[],leaks=[],uiErrors=[];let gateway,browser,context;
 t.after(async()=>{await context?.close();await browser?.close();await gateway?.stop();for(const s of servers)await new Promise(r=>{s.closeAllConnections?.();s.close(r);});for(const m of Object.values(live)){await m.cainiao?.close();m.store.close();}fs.rmSync(dir,{recursive:true,force:true});});
 for(const id of ['purchase','sales','overview']){
  const {createApp}=await import(pathToFileURL(path.join(roots[id],'server.mjs')).href),port=await freePort();
  const m=createApp({dataDir:path.join(dir,id),port,...(id==='overview'?{sources:{purchase:path.join(dir,'purchase','purchases.sqlite'),sales:path.join(dir,'sales','sales.sqlite')}}:{})});live[id]=m;
  const s=m.app.listen(port,'127.0.0.1');servers.push(s);m.integration.attach(s);await new Promise((resolve,reject)=>{s.once('listening',resolve);s.once('error',reject);});
 }
 const login='browser-fixture@example.test',accessPolicy={schemaVersion:1,users:{[login]:{enabled:true,role:'editor',modules:['purchase','sales','overview'],canRunTasks:false}}};
 const openssl=process.env.OPENSSL_PATH||(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
 const tlsKey=path.join(dir,'fixture.key'),tlsCert=path.join(dir,'fixture.crt');
 const signed=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',tlsCert,'-subj','/CN=isolated.test-tail.ts.net','-days','1','-addext','subjectAltName=DNS:isolated.test-tail.ts.net'],{windowsHide:true,stdio:'ignore'});assert.equal(signed.status,0,'OpenSSL fixture certificate');
 let gatewayUrl;
 const bridge=https.createServer({key:fs.readFileSync(tlsKey),cert:fs.readFileSync(tlsCert)},(q,s)=>{
  // This isolated loopback HTTPS bridge simulates Serve identity; no real Tailnet or membership is used.
  const headers={...q.headers,'tailscale-user-login':login};
  const request=http.request(gatewayUrl+q.url,{method:q.method,headers},response=>{
   if(response.statusCode>=400)uiErrors.push({url:q.url,status:response.statusCode,method:q.method});
   s.writeHead(response.statusCode,response.headers);response.pipe(s);
  });request.once('error',e=>{errors.push(e.message);if(!s.headersSent)s.writeHead(502);s.end();});q.pipe(request);
 });servers.push(bridge);await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
 const publicOrigin='https://127.0.0.1:'+bridge.address().port;
 gateway=await createWorkbenchGateway({services:{config:id=>({root:roots[id],dataDir:path.join(dir,id)}),capabilities:async id=>live[id].integration.state,ensure:async id=>live[id].integration.state},storeDir:path.join(dir,'gateway'),publicOrigin,port:0,accessPolicy});
 gatewayUrl=await gateway.start();browser=await chromium.launch({headless:true,args:['--no-proxy-server']});context=await browser.newContext({acceptDownloads:true,ignoreHTTPSErrors:true});
 await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin!==publicOrigin){leaks.push(request.url());return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(publicOrigin+'/api/workbench/v1/session',{waitUntil:'networkidle'});
 const call=async(id,route,method='GET',body)=>page.evaluate(async({id,route,method,body})=>{const r=await fetch('/apps/'+id+route,{method,headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};},{id,route,method,body});
 for(const id of ['purchase','sales','overview']){
  await page.goto(publicOrigin+'/apps/'+id+'/',{waitUntil:'networkidle'});try{await page.waitForFunction(()=>!!window.workbenchTransport,{},{timeout:5000});}catch(e){t.diagnostic(JSON.stringify({module:id,errors,leaks,uiErrors,html:(await page.content()).slice(0,600)}));throw e;}await page.waitForTimeout(100);
  const bootstrap=await call(id,'/api/bootstrap');assert.equal(bootstrap.status,200,id+': '+JSON.stringify(bootstrap.data));assert.equal(Object.hasOwn(bootstrap.data,'token'),false,id+' leaked local token');
 }
 assert.deepEqual(errors,[],'browser script errors');assert.deepEqual(leaks,[],'browser attempted another origin');assert.deepEqual(uiErrors,[],'module UI assets/API failed');
 await page.goto(publicOrigin+'/apps/purchase/',{waitUntil:'networkidle'});
 const manual={platform:'淘宝',account:'隔离测试账号',orderNo:'123456789012345678901',date:'2026-10-01',paidAt:'2026-10-01',supplier:'隔离测试供应商',status:'已完成',amountCents:100,refundCents:0,items:[{title:'测试商品',qty:1,unitPriceCents:100}]};
 const created=await call('purchase','/api/orders','POST',manual);assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(live.purchase.store.list().length,1);assert.equal(live.purchase.store.list()[0].orderNo,manual.orderNo);
 accessPolicy.users[login].role='viewer';const viewer=await call('purchase','/api/orders','POST',{...manual,orderNo:'viewer-denied'});assert.equal(viewer.status,403);assert.equal(live.purchase.store.list().length,1);accessPolicy.users[login].role='editor';
 await page.goto(publicOrigin+'/apps/sales/',{waitUntil:'networkidle'});
 const ledger=await call('sales','/api/ledger','POST',{shop_id:'offline',kind:'sale',date:'2026-09-01',amount:'123.45',currency:'CNY',external_id:'isolated-sale-1',note:'隔离测试'});assert.equal(ledger.status,200,JSON.stringify(ledger.data));assert.equal(live.sales.store.get('SELECT COUNT(*) n FROM ledger').n,1);
 await page.goto(publicOrigin+'/apps/overview/',{waitUntil:'networkidle'});const report=await call('overview','/api/overview?month=2026-09');assert.equal(report.status,200,JSON.stringify(report.data));assert(!JSON.stringify(report.data).includes('账本不存在'));
 await page.goto(publicOrigin+'/apps/purchase/',{waitUntil:'networkidle'});
 const upload=await page.evaluate(async()=>{const form=new FormData();form.append('files',new File(['isolated-original-content'],'original.txt',{type:'text/plain'}));const r=await fetch('/apps/purchase/api/attachments',{method:'POST',body:form});return {status:r.status,data:await r.json()};});assert.equal(upload.status,200,JSON.stringify(upload.data));assert.equal(upload.data.length,1);
 const attachment=await page.evaluate(async id=>{const r=await fetch('/apps/purchase/api/attachments/'+id);return {status:r.status,text:await r.text()};},upload.data[0].id);assert.equal(attachment.status,200);assert.equal(attachment.text,'isolated-original-content');
 const downloadPromise=page.waitForEvent('download');await page.evaluate(()=>{const a=document.createElement('a');a.href='/api/export';a.download='采购订单.csv';document.body.append(a);a.click();});const download=await downloadPromise;const downloadFailure=await download.failure();if(downloadFailure)t.diagnostic(JSON.stringify({downloadFailure,url:download.url(),errors,uiErrors}));assert.equal(downloadFailure,null);const downloadPath=await download.path();assert.match(fs.readFileSync(downloadPath,'utf8'),/123456789012345678901/);
 const {integrationHash}=await import(pathToFileURL(path.join(roots.purchase,'lib','local-integration.mjs')).href);
 const task={id:'isolated-transfer-task',platform:'taobao',from:'2026-10-01',to:'2026-10-20',status:'completed',listOutcome:'complete',count:1,accountKey:'isolated-stable-account'};
 const orders=[{platform:'taobao',account:'当前账号',id:'9999999999999999999999',createdAt:'2026-10-05 12:30:00',paidAt:'2026-10-05',status:'交易成功',shop:'隔离导入供应商',paidFen:12345,freightFen:null,refundFen:null,items:[{id:'a',title:'商品一',quantity:2,unitPriceFen:6000},{id:'b',title:'商品二',quantity:1,unitPriceFen:345}]}];
 const source={schema:'order-transfer/v1',task,orders,digest:integrationHash({task,orders})},prepared=await call('purchase','/api/integration/v1/transfers','POST',source);assert.equal(prepared.status,200,JSON.stringify(prepared.data));assert.equal(live.purchase.store.list().length,1);
 await page.goto(publicOrigin+'/apps/purchase/integration-review.html?batch='+prepared.data.id,{waitUntil:'networkidle'});
 await page.locator('#account').fill('隔离真实采购账号');await page.locator('[data-refund="0"]').fill('0');await page.locator('[data-evidence="0"]').fill('已在隔离测试原单核对无退款');
 await page.locator('#first-confirm').click();await page.locator('#final-check').waitFor();assert.equal(live.purchase.store.list().length,1,'first confirmation wrote ledger');await page.locator('#final-check').check();await page.locator('#commit').click();await page.getByText('入账完成，校验通过',{exact:true}).waitFor({timeout:20000});
 assert.equal(live.purchase.store.list().length,2);const imported=live.purchase.store.list().find(o=>o.orderNo===orders[0].id);assert.equal(imported.items.length,2);assert.equal(imported.amountCents,12345);
 const checked=await call('purchase','/api/integration/v1/transfers/'+prepared.data.id+'/verification');assert.equal(checked.status,200);assert.deepEqual(checked.data.differences,[]);
 // A distinct fixed MCP session cannot request the final UI confirmation.
 const sessionResponse=await fixtureRequest(gatewayUrl+'/api/workbench/v1/session',{headers:{host:new URL(publicOrigin).host,'tailscale-user-login':login,'x-workbench-channel':'mcp'}}),mcp=sessionResponse.json(),cookie=sessionResponse.headers['set-cookie'][0].split(';')[0];
 const denied=await fixtureRequest(gatewayUrl+'/api/workbench/v1/modules/purchase/api/integration/v1/transfers/'+prepared.data.id+'/commit',{method:'POST',headers:{host:new URL(publicOrigin).host,'tailscale-user-login':login,'x-workbench-channel':'mcp',cookie,origin:publicOrigin,'x-workbench-csrf':mcp.csrfToken,'idempotency-key':randomUUID(),'content-type':'application/json'},body:JSON.stringify({receipt:'not-a-ui-receipt'})});assert.equal(denied.status,403);
 assert.deepEqual(errors,[],'browser or proxy errors');assert.deepEqual(leaks,[],'localhost/other origin network leakage');
 t.diagnostic(JSON.stringify({scope:'isolated fixture; not real Tailnet or platform account',modules:3,purchaseOrders:2,salesLedgerRows:1,purchaseTransfer:'two real browser confirmations + verified',uploadDownload:'original by id + CSV',viewer:'write denied',mcp:'commit denied'}));
});
