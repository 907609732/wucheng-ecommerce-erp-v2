import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../lib/store.mjs';
import {validateOrder} from '../lib/importer.mjs';
import {openTaskCenter} from '../lib/task-center.mjs';
import {openPurchasePersonnel} from '../lib/purchase-personnel.mjs';
import {openTaskAssignment} from '../lib/task-assignment.mjs';

const month='2020-01',taskId='collect:微信';
const remote=(login,role='editor')=>({headers:{},workbenchActor:{id:'tailscale:'+login,login,role,modules:['purchase'],channel:'ui',sessionId:'session-'+login}});
const order=()=>validateOrder({platform:'微信',account:'真实账号',orderNo:'ASSIGN-001',date:'2020-01-02',paidAt:'2020-01-03',supplier:'商家',status:'已完成',amountCents:10000,refundCents:0,shippingCents:0,note:'',items:[{title:'商品',qty:1,unitPriceCents:10000}]});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-assign-')),store=openStore(dir),tasks=openTaskCenter(store),personnel=openPurchasePersonnel(store),board=openTaskAssignment(store,tasks,personnel);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const boss={headers:{}},headers={};personnel.select(boss,{setHeader:(name,value)=>headers[name]=value},{role:'boss'});
 const add=(name,role='employee',workbenchActorId='')=>personnel.save(boss,{name,role,workbenchActorId,active:true});
 const alice=add('小陈','employee','tailscale:alice@test'),bob=add('小李','employee','tailscale:bob@test'),bossStaff=add('远程老板','boss','tailscale:boss@test');
 const a=remote('alice@test'),b=remote('bob@test'),admin=remote('boss@test','admin');
 const act=(req,action,extra={})=>board.act(req,{month,taskId,action,revision:board.overview(req,month).revision,...extra});
 const assigned=()=>act(boss,'assign',{assigneeId:alice.id,dueOn:'2020-02-01',instructions:'核对全部采购账号'});
 return {dir,store,tasks,personnel,board,boss,headers,add,alice,bob,bossStaff,a,b,admin,act,assigned};
}

test('本机分工使用HttpOnly会话，员工ID有效且人员持久化；普通列表不泄露账号映射',t=>{
 const f=fixture(t),{personnel,boss,headers,alice,store}=f;
 assert.match(headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);assert.equal(personnel.current(boss).staff.id,'local-owner');assert.equal(personnel.current({headers:{}}).selected,false);
 const brief=personnel.list({headers:{}});assert.equal(brief.some(s=>s.id===alice.id),true);assert.equal(brief.every(s=>!Object.hasOwn(s,'workbenchActorId')&&!Object.hasOwn(s,'revision')),true);
 const employee={headers:{}};personnel.select(employee,{setHeader(){}},{role:'employee',staffId:alice.id});assert.equal(personnel.current(employee).staff.id,alice.id);
 assert.throws(()=>personnel.select({headers:{}},{setHeader(){}},{role:'employee',staffId:'missing'}),e=>e.code==='PERSONNEL_STAFF_INVALID');
 assert.equal(openPurchasePersonnel(store).list(boss).some(s=>s.id===alice.id),true);
 assert.throws(()=>personnel.save(employee,{name:'越权',role:'boss'}),e=>e.code==='PERSONNEL_BOSS_REQUIRED');
 const current=personnel.list(boss).find(s=>s.id===alice.id),disabled=personnel.save(boss,{...current,active:false});assert.equal(disabled.active,false);assert.equal(personnel.current(employee).selected,false);
 assert.throws(()=>f.board.act(employee,{month,taskId,action:'start',revision:f.board.overview(employee,month).revision}),e=>e.code==='PERSONNEL_REQUIRED');
});

test('真实登录成员同等访问全部任务，旧role不再授权且表单不能冒充他人',t=>{
 const f=fixture(t),{personnel,board,a}=f,unmapped=remote('new@test'),viewer=remote('viewer@test','viewer');
 assert.equal(personnel.current(a).role,'boss');assert.equal(personnel.current(viewer).readOnly,false);
 assert.equal(personnel.current(unmapped).selected,true);assert.equal(personnel.current(unmapped).staff,null);
 for(const req of [a,unmapped,viewer])assert.equal(board.overview(req,month).tasks.length,board.overview(f.boss,month).tasks.length);
 assert.throws(()=>personnel.select(a,{setHeader(){}},{role:'employee',staffId:f.bob.id}),e=>e.code==='PERSONNEL_ROLE_DENIED');
 f.act(viewer,'assign',{assigneeId:f.alice.id});assert.equal(board.overview(viewer,month).tasks.find(t=>t.id===taskId).assignment.assigneeId,f.alice.id);
});

