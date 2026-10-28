import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import {tailnetAlive} from '../desktop/workbench-client/tailnet-runtime.mjs';

const packaged=!!process.env.LAUNCHER_TEST_EXE;
const reportDir=path.resolve('dist/module-verification');
const label=packaged?'packaged':'source';
const reportFile=path.join(reportDir,'workbench-tailnet-settings-native-'+label+'.json');
const screenshot=path.join(reportDir,'workbench-tailnet-settings-native-'+label+'.png');
const origin='https://settings-inert.synthetic-tail.ts.net:8443';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(25);}throw Error(label);}

test('actual launcher settings use safeStorage and inert Go without enrollment; logout and identity failure clear private cache',{skip:process.platform!=='win32',timeout:90000},async t=>{
 fs.mkdirSync(reportDir,{recursive:true});
 const created=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-tailnet-settings-inert-')),dir=fs.realpathSync.native(created),profile=path.join(dir,'profile'),registry=path.join(dir,'registry.json');fs.mkdirSync(profile);
 fs.writeFileSync(registry,JSON.stringify(Object.fromEntries(['warehouse','purchase','sales','overview','exporter'].map(id=>[id,{managed:true,root:path.join(profile,'absent-programs',id),dataDir:path.join(profile,'absent-ledgers',id),exe:path.join(profile,'absent-programs',id,'absent.exe')}]))));
 let desktop,descriptor,component,version,cleanupDone=false;const pageErrors=[];const report={schemaVersion:1,checkedAt:new Date().toISOString(),scope:'Isolated actual launcher settings + actual Electron safeStorage + actual Go init/status/logout rejection/shutdown only; no start/login or real Tailnet',mode:label,ok:false,realProfileAccessed:false,nodeEnrollmentStarted:false,systemProxyChanged:false,businessServicesStarted:false};
 async function appModule(main,relative){return desktop.evaluate(async(_electron,{relative,main})=>{
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),base=_electron.app.getAppPath(),require=process.getBuiltinModule('module').createRequire(path.join(base,'package.json'));let file=path.join(base,'desktop',relative);if(!fs.existsSync(file))file=path.resolve(base,'..',relative);
  const module=require(file);return {file,exists:!!module[main]};
 },{relative,main});}
 const cleanup=async()=>{
  if(cleanupDone)return;cleanupDone=true;
  if(desktop){try{await desktop.evaluate(async({app,safeStorage},{profile,origin,binary})=>{
   const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),require=process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(),'package.json'));let file=path.join(app.getAppPath(),'desktop/workbench-client/tailnet-runtime.mjs');if(!fs.existsSync(file))file=path.resolve(app.getAppPath(),'../workbench-client/tailnet-runtime.mjs');const {TailnetRuntime}=require(file);
   const r=new TailnetRuntime({profile,origin,sidecarPath:binary,encrypt:plain=>safeStorage.encryptStringAsync?safeStorage.encryptStringAsync(plain):safeStorage.encryptString(plain),decrypt:bytes=>safeStorage.decryptStringAsync?safeStorage.decryptStringAsync(bytes):safeStorage.decryptString(bytes)});await r.shutdown();
  },{profile,origin,binary:component?.binary||path.resolve('dist/tailnet-runtime/lingtu-tailnet.exe')});}catch{}
   try{await desktop.close();}catch{if(desktop.process()?.exitCode===null)desktop.process().kill();}
  }
  if(descriptor){for(const pid of [descriptor.pid,descriptor.goPid])if(tailnetAlive(pid))try{process.kill(pid);}catch{}await until(()=>!tailnetAlive(descriptor.pid)&&!tailnetAlive(descriptor.goPid),'owned inert broker did not exit');}
  assert(path.basename(dir).startsWith('workbench-tailnet-settings-inert-'));assert.equal(fs.realpathSync.native(dir),dir);fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});report.cleanup={ownedLauncherClosed:true,ownedBrokerAndGoClosed:true,isolatedProfileRemoved:true};
 };
 t.after(async()=>{await cleanup();fs.writeFileSync(reportFile,JSON.stringify(report,null,2));});
 const env={...process.env,LINGTU_ISOLATED_TEST:'1',LINGTU_SKIP_BUNDLED_ACTIVATION:'1',LINGTU_REGISTRY_PATH:registry};delete env.ELECTRON_RUN_AS_NODE;
 desktop=await electron.launch({executablePath:path.resolve(process.env.LAUNCHER_TEST_EXE||'node_modules/electron/dist/electron.exe'),args:[...(packaged?[]:[path.resolve('desktop/launcher')]),'--user-data-dir='+profile],env});
 const page=await desktop.firstWindow();page.on('pageerror',error=>pageErrors.push(error.message));
 await page.locator('#cards [data-module=warehouse] button').waitFor();await page.locator('#settings').click();await page.locator('#settingsPanel').waitFor({state:'visible'});await page.evaluate(()=>window.launcher.list());
 version=await desktop.evaluate(({app})=>app.getVersion());report.launcherVersion=version;
 component=await desktop.evaluate(async({app})=>{const path=process.getBuiltinModule('path'),fs=process.getBuiltinModule('fs'),crypto=process.getBuiltinModule('crypto'),root=app.isPackaged?path.join(process.resourcesPath,'tailnet-runtime'):path.resolve(app.getAppPath(),'../../dist/tailnet-runtime'),binary=path.join(root,'lingtu-tailnet.exe'),manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')),bytes=fs.readFileSync(binary);return{binary,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),manifest};});
 assert.equal(component.bytes,component.manifest.bytes);assert.equal(component.sha256,component.manifest.sha256);report.component={bytes:component.bytes,sha256:component.sha256,protocolVersion:component.manifest.protocolVersion};
 const refs=await appModule('ConnectionStore','workbench-client/connection.mjs');
 await desktop.evaluate(async({safeStorage},{file,profile,origin})=>{
  const path=process.getBuiltinModule('path'),require=process.getBuiltinModule('module').createRequire(file),{ConnectionStore}=require(file),{SnapshotCache}=require(path.join(path.dirname(file),'cache.mjs')),c=new ConnectionStore(profile);
  c.configure({mode:'client',serverUrl:origin,networkProvider:'embedded'});c.bind({serverId:'synthetic-server',dataSetId:'synthetic-books',userId:'synthetic-member'});c.bindModule('purchase','synthetic-purchase');
  const cache=new SnapshotCache({root:path.join(profile,'client-cache'),encrypt:p=>safeStorage.encryptStringAsync?safeStorage.encryptStringAsync(p):safeStorage.encryptString(p),decrypt:b=>safeStorage.decryptStringAsync?safeStorage.decryptStringAsync(b):safeStorage.decryptString(b)});await cache.put(c.cacheScope('purchase'),'purchase',[{orderNo:'SYNTHETIC_PRIVATE_CACHE_MARKER',amountCents:1234}]);
 },{file:refs.file,profile,origin});
 // Refresh only settings state; load() or business open would auto-connect and
 // therefore start tsnet, which this deliberately inert fixture never calls.
 await page.evaluate(()=>loadConnection());
 assert.equal(await page.getByText('下载使用',{exact:true}).count(),0,'client settings cannot retain local module download buttons');report.clientSettingsOnlyRemoteModules=true;
 const status=await page.evaluate(()=>window.launcher.networkStatus());assert.equal(status.state,'stopped');assert.equal(status.connected,false);assert(!('loginURL' in status));assert(!('proxyPassword' in status));report.inertStatus=true;
 const runtimeInfo=await desktop.evaluate(async({app,safeStorage},{profile,origin,binary})=>{
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),require=process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(),'package.json'));let file=path.join(app.getAppPath(),'desktop/workbench-client/tailnet-runtime.mjs');if(!fs.existsSync(file))file=path.resolve(app.getAppPath(),'../workbench-client/tailnet-runtime.mjs');const {TailnetRuntime}=require(file),r=new TailnetRuntime({profile,origin,sidecarPath:binary,encrypt:p=>safeStorage.encryptStringAsync?safeStorage.encryptStringAsync(p):safeStorage.encryptString(p),decrypt:b=>safeStorage.decryptStringAsync?safeStorage.decryptStringAsync(b):safeStorage.decryptString(b)}),owned=await r.ensure(),cipher=fs.readFileSync(r.paths.record);
  return{descriptor:owned.descriptor,stateDir:r.paths.stateDir,recordEncrypted:[owned.record.controlToken,owned.record.proxyPassword,owned.record.nonce,origin].every(s=>!cipher.includes(Buffer.from(s))),safeStorage:safeStorage.isEncryptionAvailable()};
 },{profile,origin,binary:component.binary});descriptor=runtimeInfo.descriptor;assert.equal(runtimeInfo.safeStorage,true);assert.equal(runtimeInfo.recordEncrypted,true);report.safeStorageRecordEncrypted=true;
 assert.deepEqual(fs.readdirSync(runtimeInfo.stateDir),['sidecar.lock']);
 assert((await page.evaluate(()=>window.launcher.cached('purchase'))).data.length===1);
 await page.evaluate(()=>{document.querySelector('#cacheData').textContent='SYNTHETIC_PRIVATE_CACHE_MARKER';document.querySelector('#cacheStatus').textContent='synthetic cache';});
 await desktop.evaluate(async(_,{file,profile})=>{const require=process.getBuiltinModule('module').createRequire(file),{ConnectionStore}=require(file),c=new ConnectionStore(profile);try{c.bindModule('purchase','replacement-purchase');}catch{}c.bind({serverId:'synthetic-server',dataSetId:'synthetic-books',userId:'synthetic-member'});},{file:refs.file,profile});
 const locked=await page.evaluate(async()=>{try{await window.launcher.cached('purchase');return false;}catch{return true;}});assert.equal(locked,true);await page.evaluate(()=>loadConnection());assert.equal(await page.locator('#cacheData').textContent(),'');report.moduleIdentityFailureCacheLocked=true;report.moduleIdentityFailureClearedDOM=true;
 await desktop.evaluate(async(_,{file,profile})=>{const require=process.getBuiltinModule('module').createRequire(file),{ConnectionStore}=require(file);new ConnectionStore(profile).bindModule('purchase','synthetic-purchase');},{file:refs.file,profile});
 const partition='persist:workbench-'+createHash('sha256').update(origin).digest('hex').slice(0,24);
 await desktop.evaluate(async({session},{partition,origin})=>{await session.fromPartition(partition).cookies.set({url:origin,name:'__Host-workbench-session',value:'synthetic-cookie-only',path:'/',secure:true,httpOnly:true,sameSite:'strict'});},{partition,origin});
 await page.evaluate(()=>{document.querySelector('#cacheData').textContent='SYNTHETIC_PRIVATE_CACHE_MARKER';document.querySelector('#cacheStatus').textContent='synthetic cache';});
 await page.locator('#privateNetworkLogout').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('尚未注销'));
 const suspended=JSON.parse(fs.readFileSync(path.join(profile,'workbench-connection.json'),'utf8'));assert.equal(suspended.cacheLocked,true);assert.equal(suspended.networkSuspended,true);assert.equal(await page.locator('#cacheData').textContent(),'');report.logoutRejectedWithoutStartingNode=true;report.logoutFailureCacheLocked=true;report.logoutFailureClearedDOM=true;report.logoutFailureNetworkSuspended=true;
 const cookieCount=await desktop.evaluate(async({session},{partition,origin})=>(await session.fromPartition(partition).cookies.get({url:origin})).length,{partition,origin});assert.equal(cookieCount,0,'logout must clear this origin Session even if no API request has initialized clientSession');report.logoutClearedCookies=true;
 await page.reload();await page.locator('#settings').click();await page.locator('#privateNetworkPanel').waitFor({state:'visible'});await page.evaluate(async()=>{await loadConnection();await pollPrivateNetwork();});
 assert.match(await page.locator('#privateNetworkStatus').textContent(),/暂停/);assert.equal((await page.evaluate(()=>window.launcher.networkStatus())).state,'stopped');assert.equal(await page.getByText('下载使用',{exact:true}).count(),0);report.suspensionSurvivesRendererReload=true;
 // A synthetic running status exercises the dangerous BUSY/logout case without
 // ever starting the real Go backend. Any accidental automatic connect is
 // trapped in this isolated app's IPC handler before it can reach tsnet.
 await desktop.evaluate(({ipcMain})=>{globalThis.__inertAutomaticConnectAttempts=0;ipcMain.removeHandler('tailnet:status');ipcMain.handle('tailnet:status',()=>({state:'running',connected:false}));ipcMain.removeHandler('connection:check');ipcMain.handle('connection:check',()=>{globalThis.__inertAutomaticConnectAttempts++;throw Error('Unexpected automatic connect blocked by inert fixture');});});
 await page.evaluate(async()=>{await pollPrivateNetwork();await pollPrivateNetwork();});assert.equal(await desktop.evaluate(()=>globalThis.__inertAutomaticConnectAttempts),0);assert.match(await page.locator('#privateNetworkStatus').textContent(),/暂停/);report.suspendedRunningPollDidNotAutoConnect=true;report.runningPollCheckUsesSyntheticStatusAndConnectionTrap=true;
 assert.deepEqual(fs.readdirSync(runtimeInfo.stateDir),['sidecar.lock']);assert(!fs.existsSync(path.join(profile,'absent-ledgers')));assert.deepEqual(pageErrors,[]);report.onlyInertStateLockCreated=true;report.noPageErrors=true;
 await page.screenshot({path:screenshot,fullPage:true});report.screenshot=path.basename(screenshot);report.ok=true;
 await cleanup();fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
 t.diagnostic(JSON.stringify({scope:report.scope,mode:label,launcherVersion:version,screenshot:path.basename(screenshot),report:path.basename(reportFile),startedOrLoggedIn:false}));
});
