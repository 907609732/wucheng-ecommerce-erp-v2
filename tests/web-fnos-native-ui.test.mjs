import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from '@playwright/test';

// Real DOM fixtures only. Every browser request is fulfilled locally; no user
// profile, platform account, native process or external site is accessed.
const read=relative=>fs.readFileSync(new URL(relative,import.meta.url),'utf8');
let browser;
test.before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
test.after(async()=>{await browser?.close();});

async function loginPage(t,{shared,selected='overview',prefix='/app/wuchengerp'}={}){
 const page=await browser.newPage();t.after(()=>page.close());
 await page.route('**/*',route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname===prefix+'/api/workbench/v1/session')return route.fulfill({json:{actor:{},nativeBrowser:{enabled:true,...(shared===undefined?{}:{shared})}}});
  if(pathname===prefix+'/web/native-browser.html')return route.fulfill({contentType:'text/html',body:read('../server/public/native-browser.html').replaceAll('/web/',prefix+'/web/')});
  for(const name of ['native-browser.js','native-browser.css'])if(pathname===prefix+'/web/'+name)return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':'text/css',body:read('../server/public/'+name)});
  if(pathname===prefix+'/web/novnc/vnc.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Viewer fixture</title><p>Viewer fixture</p>'});
  return route.fulfill({status:404,body:''});
 });
 await page.goto('http://native-ui.test'+prefix+'/web/native-browser.html?module='+selected);
 await page.locator('#browser-view').waitFor({state:'visible'});
 return page;
}

for(const prefix of ['/app/wuchengerp','/app/wuchengerptrial'])for(const selected of ['sales','overview'])test(`shared login hides independent chooser and retains ${prefix} ${selected} alias`,async t=>{
 const page=await loginPage(t,{shared:true,selected,prefix});
 assert.equal(await page.locator('nav').isVisible(),false);
 assert.match(await page.locator('header p').innerText(),/共用.*登录|共享.*登录/);
 const target=new URL(await page.locator('#browser-view').getAttribute('src'));
 assert.equal(target.searchParams.get('path'),prefix.slice(1)+'/api/workbench/v1/native-browser/'+selected+'/websockify');
});

for(const shared of [undefined,false])test(`legacy independent login keeps module chooser when shared=${shared}`,async t=>{
 const page=await loginPage(t,{shared});
 assert.equal(await page.locator('nav').isVisible(),true);
 assert.equal(await page.locator('[data-module="overview"]').getAttribute('aria-current'),'page');
 assert.match(await page.locator('header p').innerText(),/各自保留登录状态/);
});

async function downloadDialog(t,connection){
 const page=await browser.newPage();t.after(()=>page.close());
 await page.route('**/*',route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/cainiao.js')return route.fulfill({contentType:'text/javascript',body:read('../apps/overview/public/cainiao.js')});
  if(pathname==='/style.css')return route.fulfill({contentType:'text/css',body:read('../apps/overview/public/style.css')});
  if(pathname!=='/')return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><script type="module">
   import {openCainiao} from '/cainiao.js';
   window.fixtureConnection=${JSON.stringify(connection)};window.posts=[];
   const esc=value=>{const node=document.createElement('span');node.textContent=value??'';return node.innerHTML;};
   await openCainiao({month:'2026-09',esc,toast(){},api:async path=>path==='/api/cainiao/connection'?structuredClone(window.fixtureConnection):[],post:async(path,input)=>{window.posts.push({path,input});return structuredClone(window.fixtureConnection);},modal(title,html){const dialog=document.createElement('dialog');dialog.innerHTML=html;document.body.append(dialog);dialog.showModal();return dialog;}});
   document.body.dataset.ready='true';
  </script>`});
 });
 await page.goto('http://download-ui.test/');await page.locator('body[data-ready="true"]').waitFor({state:'attached'});
 return page;
}

test('shared download dialog displays account and live queue state without extension controls',async t=>{
 const page=await downloadDialog(t,{status:'connected',account:'cn-fixture',authorizationSaved:false,mode:'native-shared',coordination:{state:'queued',position:1,message:'正在等待销售采集完成，随后自动继续。'}});
 assert.equal(await page.locator('.cn-auth').isVisible(),false);
 assert.equal(await page.locator('#cn-connection a').count(),0);
 assert.match(await page.locator('#cn-connection').innerText(),/cn-fixture/);
 assert.match(await page.locator('#cn-connection').innerText(),/等待销售采集完成/);
 assert.equal(await page.locator('#cn-start').isEnabled(),true,'waiting for the other module must not change connected status');
 await page.locator('.cn-help summary').click();assert.doesNotMatch(await page.locator('.cn-help').innerText(),/Playwright|扩展|日常 Chrome/);
 await page.evaluate(()=>{window.fixtureConnection.coordination={state:'running',position:0,message:'正在经营总览采集页中操作。'};document.dispatchEvent(new Event('visibilitychange'));});
 await page.getByText('正在经营总览采集页中操作。',{exact:true}).waitFor();
 await page.evaluate(()=>{document.querySelector('dialog').close();});
 assert.equal(await page.evaluate(()=>window.posts.length),0,'closing the dialog must not disconnect or cancel queued collection');
});

test('shared queue messages are escaped and connection errors stay readable',async t=>{
 const page=await downloadDialog(t,{status:'connected',account:'cn-fixture',mode:'native-shared',coordination:{state:'queued',position:1,message:'<b>等待采集</b>'}});
 assert.equal(await page.locator('#cn-connection').getByText('<b>等待采集</b>',{exact:true}).count(),1);
 assert.equal(await page.locator('#cn-connection b').count(),1,'queue message must not create markup');
 await page.evaluate(()=>{window.fixtureConnection={status:'error',mode:'native-shared',account:'',message:'当前采集页已关闭，请点击重新连接。',coordination:{state:'idle',position:0,message:''}};document.dispatchEvent(new Event('visibilitychange'));});
 await page.getByText('当前采集页已关闭，请点击重新连接。',{exact:true}).waitFor();
 assert.equal(await page.locator('#cn-start').isEnabled(),false);
 assert.equal(await page.locator('#cn-connect').innerText(),'重新连接');
});

test('shared connection does not ask for Windows Chrome extension confirmation',async t=>{
 const page=await downloadDialog(t,{status:'connecting',account:'',message:'正在连接共享菜鸟浏览器',mode:'native-shared',coordination:{state:'queued',position:1,message:'前方还有 1 项操作，随后自动继续。'}});
 const text=await page.locator('#cn-connection').innerText();assert.match(text,/正在连接菜鸟/);assert.doesNotMatch(text,/Chrome|扩展/);
 assert.equal(await page.locator('#cn-connect').isEnabled(),false);
});

test('Windows download dialog retains Chrome extension and remembered authorization UI',async t=>{
 const page=await downloadDialog(t,{status:'disconnected',account:'',authorizationSaved:false,message:'连接已登录菜鸟的 Chrome'});
 assert.equal(await page.locator('.cn-auth').isVisible(),true);
 assert.match(await page.locator('#cn-connection').innerText(),/连接日常 Chrome/);
 assert.equal(await page.locator('#cn-connection a').count(),1);
 await page.locator('.cn-auth summary').click();assert.equal(await page.locator('#cn-auth-token').isVisible(),true);
 await page.locator('.cn-help summary').click();assert.match(await page.locator('.cn-help').innerText(),/Playwright 扩展/);
});
