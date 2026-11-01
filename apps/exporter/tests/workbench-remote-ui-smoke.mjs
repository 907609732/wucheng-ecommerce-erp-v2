// Synthetic loopback UI acceptance only. This test never runs a collector or a ledger import.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {remoteHtml,remoteScript,remoteStyles} from '../src/main/workbench-ui.mjs';
const tasks=[{id:'fixture-task',platform:'taobao',account:'演示账号',from:'2026-01-01',to:'2026-01-31',count:1,state:'waiting-host-action',status:'needs_login',message:'需要登录',hostAction:'请在主服务器完成登录、验证码或平台授权，再继续任务',listOutcome:'complete'}];
const orders=[{id:'123456789012345678901234567890',account:'演示账号',shop:'演示供应商',createdAt:'2026-01-12',paidFen:12345,refundFen:null,status:'已完成',missing:['退款待核对'],items:[{title:'隔离演示商品',spec:'蓝色',quantity:2}]}];
const requests=[],results=new Map(),errors=[];let browser;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/apps/exporter/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(remoteHtml);}
  if(url.pathname==='/apps/exporter/app.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(remoteScript);}
  if(url.pathname==='/apps/exporter/app.css'){res.writeHead(200,{'Content-Type':'text/css'});return res.end(remoteStyles);}
  if(url.pathname==='/api/workbench/v1/session')return json({csrfToken:'fixture-csrf'});
  const route=url.pathname.replace('/api/workbench/v1/modules/exporter','');
  if(route==='/state')return json({version:'0.2.0',platforms:[{id:'taobao',name:'淘宝／天猫',mode:'browser'}],tasks,revision:'fixture-revision',busy:false,permissions:{read:true,write:true,runTasks:true,clear:true}});
  if(route.startsWith('/tasks/')&&route.endsWith('/orders'))return json({task:tasks.find(t=>route.includes(t.id))||tasks[0],orders});
  if(route.startsWith('/logs/'))return json([{time:'10:00',message:'隔离演示：等待主服务器人工处理'}]);
  if(req.method==='POST'){
    let raw='';for await(const chunk of req)raw+=chunk;requests.push({route,body:JSON.parse(raw||'{}'),key:req.headers['idempotency-key'],csrf:req.headers['x-workbench-csrf']});
    if(route==='/host-action')return json({state:'waiting-host-action',message:'请在主服务器完成登录'});
    if(route==='/tasks'){
      const key=req.headers['idempotency-key'];if(results.has(key))return json(results.get(key));
      const task={...tasks[0],id:'fixture-new-task',state:'paused',status:'paused',message:'隔离演示已接收'};tasks.push(task);results.set(key,task);return json(task);
    }
  }
  res.writeHead(404);res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}:{})});const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{const original=window.fetch.bind(window);let interrupted=false;window.fetch=async(...args)=>{const response=await original(...args);if(!interrupted&&String(args[0]).endsWith('/modules/exporter/tasks')&&args[1]?.method==='POST'){interrupted=true;await response.text();throw new TypeError('Network interruption after fixture commit');}return response;};});
  await page.goto('http://127.0.0.1:'+server.address().port+'/apps/exporter/');await page.locator('#tasks button').first().click();await page.locator('#orders').getByText(orders[0].id).waitFor();assert.match(await page.locator('#task-message').textContent(),/主服务器/);
  await page.locator('#login').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('请在主服务器完成登录'));assert.equal(requests.at(-1).csrf,'fixture-csrf');assert.ok(requests.at(-1).key);
  await page.locator('#start').click();await page.waitForFunction(()=>/fetch|Network|网络/i.test(document.getElementById('message').textContent));await page.locator('#start').click();await page.waitForFunction(()=>document.querySelectorAll('#tasks button').length===2&&document.getElementById('message').textContent.includes('任务已提交'));
  const starts=requests.filter(r=>r.route==='/tasks');assert.equal(starts.length,2);assert.equal(starts[0].key,starts[1].key);assert.equal(tasks.filter(t=>t.id==='fixture-new-task').length,1);assert.deepEqual(errors,[]);
  const output=path.resolve('artifacts/workbench-remote-ui.png');fs.mkdirSync(path.dirname(output),{recursive:true});await page.screenshot({path:output,fullPage:true});process.stdout.write(JSON.stringify({ok:true,synthetic:true,longOrderId:true,waitingHostAction:true,interruptedRetrySameKey:true,screenshot:output})+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
