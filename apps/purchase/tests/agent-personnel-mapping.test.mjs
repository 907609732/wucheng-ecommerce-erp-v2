// Deferred to the coordinated full run; no live employee or ledger is used.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openStore} from '../lib/store.mjs';import {openPurchasePersonnel} from '../lib/purchase-personnel.mjs';import {openTaskCenter} from '../lib/task-center.mjs';import {openTaskAssignment} from '../lib/task-assignment.mjs';
const remote=(id,role='editor')=>({headers:{},workbenchActor:{id,role,channel:'mcp',modules:['purchase']}});
test('duplicate legacy names require explicit mapping and preserve historical task staff IDs',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-mapping-')),store=openStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const personnel=openPurchasePersonnel(store),center=openTaskCenter(store),board=openTaskAssignment(store,center,personnel),boss={headers:{}};personnel.select(boss,{setHeader(){}},{role:'boss'});
 const one=personnel.save(boss,{name:'同名员工',role:'employee'}),two=personnel.save(boss,{name:'同名员工',role:'employee'}),admin=remote('windows:S-1-5-21-123','admin'),alice=remote('tailscale:alice@example.test');
 assert.equal(personnel.current(alice).selected,true);assert.equal(personnel.current(alice).staff,null);assert.equal(personnel.mapping(admin).staff.filter(s=>s.name==='同名员工').length,2);
 const input={month:'2020-01',taskId:'collect:微信',action:'assign',assigneeId:one.id,revision:board.overview(boss,'2020-01').revision};board.act(boss,input);
 personnel.bind(admin,{staffId:one.id,actorId:alice.workbenchActor.id,revision:one.revision,reason:'管理员明确选择第一条人员ID'});
 assert.equal(personnel.current(alice).staff.id,one.id);assert.equal(personnel.current(alice).selected,true);
 const task=board.overview(alice,'2020-01').tasks.find(t=>t.id==='collect:微信');assert.equal(task.assignment.assigneeId,one.id);assert.equal(task.permissions.canStart,true);
 assert.equal(personnel.mapping(admin).staff.find(s=>s.id===two.id).workbenchActorId,'');
 assert.throws(()=>personnel.bind(admin,{staffId:two.id,actorId:alice.workbenchActor.id,revision:two.revision,reason:'冲突'}),e=>e.code==='PERSONNEL_ACTOR_CONFLICT');
 const bound=personnel.bind(alice,{staffId:two.id,actorId:'tailscale:other@example.test',revision:two.revision,reason:'已登录成员明确选择'});assert.equal(bound.staff.id,two.id);
 assert.throws(()=>personnel.bind(admin,{staffId:one.id,actorId:'tailscale:other@example.test',revision:one.revision,reason:'过期'}),e=>e.code==='PERSONNEL_REVISION_CHANGED');
 assert.equal(personnel.current(remote(alice.workbenchActor.id,'viewer')).readOnly,false);
});
