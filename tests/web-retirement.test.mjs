import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createApp as purchase} from '../apps/purchase/server.mjs';
import {createApp as sales} from '../apps/sales/server.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('ERP source and package expose only the browser product',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));assert.equal(pkg.main,undefined);
 for(const name of Object.keys({...pkg.dependencies,...pkg.devDependencies}))assert(!/electron|turbo|yazl|yauzl/.test(name),name);
 for(const dir of ['desktop','core','network','tooling','apps/exporter'])assert(!fs.existsSync(path.join(root,dir)),dir+' must retire after extraction');
 for(const command of Object.values(pkg.scripts))assert(!/electron|installer|desktop\/|engineering\/|core\//.test(command),command);
});
test('business services never expose retired native launch operations',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-retirement-'));const p=purchase({dataDir:path.join(dir,'purchase')}),s=sales({dataDir:path.join(dir,'sales')});
 try{for(const instance of [p,s]){assert(!instance.integration.state.capabilities.some(x=>['exporter.open','overview.open'].includes(x)));assert(!instance.integration.workbench.operations.some(x=>/\/(exporter|overview)\/open$/.test(x.path)));}}finally{await s.cainiao.close();p.store.close();s.store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
