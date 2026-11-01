import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
import {signWorkbenchActor} from '../lib/workbench-actor.mjs';

test('人员分派HTTP闭环、员工隔离、旧入口防绕过及远程签名权限',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-board-http-')),{app,store,integration}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');
 integration.attach(server);await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port,month='2020-01';
 const {token}=await(await fetch(base+'/api/bootstrap')).json();
 assert.equal((await(await fetch(base+'/api/bootstrap')).json()).pendingEditsCount,0);
 const insertDraft=store.db.prepare('INSERT INTO integration_edit_drafts(id,type,target,before_json,proposed_json,reason,revision,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
 insertDraft.run('pending-old','order','fixture','{}','{}','旧待确认记录','fixture','draft','2020-01-01');
 for(let i=0;i<105;i++)insertDraft.run('completed-'+i,'order','fixture','{}','{}','已完成记录','fixture','committed','2026-10-27');
 assert.equal((await(await fetch(base+'/api/bootstrap')).json()).pendingEditsCount,1,'超过100条已完成历史不能掩盖仍待确认的旧草稿');
 store.db.prepare("UPDATE integration_edit_drafts SET state='committed' WHERE id='pending-old'").run();
 assert.equal((await(await fetch(base+'/api/bootstrap')).json()).pendingEditsCount,0,'确认完毕后入口应隐藏，历史记录仍保留');
 async function request(route,body,cookie='',authorized=true){
  const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Purchase-Token':token}:{}),...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
 }
 assert.equal((await request('/api/personnel/session',{role:'boss'},'',false)).status,403);
 const boss=await request('/api/personnel/session',{role:'boss'});assert.equal(boss.data.canAssign,true);
 const a=await request('/api/personnel',{name:'员工甲',role:'employee',active:true,workbenchActorId:'tailscale:alice'},boss.cookie);
 const b=await request('/api/personnel',{name:'员工乙',role:'employee',active:true},boss.cookie);
 assert.equal(a.status,200);assert.ok(a.data.saved.id);assert.ok(a.data.staff.length>=2);assert.ok(b.data.staff.length>=3);
 const alice=await request('/api/personnel/session',{role:'employee',staffId:a.data.saved.id}),bob=await request('/api/personnel/session',{role:'employee',staffId:b.data.saved.id});
 const board=cookie=>request('/api/task-board?month='+month,undefined,cookie);
 let view=(await board(boss.cookie)).data;
 const assigned=await request('/api/task-board/action',{month,taskId:'collect:微信',action:'assign',assigneeId:a.data.saved.id,dueOn:'2020-02-10',instructions:'核对全部采购账号',revision:view.revision},boss.cookie);
 assert.equal(assigned.status,200);assert.equal((await board(alice.cookie)).data.tasks.length,1);assert.equal((await board(bob.cookie)).data.tasks.length,0);
 assert.equal((await request('/api/tasks',{month,taskId:'collect:微信',status:'done',operator:'冒充老板',ack:true,revision:assigned.data.revision},alice.cookie)).status,403);
 assert.equal((await request('/api/month-confirmations',{month,platform:'微信'},alice.cookie)).status,403);
 assert.equal((await request('/api/personnel',{name:'非法增员',role:'boss',active:true},alice.cookie)).status,403);
 assert.equal((await request('/api/task-board/action',{month,taskId:'collect:微信',action:'start',revision:assigned.data.revision},bob.cookie)).status,403);
 const started=await request('/api/task-board/action',{month,taskId:'collect:微信',action:'start',revision:assigned.data.revision},alice.cookie);assert.equal(started.status,200);
 const submitted=await request('/api/task-board/action',{month,taskId:'collect:微信',action:'submit',result:'no_activity',note:'已逐一核查，整月没有采购',ack:true,revision:started.data.revision},alice.cookie);assert.equal(submitted.status,200);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM monthly_tasks').get().n,0);
 view=(await board(boss.cookie)).data;assert.equal(view.workflowSummary.pendingReview,1);
 assert.equal((await request('/api/task-board/action',{month,taskId:'collect:微信',action:'accept',revision:view.revision},alice.cookie)).status,403);
 const accepted=await request('/api/task-board/action',{month,taskId:'collect:微信',action:'accept',note:'已查看说明',revision:view.revision},boss.cookie);assert.equal(accepted.status,200);
 assert.equal(accepted.data.tasks.find(task=>task.id==='collect:微信').assignment.state,'accepted');
 assert.equal(store.monthLocks.confirmations().length,0);
 const freshA=(await request('/api/personnel',undefined,boss.cookie)).data.staff.find(staff=>staff.id===a.data.saved.id);
 assert.equal((await request('/api/personnel',{...freshA,active:false},boss.cookie)).status,200);
 assert.equal((await request('/api/tasks',{month},alice.cookie)).status,403);
 assert.equal((await request('/api/month-confirmations',{month},alice.cookie)).status,403);

 const key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim();
 async function remote(route,{role='editor',id='tailscale:alice',body}={}){
  const method=body===undefined?'GET':'POST',now=Date.now(),actor={v:1,id,login:id.slice(9),role,modules:['purchase'],canRunTasks:true,sessionId:'remote-test',channel:'ui',requestId:randomUUID(),issuedAt:now,expiresAt:now+30000,module:'purchase',method,path:route};
  const res=await fetch(base+route,{method,headers:{...signWorkbenchActor(actor,key),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,data:res.headers.get('content-type')?.includes('json')?await res.json():await res.text()};
 }
 assert.equal((await remote('/task-cards.js')).status,200);
 assert.equal((await remote('/api/personnel/session',{body:{role:'boss'}})).status,403);
 assert.equal((await remote('/api/personnel',{role:'viewer',body:{name:'不可写',role:'employee',active:true}})).status,403);
 const remoteAdmin=await remote('/api/personnel/session',{role:'admin',id:'tailscale:owner'});assert.equal(remoteAdmin.data.role,'boss');assert.equal(remoteAdmin.data.canManagePersonnel,true);
 assert.equal((await remote('/api/tasks',{body:{month}})).status,403);
});
