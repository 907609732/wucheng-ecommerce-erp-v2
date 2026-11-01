import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {loadingMarkup} from '../desktop/shared/loading-screen.mjs';
import {remoteHtml,remoteStyles,remoteScript} from '../apps/exporter/src/main/workbench-ui.mjs';
import {remoteWarehouseHtml,remoteWarehouseStyles,createRemoteWarehouseScript} from '../desktop/renderer/remote-warehouse-ui.mjs';
const root=process.cwd(),output=path.resolve('.codex-artifacts/loading-style-20261027');
fs.mkdirSync(output,{recursive:true});
const report={scope:'isolated loading UI, synthetic failures, no business data',layouts:[],checks:[],errors:[]};
const css=fs.readFileSync('desktop/shared/loading-screen.css','utf8');
const files=new Map([
 ['/loading-screen.css',['text/css',css]],
 ['/loading-screen.mjs',['text/javascript',fs.readFileSync('desktop/shared/loading-screen.mjs')]],
 ['/loading-screen-auto.mjs',['text/javascript',fs.readFileSync('desktop/shared/loading-screen-auto.mjs')]],
 ['/loading-logo.png',['image/png',fs.readFileSync('desktop/assets/lingtu-icon.png')]],
 ['/remote/exporter/',['text/html',remoteHtml]],['/remote/exporter/app.css',['text/css',remoteStyles]],['/remote/exporter/app.js',['text/javascript',remoteScript]],
 ['/remote/warehouse/',['text/html',remoteWarehouseHtml]],['/remote/warehouse/app.css',['text/css',remoteWarehouseStyles]],['/remote/warehouse/app.js',['text/javascript',createRemoteWarehouseScript(()=> '待核对')]],
 ['/case',['text/html','<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/loading-screen.css"><script type="module" src="/loading-screen-auto.mjs"></script></head><body style="margin:0"><div id="surface"><div class="loading">正在读取本月采购任务…</div></div><button id="busy" disabled>正在保存…</button><progress id="real" max="100" value="37"></progress></body></html>']]
]);
const server=http.createServer((q,r)=>{const entry=files.get(q.url);if(!entry){r.writeHead(404);r.end();return;}r.writeHead(200,{'Content-Type':entry[0]});r.end(entry[1]);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(pathToFileURL(path.join(root,'desktop/launcher/preparing.html')).href);
 for(const [width,height]of [[1280,720],[900,650],[480,260],[360,640]]){
  await page.setViewportSize({width,height});
  const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,progressValue:document.querySelector('progress').getAttribute('value'),brand:document.querySelector('.lt-loading__brand').textContent}));
  assert(layout.scrollWidth<=width);assert.equal(layout.progressValue,null);
  report.layouts.push(layout);await page.screenshot({path:path.join(output,'preparing-'+width+'.png')});
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('progress').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.goto(base+'/case');await page.locator('#surface .lt-loading').waitFor();
 assert.match(await page.locator('#surface').innerText(),/正在读取本月采购任务/);
 assert.equal(await page.locator('#real').getAttribute('value'),'37');
 assert(await page.locator('#busy').evaluate(el=>el.classList.contains('lt-loading-button')));
 await page.evaluate(()=>{document.querySelector('#surface').innerHTML='<div class="loading">正在确认工作身份…</div>';});
 await page.locator('#surface .lt-loading__status').filter({hasText:'正在确认工作身份'}).waitFor();
 await page.evaluate(()=>{document.querySelector('#surface').innerHTML='<div class="loading"><div>读取失败<button id="retry">重试</button></div></div>';document.querySelector('#busy').disabled=false;});
 assert.equal(await page.locator('#surface .lt-loading').count(),0);assert(await page.locator('#retry').isVisible());
 await page.waitForFunction(()=>!document.querySelector('#busy').classList.contains('lt-loading-button'));
 for(const id of ['exporter','warehouse']){
  let release;const blocked=new Promise(resolve=>release=resolve);
  await page.route('**/api/workbench/v1/session',async route=>{await blocked;await route.fulfill({status:403,contentType:'application/json',body:'{}'});});
  await page.goto(base+'/remote/'+id+'/',{waitUntil:'commit'});
  await page.locator('#remoteLoading').waitFor({state:'visible'});
  assert.match(await page.locator('#remoteLoading').innerText(),/正在连接主服务器/);
  release();await page.locator('#remoteLoading').waitFor({state:'detached'});
  assert.match(await page.locator('#connection').innerText(),/不可用/);
  await page.unroute('**/api/workbench/v1/session');
 }
 for(const id of ['purchase','sales','overview'])for(const name of ['loading-screen.css','loading-screen.mjs','loading-screen-auto.mjs'])assert.equal(fs.readFileSync('apps/'+id+'/public/'+name,'utf8'),fs.readFileSync('desktop/shared/'+name,'utf8'));
 assert(!loadingMarkup({status:'<img onerror="bad">'}).includes('<img onerror='));
 assert.deepEqual(report.errors,[]);
 report.checks=['four preparation sizes','indeterminate progress without invented percentage','reduced motion','legacy dynamic placeholders and identity change','error/retry remains available','real OCR/download progress preserved','busy button clears','both remote failures release loading','independent module assets synchronized','escaped status text'];report.ok=true;
}catch(e){report.ok=false;report.failure=e.stack;throw e;}
finally{fs.writeFileSync(path.join(output,'ui-verification.json'),JSON.stringify(report,null,2));await browser.close();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(report));}
