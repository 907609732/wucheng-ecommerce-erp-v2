import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../apps/sales/server.mjs';
import {signWorkbenchActor} from '../apps/sales/lib/workbench-actor.mjs';
import {openStore} from '../apps/sales/lib/db.mjs';
import {makeBackup,restoreBackup} from '../apps/sales/lib/backup.mjs';

test('signed sales UI must configure password before locking; wrong password cannot unlock',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-month-http-')),port=19884;
 const {app,store}=createApp({dataDir:dir,port});
 const server=app.listen(port,'127.0.0.1');
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim();
 const request=async(route,body,channel='ui')=>{
  const method=body?'POST':'GET',at=Date.now(),actor={v:1,id:'tailscale:month-test',login:'month-test',role:'admin',canRunTasks:true,modules:['sales'],channel,sessionId:'isolated-month-session',requestId:randomUUID(),issuedAt:at,expiresAt:at+30000,module:'sales',method,path:route};
  return fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{...signWorkbenchActor(actor,key),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 };
 const scope={month:'2025-01',kind:'sales',shop_id:store.shops()[0].id};
 const query=new URLSearchParams(scope);
 let response=await request('/api/reconciliation/preview?'+query);
 assert.equal(response.status,200,await response.clone().text());
 let preview=await response.json();
 response=await request('/api/reconciliation/lock',{...scope,revision:preview.revision,mode:'zero',confirmed:true});
 assert.equal(response.status,409);
 const password='Isolated-month-password-123';
 response=await request('/api/month-admin/password',{password,confirmation:password});
 assert.equal(response.status,200,await response.clone().text());
 response=await request('/api/reconciliation/preview?'+query);preview=await response.json();
 response=await request('/api/reconciliation/lock',{...scope,revision:preview.revision,mode:'zero',confirmed:true});
 assert.equal(response.status,200,await response.clone().text());
 const locked=await response.json();
 assert.equal(store.get('SELECT COUNT(*) n FROM ledger').n,0,'zero confirmation never invents ledger rows');
 response=await request('/api/reconciliation/unlock',{...scope,version:locked.lock.version,password:'wrong-password',reason:'isolated test'});
 assert.equal(response.status,403);
 assert.equal(store.get('SELECT COUNT(*) n FROM reconciliation_locks').n,1);
 response=await request('/api/reconciliation/unlock',{...scope,version:locked.lock.version,password,reason:'isolated test'});
 assert.equal(response.status,200,await response.clone().text());
 assert.equal(store.get('SELECT COUNT(*) n FROM reconciliation_locks').n,0);
 response=await request('/api/month-admin/password',{password:'Another-isolated-password',confirmation:'Another-isolated-password'},'mcp');
 assert.equal(response.status,403,'password changes require real UI');
 assert(!JSON.stringify(store.all('SELECT * FROM audit')).includes(password));
});

test('standalone sales recovery preserves its configured unlock password',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-month-recovery-')),s=openStore(dir);
 try{
  const password='Isolated-recovery-password';await s.monthAdmin.setPassword({password,confirmation:password});
  const b=await makeBackup(s),target=path.join(dir,'restored');restoreBackup(s,b.name,target);
  const restored=openStore(target);
  try{assert.equal(restored.monthAdmin.configured(),true);assert.equal(await restored.monthAdmin.verify(password),true);await assert.rejects(restored.monthAdmin.setPassword({password:'replacement-password',confirmation:'replacement-password'}));}
  finally{restored.close();}
 }finally{s.close();fs.rmSync(dir,{recursive:true,force:true});}
});
