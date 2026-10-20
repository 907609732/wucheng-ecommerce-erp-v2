import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {withElectronLifecycle} from '../desktop/modules/electron-lifecycle.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-process-guard-'));
let exe=process.execPath;
const services={registryFile:path.join(root,'registry.json'),config:()=>({exe,dataDir:path.join(root,'data')}),
  capabilities:async()=>({running:false}),request:async()=>{throw Error('No managed process should be stopped');}};
const lifecycle=withElectronLifecycle({}, {services,backupRoot:path.join(root,'backups')});
await assert.rejects(lifecycle.backup('exporter'),error=>error.code==='LEGACY_APP_RUNNING');
exe=path.join(root,'missing.exe');
const backup=await lifecycle.backup('exporter');
assert.deepEqual(backup.entries,[]);
console.log(JSON.stringify({ok:true,runningLegacyProcessBlocked:true,missingExecutableAllowed:true,noWmiRequired:true}));