test('登录成员可操作共享任务，提交和验收保留真实操作者且不锁月',t=>{
 const f=fixture(t),{store,board,boss,a,b,act}=f;store.insert(order(),null);
 f.assigned();const employee=board.overview(a,month),other=board.overview(b,month);assert.equal(employee.tasks.length,board.overview(boss,month).tasks.length);assert.equal(other.tasks.length,employee.tasks.length);
 assert.equal(employee.tasks.find(t=>t.id===taskId).permissions.canStart,true);assert.equal(employee.tasks.find(t=>t.id===taskId).permissions.canAssign,true);
 act(b,'start');assert.throws(()=>act(a,'submit',{note:'已完成',ack:false}),e=>e.code==='ASSIGNMENT_SUBMISSION_REQUIRED');
 const submitted=act(a,'submit',{note:'已核查全部采购账号及原始订单',ack:true});assert.equal(submitted.tasks.find(t=>t.id===taskId).assignment.state,'submitted');assert.equal(store.db.prepare('SELECT count(*) n FROM monthly_tasks').get().n,0);
 assert.equal(board.overview(a,month).tasks.find(t=>t.id===taskId).permissions.canReview,true);
 const accepted=act(boss,'accept',{note:'抽查原单一致'}),task=accepted.tasks.find(t=>t.id===taskId);assert.equal(task.assignment.state,'accepted');assert.equal(task.completed,true);assert.equal(store.db.prepare('SELECT status FROM monthly_tasks WHERE month=? AND task_id=?').get(month,taskId).status,'done');assert.equal(store.monthLocks.confirmations().length,0);
 assert.deepEqual(store.db.prepare('SELECT action FROM purchase_task_assignment_events ORDER BY id').all().map(r=>r.action),['assign','start','submit','accept']);
 const reopened=openStore(f.dir);try{const p=openPurchasePersonnel(reopened),d=openTaskAssignment(reopened,openTaskCenter(reopened),p);assert.equal(d.overview(f.admin,month).tasks.find(t=>t.id===taskId).assignment.state,'accepted');}finally{reopened.close();}
});

test('退回必填原因，员工补充重提；重新分派清空旧提交且旧人工勾选不能当验收',t=>{
 const f=fixture(t),{tasks,board,boss,a,b,act}=f;
 tasks.update({month,taskId,status:'done',operator:'历史经办人',ack:true,revision:tasks.overview(month).revision});assert.equal(board.overview(boss,month).tasks.find(t=>t.id===taskId).completed,false);
 f.assigned();act(a,'start');act(a,'submit',{note:'已查账号',ack:true});assert.throws(()=>act(boss,'return'),e=>e.code==='ASSIGNMENT_RETURN_REASON_REQUIRED');
 const returned=act(boss,'return',{note:'请补充账号核对范围'}).tasks.find(t=>t.id===taskId);assert.equal(returned.assignment.state,'returned');assert.equal(returned.assignment.reviewNote,'请补充账号核对范围');
 act(a,'submit',{note:'已补全部账号核对说明',ack:true});act(boss,'accept');
 const reassigned=act(boss,'assign',{assigneeId:f.bob.id}).tasks.find(t=>t.id===taskId);assert.equal(reassigned.assignment.state,'assigned');assert.equal(reassigned.assignment.submittedAt,null);assert.equal(reassigned.assignment.submissionNote,'');assert.equal(reassigned.completed,false);assert.equal(board.overview(a,month).tasks.length,board.overview(b,month).tasks.length);
 assert.throws(()=>act(a,'submit',{note:'任务尚未开始',ack:true}),e=>e.code==='ASSIGNMENT_NOT_OWNER');
});

