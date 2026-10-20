import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const output=process.argv[2]||'C:\\Results';
const online=process.argv[3]==='online';
const mark=phase=>fs.appendFileSync(path.join(output,'progress.log'),new Date().toISOString()+' '+phase+'\n');
const installed=path.dirname(process.execPath),asar=path.join(installed,'resources','app.asar');
const load=relative=>import(pathToFileURL(path.join(asar,relative)));
const {ModuleManager}=await load('desktop/modules/module-manager.mjs');
const {ServiceManager}=await load('desktop/shared/service-manager.mjs');
const {createServiceLifecycle}=await load('desktop/modules/service-lifecycle.mjs');
const {withElectronLifecycle}=await load('desktop/modules/electron-lifecycle.mjs');
const profile=path.join(process.env.APPDATA,'wucheng-ecommerce-erp-v2');
const registryFile=path.join(process.env.APPDATA,'LingtuIntegrations','registry.json');
const services=new ServiceManager({registryFile});
const evidence={environment:'Windows Sandbox',networking:online?'enabled, public GitHub downloads':'disabled by WSB configuration',
  noSystemNode:spawnSync('where.exe',['node'],{windowsHide:true}).status!==0,
  noBrowserCache:!fs.existsSync(path.join(process.env.LOCALAPPDATA,'ms-playwright')),
  noBusinessSource:!fs.existsSync(path.join(process.env.USERPROFILE,'Documents','ChatGPT')),
  initialModules:!fs.existsSync(path.join(profile,'modules','installed.json')),modules:[]};
assert.ok(evidence.noSystemNode&&evidence.noBrowserCache&&evidence.noBusinessSource&&evidence.initialModules);
const manager=new ModuleManager({root:path.join(profile,'modules'),hostVersion:'0.8.0',
  publicKeys:JSON.parse(fs.readFileSync(path.join(asar,'desktop/launcher/public-keys.json'),'utf8')),
  ...(online?{}:{fetchImpl:()=>{throw Error('Offline acceptance forbids downloads');}}),
  onProgress:p=>{if(['queued','activating','installed','error'].includes(p.phase))mark(p.id+' '+p.phase+(p.error?' '+p.error:''));}});
const options={services,dataRoot:path.join(profile,'module-data'),backupRoot:path.join(profile,'module-backups'),getInstalled:id=>manager.state().packages[id]};
manager.lifecycle=withElectronLifecycle(createServiceLifecycle(options),options);
let browser,app;
try{
  mark(online?'loading public module catalog':'verifying complete offline bundle');
  let bundle;
  if(online){
    const response=await fetch('https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/modules-stable/catalog.json');
    assert.equal(response.status,200);manager.setCatalog(await response.json());
  }else{
    bundle=await manager.inspectOffline('C:\\Bundle\\LingtuModules-Complete-Offline.zip');
    assert.equal(bundle.packages.length,7);
  }
  for(const id of ['overview','purchase','sales','warehouse','exporter']){
    if(online)await manager.install(id);else await manager.installOffline(bundle.token,id);
    const c=await services.capabilities(id);assert.equal(c.maintenance,false);
    evidence.modules.push({id,version:c.version,healthy:true});
    if(id==='overview'){
      const report=await services.request('overview','/overview?month=2026-10');
      assert.equal(report.unavailable,true);evidence.missingSourcesReported=true;
    }
  }
  const report=await services.request('overview','/overview?month=2026-10');
  assert.equal(report.unavailable,false);evidence.laterSourcesRecognizedWithoutRestart=true;
  assert.equal((await services.request('purchase','/orders')).orders.length,0);
  for(const id of ['warehouse','exporter'])await services.stop(id);
  mark('validating bundled browser and pages');
  const cloud=manager.state().packages.warehouse;
  const playwright=await import(pathToFileURL(path.join(cloud.root,'resources/app.asar/node_modules/playwright/index.mjs')));
  const runtime=manager.state().packages['browser-runtime'];
  browser=await playwright.chromium.launch({executablePath:path.join(runtime.root,runtime.entry),headless:true});
  const page=await browser.newPage();
  for(const id of ['purchase','sales','overview']){
    const cap=await services.ensure(id);await page.goto(cap.url);assert.ok((await page.locator('body').innerText()).length>30);
  }
  evidence.bundledBrowserAndPages=true;
  await browser.close();browser=null;
  const env={...process.env,LINGTU_REGISTRY_PATH:registryFile};delete env.ELECTRON_RUN_AS_NODE;
  app=await playwright._electron.launch({executablePath:process.execPath,args:['--user-data-dir='+profile],env});
  const home=await app.firstWindow();home.setDefaultTimeout(30000);
  await home.locator('#cards article').first().waitFor();
  assert.equal(await home.locator('#cards article').count(),3);
  assert.deepEqual(await home.locator('#cards button').allTextContents(),['打开','打开','打开']);
  await home.screenshot({path:path.join(output,'launcher.png')});
  await home.locator('#cards article').nth(1).getByRole('button',{name:'打开'}).click();
  await home.locator('#deskPanel').waitFor({state:'visible'});
  evidence.installedLauncherUi=true;
  const pid=app.process().pid;
  await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);
  let alive=true;try{process.kill(pid,0);}catch{alive=false;}assert.equal(alive,false);app=null;
  if(bundle)await manager.discardOffline(bundle.token);
  evidence.ok=true;
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2));mark('PASS');
}catch(error){
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({...evidence,ok:false,error:error.stack},null,2));mark('FAIL '+error.message);
  process.exitCode=1;
}finally{
  if(app)await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);
  if(browser)await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);
  for(const id of ['warehouse','purchase','sales','overview','exporter'])try{await services.stop(id);}catch{}
}
