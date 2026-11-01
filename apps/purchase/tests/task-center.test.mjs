import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../lib/store.mjs';
import {validateOrder} from '../lib/importer.mjs';
import {openTaskCenter} from '../lib/task-center.mjs';
import {createApp} from '../server.mjs';

const month='2020-01',operator='兼职经办人';
const order=(id='TASK-1',extra={})=>validateOrder({platform:'微信',account:'真实账号',orderNo:id,date:'2020-01-02',paidAt:'2020-01-03',supplier:'测试商家',status:'已完成',amountCents:10000,refundCents:0,shippingCents:0,note:'',items:[{title:'测试商品',qty:1,unitPriceCents:10000}],...extra});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-tasks-')),store=openStore(dir),center=openTaskCenter(store);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const update=(taskId,status='done',extra={})=>center.update({month,taskId,status,operator,ack:true,revision:center.overview(month).revision,...extra});
 return {dir,store,center,update};
}

test('每月固定19项任务，零订单仍待核对，按业务月份和全部账号展示真实证据',t=>{
 const {center,store}=fixture(t),empty=center.overview(month);
 assert.equal(empty.tasks.length,19);assert.equal(empty.summary.completed,0);assert.equal(empty.tasks.filter(t=>t.kind==='collect').length,7);assert.equal(empty.tasks.some(t=>t.platform==='手工'),false);
 store.insert(order(),null);store.insert(order('TASK-2',{account:'第二账号',paidAt:'',refundCents:500}),null);store.insert(order('OTHER-MONTH',{paidAt:'2020-02-01'}),null);
 const data=center.overview(month),wechat=data.tasks.find(t=>t.id==='collect:微信');
 assert.equal(data.summary.orderCount,2);assert.equal(wechat.evidence.count,2);assert.deepEqual(wechat.evidence.accounts,['真实账号','第二账号'].sort());assert.equal(wechat.evidence.missingPaidCount,1);assert.equal(wechat.evidence.refundCents,500);assert.equal(wechat.completed,false);
 assert.throws(()=>center.overview('2020-13'),e=>e.code==='INVALID_MONTH_SCOPE');
});

