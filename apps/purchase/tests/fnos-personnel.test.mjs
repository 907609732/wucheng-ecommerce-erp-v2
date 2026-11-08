import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openStore} from '../lib/store.mjs';
import {openPurchasePersonnel} from '../lib/purchase-personnel.mjs';
import {validatePurchaseAgentInput as validate} from '../lib/agent-schemas.mjs';
const valid=['fnos:nas_1-A:0','fnos:f3589ebc5e0145b089cde167cef7e7cbbe3194ed:1000','fnos:'+ 'a'.repeat(80)+':9999999999'];
const invalid=['fnos:nas:01','fnos:nas:-1','fnos:nas:10000000000','fnos::1000','fnos:'+ 'a'.repeat(81)+':1000','fnos:nas/name:1000','fnos:nas:1000:extra','fnos:nas:1\n'];
const req=id=>({headers:{},workbenchActor:{id,login:'同名员工',label:'同名员工',modules:['purchase']}});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fnos-personnel-')),store=openStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return openPurchasePersonnel(store);}
test('personnel save accepts precise fnOS IDs and preserves existing Tailscale save behavior',t=>{
 const p=fixture(t),admin=req('tailscale:admin@example.test');
 for(const id of [...valid,'tailscale:old@example.test'])assert.equal(p.save(admin,{name:'测试员工',role:'employee',workbenchActorId:id}).workbenchActorId,id);
 for(const id of invalid.filter(id=>!id.endsWith('\n')))assert.throws(()=>p.save(admin,{name:'测试员工',role:'employee',workbenchActorId:id}),e=>e.code==='PERSONNEL_ACTOR_INVALID');
});
test('explicit fnOS binding preserves staff identity, duplicate names and conflict protection',t=>{
 const p=fixture(t),admin=req('windows:S-1-5-21-123'),one=p.save(admin,{name:'同名员工',role:'employee'}),two=p.save(admin,{name:'同名员工',role:'employee'}),actor=req(valid[1]);
 assert.equal(p.current(actor).staff,null);assert.equal(p.current(actor).canSubmit,true);
 for(const id of [...valid,'tailscale:old@example.test','windows:S-1-5-21-123'])assert.equal(p.previewBinding(admin,{staffId:one.id,revision:one.revision,actorId:id}).after.workbenchActorId,id);
 for(const id of invalid)assert.throws(()=>p.previewBinding(admin,{staffId:one.id,revision:one.revision,actorId:id}),e=>e.code==='PERSONNEL_ACTOR_INVALID');
 const result=p.bind(admin,{staffId:one.id,revision:one.revision,actorId:valid[1],reason:'明确选择历史人员ID'});assert.equal(result.staff.id,one.id);assert.equal(result.historicalAssignmentsPreserved,true);assert.equal(p.current(actor).staff.id,one.id);
 assert.equal(p.mapping(admin).staff.find(s=>s.id===two.id).workbenchActorId,'');assert.throws(()=>p.bind(admin,{staffId:two.id,revision:two.revision,actorId:valid[1]}),e=>e.code==='PERSONNEL_ACTOR_CONFLICT');
});
test('people.bind schema accepts precise fnOS identities and rejects malformed IDs',()=>{
 for(const actorId of [...valid,'tailscale:old@example.test','windows:S-1-5-21-123'])assert.doesNotThrow(()=>validate('people.bind',{staffId:'historical',actorId,revision:'revision',reason:'用户明确选择'}));
 for(const actorId of invalid)assert.throws(()=>validate('people.bind',{staffId:'historical',actorId,revision:'revision',reason:'测试非法ID'}));
});
