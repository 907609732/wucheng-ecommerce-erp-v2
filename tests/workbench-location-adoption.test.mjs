import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {buildWorkbenchLocationPreview} from '../scripts/preview-workbench-location.mjs';
import {adoptWorkbenchLocation,validateReviewedPreview,validateGatewayOwner} from '../scripts/adopt-workbench-location.mjs';

const ids=['warehouse','purchase','sales','overview','exporter'];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){
  const logical=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-adoption-test-')),root=fs.realpathSync.native(logical);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100}));
  const home=path.join(root,'home'),profile=path.join(root,'physical-profile'),registryFile=path.join(root,'old-registry.json'),identity={schemaVersion:1,serverId:randomUUID(),dataSetId:randomUUID()},origin='https://fixture.test-tail.ts.net:8443';
  fs.mkdirSync(path.join(profile,'workbench-server'),{recursive:true});fs.mkdirSync(path.join(profile,'modules'),{recursive:true});
  fs.writeFileSync(path.join(profile,'workbench-server','identity.json'),JSON.stringify(identity));
  fs.writeFileSync(path.join(profile,'workbench-server','access-policy.json'),JSON.stringify({schemaVersion:1,users:{'fixture@example.test':{role:'admin',modules:ids,enabled:true,canRunTasks:true}}}));
  fs.writeFileSync(path.join(profile,'workbench-connection.json'),JSON.stringify({schemaVersion:1,mode:'server',serverUrl:origin,pins:null}));
  const gatewayFile=path.join(profile,'workbench-server','gateway.sqlite'),g=new DatabaseSync(gatewayFile);g.exec('CREATE TABLE operations(state TEXT)');g.close();
  const registry={},packages={},bindings={},running=new Set(ids),processes=new Map(),events=[];
  for(const[id,index]of ids.map((id,index)=>[id,index])){
    const program=path.join(profile,'modules','packages',id,'1.0.0'),data=path.join(root,'data',id),db=id==='warehouse'?'workspace/data/erp.sqlite':id==='exporter'?'orders.sqlite':id+'.sqlite';fs.mkdirSync(program,{recursive:true});fs.mkdirSync(path.dirname(path.join(data,db)),{recursive:true});
    const dataSetId=randomUUID(),store=new DatabaseSync(path.join(data,db));store.exec('CREATE TABLE workbench_identity(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE business(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO business VALUES(1,\'original unchanged business\')');store.prepare('INSERT INTO workbench_identity VALUES(?,?)').run(['warehouse','exporter'].includes(id)?'ledger-instance':'ledger:'+id,dataSetId);store.close();
    registry[id]={root:program,dataDir:data,managed:true,allowInitialize:false,db,version:'1.0.0'};packages[id]={root:program,entry:'server.mjs',version:'1.0.0'};bindings[id]={dataSetId,db:path.join(data,db)};processes.set(500+index,{pid:500+index,startedAtTicks:String(index+1),exe:'not-used',args:[]});
  }
  const nodeRoot=path.join(profile,'modules','packages','node-runtime','24.0.0');fs.mkdirSync(nodeRoot,{recursive:true});const node=path.join(nodeRoot,'node.exe');fs.writeFileSync(node,'fixture runtime');packages['node-runtime']={root:nodeRoot,entry:'node.exe',version:'24.0.0'};
  const entry=path.join(profile,'gateway-components','0.9.0','desktop','workbench-migration','server-entry.mjs');fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'fixture gateway');
  fs.writeFileSync(registryFile,JSON.stringify(registry));const installedFile=path.join(profile,'modules','installed.json');fs.writeFileSync(installedFile,JSON.stringify({schemaVersion:1,packages}));
  const preview=buildWorkbenchLocationPreview({profile,registryFile,home,now:new Date('2026-10-25T12:00:00Z')}),reviewFile=path.join(root,'reviewed.json');fs.writeFileSync(reviewFile,JSON.stringify(preview));
  const gateway={pid:900,startedAtTicks:'900',exe:node,listenerAddresses:['127.0.0.1'],args:[node,entry,'--store-dir',path.join(profile,'workbench-server'),'--origin',origin]};let gatewayRunning=true;
  const services={config:id=>registry[id],capabilities:async id=>running.has(id)?{url:'http://127.0.0.1:20000',busy:false,pid:500+ids.indexOf(id),dataSetId:bindings[id].dataSetId,workbench:{protocolVersion:1}}:null,stop:async id=>{events.push('stop:'+id);running.delete(id);}};
  const system={assertNoHostLaunchers:async()=>{},findManagedModuleProcesses:async()=>0,processInfo:async pid=>pid===900?gatewayRunning?gateway:null:running.has(ids[pid-500])?processes.get(pid):null,inspectGateway:async()=>gatewayRunning?gateway:null,health:async()=>identity,waitForExit:async p=>{events.push('exit:'+p.pid);},stopGateway:async p=>{assert.equal(p.pid,900);events.push('stop:gateway');gatewayRunning=false;}};
  const options={home,system,servicesFactory:args=>{assert.equal(args.registryFile,registryFile);assert.equal(args.policyFile,path.join(profile,'workbench-server','access-policy.json'));return services;}};
  const dbHashes=()=>Object.fromEntries(ids.map(id=>[id,hash(bindings[id].db)]));
  return {root,home,profile,registryFile,installedFile,gatewayFile,registry,bindings,packages,preview,reviewFile,gateway,services,system,options,events,running,dbHashes};
}

