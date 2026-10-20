import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import asar from '@electron/asar';
import {ModuleManager} from '../desktop/modules/module-manager.mjs';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {createServiceLifecycle} from '../desktop/modules/service-lifecycle.mjs';
import {withElectronLifecycle} from '../desktop/modules/electron-lifecycle.mjs';
const report=JSON.parse(fs.readFileSync('dist/module-verification/services.json','utf8'));
const services=new ServiceManager({registryFile:report.registryFile});
const manager=new ModuleManager({root:path.join(report.root,'modules'),hostVersion:'0.8.0',publicKeys:JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8'))});
const options={services,dataRoot:path.join(report.root,'data'),backupRoot:path.join(report.root,'backups'),getInstalled:id=>manager.state().packages[id]};
manager.lifecycle=withElectronLifecycle(createServiceLifecycle(options),options);
manager.setCatalog(JSON.parse(fs.readFileSync('dist/modules/catalog.json','utf8')));
const previous=manager.state().packages.warehouse;
try{
  if(previous.version==='0.7.2')await manager.uninstall('warehouse');
  const current=await manager.install('warehouse',{offlineDirectory:path.resolve('dist/modules')});
  assert.equal(current.version,'0.7.2');assert.notEqual(current.root,previous.root);
  assert.equal(current.entry,'LingtuWarehouseModule.exe');
  assert.equal((await services.capabilities('warehouse')).maintenance,false);
  const dependency=JSON.parse(asar.extractFile(path.join(current.root,'resources/app.asar'),path.normalize('node_modules/follow-redirects/package.json')));
  assert.equal(dependency.version,'1.16.1');
  const result={ok:true,from:previous.version,to:current.version,independentProcessName:current.entry,healthChecked:true,patchedHttpDependency:dependency.version};
  fs.writeFileSync('dist/module-verification/cloud-update.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await services.stop('warehouse');}
