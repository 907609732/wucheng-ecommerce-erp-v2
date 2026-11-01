import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'.codex-artifacts/warehouse-extension-ui');fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
 if(req.url==='/fixture'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/desktop/shared/ui/tokens.css"><link rel="stylesheet" href="/desktop/shared/ui/base.css"><link rel="stylesheet" href="/desktop/shared/ui/components.css"><link rel="stylesheet" href="/desktop/launcher/business-workspace.css"><body></body></html>');}
 const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.setHeader('content-type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1000,height:750}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/fixture');
 await page.evaluate(async()=>{
  document.body.innerHTML='<button id="nav-warehouse">云仓同步</button>';
  const {createExtensionInstaller}=await import('/desktop/launcher/extension-installer.mjs');
  window.fixture={installed:false,installs:0,plans:0,cancels:0,fail:false,hold:false};
  const api={extensionStatus:async()=>({installed:fixture.installed}),extensionPlan:async()=>{fixture.plans++;return {version:'0.11.8',bytes:1048576};},onProgress:fn=>{fixture.progress=fn;return ()=>{};},extensionCancel:async()=>{fixture.cancels++;fixture.reject?.(Error('安装已取消'));},extensionInstall:async()=>{
   fixture.installs++;fixture.progress({id:'warehouse',phase:'downloading',received:50,total:100});
   if(fixture.fail)throw Error('模拟断网');if(fixture.hold)await new Promise((resolve,reject)=>{fixture.reject=reject;});fixture.installed=true;
  }};
  const installer=createExtensionInstaller({launcher:api,beforeShow:async()=>{},afterClose:async()=>{}});
  document.getElementById('nav-warehouse').onclick=()=>{window.request=installer.request();};
 });
 await page.getByText('待安装',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>fixture.installs),0);
 await page.locator('#nav-warehouse').click();await page.locator('dialog[open]').waitFor();assert.match(await page.locator('[data-details]').innerText(),/0.11.8.*1.0 MB/);assert.equal(await page.evaluate(()=>fixture.installs),0);
 await page.locator('[data-close]').click();assert.equal(await page.evaluate(()=>window.request),false);
 await page.evaluate(()=>fixture.fail=true);await page.locator('#nav-warehouse').click();await page.locator('[data-install]').click();await page.getByText('模拟断网',{exact:true}).waitFor();
 assert.equal(await page.locator('#nav-warehouse small').innerText(),'待安装');
 await page.evaluate(()=>{fixture.fail=false;fixture.hold=true;});await page.locator('[data-install]').click();await page.getByText('取消安装',{exact:true}).click();await page.getByText('安装已取消',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>fixture.cancels),1);
 await page.evaluate(()=>fixture.hold=false);await page.locator('[data-install]').click();await page.locator('dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.request),true);assert.equal(await page.locator('#nav-warehouse small').innerText(),'已安装');
 const before=await page.evaluate(()=>fixture.installs);await page.locator('#nav-warehouse').click();assert.equal(await page.evaluate(()=>window.request),true);assert.equal(await page.evaluate(()=>fixture.installs),before);
 assert.deepEqual(errors.filter(error=>!error.includes('launcher')),[]);
 await page.screenshot({path:path.join(output,'installed.png')});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks:['no automatic download','confirmation and metadata','close','network error and retry','cancel','install then open','installed state']}));console.log('Warehouse extension UI acceptance passed');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
