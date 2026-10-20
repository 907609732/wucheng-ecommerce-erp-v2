// Run after building purchase/sales/node-runtime packages. All service data,
// registries and ports are isolated from the user's running applications.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {ModuleManager, atomicJson} from '../desktop/modules/module-manager.mjs';
import {createServiceLifecycle} from '../desktop/modules/service-lifecycle.mjs';
import {withElectronLifecycle} from '../desktop/modules/electron-lifecycle.mjs';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const freePort = () => new Promise(resolve => {const s = net.createServer(); s.listen(0, '127.0.0.1', () => {const p = s.address().port; s.close(() => resolve(p));});});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingtu-services-smoke-'));
const electronOnly=process.argv.includes('--electron-only'),full=process.argv.includes('--full')||electronOnly;
const ids=electronOnly?['warehouse','exporter']:full?['purchase','sales','overview','warehouse','exporter']:['purchase','sales'];
const registryFile = path.join(root, 'registry.json');
const registry = {};
for (const id of ids) registry[id] = {port: await freePort(), mobilePort: await freePort(), dataDir: path.join(root, 'data', id), exe:path.join(root,id,'not-installed.exe'), managed: true, allowInitialize: true};
atomicJson(registryFile, registry);
const services = new ServiceManager({registryFile});
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const packages = [...(full?['node-runtime','browser-runtime']:['node-runtime']), ...ids].map(id => JSON.parse(fs.readFileSync(`dist/modules/${id}.descriptor.json`, 'utf8')));
const payload = Buffer.from(JSON.stringify({schemaVersion: 1, packages}));
const modules = new ModuleManager({root: path.join(root, 'modules'), hostVersion: '0.8.0', publicKeys: {test: publicKey},
  onProgress:p=>{if(['installed','error'].includes(p.phase))console.log(JSON.stringify({module:p.id,phase:p.phase,error:p.error}));}});
const lifecycleOptions={services, dataRoot: path.join(root, 'data'), backupRoot: path.join(root, 'backups'), getInstalled: id => modules.state().packages[id]};
modules.lifecycle = withElectronLifecycle(createServiceLifecycle(lifecycleOptions),lifecycleOptions);
modules.setCatalog({format: 'lingtu-catalog/v1', keyId: 'test', payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64')});
const results = [];
try {
  for (const id of ids) {
    await modules.install(id, {offlineDirectory: path.resolve('dist/modules')});
    const cap = await services.capabilities(id);
    assert.equal(cap.maintenance, false);
    assert.ok(cap.root.startsWith(root));
    assert.ok(cap.dataDir.startsWith(root));
    if(!['warehouse','exporter'].includes(id)){
      const html = await (await fetch(cap.url)).text();
      assert.ok(html.includes('<html'));
    }
    if(id==='sales'){
      const boot=await (await fetch(cap.url+'/api/bootstrap')).json();
      assert.deepEqual(boot.shops.map(s=>s.id).sort(),['dropship','offline']);
      const result=await fetch(cap.url+'/api/shops',{method:'POST',headers:{'Content-Type':'application/json','x-sales-token':boot.token},body:JSON.stringify({platform:'淘宝',name:'隔离验收店铺'})});
      assert.equal(result.status,200);
    }
    if(!['warehouse','exporter'].includes(id))assert.equal(services.config(id).allowInitialize, false);
    const installed = modules.state().packages[id];
    await modules.uninstall(id);
    if(!['warehouse','exporter'].includes(id))assert.ok(fs.existsSync(path.join(cap.dataDir, services.config(id).db)));
    assert.ok(!fs.existsSync(installed.root));
    await modules.install(id, {offlineDirectory: path.resolve('dist/modules')});
    assert.equal((await services.capabilities(id)).dataDir, cap.dataDir);
    if(id==='sales'){
      const after=await(await fetch((await services.capabilities(id)).url+'/api/bootstrap')).json();
      assert.equal(after.shops.filter(s=>s.name==='隔离验收店铺').length,1);
    }
    results.push({id, installed: true, apiHealthy:true, homeLoaded: !['warehouse','exporter'].includes(id), reinstallPreservedData: true, maintenanceReleased: true});
  }
  const report={ok:true,root,registryFile,results};
  fs.mkdirSync('dist/module-verification',{recursive:true});
  fs.writeFileSync('dist/module-verification/services.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ok: false, root, error: error.message, code: error.code}));
  process.exitCode = 1;
} finally {
  for (const id of ids) {
    try { await services.stop(id); } catch {}
  }
  // Keep isolated failure artifacts and backups for diagnosis. No user data is touched.
}