test('人工完成与无采购必须明确确认，进度持久化且不写采购数据或月锁',t=>{
 const {store,center,dir,update}=fixture(t),before=store.db.prepare('SELECT * FROM orders').all();
 assert.throws(()=>update('collect:微信','done',{operator:''}),e=>e.code==='TASK_OPERATOR_REQUIRED');
 assert.throws(()=>update('collect:微信','done',{ack:false}),e=>e.code==='TASK_ACK_REQUIRED');
 assert.throws(()=>update('collect:微信','no_activity'),e=>e.code==='INVALID_NO_ACTIVITY');
 const next=update('collect:微信','no_activity',{note:'已检查全部账号，本月没有采购'});
 assert.equal(next.summary.completed,1);assert.equal(next.tasks.find(t=>t.id==='collect:微信').status,'no_activity');
 assert.equal(openTaskCenter(store).overview(month).tasks.find(t=>t.id==='collect:微信').mark.operator,operator);
 const reopened=openStore(dir);try{assert.equal(openTaskCenter(reopened).overview(month).summary.completed,1);}finally{reopened.close();}
 assert.deepEqual(store.db.prepare('SELECT * FROM orders').all(),before);assert.equal(store.monthLocks.confirmations().length,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM monthly_task_events').get().n,1);
 assert.throws(()=>update('review:refunds','no_activity',{note:'本月没有采购'}),e=>e.code==='INVALID_NO_ACTIVITY');
});

test('数据新增、编辑和删除使相应完成失效，其他平台任务保持，不能把有订单标无采购',t=>{
 const {store,center,update}=fixture(t);
 update('collect:微信','no_activity',{note:'已查全账号'});update('collect:淘宝','done');update('review:refunds','done');
 const inserted=store.insert(order(),null),data=center.overview(month);
 assert.equal(data.tasks.find(t=>t.id==='collect:微信').status,'stale');assert.equal(data.tasks.find(t=>t.id==='review:refunds').status,'stale');assert.equal(data.tasks.find(t=>t.id==='collect:淘宝').status,'done');
 assert.throws(()=>update('collect:微信','no_activity',{note:'错误标记'}),e=>e.code==='INVALID_NO_ACTIVITY');
 update('collect:微信','done');const edited=store.update(inserted.id,{...inserted,note:'补充原单信息'});assert.equal(center.overview(month).tasks.find(t=>t.id==='collect:微信').status,'stale');
 update('collect:微信','done');store.db.prepare('DELETE FROM orders WHERE id=?').run(edited.id);assert.equal(center.overview(month).tasks.find(t=>t.id==='collect:微信').status,'stale');
});

test('乐观锁拒绝旧页面、数据变化和重置后的旧版本，且失败不留任务事件',t=>{
 const {store,center,update}=fixture(t),first=center.overview(month).revision;
 update('collect:微信','done');const count=()=>store.db.prepare('SELECT count(*) AS n FROM monthly_task_events').get().n;
 assert.throws(()=>update('collect:淘宝','done',{revision:first}),e=>e.code==='TASK_REVISION_CHANGED');assert.equal(count(),1);
 update('collect:微信','pending');assert.notEqual(center.overview(month).revision,first);assert.equal(center.overview(month).tasks.find(t=>t.id==='collect:微信').status,'pending');
 const revision=center.overview(month).revision;store.insert(order(),null);
 assert.throws(()=>update('collect:微信','done',{revision}),e=>e.code==='TASK_REVISION_CHANGED');assert.equal(count(),2);
});

test('真实月锁决定确认任务完成并保护进度，全平台锁定后全月复核自动显示锁定',async t=>{
 const {store,center,update}=fixture(t);
 assert.throws(()=>update('confirm:微信','done'),e=>e.code==='TASK_NOT_WRITABLE');
 await store.monthLocks.setPassword({password:'Task-center-test-842761',confirmation:'Task-center-test-842761'});
 store.monthLocks.confirm(store.monthLocks.preview(month,'微信'));
 const partly=center.overview(month);assert.equal(partly.tasks.find(t=>t.id==='confirm:微信').status,'locked');assert.equal(partly.tasks.find(t=>t.id==='collect:微信').canMark,false);assert.equal(partly.tasks.find(t=>t.id==='review:refunds').canMark,true);
 assert.throws(()=>update('collect:微信','done'),e=>e.code==='TASK_NOT_WRITABLE');
 for(const task of partly.tasks.filter(t=>t.kind==='confirm'&&t.platform!=='微信'))store.monthLocks.confirm(store.monthLocks.preview(month,task.platform));
 const locked=center.overview(month);assert.equal(locked.summary.lockedPlatforms,7);assert.equal(locked.summary.completed,19);assert.equal(locked.tasks.every(t=>t.status==='locked'&&!t.canMark),true);
 assert.throws(()=>update('review:refunds','done'),e=>e.code==='TASK_NOT_WRITABLE');
});

test('任务HTTP读取不写进度，写入必须带页面token并遵守版本、任务权限和月份校验',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-task-http-')),{app,store}=createApp({dataDir:dir}),server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(url+'/api/bootstrap')).json();
 const read=await fetch(url+'/api/tasks?month='+month),initial=await read.json();assert.equal(read.status,200);assert.equal(initial.tasks.length,19);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM monthly_tasks').get().n,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM monthly_task_events').get().n,0);
 const body={month,taskId:'collect:微信',status:'done',operator,ack:true,revision:initial.revision};
 const post=async(payload,authorized=true)=>{const response=await fetch(url+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Purchase-Token':token}:{})},body:JSON.stringify(payload)});return {status:response.status,data:await response.json()};};
 assert.equal((await post(body,false)).status,403);assert.equal(store.db.prepare('SELECT count(*) AS n FROM monthly_tasks').get().n,0);
 const saved=await post(body);assert.equal(saved.status,200);assert.equal(saved.data.tasks.length,19);assert.equal(saved.data.tasks.find(t=>t.id===body.taskId).status,'done');
 assert.equal((await post(body)).status,409);
 const denied=await post({...body,taskId:'confirm:微信',revision:saved.data.revision});assert.equal(denied.status,423);assert.equal(denied.data.code,'TASK_NOT_WRITABLE');
 assert.equal((await fetch(url+'/api/tasks?month=2020-13')).status,400);
 assert.equal((await post({...body,month:'bad-month',revision:saved.data.revision})).status,400);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM monthly_task_events').get().n,1);
});
