import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
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
const versions=path.join(root,'versions'),old=path.join(versions,'old'),current=path.join(versions,'current');
fs.mkdirSync(old,{recursive:true});fs.mkdirSync(current,{recursive:true});
const oldExe=path.join(old,'node.exe');fs.copyFileSync(process.execPath,oldExe);
const child=spawn(oldExe,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
try{
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const orphanServices={...services,config:()=>({exe:path.join(current,'missing.exe'),root:current,managed:true,dataDir:path.join(root,'data')})};
  const guarded=withElectronLifecycle({}, {services:orphanServices,backupRoot:path.join(root,'backups')});
  await assert.rejects(guarded.backup('exporter'),error=>error.code==='LEGACY_APP_RUNNING');
}finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
console.log(JSON.stringify({ok:true,runningLegacyProcessBlocked:true,unregisteredOlderVersionBlocked:true,missingExecutableAllowed:true,noWmiRequired:true}));
