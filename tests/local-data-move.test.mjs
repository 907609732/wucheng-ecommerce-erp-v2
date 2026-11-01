import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {previewLocalDataMove,stageLocalDataMove,verifyLocalDataMove,completeLocalDataMove,rollbackLocalDataMove,initializeUnifiedData,rewriteOperationalPaths,verifyPendingLocalDataMoves,verifyPendingLocalDataMovesAsync,pendingLocalDataMoves,finishVerifiedLocalDataMoves} from '../desktop/workbench-migration/local-data-move.mjs';
const ids=['warehouse','purchase','sales','overview','exporter'];
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'data-move-test-')),registryFile=path.join(root,'registry.json'),registry={};t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const id of ids){const dataDir=path.join(root,'source',id),db=id==='warehouse'?'workspace/data/erp.sqlite':id==='exporter'?'orders.sqlite':id+'.sqlite';fs.mkdirSync(path.dirname(path.join(dataDir,db)),{recursive:true});const d=new DatabaseSync(path.join(dataDir,db));d.exec("CREATE TABLE orders(id TEXT PRIMARY KEY,amount_cents INTEGER,remarks TEXT);CREATE TABLE workbench_identity(key TEXT PRIMARY KEY,value TEXT);INSERT INTO orders VALUES('00123456789012345678901234567890',12345,'人工备注');INSERT INTO workbench_identity VALUES('ledger:test','unchanged-dataset');");d.close();fs.mkdirSync(path.join(dataDir,'originals'),{recursive:true});fs.writeFileSync(path.join(dataDir,'originals','source.xlsx'),Buffer.from([1,2,3]));if(['warehouse','exporter'].includes(id)){fs.mkdirSync(path.join(dataDir,'Partitions'),{recursive:true});fs.writeFileSync(path.join(dataDir,'Partitions','private-login'),'private-fixture');}registry[id]={dataDir,db,root:path.join(root,'program',id),managed:true,version:'1.0.0'};}
 fs.writeFileSync(registryFile,JSON.stringify(registry));const backupRoot=path.join(root,'backup');fs.mkdirSync(backupRoot);const services={registryFile,config:id=>JSON.parse(fs.readFileSync(registryFile))[id],capabilities:async()=>null,stop:async()=>{}};
 return {root,services,backupRoot,dataRoot:path.join(root,'Data'),registryFile};
}
test('move preserves whole databases, long IDs, money and login roots; activated paths cannot roll back',async t=>{
 const f=fixture(t),plan=await previewLocalDataMove(f),result=await stageLocalDataMove({...f,plan});assert.equal(result.phase,'awaiting-activation');assert.equal(verifyLocalDataMove(result.journalFile).modules,5);
 verifyPendingLocalDataMoves(f.services);const r=JSON.parse(fs.readFileSync(f.registryFile));for(const id of ids){assert.equal(r[id].dataDir,path.join(f.dataRoot,id));assert.equal(r[id].allowInitialize,false);if(['warehouse','exporter'].includes(id)){assert.equal(r[id].authProfileDir,plan.modules.find(m=>m.id===id).source);assert(fs.existsSync(path.join(r[id].authProfileDir,'Partitions/private-login')));assert(!fs.existsSync(path.join(r[id].dataDir,'Partitions')));}r[id].maintenance=false;}
 fs.writeFileSync(f.registryFile,JSON.stringify(r));assert.throws(()=>rollbackLocalDataMove(result.journalFile),/业务写入/);assert.equal(completeLocalDataMove(result.journalFile).ok,true);assert.throws(()=>rollbackLocalDataMove(result.journalFile),/不能整库回退/);
});
test('pre-activation rollback restores original registry, leaves candidates and removes only owned barriers',async t=>{
 const f=fixture(t),before=fs.readFileSync(f.registryFile),plan=await previewLocalDataMove(f),result=await stageLocalDataMove({...f,plan});rollbackLocalDataMove(result.journalFile);assert(fs.readFileSync(f.registryFile).equals(before));assert(fs.existsSync(path.join(f.dataRoot,'purchase','purchase.sqlite')));assert(!fs.existsSync(path.join(plan.modules[0].source,'.workbench-maintenance.json')));
});
test('busy tasks, existing targets, links and overlapping directories block before mutation',async t=>{
 const f=fixture(t);f.services.capabilities=async()=>({busy:true});await assert.rejects(previewLocalDataMove(f),{code:'SERVICE_BUSY'});f.services.capabilities=async()=>null;
 fs.mkdirSync(path.join(f.dataRoot,'purchase'),{recursive:true});await assert.rejects(previewLocalDataMove(f),{code:'TARGET_EXISTS'});fs.rmdirSync(path.join(f.dataRoot,'purchase'));
 await assert.rejects(previewLocalDataMove({...f,dataRoot:path.join(f.services.config('warehouse').dataDir,'nested')}),{code:'OVERLAPPING_PATHS'});
});
test('file corruption is detected and never silently completes',async t=>{
 const f=fixture(t),result=await stageLocalDataMove({...f,plan:await previewLocalDataMove(f)});fs.writeFileSync(path.join(f.dataRoot,'purchase','originals/source.xlsx'),'corrupt');assert.throws(()=>verifyLocalDataMove(result.journalFile),{code:'VERIFICATION_FAILED'});
});
test('initialization never substitutes a missing registered ledger or writes in client mode',t=>{
 const f=fixture(t),before=fs.readFileSync(f.registryFile);assert.deepEqual(initializeUnifiedData({...f,mode:'client'}),{client:true});assert(fs.readFileSync(f.registryFile).equals(before));fs.unlinkSync(path.join(f.services.config('purchase').dataDir,'purchase.sqlite'));assert.throws(()=>initializeUnifiedData(f),{code:'MISSING_LEDGER'});
});
test('only known operational paths move; external paths and audit evidence stay unchanged',t=>{
 const f=fixture(t),file=path.join(f.root,'paths.sqlite'),old=path.join(f.root,'source'),target=path.join(f.root,'Data');const db=new DatabaseSync(file);db.exec('CREATE TABLE imported_files(stored_path TEXT);CREATE TABLE operation_logs(before_value TEXT);');db.prepare('INSERT INTO imported_files VALUES(?)').run(path.join(old,'originals','a.xlsx'));db.prepare('INSERT INTO imported_files VALUES(?)').run(path.join(f.root,'external.xlsx'));db.prepare('INSERT INTO operation_logs VALUES(?)').run(path.join(old,'historical.xlsx'));db.close();assert.equal(rewriteOperationalPaths(file,old,target).length,1);const after=new DatabaseSync(file,{readOnly:true});assert.equal(after.prepare('SELECT stored_path FROM imported_files LIMIT 1').get().stored_path,path.join(target,'originals','a.xlsx'));assert.equal(after.prepare('SELECT before_value FROM operation_logs').get().before_value,path.join(old,'historical.xlsx'));after.close();
});
test('interrupted service restoration resumes without rechecking later legitimate business edits',async t=>{
 const f=fixture(t),plan=await previewLocalDataMove(f);for(const m of plan.modules)m.wasRunning=['warehouse','sales'].includes(m.id);
 const result=await stageLocalDataMove({...f,plan});verifyPendingLocalDataMoves(f.services);
 const registry=JSON.parse(fs.readFileSync(f.registryFile));for(const id of ids)registry[id].maintenance=false;fs.writeFileSync(f.registryFile,JSON.stringify(registry));
 let failSales=true;const started=[];f.services.ensure=async id=>{started.push(id);if(id==='sales'&&failSales)throw Error('synthetic restart failure');};
 await assert.rejects(finishVerifiedLocalDataMoves(f.services),/synthetic restart/);
 const database=new DatabaseSync(path.join(f.dataRoot,'warehouse','workspace/data/erp.sqlite'));database.exec("INSERT INTO orders VALUES('later-edit',678,'after release')");database.close();
 assert.equal(pendingLocalDataMoves(f.services,{verificationOnly:true}).length,0);assert.equal(verifyPendingLocalDataMoves(f.services).ok,true);
 failSales=false;assert.equal((await finishVerifiedLocalDataMoves(f.services))[0].ok,true);assert.equal(pendingLocalDataMoves(f.services).length,0);assert.deepEqual(started,['warehouse','sales','warehouse','sales']);
 const after=new DatabaseSync(path.join(f.dataRoot,'warehouse','workspace/data/erp.sqlite'),{readOnly:true});assert.equal(after.prepare("SELECT amount_cents FROM orders WHERE id='later-edit'").get().amount_cents,678);after.close();
});
test('startup revision may advance only with the same ledger identity, keys and unchanged business rows',async t=>{
 const f=fixture(t),original=new DatabaseSync(path.join(f.services.config('purchase').dataDir,'purchase.sqlite'));original.exec("DELETE FROM workbench_identity;INSERT INTO workbench_identity VALUES('ledger:purchase','unchanged-ledger-uuid'),('revision:purchase','4');CREATE TABLE usage(id INTEGER PRIMARY KEY,day TEXT,opens INTEGER)");original.prepare('INSERT INTO usage VALUES(1,?,2)').run(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));original.close();
 const result=await stageLocalDataMove({...f,plan:await previewLocalDataMove(f)}),file=path.join(f.dataRoot,'purchase','purchase.sqlite');
 const update=(key,value)=>{const db=new DatabaseSync(file);db.prepare('UPDATE workbench_identity SET value=? WHERE key=?').run(value,key);db.close();};update('revision:purchase','5');
 assert.throws(()=>verifyLocalDataMove(result.journalFile,{afterActivation:true}),{code:'VERIFICATION_FAILED'});const usage=new DatabaseSync(file);usage.exec('UPDATE usage SET opens=3');usage.close();
 assert.throws(()=>verifyLocalDataMove(result.journalFile),{code:'VERIFICATION_FAILED'});assert.equal(verifyLocalDataMove(result.journalFile,{afterActivation:true}).revisionAdvances[0].after,'5');
 update('ledger:purchase','wrong-ledger');assert.throws(()=>verifyLocalDataMove(result.journalFile,{afterActivation:true}),{code:'VERIFICATION_FAILED'});update('ledger:purchase','unchanged-ledger-uuid');update('revision:purchase','3');assert.throws(()=>verifyLocalDataMove(result.journalFile,{afterActivation:true}),{code:'VERIFICATION_FAILED'});
 update('revision:purchase','5');const db=new DatabaseSync(file);db.exec('UPDATE orders SET amount_cents=999');db.close();assert.throws(()=>verifyLocalDataMove(result.journalFile,{afterActivation:true}),{code:'VERIFICATION_FAILED'});
});
test('only exact product-owned scripts matching the bundled source can change after activation',async t=>{
 const f=fixture(t),relative='workspace/extensions/lingtu-desks/extension.mjs',source=path.join(f.services.config('warehouse').dataDir,relative);fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,'old-owned-program');const result=await stageLocalDataMove({...f,plan:await previewLocalDataMove(f)}),target=path.join(f.dataRoot,'warehouse',relative);
 fs.copyFileSync(new URL('../desktop/extensions/lingtu-desks/extension.mjs',import.meta.url),target);assert.throws(()=>verifyLocalDataMove(result.journalFile),{code:'VERIFICATION_FAILED'});assert.equal(verifyLocalDataMove(result.journalFile,{afterActivation:true}).managedProgramUpdates.length,1);
 fs.writeFileSync(target,'arbitrary replacement');assert.throws(()=>verifyLocalDataMove(result.journalFile,{afterActivation:true}),{code:'VERIFICATION_FAILED'});
});


