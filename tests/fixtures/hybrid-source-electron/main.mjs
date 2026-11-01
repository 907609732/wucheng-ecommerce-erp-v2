import {app,BrowserWindow,ipcMain} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),fixtureRoot=fs.realpathSync(process.env.HYBRID_SOURCE_FIXTURE_ROOT||'');
const temp=fs.realpathSync(os.tmpdir()),relative=path.relative(temp,fixtureRoot);
if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!path.basename(fixtureRoot).startsWith('wucheng-hybrid-source-harness-')||fs.lstatSync(fixtureRoot).isSymbolicLink())throw Error('Only a dedicated temporary source fixture is accepted');
const manifest=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'fixture-manifest.json'),'utf8'));
if(manifest.purpose!=='hybrid-source-manual-acceptance'||manifest.fixtureRoot!==fixtureRoot||manifest.registryFile!==path.join(fixtureRoot,'fixture-registry.json'))throw Error('Fixture manifest mismatch');
const root=manifest.root,ids=new Set(['purchase','sales','overview']),configs=JSON.parse(fs.readFileSync(manifest.registryFile,'utf8'));
function assertModule(id){
  if(!ids.has(id))throw Error('此源码隔离夹具仅提供采购、销售、经营；其他模块须在完整测试包验收');
  const config=configs[id];
  if(config.root!==path.join(root,'apps',id)||config.dataDir!==path.join(fixtureRoot,'data',id)||config.managed!==true||config.allowInitialize!==false||!Number.isInteger(config.port))throw Error('Fixture module binding changed');
  if(fs.lstatSync(config.dataDir).isSymbolicLink())throw Error('Fixture data directory was redirected');
  return config;
}
for(const id of ids)assertModule(id);
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
const [{installDeskViews},{ServiceManager},{createDesktopUiSessions},{createHostIdentity},{assertLauncherSender},{assertLauncherOperationAllowed},{createBusinessInterface},purchase,sales,overview]=await Promise.all([
  load('desktop/local-desks.mjs'),load('desktop/shared/service-manager.mjs'),load('desktop/business-host/desktop-ui-sessions.mjs'),load('desktop/business-host/identity.mjs'),load('desktop/business-host/trust.mjs'),load('desktop/business-host/launcher-policy.mjs'),load('desktop/business-interface/index.mjs'),load('apps/purchase/lib/agent-adapter.mjs'),load('apps/sales/lib/agent-adapter.mjs'),load('apps/overview/lib/agent-adapter.mjs')
]);
app.setName('五成 ERP 三合一源码隔离验收');app.setPath('userData',path.join(fixtureRoot,'electron-profile'));
let runtime,win,closing=false;
const principal=createHostIdentity({storeDir:path.join(fixtureRoot,'identity')});
const serviceManager=new ServiceManager({registryFile:manifest.registryFile,agentManaged:true});
const manager={registryFile:manifest.registryFile,config:id=>{assertModule(id);return serviceManager.config(id);},ensure:id=>{assertModule(id);return serviceManager.ensure(id);},status:async()=>Promise.all([...ids].map(async id=>({extension:id,...assertModule(id),status:(await serviceManager.capabilities(id))?'running':'stopped'}))),stop:async()=>{throw Error('此夹具的服务只由启动器在退出后清理');}};
const transport=async()=>{throw Error('此原生界面夹具只允许操作临时合成账本；外部接口须由独立契约用例验收');};
const actors=()=>principal.requireMember(principal.localActor('ui'),true);
runtime=await createBusinessInterface({paths:{profile:path.join(fixtureRoot,'business-profile'),environment:{mode:'test',label:'隔离合成账本 · 源码验收'}},services:manager,identity:principal,startBridge:false,
  adapters:[purchase.createPurchaseAgentAdapter({transport}),sales.createSalesAgentAdapter({transport}),overview.createOverviewAgentAdapter({transport})],transport
});
const report=(type,value={})=>fs.appendFileSync(path.join(manifest.output,'native-events.jsonl'),JSON.stringify({type,at:new Date().toISOString(),...value})+'\n');
report('fixture.created',{sourceFixture:true,packagedBeta:false,identityType:'windows',identitySha256:createHash('sha256').update(actors().id).digest('hex'),companyCredentialsLoaded:false});
// Let Electron finish evaluating its ESM entry point before waiting for app readiness.
// A top-level readiness await can prevent ready from firing, leaving no window or error.
app.whenReady().then(async()=>{
report('fixture.ready');
const title='五成 ERP · 三合一隔离验收',page=path.join(root,'desktop','launcher','business-index.html');
win=new BrowserWindow({title,width:1480,height:940,minWidth:900,minHeight:650,show:true,webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
report('window.created',{webContentsId:win.webContents.id});
win.setMenu(null);win.webContents.on('page-title-updated',event=>{event.preventDefault();win.setTitle(title);});
const trusted=event=>assertLauncherSender(event,win,[page]);
const signed=createDesktopUiSessions({services:manager,resolveActor:actors,assertRequestAllowed:()=>{if(closing)throw Error('Fixture is closing');},onError:error=>report('signature.failed',{code:error.code||'DESKTOP_UI_FAILED'})});
const observedViews=new WeakSet();
const desks=installDeskViews(win,{manager,partitionFor:id=>'persist:source-hybrid-'+manifest.nonce+'-'+id,
  beforeOpen:async id=>{assertModule(id);actors();},prepareView:({id,view,cap})=>{signed.attach({id,view,cap});if(!observedViews.has(view)){observedViews.add(view);view.webContents.on('did-finish-load',()=>report('business.loaded',{module:id,url:view.webContents.getURL()}));}},
  authorizeOperation:(name,args,event)=>{if(!['desks:child-open','desks:child-home','desks:child-navigate','desks:data-changed'].includes(name))trusted(event);assertLauncherOperationAllowed(name,{moduleId:['desks:surface','desks:child-navigate'].includes(name)?args[0]?.module:name==='desks:open'?args[0]?.id:name==='desks:child-open'?args[0]:undefined});},notify:message=>win.webContents.send('modules:message',message)
});
ipcMain.handle('launcher:ready',event=>{trusted(event);return{ready:true};});
ipcMain.handle('modules:open',async(event,id,route)=>{trusted(event);assertModule(id);return desks.open(id,route);});
ipcMain.handle('business:status',event=>{trusted(event);return {ready:true,environment:{mode:'test',label:'隔离合成账本 · 源码验收'},actor:actors(),connection:{state:'local',label:'临时隔离服务'},embeddedAgent:false};});
ipcMain.handle('business:review',async(event,value)=>{trusted(event);if(!value||!['list','get','approve','reject'].includes(value.operation))throw Error('未知复核操作');const {operation,...payload}=value;return runtime.request('reviews.'+operation,payload,{actor:actors(),trustedUi:true});});
ipcMain.handle('connection:get',event=>{trusted(event);return {mode:'standalone',networkProvider:'system',detail:'本夹具仅连接临时合成账本，禁止修改公司连接'};});
ipcMain.handle('connection:check',event=>{trusted(event);return {state:'local',detail:'本次临时服务'};});
ipcMain.handle('connection:save',event=>{trusted(event);throw Error('隔离夹具禁止修改公司连接');});
ipcMain.handle('launcher:integration-config',event=>{trusted(event);return {version:'source-fixture',scope:'temporary-books-only',externalInterface:'Not published by this fixture; validate with dedicated business-interface tests'};});
ipcMain.handle('launcher:copy-integration',event=>{trusted(event);throw Error('隔离夹具不发布外部接入配置');});
ipcMain.handle('diagnostics:read',event=>{trusted(event);return {entries:[{source:'fixture',text:fs.readFileSync(path.join(manifest.output,'native-events.jsonl'),'utf8')}]};});
win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
win.on('resize',()=>report('window.resized',{bounds:win.getContentBounds(),zoom:win.webContents.getZoomFactor()}));
await win.loadFile(page);
report('launcher.loaded',{url:win.webContents.getURL()});
win.show();win.focus();
report('window.shown',{visible:win.isVisible(),minimized:win.isMinimized(),focused:win.isFocused(),bounds:win.getBounds()});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void(async()=>{try{await runtime.close();}catch(error){report('fixture.close-failed',{code:error.code||'SOURCE_FIXTURE_CLOSE_FAILED'});}finally{report('fixture.closed',{acceptancePassed:false});app.quit();}})();});
}).catch(async error=>{
  const failure={code:error.code||'SOURCE_FIXTURE_STARTUP_FAILED',message:error.message,stack:error.stack};
  try{report('fixture.startup-error',failure);}catch{}
  process.stderr.write('[hybrid-source-fixture] '+JSON.stringify(failure)+'\n');
  try{await runtime.close();}catch{}
  app.exit(1);
});
