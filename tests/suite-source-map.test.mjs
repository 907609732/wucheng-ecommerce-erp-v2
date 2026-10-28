import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {suiteSourceDigests,warehouseSourceDigest,legacyWarehouseSourceDigest} from '../scripts/suite-source-digests.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-source-map-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const put=(file,text)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
 for(const file of ['core/erp.js','desktop/main.mjs','desktop/shared/service-manager.mjs','desktop/shared/cli-child-result.mjs','desktop/launcher/main.mjs','desktop/workbench-client/transport.mjs','desktop/workbench-migration/local-data-move.mjs','desktop/invoice-module/old.mjs','desktop/modules/bundled-suite.mjs','desktop/modules/service-lifecycle.mjs','desktop/workbench/gateway.mjs','desktop/workbench/policy.mjs','desktop/workbench/actor.mjs','package.json','package-lock.json','config.json'])put(file,'original '+file);
 for(const id of ['purchase','sales','overview','exporter'])put('apps/'+id+'/source.mjs','original app '+id);
 return {root,put};
}
test('cloud source maps exclude only frontend and files actually excluded by the cloud builder',t=>{
 const f=fixture(t),before=warehouseSourceDigest(f.root),legacy=legacyWarehouseSourceDigest(f.root);
 for(const file of ['desktop/launcher/main.mjs','desktop/shared/cli-child-result.mjs','desktop/workbench-client/transport.mjs','desktop/workbench-migration/local-data-move.mjs','desktop/invoice-module/old.mjs','desktop/modules/bundled-suite.mjs','desktop/modules/service-lifecycle.mjs','desktop/workbench/gateway.mjs','desktop/workbench/policy.mjs'])f.put(file,'frontend-only update');
 assert.equal(warehouseSourceDigest(f.root),before);assert.notEqual(legacyWarehouseSourceDigest(f.root),legacy);
 f.put('desktop/workbench/actor.mjs','changed actor runtime');assert.notEqual(warehouseSourceDigest(f.root),before);
});
test('runtime, lockfile, package metadata and config changes always invalidate cloud reuse',t=>{
 for(const file of ['core/erp.js','desktop/main.mjs','desktop/shared/service-manager.mjs','package.json','package-lock.json','config.json']){const f=fixture(t),before=warehouseSourceDigest(f.root);f.put(file,'changed runtime');assert.notEqual(warehouseSourceDigest(f.root),before,file);}
});
test('each application source map remains independent and code changes cannot hide in a frontend rebuild',t=>{
 const f=fixture(t),before=suiteSourceDigests(f.root);f.put('apps/exporter/source.mjs','new collector');const after=suiteSourceDigests(f.root);assert.notEqual(after.exporter,before.exporter);for(const id of ['purchase','sales','overview','warehouse'])assert.equal(after[id],before[id]);
});
