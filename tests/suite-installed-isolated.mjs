// Invoke with the CANDIDATE Electron executable and ELECTRON_RUN_AS_NODE=1.
// No host installer, global registry, fixed business port or real profile is used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {_electron as electron,chromium} from 'playwright';

assert(process.versions.electron,'Use the packaged Electron as Node for packaged ASAR imports');
const resources=path.join(path.dirname(process.execPath),'resources'),asar=path.join(resources,'app.asar');
assert(fs.existsSync(path.join(resources,'bundled-suite/catalog.json')),'Candidate has no complete suite');
const load=relative=>import(pathToFileURL(path.join(asar,relative)));
const {ModuleManager}=await load('desktop/modules/module-manager.mjs');
const {ServiceManager}=await load('desktop/shared/service-manager.mjs');
const {createServiceLifecycle}=await load('desktop/modules/service-lifecycle.mjs');
const {withElectronLifecycle}=await load('desktop/modules/electron-lifecycle.mjs');
const {ensureBundledSuite}=await load('desktop/modules/bundled-suite.mjs');
const {initializeUnifiedData}=await load('desktop/workbench-migration/local-data-move.mjs');
const version=JSON.parse(fs.readFileSync(path.join(asar,'desktop/launcher/package.json'),'utf8')).version;
const reused=!!process.env.LINGTU_ACCEPTANCE_FIXTURE;
const fixture=reused?path.resolve(process.env.LINGTU_ACCEPTANCE_FIXTURE):fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-full-suite-')),profile=path.join(fixture,'profile'),registryFile=path.join(fixture,'registry.json'),dataRoot=path.join(fixture,'Data');
if(!fixture.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(fixture).startsWith('lingtu-full-suite-')||fs.lstatSync(fixture).isSymbolicLink())throw Error('Acceptance fixture must be its own plain temporary namespace');
fs.mkdirSync(profile,{recursive:true});
const output=path.resolve('dist/module-verification');fs.mkdirSync(output,{recursive:true});
const report={version,scope:'Local complete candidate, isolated temporary profile/data/ports; no host installation, credentials or production business records',checks:[],moduleDownloads:0,reusedSyntheticFixture:reused};
const reportFile=path.join(output,'suite-isolated-'+version+'.json'),progressFile=path.join(output,'suite-isolated-'+version+'-progress.json');
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const ports=[];if(!reused)while(ports.length<4){const port=await freePort();if(!ports.includes(port))ports.push(port);}
const ids=['warehouse','purchase','sales','overview','exporter'];
if(!reused)fs.writeFileSync(registryFile,JSON.stringify(Object.fromEntries(ids.map((id,index)=>[id,{managed:true,allowInitialize:true,root:path.join(fixture,'old-program',id),exe:path.join(fixture,'old-program',id,'missing.exe'),dataDir:path.join(dataRoot,id),...(id==='purchase'?{port:ports[0],mobilePort:ports[1]}:id==='sales'?{port:ports[2]}:id==='overview'?{port:ports[3]}:{})}]))));
const services=new ServiceManager({registryFile,policyFile:path.join(profile,'unused-access-policy.json')});
for(const id of ids)if(!path.resolve(services.config(id).dataDir).startsWith(path.resolve(fixture)+path.sep))throw Error('Acceptance registry points outside its synthetic fixture');
if(!reused){initializeUnifiedData({services,dataRoot,mode:'standalone'});const warehouseDir=services.config('warehouse').dataDir;fs.mkdirSync(warehouseDir,{recursive:true});fs.writeFileSync(path.join(warehouseDir,'settings.json'),JSON.stringify({runtimeMode:'standalone',remoteServiceEnabled:false,scheduleEnabled:false,monthlySalesEnabled:false,startAtLogin:false}));}
const modules=new ModuleManager({root:path.join(profile,'modules'),hostVersion:version,publicKeys:JSON.parse(fs.readFileSync(path.join(asar,'desktop/launcher/public-keys.json'),'utf8')),fetchImpl:()=>{report.moduleDownloads++;throw Error('Acceptance permits only embedded offline artifacts');}});
const lifecycleOptions={services,dataRoot,backupRoot:path.join(profile,'module-backups'),getInstalled:id=>modules.state().packages[id]};
modules.lifecycle=withElectronLifecycle(createServiceLifecycle(lifecycleOptions),lifecycleOptions);
const options={modules,services,profile,bundleDirectory:path.join(resources,'bundled-suite'),mode:'standalone',onProgress:value=>fs.writeFileSync(progressFile,JSON.stringify(value))};
const ledger=id=>path.join(services.config(id).dataDir,id==='warehouse'?'workspace/data/erp.sqlite':id==='exporter'?'orders.sqlite':services.config(id).db);
let app,browser;
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function waitStopped(id){const until=Date.now()+15000;while(Date.now()<until){const cap=await services.capabilities(id);if(!(id==='warehouse'||id==='exporter'?cap?.running:cap))return;await new Promise(r=>setTimeout(r,200));}throw Error('Unused service did not exit within fifteen seconds: '+id);}
async function waitAllStopped(){for(const id of ids)await waitStopped(id);}
async function waitReady(id){const until=Date.now()+30000;while(Date.now()<until){const cap=await services.capabilities(id);if(cap&&!cap.maintenance&&(!['warehouse','exporter'].includes(id)||cap.running))return cap;await new Promise(r=>setTimeout(r,200));}throw Error('Module did not become ready: '+id);}
async function waitView(cap){const until=Date.now()+30000;while(Date.now()<until){const urls=await app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>w.getURL()));if(urls.some(url=>url.startsWith(cap.url)))return;await new Promise(r=>setTimeout(r,200));}throw Error('Actual embedded module page did not load');}
const step=value=>fs.writeFileSync(progressFile,JSON.stringify({phase:'acceptance',step:value}));
async function stopAll(){for(const id of ids)try{await services.stop(id);}catch(error){report.cleanupWarnings??=[];report.cleanupWarnings.push(id+': '+error.message);}}
async function closeUi(){
 if(!app)return;const current=app,pid=current.process().pid;app=null;
 await Promise.race([current.evaluate(({app})=>app.quit()).catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);
 await Promise.race([current.close().catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);
 const until=Date.now()+10000;while(Date.now()<until){try{process.kill(pid,0);}catch{return;}await new Promise(r=>setTimeout(r,100));}throw Error('Isolated product UI process did not exit');
}
try{
 if(reused){await stopAll();await waitAllStopped();}
 const activation=await ensureBundledSuite(options);assert(activation.ready);if(!reused)assert(activation.activated);assert.equal(Object.keys(modules.state().packages).length,7);
 await waitAllStopped();
 for(const id of ids){assert(fs.existsSync(ledger(id)),'Fresh '+id+' book is absent');const db=new DatabaseSync(ledger(id),{readOnly:true});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();const cap=await services.capabilities(id);assert(!(id==='warehouse'||id==='exporter'?cap?.running:cap),'Unused service was left running: '+id);}
 report.checks.push('Seven signed artifacts activate entirely offline; all five books initialize and pass integrity checks; unused services stop');
 report.versions=Object.fromEntries(Object.entries(modules.state().packages).map(([id,p])=>[id,p.version]));
 step('bundled-browser');
 const runtime=modules.state().packages['browser-runtime'];browser=await chromium.launch({executablePath:path.join(runtime.root,runtime.entry),headless:true,args:['--disable-gpu','--use-angle=swiftshader']});const tab=await browser.newPage();await tab.setContent('<h1>Offline bundled browser</h1>');assert.equal(await tab.locator('h1').textContent(),'Offline bundled browser');await browser.close();browser=null;
 const env={...process.env,LINGTU_REGISTRY_PATH:registryFile,LINGTU_ISOLATED_TEST:'1',LINGTU_SKIP_BUNDLED_ACTIVATION:'1'};delete env.ELECTRON_RUN_AS_NODE;
 step('ui-home');app=await electron.launch({executablePath:process.execPath,args:['--disable-gpu','--use-angle=swiftshader','--user-data-dir='+profile],env,timeout:60000});const page=await app.firstWindow();page.setDefaultTimeout(60000);await page.locator('#cards button').first().waitFor();assert.deepEqual(await page.locator('#cards button').allTextContents(),['打开','打开','打开','打开']);await page.screenshot({path:path.join(output,'suite-isolated-home-'+version+'.png')});
 for(const id of ['purchase','sales','overview']){step('ui-'+id);await page.locator('#home').click();await page.locator('[data-module='+id+'] button').click();await page.locator('#deskPanel').waitFor({state:'visible'});const cap=await waitReady(id);await waitView(cap);}
 step('ui-warehouse');await page.locator('#home').click();await page.locator('[data-module=warehouse] button').click();const cloud=await waitReady('warehouse');assert(cloud.running&&!cloud.maintenance&&cloud.dataSetId);
 const exporter=await services.ensure('exporter');assert(exporter.running&&!exporter.maintenance&&exporter.dataSetId);
 report.checks.push('Four home entries open real module services and retained embedded pages; bundled Chromium and exporter initialize');
 step('close-ui');await closeUi();await stopAll();await waitAllStopped();
 const sentinels=[];for(const id of ids){const db=new DatabaseSync(ledger(id));db.exec('CREATE TABLE acceptance_sentinel(id TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT INTO acceptance_sentinel VALUES(?,?)').run('only-synthetic','fixture-'+id);db.close();const file=path.join(services.config(id).dataDir,'acceptance-original.txt');fs.writeFileSync(file,'Synthetic original '+id);sentinels.push({id,file,sha256:hash(file)});}
 step('managed-removal');await modules.uninstall('purchase');assert(fs.existsSync(ledger('purchase')));await ensureBundledSuite({...options,forceVerification:true});await waitAllStopped();step('retained-data-verification');
 for(const {id,file,sha256}of sentinels){const db=new DatabaseSync(ledger(id),{readOnly:true});assert.equal(db.prepare('SELECT value FROM acceptance_sentinel WHERE id=?').get('only-synthetic').value,'fixture-'+id);db.close();assert.equal(hash(file),sha256);}
 assert.equal(report.moduleDownloads,0);report.checks.push('Low-level managed component removal and full-suite recovery retain all five synthetic books and original files; zero module downloads');
 report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;}
finally{
 if(browser)await browser.close().catch(()=>{});await closeUi();await stopAll();
 // Retain the synthetic fixture for a separate explicit cleanup pass. Electron's
 // patched fs must never recursively traverse its nested app.asar payloads.
 report.fixtureRetained=true;report.fixture=fixture;
 fs.writeFileSync(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
