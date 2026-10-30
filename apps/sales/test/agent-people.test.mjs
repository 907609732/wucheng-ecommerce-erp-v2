import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openStore} from '../lib/db.mjs';import {createPersonnel} from '../lib/personnel.mjs';import {createSalesDomainPeople} from '../lib/agent-people.mjs';
test('same-name and anonymous historical identities require explicit IDs and never rewrite old ownership',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-person-mapping-')),store=openStore(dir);createPersonnel(store);const people=createSalesDomainPeople(store);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 store.run('INSERT INTO sales_staff_handoffs VALUES(?,?,?,?)','2026-01','legacy-person-A','2026-02-01','old');store.run('INSERT INTO sales_staff_handoffs VALUES(?,?,?,?)','2026-02','legacy-person-B','2026-03-01','old');
 const actor={id:'actual-login',login:'actual-login',role:'editor'},before=people.inspect(actor);assert.equal(before.mapping,null);assert.ok(before.candidates.every(row=>row.ambiguousName));
 assert.throws(()=>people.link(actor,{domainPersonId:'历史提交人（姓名未登记）',displayName:'同名',reason:'明确选择',revision:before.revision}),{code:'DOMAIN_PERSON_UNAVAILABLE'});
 const linked=people.link(actor,{domainPersonId:'legacy-person-A',displayName:'本人确认的姓名',reason:'本人核对历史标识',revision:before.revision});assert.equal(linked.confirmedBy,actor.id);assert.equal(people.requireMapping(actor).domain_person_id,'legacy-person-A');
 const other={id:'other-login',role:'editor'},state=people.inspect(other);assert.ok(!state.candidates.some(row=>row.id==='legacy-person-A'));
 assert.throws(()=>people.link(other,{domainPersonId:'legacy-person-A',displayName:'本人确认的姓名',reason:'不能冒领',revision:state.revision}),{code:'DOMAIN_PERSON_UNAVAILABLE'});
 assert.equal(store.get('SELECT submitted_by FROM sales_staff_handoffs WHERE month=?','2026-01').submitted_by,'legacy-person-A');
});
