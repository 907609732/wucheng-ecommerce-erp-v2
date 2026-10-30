import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertBetaDataNotInMaintenance,withBetaDataMaintenance,withBetaServiceStartFence} from '../desktop/agent-host/data-maintenance.mjs';
import {agentBetaPaths,prepareAgentProfile,guardAgentServices} from '../desktop/agent-host/isolation.mjs';

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

test('guarded services retain the fence across async startup and serialize module starts',async t=>{
 const local=fs.mkdtempSync(path.join(os.tmpdir(),'agent-start-fence-')),old=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=local;
 t.after(()=>{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;fs.rmSync(local,{recursive:true,force:true});});
 const paths=agentBetaPaths();prepareAgentProfile(paths);const registry=JSON.parse(fs.readFileSync(paths.registryFile,'utf8'));
 for(const id of ['purchase','sales']){fs.mkdirSync(registry[id].dataDir,{recursive:true});registry[id].db=id==='purchase'?'purchases.sqlite':'sales.sqlite';fs.writeFileSync(path.join(registry[id].dataDir,registry[id].db),'isolated ledger placeholder');}
 const started=[],gates=[];let notify;const firstStarted=new Promise(resolve=>{notify=resolve;});
 const services={registryFile:paths.registryFile,config:id=>registry[id],ensure(id){return this.start(id);},async start(id){started.push(id);notify();await new Promise(resolve=>gates.push(resolve));return {id};}};
 guardAgentServices(services,paths);const first=services.ensure('purchase');await firstStarted;
 assert.throws(()=>withBetaDataMaintenance(paths,()=>{}),/EEXIST/);
 const second=services.ensure('sales');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['purchase']);
 gates.shift()();await first;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['purchase','sales']);
 assert.throws(()=>assertBetaDataNotInMaintenance(paths));gates.shift()();await second;assert.doesNotThrow(()=>assertBetaDataNotInMaintenance(paths));
});
