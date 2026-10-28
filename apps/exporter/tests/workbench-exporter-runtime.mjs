// Actual Electron integration smoke with an isolated user-data directory.
// The maintenance flag keeps the window hidden and blocks collectors/messages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {signWorkbenchActor} from '../src/main/workbench-auth.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-exporter-runtime-')),taskId=randomUUID();let child;
try{
  const db=new DatabaseSync(path.join(dir,'orders.sqlite')),now=new Date().toISOString();db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,platform TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE task_orders(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,order_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(task_id,order_id));');
  const task={id:taskId,platform:'jd',account:'隔离测试账号',accountCookie:'must-not-transfer',accountKey:'fixture-account-key',from:'2026-01-01',to:'2026-01-31',status:'completed',createdAt:now,updatedAt:now,count:1,pages:1,message:'隔离测试，不进行真实采集',cursor:'must-not-transfer-cursor',exportedPath:'',listOutcome:'complete'};
  const order={platform:'jd',account:task.account,id:'123456789012345678901234567890',createdAt:'2026-01-12',paidAt:'',shippedAt:'',completedAt:'',status:'完成',shop:'隔离测试供应商',sellerId:'',paidFen:12345,freightFen:0,refundFen:null,refundStatus:'待核对',receiver:'',phone:'',address:'',logistics:'',tracking:'',remark:'',detailUrl:'',items:[{id:'fixture-item',title:'隔离演示商品',spec:'',quantity:2,unitPriceFen:null,imageUrl:'',productUrl:''}],extra:{},missing:['refund'],source:'page',capturedAt:now};
  db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(taskId,'jd',JSON.stringify(task));db.prepare('INSERT INTO task_orders VALUES(?,?,?)').run(taskId,order.id,JSON.stringify(order));db.close();
  const env={...process.env,ORDERDESK_TEST_DATA:dir,LINGTU_MAINTENANCE:'1',LINGTU_MANAGED_MODULE:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  child=spawn(path.resolve('node_modules/electron/dist/electron.exe'),['.'],{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',chunk=>{output+=chunk.toString().slice(0,1000);});
  const runtimeFile=path.join(dir,'.integration-runtime.json');for(let i=0;i<120&&!fs.existsSync(runtimeFile);i++){if(child.exitCode!==null)throw Error('isolated exporter exited before integration startup: '+output.slice(0,2000));await delay(250);}assert.ok(fs.existsSync(runtimeFile),'isolated exporter integration did not start');
  const runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8')),key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim(),token=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
  const request=async(route,{method='GET',body}={})=>{const target='/api/integration/v1/workbench'+route,stamp=Date.now(),actor={v:1,id:'tailscale:tester@example.test',login:'tester@example.test',role:'admin',modules:['exporter','purchase'],canRunTasks:true,sessionId:'runtime-test',channel:'ui',requestId:randomUUID(),issuedAt:stamp,expiresAt:stamp+30000,module:'exporter',method,path:target};const response=await fetch(runtime.url+target,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...signWorkbenchActor(actor,key)},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};};
  const state=await request('/state');assert.equal(state.status,200);assert.equal(state.body.tasks[0].id,taskId);assert.equal(state.body.tasks[0].accountCookie,undefined);assert.equal(state.body.tasks[0].cursor,undefined);const result=await request('/tasks/'+taskId+'/orders');assert.equal(result.status,200);assert.equal(result.body.orders[0].id,order.id);assert.equal((await request('/ui')).status,200);assert.equal((await request('/ui/app.js')).status,200);
  const exported=await request('/migration/export');assert.equal(exported.status,200);assert.equal(exported.body.module,'exporter');assert.equal(JSON.stringify(exported.body).includes('must-not-transfer'),false);assert.equal((await request('/migration/commit',{method:'POST',body:{plan:{},permit:{}}})).status,409);assert.equal((await request('/tasks',{method:'POST',body:{platform:'jd',from:'2026-01-01',to:'2026-01-31'}})).status,503);
  process.stdout.write(JSON.stringify({ok:true,actualElectron:true,isolatedData:true,remoteState:true,longOrderId:true,uiAssets:true,migrationExport:true,credentialsExcluded:true,maintenanceBlocksCollector:true})+'\n');
  const exited=once(child,'exit');const stop=await fetch(runtime.url+'/api/integration/v1/stop',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});assert.equal(stop.status,200);await Promise.race([exited,delay(10000).then(()=>{throw Error('isolated exporter did not stop');})]);child=undefined;
}finally{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await Promise.race([exited,delay(3000)]);}fs.rmSync(dir,{recursive:true,force:true});}