test('internal asynchronous verification keeps parent timers responsive and records the same verified boundary',async t=>{
 const f=fixture(t),attachments=path.join(f.services.config('purchase').dataDir,'originals');
 for(let i=0;i<160;i++)fs.writeFileSync(path.join(attachments,'attachment-'+i+'.bin'),Buffer.alloc(32*1024,i));
 const result=await stageLocalDataMove({...f,plan:await previewLocalDataMove(f)});
 let ticks=0;const timer=setInterval(()=>ticks++,2);
 try{assert.equal((await verifyPendingLocalDataMovesAsync(f.services)).ok,true);}finally{clearInterval(timer);}
 assert.ok(ticks>2,'Parent event loop must keep processing UI timers during the worker scan');
 assert.equal(JSON.parse(fs.readFileSync(result.journalFile)).phase,'verified');
 assert.equal(ids.every(id=>f.services.config(id).maintenance===true),true,'Worker verifies but never releases maintenance');
});
test('asynchronous verifier rejects corrupt originals without releasing maintenance or marking verified',async t=>{
 const f=fixture(t),result=await stageLocalDataMove({...f,plan:await previewLocalDataMove(f)});
 fs.writeFileSync(path.join(f.dataRoot,'purchase','originals/source.xlsx'),'corrupted fixture');
 await assert.rejects(verifyPendingLocalDataMovesAsync(f.services),{code:'VERIFICATION_FAILED'});
 assert.equal(JSON.parse(fs.readFileSync(result.journalFile)).phase,'awaiting-activation');
 assert.equal(ids.every(id=>f.services.config(id).maintenance===true),true);
});
test('asynchronous verifier refuses a registry that changes while the worker starts',async t=>{
 const f=fixture(t),result=await stageLocalDataMove({...f,plan:await previewLocalDataMove(f)});
 const verification=verifyPendingLocalDataMovesAsync(f.services);
 // Schedule after the parent has captured the registry bytes and spawned Node.
 const timer=setTimeout(()=>{const registry=JSON.parse(fs.readFileSync(f.registryFile));registry.purchase.dataMoveId='different-owner';fs.writeFileSync(f.registryFile,JSON.stringify(registry));},20);
 try{await assert.rejects(verification,{code:'MOVE_OWNERSHIP_CHANGED'});}finally{clearTimeout(timer);}
 assert.equal(JSON.parse(fs.readFileSync(result.journalFile)).phase,'awaiting-activation');
 assert.equal(ids.every(id=>f.services.config(id).maintenance===true),true);
});