test('reviewed adoption stops only owned fixtures, commits marker last and never changes business databases',async t=>{
  const f=fixture(t),before=f.dbHashes(),phases=[];
  const r=await adoptWorkbenchLocation(f.reviewFile,{...f.options,checkpoint:phase=>phases.push(phase)});
  assert.equal(r.ok,true);assert.equal(r.markerCommittedLast,true);assert.equal(r.gatewayStopped,true);assert.equal(r.restartRequired,true);assert.equal(r.backupFiles,4);assert.deepEqual(f.dbHashes(),before);
  assert.deepEqual(f.events.filter(e=>e.startsWith('stop:')),['stop:overview','stop:sales','stop:purchase','stop:exporter','stop:warehouse','stop:gateway']);
  assert(phases.indexOf('marker-written')>phases.indexOf('installed-written'));assert(phases.indexOf('registry-written')>phases.indexOf('services-stopped'));
  for(const b of f.preview.backupPlan.files)assert.equal(hash(b.destination),b.sha256);
  assert.equal(fs.existsSync(path.join(f.profile,'modules','install.lock')),false);assert.equal(JSON.parse(fs.readFileSync(f.preview.proposedMarker.file,'utf8')).serverId,f.preview.proposedMarker.content.serverId);
});

test('stale or tampered reviewed preview refuses all backup, stop and metadata actions',async t=>{
  const f=fixture(t);fs.appendFileSync(f.installedFile,' ');
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='REVIEW_CHANGED');assert.deepEqual(f.events,[]);assert.equal(fs.existsSync(f.preview.backupPlan.directory),false);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);
});

test('pending or unknown gateway outcomes refuse service shutdown',async t=>{
  for(const state of ['pending','unknown']){const f=fixture(t),db=new DatabaseSync(f.gatewayFile);db.prepare('INSERT INTO operations VALUES(?)').run(state);db.close();await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='GATEWAY_WRITES_PENDING');assert.deepEqual(f.events,[]);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);}
});

test('busy modules or changed ledger identities fail before any shutdown',async t=>{
  for(const scenario of ['busy','ledger']){const f=fixture(t),original=f.services.capabilities;f.services.capabilities=async id=>{const cap=await original(id);if(id==='purchase'){if(scenario==='busy')cap.busy=true;else cap.dataSetId=randomUUID();}return cap;};await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='MODULE_NOT_IDLE_OR_IDENTITY_CHANGED');assert.deepEqual(f.events,[]);assert.equal(fs.existsSync(f.preview.backupPlan.directory),false);}
});

test('an installation journal prevents adoption without deleting or recovering it',async t=>{
  const f=fixture(t),journal=path.join(f.profile,'modules','transaction.json');fs.writeFileSync(journal,'{"phase":"activating"}');await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='INSTALL_JOURNAL_PRESENT');assert.deepEqual(f.events,[]);assert.equal(fs.readFileSync(journal,'utf8'),'{"phase":"activating"}');
});

