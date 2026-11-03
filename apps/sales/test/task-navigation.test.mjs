import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp,createSessionFetch} from './helpers.mjs';
import {addLedger} from '../lib/ledger.mjs';

test('bootstrap counts pending edits through review and confirmation, excluding completed changes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-task-navigation-'));
 const port=18873,{app,store}=createApp({dataDir:dir,port,demo:true});
 const server=app.listen(port,'127.0.0.1');
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`;
 const fetch=await createSessionFetch(base,'boss');
 const bootstrap=async()=>{const response=await fetch(base+'/api/bootstrap');assert.equal(response.status,200);return response.json();};
 assert.equal((await bootstrap()).pendingEdits,0);
 const record=addLedger(store,{shop_id:'offline',date:'2025-09-01',kind:'sale',amount:'12.34',external_id:'navigation-edit-test'});
 const key=fs.readFileSync(path.join(dir,'.integration-key'),'utf8').trim();
 const proposed=await fetch(base+'/api/integration/v1/edits',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({type:'ledger',target:record.id,patch:{note:'核对纸质收据'},reason:'任务中心导航状态测试'})});
 assert.equal(proposed.status,200);
 const draft=await proposed.json();
 assert.equal((await bootstrap()).pendingEdits,1);
 // The count must include pending records older than the review list's 100-row limit.
 for(let i=0;i<105;i++)store.run("INSERT INTO integration_edit_drafts(id,type,target,before_json,proposed_json,reason,revision,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)",`completed-${i}`,'ledger',record.id,'{}','{}','历史已完成记录','historical','committed',new Date(Date.UTC(2099,0,1,0,i)).toISOString());
 assert.equal((await bootstrap()).pendingEdits,1);
 const sessionResponse=await fetch(base+'/api/integration/v1/review-session',{headers:{'sec-fetch-site':'same-origin',Referer:base+'/integration-edits.html'}});
 assert.equal(sessionResponse.status,200);
 const session=await sessionResponse.json(),cookie=sessionResponse.headers.get('set-cookie').split(';')[0];
 const confirmed=await fetch(base+`/api/integration/v1/edits/${draft.id}/commit`,{method:'POST',headers:{'Content-Type':'application/json','x-review-token':session.nonce,Cookie:cookie},body:JSON.stringify({revision:draft.revision})});
 assert.equal(confirmed.status,200);
 assert.equal((await confirmed.json()).verified,true);
 assert.equal((await bootstrap()).pendingEdits,0);
 assert.equal(store.get('SELECT note FROM ledger WHERE id=?',record.id).note,'核对纸质收据');
});