test('数据变化使提交和已验收失效，旧revision拒绝并发，停用和真实月锁阻止操作',async t=>{
 const f=fixture(t),{store,personnel,board,boss,a,act}=f;const original=store.insert(order(),null);f.assigned();const old=board.overview(boss,month).revision;
 act(a,'start');assert.throws(()=>act(boss,'assign',{assigneeId:f.bob.id,revision:old}),e=>e.code==='ASSIGNMENT_REVISION_CHANGED');
 act(a,'submit',{note:'数据完整',ack:true});const submitted=board.overview(boss,month).revision,edited=store.update(original.id,{...original,note:'新增核对依据'});
 assert.equal(board.overview(a,month).tasks.find(t=>t.id===taskId).assignment.state,'stale');assert.throws(()=>act(boss,'accept',{revision:submitted}),e=>e.code==='ASSIGNMENT_REVISION_CHANGED');assert.throws(()=>act(boss,'accept'),e=>e.code==='ASSIGNMENT_SUBMISSION_STALE');
 act(a,'submit',{note:'已核对新增依据',ack:true});act(boss,'accept');store.update(edited.id,{...edited,note:'验收后补资料'});assert.equal(board.overview(a,month).tasks.find(t=>t.id===taskId).assignment.state,'stale');assert.equal(board.overview(a,month).tasks.find(t=>t.id===taskId).completed,false);
 const staff=personnel.list(boss).find(s=>s.id===f.alice.id);personnel.save(boss,{...staff,active:false});act(a,'submit',{note:'历史人员停用不再剥夺真实登录访问',ack:true});
 assert.throws(()=>act(boss,'assign',{assigneeId:f.alice.id}),e=>e.code==='ASSIGNMENT_STAFF_INVALID');act(boss,'assign',{assigneeId:f.bob.id});
 await store.monthLocks.setPassword({password:'Assignment-month-lock-842761',confirmation:'Assignment-month-lock-842761'});store.monthLocks.confirm(store.monthLocks.preview(month,'微信'));
 const lockedBoard=board.overview(boss,month),locked=lockedBoard.tasks.find(t=>t.id===taskId);assert.equal(locked.status,'locked');assert.equal(locked.assignment.state,'assigned');assert.equal(Object.values(locked.permissions).every(v=>!v),true);assert.equal(lockedBoard.workflowSummary.assigned,0);assert.equal(lockedBoard.workflowSummary.unassigned,11);assert.equal(board.overview(f.b,month).workflowSummary.mine,0);assert.throws(()=>act(f.b,'start'),e=>e.code==='ASSIGNMENT_MONTH_LOCKED');
});

test('无采购提交需真实零订单，老板本人可接任务；系统owner、自己停用和人员并发受保护',t=>{
 const f=fixture(t),{personnel,boss,admin,board,act}=f;
 assert.throws(()=>personnel.save(boss,{id:'local-owner',name:'修改系统老板',role:'employee',active:false,revision:'x'}),e=>e.code==='PERSONNEL_OWNER_IMMUTABLE');
 assert.throws(()=>personnel.save(admin,{...f.bossStaff,active:false}),e=>e.code==='PERSONNEL_SELF_DISABLE');
 const duplicate=personnel.save(boss,{name:f.alice.name,role:'employee',active:true});assert.notEqual(duplicate.id,f.alice.id);
 const changed=personnel.save(boss,{...duplicate,name:'改名'});assert.throws(()=>personnel.save(boss,{...duplicate,name:'过期更改'}),e=>e.code==='PERSONNEL_REVISION_CHANGED');assert.ok(changed.revision);
 act(boss,'assign',{assigneeId:'local-owner'});act(boss,'start');act(boss,'submit',{result:'no_activity',note:'已检查全部账号，无采购',ack:true});act(boss,'accept');assert.equal(board.overview(boss,month).tasks.find(t=>t.id===taskId).status,'no_activity');
 assert.throws(()=>act(boss,'assign',{taskId:'confirm:微信',assigneeId:f.alice.id}),e=>e.code==='ASSIGNMENT_CONFIRM_PROTECTED');
 assert.throws(()=>act(boss,'assign',{assigneeId:f.bob.id,dueOn:'2020-02-31'}),e=>e.code==='ASSIGNMENT_DUE_INVALID');
 f.store.insert(order(),null);act(boss,'start');assert.throws(()=>act(boss,'submit',{result:'no_activity',note:'有订单不能无采购',ack:true}),e=>e.code==='ASSIGNMENT_RESULT_INVALID');
});

test('验收写入失败时，旧人工核对、分派状态与审计整笔回滚',t=>{
 const f=fixture(t),{store,boss,a,act,board}=f;f.assigned();act(a,'start');act(a,'submit',{note:'已经核对全部账号',ack:true});
 const revision=board.overview(boss,month).revision,eventCount=store.db.prepare('SELECT count(*) n FROM purchase_task_assignment_events').get().n;
 store.db.exec("CREATE TRIGGER test_assignment_accept_abort BEFORE INSERT ON purchase_task_assignment_events WHEN NEW.action='accept' BEGIN SELECT RAISE(ABORT,'test accept rollback'); END");
 assert.throws(()=>act(boss,'accept'),/test accept rollback/);assert.equal(store.db.prepare('SELECT count(*) n FROM monthly_tasks').get().n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM monthly_task_events').get().n,0);assert.equal(board.overview(boss,month).tasks.find(t=>t.id===taskId).assignment.state,'submitted');assert.equal(board.overview(boss,month).revision,revision);assert.equal(store.db.prepare('SELECT count(*) n FROM purchase_task_assignment_events').get().n,eventCount);
});
