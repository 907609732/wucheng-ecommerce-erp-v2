// Explicit installed candidate only. All books/profiles belong to a new TEMP root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const exe=path.resolve(process.argv[2]||'');
assert.equal(path.basename(exe),'WuchengAgentPreview.exe');assert(fs.existsSync(exe));
const output=path.resolve(process.argv.find(value=>value.startsWith('--output='))?.slice('--output='.length)||'.codex-artifacts/business-build-20261101');fs.mkdirSync(output,{recursive:true});
// Fail closed instead of replacing an existing preview's services.
for(const port of [27432,27433,27434,27480]){const used=await new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(true));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(false)));});assert(!used,'Preview port already occupied: '+port);}
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'wucheng-installed-ui-')),local=path.join(fixture,'local'),roaming=path.join(fixture,'roaming'),root=path.join(local,'WuchengAgentBeta-preview'),registryFile=path.join(root,'registry.json');
fs.mkdirSync(local,{recursive:true});fs.mkdirSync(roaming,{recursive:true});
const env={...process.env,LOCALAPPDATA:local,APPDATA:roaming,LINGTU_AGENT_PREVIEW:'1',LINGTU_ISOLATED_TEST:'1'};
for(const name of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)|^(?:CODEX_HOME|HERMES_HOME|ELECTRON_RUN_AS_NODE|LINGTU_REGISTRY_PATH|LINGTU_WORKBENCH_POLICY_FILE|LINGTU_AGENT_BETA_ROOT|LINGTU_SKIP_BUNDLED_ACTIVATION)$/i.test(name))delete env[name];
const report={exe,fixture,scope:'Installed candidate; real packaged Electron and five modules; fresh temporary books only',checks:[],errors:[],startedAt:new Date().toISOString()};
const reportFile=path.join(output,'installed-ui-verification.json');let host,native,manager;
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
const capture=async(application,name)=>{const png=await application.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.isVisible());if(!w)throw Error('No visible native window');return (await w.capturePage()).toPNG().toString('base64');});fs.writeFileSync(path.join(output,'installed-'+name+'.png'),Buffer.from(png,'base64'));};
try{
 host=await electron.launch({executablePath:exe,env,timeout:120000});
 let shell;for(let i=0;i<600;i++){shell=host.context().pages().find(p=>p.url().endsWith('business-index.html'));if(shell)break;await new Promise(r=>setTimeout(r,500));}assert(shell,'Business shell finished initialization');await shell.locator('#desk-tab-overview').waitFor({timeout:120000});
 const config=JSON.parse(fs.readFileSync(registryFile,'utf8'));for(const [id,c]of Object.entries(config))assert(c.dataDir.startsWith(path.join(root,'data')+path.sep),id+' data isolation');
 const version=await host.evaluate(()=>process.versions.electron);manager=new ServiceManager({registryFile,sharedElectronExecutable:exe,sharedElectronVersion:version});
 for(const id of ['overview','purchase','sales']){
  await shell.locator('#desk-tab-'+id).click();const prefix='http://127.0.0.1:'+config[id].port;let page;
  for(let i=0;i<240;i++){page=host.context().pages().find(p=>p.url().startsWith(prefix));if(page&&await page.locator('body').innerText().then(t=>t.length>200).catch(()=>false))break;await new Promise(r=>setTimeout(r,500));}assert(page,id+' actual renderer');
  page.on('pageerror',e=>report.errors.push({module:id,message:e.message}));const text=await page.locator('body').innerText();assert(text.length>200);assert(!text.includes('Cannot GET /'));await page.waitForTimeout(1000);await capture(host,id);report.checks.push({module:id,url:page.url(),visible:await page.evaluate(()=>window.lingtuShell.isVisible()),text:text.slice(0,700)});save();
 }
 await shell.locator('[data-view="settings"]').click();await capture(host,'settings');
 const optional=await shell.evaluate(()=>window.launcher.extensionStatus?.('warehouse'));
 if(optional&&!optional.installed){
  await shell.evaluate(()=>window.launcher.extensionInstall('warehouse'));
  assert.equal((await shell.evaluate(()=>window.launcher.extensionStatus('warehouse'))).installed,true);
  report.checks.push({module:'warehouse',optionalInstall:true});save();
 }
 for(const id of ['warehouse','exporter']){
  native=await electron.launch({executablePath:exe,args:['--agent-component='+id],env:{...env,LINGTU_REGISTRY_PATH:registryFile,LINGTU_MANAGED_MODULE:'1',LINGTU_ALLOW_INITIALIZE:'0'},timeout:120000});
  const page=await native.firstWindow();page.on('pageerror',e=>report.errors.push({module:id,message:e.message}));await page.waitForLoadState('domcontentloaded');await page.waitForTimeout(1500);
  if(id==='warehouse'&&await page.locator('#firstRunSetup').isVisible().catch(()=>false)){await page.locator('[data-setup-mode="standalone"]').click();await page.locator('#finishFirstRun').click();await page.locator('#firstRunSetup').waitFor({state:'hidden'});}
  if(id==='warehouse')await page.locator('#backHome').waitFor({timeout:60000});else await page.locator('.topbar').waitFor({timeout:60000});
  const text=await page.locator('body').innerText();assert(text.length>30,id+' renderer content');await capture(native,id);report.checks.push({module:id,url:page.url(),text:text.slice(0,900)});save();await native.close();native=null;
 }
 assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.error={message:error.message,stack:error.stack};throw error;}
finally{report.finishedAt=new Date().toISOString();save();if(native)await native.close().catch(()=>{});if(host)await host.close().catch(()=>{});if(manager)for(const id of ['purchase','sales','overview','warehouse','exporter'])await manager.stop(id).catch(e=>{report.cleanupWarnings??=[];report.cleanupWarnings.push(id+': '+e.message);});save();}
console.log(JSON.stringify(report));
