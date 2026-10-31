import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {createPreparationWindow,createPreparationShutdown,formatPreparationProgress} from '../desktop/launcher/preparation-window.mjs';

const html=path.resolve('desktop/launcher/preparing.html'),preload=path.resolve('desktop/launcher/preparing-preload.cjs');
class Contents extends EventEmitter{sent=[];getURL(){return this.url;}send(...args){this.sent.push(args);}setWindowOpenHandler(handler){this.windowOpenHandler=handler;}}
class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new Contents();this.destroyed=false;this.shown=0;}loadFile(file){this.file=file;this.webContents.url=pathToFileURL(file).href;return Promise.resolve();}show(){this.shown++;}setMenu(){}isDestroyed(){return this.destroyed;}destroy(){if(!this.destroyed){this.destroyed=true;this.emit('closed');}}}
function make(options={}){const ipcMain=new EventEmitter(),controller=createPreparationWindow({BrowserWindow:Window,ipcMain,html,preload,...options});return {...controller,ipcMain};}

test('activation readiness waits for both real load/render events and the trusted visible-page paint acknowledgement',async()=>{
 for(const first of ['load','render']){
  const c=make();let ready=false;void c.ready.then(()=>{ready=true;});c.update(formatPreparationProgress({phase:'verify'}));
  c.window.webContents.url='about:blank';c.window.webContents.emit('did-finish-load');c.window.webContents.url=pathToFileURL(html).href;
  assert.equal(c.window.options.show,false);assert.equal(c.window.options.webPreferences.sandbox,true);assert.equal(c.window.options.webPreferences.nodeIntegration,false);
  const load=()=>c.window.webContents.emit('did-finish-load'),render=()=>c.window.emit('ready-to-show');
  (first==='load'?load:render)();await Promise.resolve();assert.equal(ready,false);assert.equal(c.window.shown,0);
  (first==='load'?render:load)();await Promise.resolve();assert.equal(ready,false);assert.equal(c.window.shown,1);assert.equal(c.window.webContents.sent.filter(([name])=>name==='launcher:preparation-paint-check').length,1);
  c.ipcMain.emit('launcher:preparation-painted',{sender:new Contents()});c.ipcMain.emit('launcher:preparation-painted',{sender:c.window.webContents,senderFrame:{url:'https://example.invalid/'}});await Promise.resolve();assert.equal(ready,false);
  c.ipcMain.emit('launcher:preparation-painted',{sender:c.window.webContents,senderFrame:{url:pathToFileURL(html).href}});assert.equal(await c.ready,c.window);assert.equal(c.ipcMain.listenerCount('launcher:preparation-painted'),0);c.destroy();
 }
});
test('preparation loading failure or cancellation rejects readiness without activating anything',async()=>{
 const failed=make();failed.window.webContents.emit('did-fail-load',{},-2,'failed',pathToFileURL(html).href,true);await assert.rejects(failed.ready,/准备窗口加载失败/);assert.equal(failed.window.shown,0);failed.destroy();
 const abort=new AbortController(),cancelled=make({signal:abort.signal});abort.abort();await assert.rejects(cancelled.ready,{name:'AbortError'});assert.equal(cancelled.window.isDestroyed(),true);assert.equal(cancelled.ipcMain.listenerCount('launcher:preparation-painted'),0);
});
test('quit cancels activation and defers the real quit until its cleanup settles, including reentrant window-close events',async()=>{
 let release;const activation=new Promise(resolve=>{release=resolve;}),controller=new AbortController(),order=[];let prevented=0,quitCount=0,handler;
 handler=createPreparationShutdown({controller,getActivation:()=>activation,getGateway:()=>({stop:async()=>{order.push('gateway');}}),getHost:()=>({close:async()=>{order.push('host');}}),quit:()=>{quitCount++;handler({preventDefault(){throw Error('Completed shutdown must not be prevented');}});}});
 controller.signal.addEventListener('abort',()=>{order.push('abort');handler({preventDefault(){prevented++;}});});handler({preventDefault(){prevented++;}});
 assert.equal(controller.signal.aborted,true);assert.equal(prevented,2);assert.equal(quitCount,0);assert.deepEqual(order,['abort']);release();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['abort','gateway','host']);assert.equal(quitCount,1);
});
test('progress uses actual phase/component counters and never invents unknown percentages',()=>{
 assert.deepEqual(formatPreparationProgress({phase:'copy',component:'purchase',processed:12,total:50},{purchase:'采购台'}),{phase:'copy',label:'正在准备业务程序',detail:'采购台 · 已处理 12 / 50 项',processed:12,total:50});
 const unknown=formatPreparationProgress({phase:'runtime',component:'node-runtime'},{'node-runtime':'共享运行环境'});assert.equal('processed'in unknown,false);assert.equal('total'in unknown,false);assert.doesNotMatch(unknown.detail,/undefined|%/);
 assert.equal('processed'in formatPreparationProgress({phase:'verify',processed:10,total:1}),false);
});
test('headless preparation page keeps shared Loading and acknowledges real animation frames with no business bridge',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript({content:`window.__prepHandlers={};window.__prepMessages=[];window.__prepFrames=0;const originalFrame=requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>originalFrame(time=>{window.__prepFrames++;callback(time);});window.require=name=>{if(name!=='electron')throw Error('Unexpected preload module');return {ipcRenderer:{on:(name,fn)=>{window.__prepHandlers[name]=fn;},send:(...args)=>window.__prepMessages.push(args)}};};\n`+fs.readFileSync(preload,'utf8')});
  await page.goto(pathToFileURL(html).href);await page.locator('.lt-loading__progress').waitFor();assert.equal(await page.locator('progress').getAttribute('value'),null);assert.equal(await page.evaluate(()=>typeof window.launcher),'undefined');
  await page.evaluate(()=>window.__prepHandlers['launcher:preparation-paint-check']());await page.waitForFunction(()=>window.__prepMessages.some(([name])=>name==='launcher:preparation-painted'));assert.ok(await page.evaluate(()=>window.__prepFrames>=2));
  await page.evaluate(status=>window.__prepHandlers['launcher:preparation']({},status),formatPreparationProgress({phase:'copy',component:'sales',processed:25,total:100},{sales:'销售台'}));
  assert.equal(await page.locator('progress').getAttribute('value'),'25');assert.equal(await page.locator('progress').getAttribute('max'),'100');assert.match(await page.locator('#detail').innerText(),/销售台.*25 \/ 100/);
  await page.evaluate(status=>window.__prepHandlers['launcher:preparation']({},status),formatPreparationProgress({phase:'runtime'}));assert.equal(await page.locator('progress').getAttribute('value'),null);assert.equal(await page.locator('.lt-loading').getAttribute('aria-busy'),'true');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
