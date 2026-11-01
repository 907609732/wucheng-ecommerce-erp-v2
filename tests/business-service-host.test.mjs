import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const port=async()=>{const s=http.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
test('managed desks share a host PID with separate environments and existing ledgers',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'business-host-')),registry={},pids=new Set();
 t.after(async()=>{for(const pid of pids)try{process.kill(pid);}catch{}await new Promise(r=>setTimeout(r,250));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 for(const [id,pkg,env,db]of [['sales','wucheng-sales-desk','SALES_PORT','sales.sqlite'],['overview','lingtu-business-overview','OVERVIEW_PORT','overview.sqlite']]){
  const dir=path.join(root,id),data=path.join(dir,'data');fs.mkdirSync(path.join(dir,'node_modules','express'),{recursive:true});fs.mkdirSync(data);fs.writeFileSync(path.join(data,db),'existing-ledger');fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:pkg,type:'module',version:'0.0.1'}));
  registry[id]={root:dir,dataDir:data,port:await port(),version:'0.0.1',managed:true,sharedServiceHost:true,nodePath:process.execPath,allowInitialize:false};
  const source=`import http from 'node:http';import {fileURLToPath} from 'node:url';import path from 'node:path';const root=path.dirname(fileURLToPath(import.meta.url));const port=Number(process.env.${env});http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({id:${JSON.stringify(pkg)},apiVersion:1,version:'0.0.1',root,dataDir:process.env.${id.toUpperCase()}_DATA_DIR,pid:process.pid,url:'http://127.0.0.1:'+port,moduleRoot:process.env.LINGTU_MODULE_ROOT}));}).listen(port,'127.0.0.1');`;
  fs.writeFileSync(path.join(dir,'server.mjs'),source);
 }
 const registryFile=path.join(root,'registry.json');fs.writeFileSync(registryFile,JSON.stringify(registry));const manager=new ServiceManager({registryFile,startupTimeoutMs:10000,startupPollMs:30});
 const a=await manager.ensure('sales');pids.add(a.pid);const b=await manager.ensure('overview');pids.add(b.pid);assert.equal(a.pid,b.pid);assert.notEqual(a.dataDir,b.dataDir);assert.equal(a.moduleRoot,registry.sales.root);assert.equal(b.moduleRoot,registry.overview.root);assert.equal(fs.readFileSync(path.join(registry.sales.dataDir,'sales.sqlite'),'utf8'),'existing-ledger');assert.equal(fs.readFileSync(path.join(registry.overview.dataDir,'overview.sqlite'),'utf8'),'existing-ledger');
});
