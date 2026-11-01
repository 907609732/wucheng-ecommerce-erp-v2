import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,sign} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {createServiceLifecycle} from '../desktop/modules/service-lifecycle.mjs';
import {withElectronLifecycle} from '../desktop/modules/electron-lifecycle.mjs';
import {ModuleManager} from '../desktop/modules/module-manager.mjs';
import {digest} from '../desktop/modules/package-format.mjs';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-async-lifecycle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
 const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);const ledger=path.join(dataDir,'ledger.sqlite');const db=new DatabaseSync(ledger);db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,paid_fen INTEGER);INSERT INTO orders VALUES(\'long-order-12345678901234567890\',12345)');db.close();
 const config={dataDir,db:'ledger.sqlite',exe:process.execPath},registryFile=path.join(root,'registry.json');fs.writeFileSync(registryFile,JSON.stringify({purchase:config,warehouse:config}));
 const services={registryFile,config:()=>config,capabilities:async()=>null,stop:async()=>{},ensure:async()=>{throw Error('Unexpected activation');}};
 const options={services,dataRoot:path.join(root,'new-data'),backupRoot:path.join(root,'backups'),getInstalled:()=>({root:path.dirname(process.execPath),entry:path.basename(process.execPath)})};
 return {root,dataDir,ledger,services,options,service:createServiceLifecycle(options)};
}
test('large many-file backup yields to UI timers while copy is incomplete',async t=>{
 const f=fixture(t),attachments=path.join(f.dataDir,'attachments'),total=600;fs.mkdirSync(attachments);const bytes=Buffer.alloc(64*1024,71);for(let i=0;i<total;i++)fs.writeFileSync(path.join(attachments,String(i)+'.bin'),bytes);
 let partialCopyTicks=0;const timer=setInterval(()=>{const dirs=fs.existsSync(f.options.backupRoot)?fs.readdirSync(f.options.backupRoot):[];for(const dir of dirs){const target=path.join(f.options.backupRoot,dir,'data','attachments');if(fs.existsSync(target)){const copied=fs.readdirSync(target).length;if(copied>0&&copied<total)partialCopyTicks++;}}},2);
 let backup;try{backup=await f.service.backup('purchase');}finally{clearInterval(timer);}
 assert.ok(partialCopyTicks>2,'UI timers must run while—not only before/after—the directory is being copied');
 assert.equal(fs.readdirSync(path.join(backup.directory,'data','attachments')).length,total);
 assert.deepEqual(fs.readFileSync(path.join(backup.directory,'data','attachments','599.bin')),bytes);
 const db=new DatabaseSync(path.join(backup.directory,'data','ledger.sqlite'));assert.equal(db.prepare('SELECT paid_fen FROM orders').get().paid_fen,12345);db.close();
});
test('link rejection aborts signed installation before activation and preserves registry and source',async t=>{
 const f=fixture(t),external=path.join(f.root,'external');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'private.txt'),'must stay external');fs.symlinkSync(external,path.join(f.dataDir,'linked'),process.platform==='win32'?'junction':'dir');
 const before=fs.readFileSync(f.services.registryFile),offline=path.join(f.root,'offline');fs.mkdirSync(offline);const archive=path.join(offline,'purchase.zip'),zip=new yazl.ZipFile();zip.addBuffer(Buffer.from('export const fixture=true;'),'server.mjs');zip.end();await pipeline(zip.outputStream,fs.createWriteStream(archive));
 const spec={id:'purchase',version:'1.0.0',hostRange:'>=0.7.1 <1',platform:'win32',arch:'x64',kind:'service',archive:'purchase.zip',entry:'server.mjs',bytes:fs.statSync(archive).size,unpackedBytes:64,sha256:await digest(archive),dependencies:[],url:'https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/test/purchase.zip'};
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),payload=Buffer.from(JSON.stringify({schemaVersion:1,packages:[spec]}));let activated=false;
 const manager=new ModuleManager({root:path.join(f.root,'modules'),hostVersion:'0.7.1',platform:'win32',arch:'x64',publicKeys:{test:publicKey.export({type:'spki',format:'pem'})},lifecycle:{...f.service,activate:async()=>{activated=true;}}});
 manager.setCatalog({format:'lingtu-catalog/v1',keyId:'test',payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')});
 await assert.rejects(manager.install('purchase',{offlineDirectory:offline}),{code:'UNSAFE_DATA_PATH'});
 assert.equal(activated,false);assert.deepEqual(manager.state().packages,{});assert.deepEqual(fs.readFileSync(f.services.registryFile),before);assert.equal(fs.readFileSync(path.join(external,'private.txt'),'utf8'),'must stay external');
});
test('Electron-owned profile backup rejects links and never marks an incomplete backup valid',async t=>{
 const f=fixture(t),workspace=path.join(f.dataDir,'workspace'),external=path.join(f.root,'external');fs.mkdirSync(workspace);fs.mkdirSync(external);fs.symlinkSync(external,path.join(workspace,'linked'),process.platform==='win32'?'junction':'dir');
 const lifecycle=withElectronLifecycle(f.service,f.options);await assert.rejects(lifecycle.backup('warehouse'),{code:'UNSAFE_DATA_PATH'});
 const directories=fs.readdirSync(f.options.backupRoot);assert.ok(directories.length>0);assert.equal(directories.some(dir=>fs.existsSync(path.join(f.options.backupRoot,dir,'backup.json'))),false);
});
test('corrupt SQLite is rejected by asynchronous database child check',async t=>{
 const f=fixture(t);fs.writeFileSync(f.ledger,'corrupt database');let ticks=0;const timer=setInterval(()=>ticks++,2);
 try{await assert.rejects(f.service.backup('purchase'),{code:'DATABASE_CHECK_FAILED'});}finally{clearInterval(timer);}
 assert.ok(ticks>0,'DB child validation must not block the event loop');
 assert.equal(fs.existsSync(f.options.backupRoot)&&fs.readdirSync(f.options.backupRoot).some(dir=>fs.existsSync(path.join(f.options.backupRoot,dir,'backup.json'))),false);
});
