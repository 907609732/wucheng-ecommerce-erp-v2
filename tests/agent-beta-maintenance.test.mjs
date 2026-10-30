import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertBetaDataNotInMaintenance,withBetaDataMaintenance,withBetaServiceStartFence} from '../desktop/agent-host/data-maintenance.mjs';

test('service start and data maintenance share an exclusive fence',async t=>{
 const local=fs.mkdtempSync(path.join(os.tmpdir(),'agent-maintenance-')),old=process.env.LOCALAPPDATA,paths={root:path.join(local,'WuchengAgentBeta')};process.env.LOCALAPPDATA=local;
 t.after(()=>{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;fs.rmSync(local,{recursive:true,force:true});});
 let release;const pending=withBetaServiceStartFence(paths,()=>new Promise(resolve=>{release=resolve;}));
 assert.throws(()=>assertBetaDataNotInMaintenance(paths),/准备或回滚/);
 assert.throws(()=>withBetaDataMaintenance(paths,()=>{}),/EEXIST/);
 release();await pending;assert.doesNotThrow(()=>assertBetaDataNotInMaintenance(paths));
 assert.throws(()=>withBetaDataMaintenance(paths,()=>{throw Error('preflight');}),/preflight/);assert.doesNotThrow(()=>assertBetaDataNotInMaintenance(paths));
 assert.throws(()=>withBetaDataMaintenance(paths,mark=>{mark();throw Error('switch interrupted');}),/switch interrupted/);assert.throws(()=>assertBetaDataNotInMaintenance(paths),/准备或回滚/);
});
