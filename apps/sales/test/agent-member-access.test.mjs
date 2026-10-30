// Written for the final access decision; run only after the coordinated code freeze.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';import {signWorkbenchActor} from '../lib/workbench-actor.mjs';import {createPersonnel} from '../lib/personnel.mjs';
test('every signed-in member has equal business access while financial commit still requires review',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-member-access-')),created=createApp({dataDir:dir,port:0,demo:true}),server=created.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await created.cainiao.close();await new Promise(resolve=>server.close(resolve));created.store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim();
 const call=async(route,{method='GET',body,role='viewer',headers={}}={})=>{const url='/api/integration/v1/agent/'+route,issuedAt=Date.now();return fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{...signWorkbenchActor({v:1,id:'signed-member',login:'signed-member',role,modules:[],canRunTasks:false,module:'sales',channel:'mcp',sessionId:'member-session',requestId:randomUUID(),issuedAt,expiresAt:issuedAt+60000,method,path:url},key),'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});};
 for(const role of ['viewer','editor','admin']){const response=await call('query?'+new URLSearchParams({capabilityId:'sales.report',input:JSON.stringify({period:'2026-09'})}),{role});assert.equal(response.status,200);}
 const binding=await(await call('binding')).json(),input={channel:'warehouse',entry_mode:'month',period:'2026-09',shipping:'10.00'},preparedResponse=await call('prepare',{method:'POST',body:{taskId:'member-task',capabilityId:'sales.freight-create',input}});assert.equal(preparedResponse.status,200);
 const prepared={binding,capabilityId:'sales.freight-create',input,...await preparedResponse.json()},commit=await call('commit',{method:'POST',body:{prepared},headers:{'Idempotency-Key':'member-unapproved'}});assert.equal(commit.status,403);assert.equal(created.store.get('SELECT COUNT(*) n FROM freight_records').n,0);
 const personnel=createPersonnel(created.store).current({headers:{},workbenchActor:{id:'signed-member',role:'viewer',channel:'mcp'}});assert.equal(personnel.selected,true);assert.equal(personnel.canSubmit,true);assert.equal(personnel.canReconcile,true);assert.equal(personnel.readOnly,false);
});
