import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startCloudControl} from '../desktop/modules/cloud-control.mjs';
import {createWorkbenchMigration} from '../desktop/workbench/warehouse-adapter.mjs';
import {createServiceMigrationAdapter} from '../desktop/workbench-migration/service-adapter.mjs';
import {MigrationCoordinator,digest} from '../desktop/workbench-migration/coordinator.mjs';

// Uses real module HTTP, real coordinator, real online backups, staged originals
// and real SQLite writes in fresh temporary directories. No collectors/messages.
const schema=`PRAGMA foreign_keys=ON;
CREATE TABLE warehouses(id TEXT PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE skus(sku TEXT PRIMARY KEY,name TEXT NOT NULL,barcode TEXT NOT NULL DEFAULT '');
CREATE TABLE inventory_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,sku TEXT NOT NULL REFERENCES skus(sku),warehouse_id TEXT NOT NULL REFERENCES warehouses(id),snapshot_date TEXT NOT NULL,quantity REAL NOT NULL,UNIQUE(sku,warehouse_id,snapshot_date));
CREATE TABLE imported_files(hash TEXT PRIMARY KEY,original_name TEXT NOT NULL,stored_path TEXT NOT NULL,size_bytes INTEGER NOT NULL,import_type TEXT NOT NULL);`;
test('composed warehouse migration RPC requires both UI checks, backs up, stages originals, commits, verifies and deduplicates',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-cloud-migration-composed-')),serverDir=path.join(root,'server'),clientDir=path.join(root,'client'),assetRoot=path.join(root,'assets');for(const dir of [serverDir,clientDir,assetRoot])fs.mkdirSync(dir);
  const registryFile=path.join(root,'registry.json'),serverDb=path.join(serverDir,'erp.sqlite'),clientDb=path.join(clientDir,'erp.sqlite'),actor={v:1,id:'tailscale:owner@example.test',login:'owner@example.test',role:'admin',modules:['warehouse'],canRunTasks:true,sessionId:'composed-session',channel:'ui'};let control,source,stops=0;
  try{
    for(const file of [serverDb,clientDb]){const db=new DatabaseSync(file);db.exec(schema);db.close();}
    fs.mkdirSync(path.join(clientDir,'originals'));const original=Buffer.from('sku,quantity\nfixture-sku,23\n'),originalPath=path.join(clientDir,'originals','original.csv'),originalHash=createHash('sha256').update(original).digest('hex');fs.writeFileSync(originalPath,original);
    const db=new DatabaseSync(clientDb);db.prepare('INSERT INTO warehouses VALUES(?,?)').run('cainiao','菜鸟云仓');db.prepare('INSERT INTO skus VALUES(?,?,?)').run('fixture-sku','隔离演示商品','12345678901234567890');db.prepare('INSERT INTO inventory_snapshots(sku,warehouse_id,snapshot_date,quantity) VALUES(?,?,?,?)').run('fixture-sku','cainiao','2026-01-31',23);db.prepare('INSERT INTO imported_files VALUES(?,?,?,?,?)').run(originalHash,'original.csv',originalPath,original.length,'inventory');db.close();
    source=createWorkbenchMigration({databasePath:clientDb,dataDir:clientDir,sourceInstance:'fixture-client-source'});const bundle=source.exportSnapshot();assert.equal(bundle.records.length,4);for(const record of bundle.records)for(const descriptor of record.files){descriptor.stagingId=descriptor.sha256;fs.copyFileSync(descriptor.sourcePath,path.join(assetRoot,descriptor.sha256));assert.equal(descriptor.filename,path.basename(descriptor.sourcePath));delete descriptor.sourcePath;}assert.equal(JSON.stringify(bundle).includes(clientDir),false);
    const cfg={id:'lingtu-warehouse',root:serverDir,dataDir:serverDir,db:'erp.sqlite',keyFile:'.integration-key'};fs.writeFileSync(registryFile,JSON.stringify({warehouse:cfg}));
    control=await startCloudControl({root:serverDir,dataDir:serverDir,version:'0.7.4',busy:()=>false,activate:async()=>{},open:async()=>{},stop:()=>{},business:{startTask:()=>{throw Error('real collection forbidden');}},migration:{databasePath:serverDb,dataDir:serverDir,sourceInstance:'fixture-server'}});
    const runtime=()=>JSON.parse(fs.readFileSync(path.join(serverDir,'.integration-runtime-cloud.json'),'utf8'));
    const services={registryFile,config:id=>{assert.equal(id,'warehouse');return JSON.parse(fs.readFileSync(registryFile,'utf8')).warehouse;},ensure:async id=>{assert.equal(id,'warehouse');return {...runtime(),busy:false,maintenance:fs.existsSync(path.join(serverDir,'.workbench-maintenance.json'))};},capabilities:async()=>runtime(),stop:async()=>{stops++;throw Error('composed success path must not stop/restore an active database');}};
    const adapter=createServiceMigrationAdapter({services,id:'warehouse',backupRoot:path.join(root,'backups'),assetRoot}),coordinator=new MigrationCoordinator({root:path.join(root,'migrations'),adapters:{warehouse:adapter},serverId:'fixture-server-id',dataSetId:'fixture-data-set'}),input={clientId:'fixture-client',sourceDigest:digest(bundle),bundles:[bundle]};
    const staged=await coordinator.stage(input,actor);assert.equal(staged.status,'staged');await assert.rejects(coordinator.commit(staged.id,{revision:staged.revision,reviewDigest:'missing'},actor),/两次/);
    const initial=await coordinator.preview(staged.id,actor),selections={warehouse:initial.modules.warehouse.rows.map(row=>({kind:row.kind,sourceId:row.sourceId,action:'add'}))},selected=await coordinator.select(staged.id,{revision:initial.revision,selections},actor);await assert.rejects(coordinator.confirm(staged.id,{step:2,revision:selected.revision},actor),/第一次确认/);
    const first=await coordinator.confirm(staged.id,{step:1,revision:selected.revision},actor),second=await coordinator.confirm(staged.id,{step:2,revision:first.revision,reviewDigest:first.reviewDigest},actor),committed=await coordinator.commit(staged.id,{revision:second.revision,reviewDigest:second.reviewDigest},actor);
    assert.equal(committed.status,'completed',JSON.stringify(committed.error||committed.recovery));assert.equal(committed.results.warehouse.verification.ok,true);assert.equal(committed.results.warehouse.verified.length,4);assert.ok(committed.receipt);assert.equal(stops,0);assert.equal(fs.existsSync(path.join(serverDir,'.workbench-maintenance.json')),false);
    const reader=new DatabaseSync(serverDb);assert.equal(reader.prepare('SELECT quantity FROM inventory_snapshots').get().quantity,23);const stored=reader.prepare('SELECT stored_path FROM imported_files').get().stored_path;assert.ok(stored.startsWith(path.join(serverDir,'workbench-migration-files')));assert.deepEqual(fs.readFileSync(stored),original);reader.close();
    const journal=coordinator.read(staged.id);assert.ok(fs.existsSync(journal.backups.warehouse.database));assert.equal(createHash('sha256').update(fs.readFileSync(journal.backups.warehouse.database)).digest('hex'),journal.backups.warehouse.sha256);
    const retry=await coordinator.commit(staged.id,{revision:second.revision,reviewDigest:second.reviewDigest},actor);assert.equal(retry.status,'completed');assert.equal(retry.receipt.migrationId,committed.receipt.migrationId);
    const secondBatch=await coordinator.stage({...input,clientId:'fixture-other-client'},actor),again=await coordinator.preview(secondBatch.id,actor);assert.ok(again.modules.warehouse.rows.every(row=>row.action==='duplicate'));const kept=await coordinator.select(secondBatch.id,{revision:again.revision,selections:{warehouse:again.modules.warehouse.rows.map(row=>({kind:row.kind,sourceId:row.sourceId,action:'skip'}))}},actor),keptFirst=await coordinator.confirm(secondBatch.id,{step:1,revision:kept.revision},actor),keptSecond=await coordinator.confirm(secondBatch.id,{step:2,revision:keptFirst.revision,reviewDigest:keptFirst.reviewDigest},actor),deduped=await coordinator.commit(secondBatch.id,{revision:keptSecond.revision,reviewDigest:keptSecond.reviewDigest},actor);assert.equal(deduped.status,'completed',JSON.stringify(deduped.error));assert.equal(deduped.results.warehouse.verified.length,0);
    const final=new DatabaseSync(serverDb);assert.equal(final.prepare('SELECT COUNT(*) n FROM inventory_snapshots').get().n,1);assert.equal(final.prepare('SELECT COUNT(*) n FROM imported_files').get().n,1);final.close();
  }finally{await control?.close();source?.close();fs.rmSync(root,{recursive:true,force:true});}
});