test('gateway ownership requires managed node, managed entry and the original store',t=>{
  const f=fixture(t),installed={packages:f.packages},connection={serverUrl:'https://fixture.test-tail.ts.net:8443'};
  assert.equal(validateGatewayOwner(f.gateway,f.preview,installed,connection).pid,900);
  const other=path.join(f.root,'other.exe');fs.writeFileSync(other,'other');assert.throws(()=>validateGatewayOwner({...f.gateway,exe:other},f.preview,installed,connection),e=>e.code==='GATEWAY_NODE_MISMATCH');
  assert.throws(()=>validateGatewayOwner({...f.gateway,args:[f.gateway.exe,other,...f.gateway.args.slice(2)]},f.preview,installed,connection),e=>e.code==='GATEWAY_ENTRY_MISMATCH');
  const dir=path.join(f.root,'other-store');fs.mkdirSync(dir);assert.throws(()=>validateGatewayOwner({...f.gateway,args:[f.gateway.exe,f.gateway.args[1],'--store-dir',dir,'--origin',connection.serverUrl]},f.preview,installed,connection),e=>e.code==='GATEWAY_STORE_MISMATCH');
});

test('failure after installed write restores only this script metadata and retains backups',async t=>{
  const f=fixture(t),before=f.dbHashes(),registryHash=hash(f.registryFile),installedHash=hash(f.installedFile);
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,{...f.options,checkpoint:phase=>{if(phase==='installed-written')throw Object.assign(Error('fixture interruption'),{code:'TEST_INTERRUPTED'});}}),e=>e.code==='TEST_INTERRUPTED'&&e.report.metadataRolledBack);
  assert.deepEqual(f.dbHashes(),before);assert.equal(hash(f.registryFile),registryHash);assert.equal(hash(f.installedFile),installedHash);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);assert.equal(fs.existsSync(f.preview.files[0].destination),false);assert.equal(fs.existsSync(f.preview.backupPlan.directory),true);
});

test('rollback refuses to overwrite a later external metadata edit',async t=>{
  const f=fixture(t),before=f.dbHashes(),target=f.preview.files[0].destination;
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,{...f.options,checkpoint:phase=>{if(phase==='registry-written'){fs.writeFileSync(target,'{"external":"later edit"}');throw Object.assign(Error('fixture'),{code:'TEST_INTERRUPTED'});}}}),e=>e.report?.rollbackConflicts.includes('registry')&&e.report.metadataRolledBack===false);
  assert.equal(fs.readFileSync(target,'utf8'),'{"external":"later edit"}');assert.deepEqual(f.dbHashes(),before);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);
});

test('a module revived by gateway traffic aborts before writing metadata',async t=>{
  const f=fixture(t),before=f.dbHashes(),stop=f.system.stopGateway;f.system.stopGateway=async p=>{await stop(p);f.running.add('purchase');};
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='MODULE_RESTARTED_DURING_STOP');assert.deepEqual(f.dbHashes(),before);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);assert.equal(fs.existsSync(f.preview.files[0].destination),false);
});

test('revival before first write, before marker, or after marker is caught and owned metadata rolled back',async t=>{
  for(const phase of ['services-stopped','installed-written','marker-written']){const f=fixture(t),before=f.dbHashes(),installed=hash(f.installedFile);
    await assert.rejects(adoptWorkbenchLocation(f.reviewFile,{...f.options,checkpoint:at=>{if(at===phase)f.running.add('purchase');}}),e=>e.code==='MODULE_RESTARTED_DURING_STOP'&&e.report.metadataRolledBack);
    assert.deepEqual(f.dbHashes(),before);assert.equal(hash(f.installedFile),installed);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);assert.equal(fs.existsSync(f.preview.files[0].destination),false);
  }
});

test('a controlled cold child without any listener or start record still blocks adoption',async t=>{
  const f=fixture(t);f.system.findManagedModuleProcesses=async()=>1;
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='MANAGED_MODULE_PROCESS_STILL_ALIVE');assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);
});

test('active ERP launcher UI or CLI must exit normally before any controlled shutdown',async t=>{
  const f=fixture(t);f.system.assertNoHostLaunchers=async()=>{throw Object.assign(Error('fixture'),{code:'HOST_LAUNCHER_ACTIVE'});};
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='HOST_LAUNCHER_ACTIVE');assert.deepEqual(f.events,[]);assert.equal(fs.existsSync(f.preview.backupPlan.directory),false);
});

test('a new pending operation during gateway exit aborts rather than committing marker',async t=>{
  const f=fixture(t),stop=f.system.stopGateway;f.system.stopGateway=async p=>{await stop(p);const db=new DatabaseSync(f.gatewayFile);db.exec("INSERT INTO operations VALUES('pending')");db.close();};
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='GATEWAY_WRITES_PENDING');assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);
});

