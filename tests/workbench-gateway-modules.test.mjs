import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {createWorkbenchGateway} from '../desktop/workbench/gateway.mjs';

const projects=process.env.LINGTU_MODULE_TEST_ROOT||path.join(os.homedir(),'Documents','ChatGPT');
const roots={purchase:path.join(projects,'采购'),sales:path.join(projects,'销售台'),overview:path.join(projects,'采购','采购台和销售额台聚合')};
const available=Object.values(roots).every(root=>fs.existsSync(path.join(root,'server.mjs')));
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
test('real desk modules serve isolated ledgers and UI through gateway with no host tokens or path leakage',{skip:!available},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-desks-test-')),live={},servers=[];let gateway;
 t.after(async()=>{await gateway?.stop();for(const server of servers)await new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);});for(const module of Object.values(live)){await module.cainiao?.close();module.store.close();}fs.rmSync(dir,{recursive:true,force:true});});
 for(const id of ['purchase','sales','overview']){
  const {createApp}=await import(pathToFileURL(path.join(roots[id],'server.mjs')).href),port=await freePort(),dataDir=path.join(dir,id);
  const options={dataDir,port,...(id==='overview'?{sources:{purchase:path.join(dir,'purchase','purchases.sqlite'),sales:path.join(dir,'sales','sales.sqlite')}}:{})};
  const module=createApp(options);live[id]=module;const server=module.app.listen(port,'127.0.0.1');servers.push(server);module.integration.attach(server);await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 }
 const services={config:id=>({root:roots[id],dataDir:path.join(dir,id)}),capabilities:async id=>live[id].integration.state,ensure:async id=>live[id].integration.state};
 const login='isolated@example.test',publicOrigin='https://isolated.test-tail.ts.net:8443';
 gateway=await createWorkbenchGateway({services,storeDir:path.join(dir,'gateway'),publicOrigin,accessPolicy:{schemaVersion:1,users:{[login]:{enabled:true,role:'editor',modules:['purchase','sales','overview'],canRunTasks:false}}}});
 const headers={host:new URL(publicOrigin).host,'tailscale-user-login':login},session=await gateway.app.inject({url:'/api/workbench/v1/session',headers});assert.equal(session.statusCode,200,session.body);headers.cookie=[session.headers['set-cookie']].flat()[0].split(';')[0];
 for(const id of ['purchase','sales','overview']){
  const api=await gateway.app.inject({url:'/apps/'+id+'/api/bootstrap',headers});assert.equal(api.statusCode,200,id+': '+api.body);assert(!Object.hasOwn(api.json(),'token'),id+' bootstrap token');assert(!api.body.includes(dir.replaceAll('\\','\\\\')),id+' host data path');
  const html=await gateway.app.inject({url:'/apps/'+id+'/',headers});assert.equal(html.statusCode,200,id+': '+html.body);assert.match(html.body,new RegExp('/apps/'+id+'/workbench-base.js'));
  const shim=await gateway.app.inject({url:'/apps/'+id+'/workbench-base.js',headers});assert.equal(shim.statusCode,200,id+': '+shim.body);assert.match(shim.body,/Idempotency-Key/);
 }
 const cap=(await gateway.app.inject({url:'/api/workbench/v1/capabilities',headers})).json();assert.equal(cap.operationManifest.length,3);assert(cap.operationManifest.every(m=>m.operations.length>20));
 const denied=await gateway.app.inject({url:'/apps/purchase/api/backups',method:'POST',payload:{},headers:{...headers,origin:publicOrigin,'x-workbench-csrf':session.json().csrfToken,'idempotency-key':'forbidden-backup-001'}});assert([403,404].includes(denied.statusCode),denied.body);
});
