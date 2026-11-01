import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(manifest.purpose,'hybrid-source-manual-acceptance');
const output=path.resolve('.codex-artifacts/business-build-20261101');fs.mkdirSync(output,{recursive:true});
let browser;
for(let i=0;i<90;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+manifest.debugPort);break;}catch{await new Promise(r=>setTimeout(r,1000));}}
assert.ok(browser,'fixture CDP ready');
const context=browser.contexts()[0],shell=context.pages().find(p=>p.url().endsWith('business-index.html'));assert.ok(shell);
const report={scope:'Real Electron native views with temporary synthetic ledgers; CDP renderer screenshots, not OS composite screenshots',fixtureRoot:manifest.fixtureRoot,checks:[],errors:[]};
const track=p=>p.on('pageerror',e=>report.errors.push({url:p.url(),message:e.message}));context.pages().forEach(track);context.on('page',track);
try{
 const pages={};
 for(const id of ['overview','purchase','sales']){
  await shell.locator('[data-desk="'+id+'"]').click();
  const registry=JSON.parse(fs.readFileSync(manifest.registryFile,'utf8')),prefix='http://127.0.0.1:'+registry[id].port;
  for(let i=0;i<100;i++){pages[id]=context.pages().find(p=>p.url().startsWith(prefix));if(pages[id]&&await pages[id].evaluate(()=>document.readyState==='complete'&&!!window.wuchengBusinessSurface).catch(()=>false))break;await new Promise(r=>setTimeout(r,200));}
  const page=pages[id];assert.ok(page,id+' page');await page.waitForTimeout(600);
  const text=await page.locator('body').innerText();assert.ok(text.length>50,id+' content');assert.ok(!text.includes('Cannot GET /'),id+' route');
  await page.screenshot({path:path.join(output,'ui-'+id+'.png')});
  report.checks.push({module:id,url:page.url(),text:text.slice(0,1200),visible:await page.evaluate(()=>window.lingtuShell.isVisible())});
  await page.evaluate(id=>{window.__qaCacheMarker=id+'-retained';},id);
 }
 for(const id of ['overview','purchase','sales']){await shell.locator('[data-desk="'+id+'"]').click();await shell.waitForTimeout(250);assert.equal(await pages[id].evaluate(()=>window.__qaCacheMarker),id+'-retained');assert.equal(await pages[id].evaluate(()=>window.lingtuShell.isVisible()),true);for(const [other,p]of Object.entries(pages))if(other!==id)assert.equal(await p.evaluate(()=>window.lingtuShell.isVisible()),false);}
 report.checks.push({cache:'all three native views retained their JS context across tab switches',visibility:'active view true; both hidden views false'});
 await shell.locator('[data-view="settings"]').click();await shell.waitForTimeout(250);for(const p of Object.values(pages))assert.equal(await p.evaluate(()=>window.lingtuShell.isVisible()),false);
 await shell.screenshot({path:path.join(output,'ui-settings.png')});report.checks.push({settings:'all business views hidden while settings displayed'});
 assert.deepEqual(report.errors,[]);report.ok=true;
}finally{fs.writeFileSync(path.join(output,'ui-source-verification.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report));