test('stopped module dead child start records are retained and do not block adoption',async t=>{
  const f=fixture(t),file=path.join(f.registry.purchase.dataDir,'.integration-start.lock'),record=JSON.stringify({schemaVersion:1,token:randomUUID(),module:'purchase',ownerPid:123456,childPid:501});fs.writeFileSync(file,record);
  const r=await adoptWorkbenchLocation(f.reviewFile,f.options);assert.equal(r.ok,true);assert.equal(fs.readFileSync(file,'utf8'),record);
});

test('a live start child or corrupt start record blocks metadata without deleting the record',async t=>{
  for(const mode of ['alive','corrupt']){const f=fixture(t),file=path.join(f.registry.purchase.dataDir,'.integration-start.lock'),record=mode==='alive'?JSON.stringify({schemaVersion:1,token:randomUUID(),module:'purchase',ownerPid:123456,childPid:123457}):'{broken';fs.writeFileSync(file,record);const info=f.system.processInfo;f.system.processInfo=async pid=>pid===123457?{pid,startedAtTicks:'external-child'}:info(pid);
    await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code===(mode==='alive'?'MODULE_START_RECORD_ALIVE':'MODULE_START_RECORD_INVALID'));assert.equal(fs.readFileSync(file,'utf8'),record);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);
  }
});

test('legacy dead owners and unpublished child IDs cannot prove that a cold-start child is absent',async t=>{
  for(const record of ['123456',JSON.stringify({schemaVersion:1,token:randomUUID(),module:'purchase',ownerPid:123456,childPid:null})]){const f=fixture(t),file=path.join(f.registry.purchase.dataDir,'.integration-start.lock');fs.writeFileSync(file,record);
    await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='MODULE_START_RECORD_UNCERTAIN');assert.equal(fs.readFileSync(file,'utf8'),record);assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);assert.equal(fs.existsSync(f.preview.files[0].destination),false);
  }
});

test('a changed gateway process is never terminated even after modules stopped',async t=>{
  const f=fixture(t);let calls=0;f.system.inspectGateway=async()=>({...f.gateway,startedAtTicks:++calls===1?'900':'901'});
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,f.options),e=>e.code==='GATEWAY_PROCESS_CHANGED');assert(!f.events.includes('stop:gateway'));assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);
});

test('rollback after marker creation removes only the owned marker and leaves ledgers intact',async t=>{
  const f=fixture(t),before=f.dbHashes(),installedHash=hash(f.installedFile);
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,{...f.options,checkpoint:phase=>{if(phase==='marker-written')throw Object.assign(Error('fixture'),{code:'TEST_INTERRUPTED'});}}),e=>e.report?.metadataRolledBack===true);
  assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);assert.equal(fs.existsSync(f.preview.files[0].destination),false);assert.equal(hash(f.installedFile),installedHash);assert.deepEqual(f.dbHashes(),before);
});

test('a later database edit survives metadata rollback rather than being restored from backup',async t=>{
  const f=fixture(t),newId=randomUUID();
  await assert.rejects(adoptWorkbenchLocation(f.reviewFile,{...f.options,checkpoint:phase=>{if(phase==='services-stopped'){const db=new DatabaseSync(f.bindings.purchase.db);db.prepare("UPDATE workbench_identity SET value=? WHERE key='ledger:purchase'").run(newId);db.exec("UPDATE business SET value='later external edit' WHERE id=1");db.close();}}}),e=>e.code==='LEDGER_CHANGED_AFTER_METADATA');
  const db=new DatabaseSync(f.bindings.purchase.db,{readOnly:true});try{assert.equal(db.prepare("SELECT value FROM workbench_identity WHERE key='ledger:purchase'").get().value,newId);assert.equal(db.prepare('SELECT value FROM business WHERE id=1').get().value,'later external edit');}finally{db.close();}assert.equal(fs.existsSync(f.preview.proposedMarker.file),false);
});

test('reviewed destination marker cannot escape the current Documents location',t=>{
  const f=fixture(t);assert.throws(()=>validateReviewedPreview({...f.preview,proposedMarker:{...f.preview.proposedMarker,file:path.join(f.root,'wrong.json')}},{home:f.home}),e=>e.code==='MARKER_DESTINATION_CHANGED');
});
