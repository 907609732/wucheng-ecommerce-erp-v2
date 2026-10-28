// Runs only in a disposable Windows Sandbox. Its Playwright JS harness is mapped
// read-only; business code, Node and Chromium must all come from the installer.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import net from 'node:net';
assert.equal(os.userInfo().username,'WDAGUtilityAccount','Never run the uninstall/reinstall fixture on a real host');
const [output,installer,productExe]=process.argv.slice(2),installed=path.dirname(productExe),asar=path.join(installed,'resources/app.asar');
const mark=text=>fs.appendFileSync(path.join(output,'progress.log'),new Date().toISOString()+' '+text+'\n');
const evidence={scope:'Disposable Windows Sandbox; real full installer, offline, synthetic books only',networking:'Disabled by .wsb',checks:[],knownFailures:[],versions:{}};
const load=relative=>import(pathToFileURL(path.join(asar,relative)));
const {ServiceManager}=await load('desktop/shared/service-manager.mjs');
const {_electron:electron,chromium}=await import(pathToFileURL('C:/Kit/tools/node_modules/playwright/index.mjs'));
const version=JSON.parse(fs.readFileSync(path.join(asar,'desktop/launcher/package.json'),'utf8')).version;evidence.version=version;
const fixture=path.join(os.homedir(),'Desktop','OfflineWorkbenchFixture'),profile=path.join(fixture,'profile'),registryFile=path.join(fixture,'registry.json');
fs.mkdirSync(profile,{recursive:true});
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const ports=await Promise.all([0,1,2,3].map(freePort));
fs.writeFileSync(registryFile,JSON.stringify({warehouse:{allowInitialize:true},purchase:{allowInitialize:true,port:ports[0],mobilePort:ports[1]},sales:{allowInitialize:true,port:ports[2]},overview:{allowInitialize:true,port:ports[3]},exporter:{allowInitialize:true}}));
const env={...process.env,LINGTU_REGISTRY_PATH:registryFile,LINGTU_ISOLATED_TEST:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.LINGTU_SKIP_BUNDLED_ACTIVATION;
const services=new ServiceManager({registryFile});
const ids=['warehouse','purchase','sales','overview','exporter'];
const ledger=id=>path.join(services.config(id).dataDir,id==='warehouse'?'workspace/data/erp.sqlite':id==='exporter'?'orders.sqlite':services.config(id).db);
const observer=setInterval(()=>{
 const json=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
 const suite=json(path.join(profile,'suite-activation.json')),component=json(path.join(profile,'modules/transaction.json')),state=json(path.join(profile,'modules/installed.json'));
 fs.writeFileSync(path.join(output,'activation-progress.json'),JSON.stringify({phase:suite?.phase||null,error:suite?.error||null,component:component?.id||null,componentPhase:component?.phase||null,installed:Object.entries(state?.packages||{}).map(([id,p])=>({id,version:p.version})),receipt:fs.existsSync(path.join(profile,'suite-current.json'))},null,2));
},2000);observer.unref();
let app,browser;
async function closeUi(){if(!app)return;const current=app,pid=current.process().pid;app=null;await Promise.race([current.evaluate(({app})=>app.quit()).catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);await Promise.race([current.close().catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);const until=Date.now()+10000;while(Date.now()<until){try{process.kill(pid,0);}catch{return;}await new Promise(r=>setTimeout(r,100));}throw Error('Sandbox product UI process did not exit');}
async function openUi(){
 app=await electron.launch({executablePath:productExe,args:['--disable-gpu','--use-angle=swiftshader','--user-data-dir='+profile],env,timeout:600000});
 app.process().stderr?.on('data',chunk=>fs.appendFileSync(path.join(output,'ui-stderr.log'),chunk));
 const deadline=Date.now()+600000;
 // A preparation window may appear before the actual home page. Wait for the
 // real product surface instead of binding acceptance to window creation order.
 while(Date.now()<deadline){for(const page of app.windows())try{if(await page.locator('#cards button').count()){page.setDefaultTimeout(60000);return page;}}catch{}await new Promise(r=>setTimeout(r,250));}
 throw Error('Actual workbench home never became ready; inspect isolated UI stderr');
}
async function stopAll(){for(const id of ids)try{await services.stop(id);}catch(error){mark('stop '+id+' '+error.message);}}
async function waitAllStopped(){for(const id of ids){const until=Date.now()+15000;let stopped=false;while(Date.now()<until){const cap=await services.capabilities(id);if(!(id==='warehouse'||id==='exporter'?cap?.running:cap)){stopped=true;break;}await new Promise(r=>setTimeout(r,200));}assert(stopped,'Unused service did not exit within fifteen seconds: '+id);}}
async function waitReady(id){const until=Date.now()+30000;while(Date.now()<until){const cap=await services.capabilities(id);if(cap&&!cap.maintenance&&(!['warehouse','exporter'].includes(id)||cap.running))return cap;await new Promise(r=>setTimeout(r,200));}throw Error('Module did not become ready: '+id);}
async function waitView(cap){const until=Date.now()+30000;while(Date.now()<until){const urls=await app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>w.getURL()));if(urls.some(url=>url.startsWith(cap.url)))return;await new Promise(r=>setTimeout(r,200));}throw Error('Embedded page did not load');}
async function warmSwitches(page,views){
 const results={scope:'Five measured returns to each already loaded native WebContentsView; cold service/page startup excluded',modules:{}};
 for(const [id,contentId] of Object.entries(views)){
  await app.evaluate(async({webContents},{contentId,id})=>webContents.fromId(contentId).executeJavaScript(`(()=>{window.__workbenchAcceptanceRetention=${JSON.stringify(id)};const input=document.createElement('input');input.id='__workbench_acceptance_retained_input';input.style.display='none';input.value=${JSON.stringify('synthetic-'+id)};document.body.appendChild(input)})()`),{contentId,id});
  const samples=[];
  for(let index=0;index<5;index++){
   await page.locator('#home').click();
   const started=performance.now();await page.locator('[data-module='+id+'] button').click();
   const until=Date.now()+10000;let visible=false;
   while(Date.now()<until){visible=await app.evaluate(({BrowserWindow},contentId)=>BrowserWindow.getAllWindows().flatMap(win=>win.contentView.children).some(view=>view.webContents?.id===contentId&&view.getVisible()),contentId);if(visible)break;await new Promise(r=>setTimeout(r,5));}
   assert(visible,'Warm view did not become visible: '+id);samples.push(Number((performance.now()-started).toFixed(2)));
   const retained=await app.evaluate(async({webContents},contentId)=>webContents.fromId(contentId).executeJavaScript("({marker:window.__workbenchAcceptanceRetention,input:document.getElementById('__workbench_acceptance_retained_input')?.value})"),contentId);
   assert.equal(retained.marker,id);assert.equal(retained.input,'synthetic-'+id);
  }
  const sorted=[...samples].sort((a,b)=>a-b);results.modules[id]={webContentsId:contentId,samplesMs:samples,medianMs:sorted[2],maxMs:sorted.at(-1),allWithinOneSecond:samples.every(value=>value<=1000),pageStateRetained:true};
 }
 fs.writeFileSync(path.join(output,'warm-switches.json'),JSON.stringify(results,null,2));return results;
}
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try{
 let internet=false;try{await fetch('https://example.com',{signal:AbortSignal.timeout(3000)});internet=true;}catch{}assert.equal(internet,false,'Offline VM unexpectedly reached the Internet');
 evidence.environment=JSON.parse(fs.readFileSync(path.join(output,'environment-before.json'),'utf8').replace(/^\uFEFF/,''));
 assert(evidence.environment.noSystemNode&&evidence.environment.noBrowserCache&&evidence.environment.noBusinessSource);
 mark('Launching actual first-run workbench; no manual component import');
 let page=await openUi();
 const state=JSON.parse(fs.readFileSync(path.join(profile,'modules/installed.json'),'utf8'));
 assert.equal(Object.keys(state.packages).length,7);assert(fs.existsSync(path.join(profile,'suite-current.json')));assert.equal(fs.existsSync(path.join(profile,'suite-activation.json')),false);
 await waitAllStopped();
 for(const id of ids){if(!fs.existsSync(ledger(id))&&id==='warehouse'){evidence.knownFailures.push('FRESH_WAREHOUSE_LEDGER_MISSING');}else{assert(fs.existsSync(ledger(id)),'Missing new formal book: '+id);const db=new DatabaseSync(ledger(id),{readOnly:true});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();}const cap=await services.capabilities(id);assert(!(id==='warehouse'||id==='exporter'?cap?.running:cap),'An unused module remained running: '+id);}
 assert.deepEqual(await page.locator('#cards button').allTextContents(),['打开','打开','打开','打开']);
 await page.screenshot({path:path.join(output,'fresh-home.png')});
 evidence.checks.push('Actual UI first launch automatically installs seven signed components offline; existing new books pass integrity checks; unused services stop');
 const warmViews={};
 for(const id of ['purchase','sales','overview']){mark('Opening '+id);await page.locator('#home').click();await page.locator('[data-module='+id+'] button').click();await page.locator('#deskPanel').waitFor({state:'visible'});const cap=await waitReady(id);evidence.versions[id]=cap.version;await waitView(cap);warmViews[id]=await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows().flatMap(win=>win.contentView.children).find(view=>view.webContents?.getURL().startsWith(url))?.webContents.id,cap.url);assert(warmViews[id]);}
 evidence.warmSwitches=await warmSwitches(page,warmViews);evidence.checks.push('Five measured warm returns per embedded module retain the same WebContents and synthetic DOM input state; raw timings are recorded separately');
 await page.locator('#home').click();await page.locator('[data-module=warehouse] button').click();const cloud=await waitReady('warehouse');assert(cloud.running&&!cloud.maintenance);if(!cloud.dataSetId){if(!evidence.knownFailures.includes('FRESH_WAREHOUSE_LEDGER_MISSING'))throw Error('Warehouse dataset identity missing');}evidence.versions.warehouse=cloud.version;
 const exporter=await services.ensure('exporter');assert(exporter.running&&!exporter.maintenance);assert(exporter.dataSetId);evidence.versions.exporter=exporter.version;
 evidence.checks.push('Home entries open real services and embedded module pages; warehouse/exporter report stable dataset identities');
 const runtime=state.packages['browser-runtime'];browser=await chromium.launch({executablePath:path.join(runtime.root,runtime.entry),headless:true,args:['--disable-gpu','--use-angle=swiftshader']});const tab=await browser.newPage();await tab.setContent('<h1>Bundled browser works offline</h1>');assert.equal(await tab.locator('h1').textContent(),'Bundled browser works offline');await browser.close();browser=null;evidence.checks.push('Installed bundled Chromium launches without a system browser cache');
 await closeUi();await stopAll();await waitAllStopped();
 const doctor=spawnSync(productExe,['--cli','doctor','--user-data-dir='+profile,'--registry-file='+registryFile],{env,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
 fs.writeFileSync(path.join(output,'installed-cli-doctor-process.json'),JSON.stringify({status:doctor.status,stdout:doctor.stdout,stderr:doctor.stderr,error:doctor.error?.message},null,2));assert.equal(doctor.status,0,'Installed standalone CLI doctor failed');
 const diagnosis=JSON.parse(doctor.stdout.trim());assert.equal(diagnosis.ok,true);assert(diagnosis.diagnostics&&typeof diagnosis.diagnostics==='object');
 fs.writeFileSync(path.join(output,'installed-cli-doctor.json'),JSON.stringify(diagnosis,null,2));evidence.checks.push('Actual installed standalone --cli doctor returns ok:true diagnostics through the warehouse child-process fallback, using the explicit profile and registry; no sync/login/send commands run');
 const sentinels=[];
 if(!evidence.knownFailures.length){
 for(const id of ids){const file=ledger(id);if(!fs.existsSync(file)&&id==='warehouse')continue;const db=new DatabaseSync(file);db.exec('CREATE TABLE IF NOT EXISTS acceptance_sentinel(id TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT OR REPLACE INTO acceptance_sentinel VALUES(?,?)').run('offline-fixture','synthetic-'+id);db.close();const asset=path.join(services.config(id).dataDir,'acceptance-original.txt');fs.writeFileSync(asset,'Synthetic original '+id+'\n');sentinels.push({id,asset,sha256:sha(asset)});}
 const uninstall=fs.readdirSync(installed).find(name=>/^Uninstall .*\.exe$/i.test(name));assert(uninstall,'Installer did not create a product uninstaller');
 mark('Uninstalling workbench in Sandbox, preserving synthetic business data');const removed=spawnSync(path.join(installed,uninstall),['/S'],{env,windowsHide:true,timeout:600000});assert.equal(removed.status,0);
 for(const {id,asset,sha256}of sentinels){assert(fs.existsSync(ledger(id)));assert.equal(sha(asset),sha256);}
 mark('Reinstalling full setup offline');const install=spawnSync(installer,['/S'],{env,windowsHide:true,timeout:600000});assert.equal(install.status,0);
 page=await openUi();await page.screenshot({path:path.join(output,'reinstalled-home.png')});
 for(const {id,asset,sha256}of sentinels){const db=new DatabaseSync(ledger(id),{readOnly:true});assert.equal(db.prepare('SELECT value FROM acceptance_sentinel WHERE id=?').get('offline-fixture').value,'synthetic-'+id);db.close();assert.equal(sha(asset),sha256);const cap=await services.ensure(id);assert(cap&&!cap.maintenance);}
 evidence.checks.push('Actual product uninstall and reinstall preserve all five synthetic books and original files; modules reopen without downloading');
 // Bind this disposable profile canonically before enabling real Windows Run.
 // Reboot must not depend on a transient test environment variable.
 await closeUi();await stopAll();await waitAllStopped();
 const markerFile=path.join(os.homedir(),'Documents/LingtuWorkbench/workbench-location.json');
 fs.mkdirSync(path.dirname(markerFile),{recursive:true});fs.writeFileSync(markerFile,JSON.stringify({schemaVersion:1,profile:fs.realpathSync.native(profile),registryFile:fs.realpathSync.native(registryFile)}));
 delete env.LINGTU_ISOLATED_TEST;page=await openUi();
 const saved=await page.evaluate(()=>window.launcher.savePreferences({startAtLogin:true}));assert.equal(saved.startAtLogin,true);
 const integrations=await page.evaluate(()=>window.launcher.integrationConfig());assert(integrations.mcp.mcpServers.wucheng.args.includes('--registry-file='+registryFile));assert(integrations.cli.args.includes('--registry-file='+registryFile));
 const bootProbe=spawnSync(path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File','C:/Kit/suite-sandbox-boot-probe.ps1','-OutputFile','C:/WorkbenchAcceptanceBootProbe.json'],{encoding:'utf8',windowsHide:true,timeout:60000});
 fs.writeFileSync(path.join(output,'boot-probe-process.json'),JSON.stringify({status:bootProbe.status,stdout:bootProbe.stdout,stderr:bootProbe.stderr,error:bootProbe.error?.message},null,2));assert.equal(bootProbe.status,0,'Sandbox-only boot witness could not be created');
 const bootWitness=JSON.parse(fs.readFileSync('C:/WorkbenchAcceptanceBootProbe.json','utf8'));fs.writeFileSync(path.join(output,'boot-witness-before.json'),JSON.stringify(bootWitness,null,2));assert(bootWitness.token&&bootWitness.volatileKey);
 const rebootState={version,profile,registryFile,productExe,output,bootWitness,node:path.join(state.packages['node-runtime'].root,state.packages['node-runtime'].entry),fingerprint:JSON.parse(fs.readFileSync(path.join(profile,'suite-current.json'),'utf8')).fingerprint,books:sentinels.map(row=>({...row,database:ledger(row.id)}))};
 fs.writeFileSync('C:/WorkbenchAcceptanceReboot.json',JSON.stringify(rebootState,null,2));
 fs.copyFileSync('C:/Kit/suite-sandbox-resume.ps1','C:/WorkbenchAcceptanceResume.ps1');fs.copyFileSync('C:/Kit/suite-sandbox-resume-check.mjs','C:/WorkbenchAcceptanceResumeCheck.mjs');fs.copyFileSync('C:/Kit/suite-sandbox-book-probe.ps1','C:/WorkbenchAcceptanceBookProbe.ps1');
 const preflight=spawnSync(path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File','C:/WorkbenchAcceptanceBookProbe.ps1','-StateFile','C:/WorkbenchAcceptanceReboot.json','-OutputStem','C:/Results/pre-reboot-books'],{encoding:'utf8',windowsHide:true,timeout:90000});
 fs.writeFileSync(path.join(output,'pre-reboot-books-wrapper.json'),JSON.stringify({status:preflight.status,stdout:preflight.stdout,stderr:preflight.stderr,error:preflight.error?.message},null,2));assert.equal(preflight.status,0,'The exact post-reboot book probe did not pass before reboot');
 const resumeCommand='"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\\WorkbenchAcceptanceResume.ps1"';
 const registered=spawnSync('reg.exe',['add','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce','/v','LingtuSuiteAcceptanceResume','/t','REG_SZ','/d',resumeCommand,'/f'],{windowsHide:true,encoding:'utf8'});assert.equal(registered.status,0);
 evidence.rebootPending=true;evidence.checks.push('Real settings enable Windows login startup; exported MCP/CLI retain the explicit registry; the identical post-boot book probe passes before reboot');mark('Ready for actual Sandbox-only reboot');
 }else evidence.checks.push('Uninstall/reinstall deferred until the known fresh warehouse ledger bootstrap defect is rebuilt');
 evidence.syntheticBooksRetained=sentinels.length;evidence.ok=evidence.knownFailures.length===0;if(!evidence.ok)process.exitCode=1;mark(evidence.ok?'PASS':'COMPLETED WITH KNOWN FAILURES');
}catch(error){evidence.ok=false;evidence.error=error.stack;process.exitCode=1;mark('FAIL '+error.message);}
finally{clearInterval(observer);if(browser)await browser.close().catch(()=>{});await closeUi();await stopAll();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2));}
