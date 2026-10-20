// Explicit local migration runner; uses the same signed-package lifecycle as UI.
import fs from 'node:fs';
import path from 'node:path';
import {ModuleManager} from '../desktop/modules/module-manager.mjs';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
import {createServiceLifecycle} from '../desktop/modules/service-lifecycle.mjs';
import {withElectronLifecycle} from '../desktop/modules/electron-lifecycle.mjs';
const [flag,baselineFile]=process.argv.slice(2);
if(flag!=='--apply'||!baselineFile||!fs.existsSync(baselineFile))throw Error('Requires --apply and a completed local baseline');
const profile=path.join(process.env.APPDATA,'wucheng-ecommerce-erp-v2');
const services=new ServiceManager();
const baseline=JSON.parse(fs.readFileSync(baselineFile,'utf8'));
for(const id of ['warehouse','purchase','sales','overview','exporter']){
  const c=services.config(id),expected=path.join(c.dataDir,id==='exporter'?'orders.sqlite':c.db);
  if(!baseline.databases.some(d=>d.id===id&&path.resolve(d.path)===path.resolve(expected)))throw Error('Baseline data path mismatch: '+id);
}
const manager=new ModuleManager({root:path.join(profile,'modules'),hostVersion:'0.8.0',
  publicKeys:JSON.parse(fs.readFileSync('desktop/launcher/public-keys.json','utf8')),
  onProgress:p=>{if(['queued','activating','installed','error'].includes(p.phase))console.log(JSON.stringify({id:p.id,phase:p.phase,error:p.error}));}});
const options={services,dataRoot:path.join(profile,'module-data'),backupRoot:path.join(profile,'module-backups'),getInstalled:id=>manager.state().packages[id]};
manager.lifecycle=withElectronLifecycle(createServiceLifecycle(options),options);
manager.setCatalog(JSON.parse(fs.readFileSync('dist/modules/catalog.json','utf8')));
for(const id of ['warehouse','purchase','sales','overview','exporter'])await manager.install(id,{offlineDirectory:path.resolve('dist/modules')});
const result={ok:true,packages:manager.list().filter(x=>x.installed).map(x=>({id:x.id,version:x.installed.version})),
  services:(await services.status({includeWarehouse:true})).map(({extension,status,version,busy})=>({extension,status,version,busy})),completedAt:new Date().toISOString()};
fs.writeFileSync('dist/module-verification/local-adoption.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
