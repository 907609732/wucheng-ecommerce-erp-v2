import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {ModuleManager} from '../desktop/modules/module-manager.mjs';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {createServiceLifecycle} from '../desktop/modules/service-lifecycle.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-public-download-'));
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const registryFile=path.join(root,'registry.json');
fs.writeFileSync(registryFile,JSON.stringify(Object.fromEntries(['purchase','sales','overview'].map(id=>[id,{managed:true,allowInitialize:true,root:path.join(root,id),dataDir:path.join(root,'data',id),port}]))));
const services=new ServiceManager({registryFile});
const manager=new ModuleManager({root:path.join(root,'modules'),hostVersion:'0.8.0',
  publicKeys:JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8'))});
manager.lifecycle=createServiceLifecycle({services,dataRoot:path.join(root,'data'),backupRoot:path.join(root,'backups'),getInstalled:id=>manager.state().packages[id]});
const response=await fetch('https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/modules-stable/catalog.json');
assert.equal(response.status,200);
manager.setCatalog(await response.json());
try{
  await manager.install('overview');
  const cap=await services.capabilities('overview');assert.equal(cap.version,'1.4.1');
  const report=await services.request('overview','/overview?month=2026-10');
  assert.equal(report.unavailable,true);
  const result={ok:true,unauthenticatedPublicCatalog:true,downloadedAndVerified:['node-runtime','overview'],serviceHealthy:true,missingSourcesExplicit:true,checkedAt:new Date().toISOString()};
  fs.writeFileSync('dist/module-verification/public-download.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await services.stop('overview');}
