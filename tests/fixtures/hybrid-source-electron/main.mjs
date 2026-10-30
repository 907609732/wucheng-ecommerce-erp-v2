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
const [{installDeskViews},{ServiceManager},{createDesktopUiSessions},{createHostIdentity},{assertLauncherSender,agentEnvelope},{assertLauncherOperationAllowed},{createAgentRuntime},purchase,sales,overview]=await Promise.all([
  load('desktop/local-desks.mjs'),load('desktop/shared/service-manager.mjs'),load('desktop/agent-host/desktop-ui-sessions.mjs'),load('desktop/agent-host/identity.mjs'),load('desktop/agent-host/trust.mjs'),load('desktop/agent-host/launcher-policy.mjs'),load('desktop/agent-runtime/index.mjs'),load('apps/purchase/lib/agent-adapter.mjs'),load('apps/sales/lib/agent-adapter.mjs'),load('apps/overview/lib/agent-adapter.mjs')
]);
app.setName('五成 ERP 三合一源码隔离验收');app.setPath('userData',path.join(fixtureRoot,'electron-profile'));
let runtime,win,closing=false;
const principal=createHostIdentity({storeDir:path.join(fixtureRoot,'identity')});
const serviceManager=new ServiceManager({registryFile:manifest.registryFile,agentManaged:true});
const manager={registryFile:manifest.registryFile,config:id=>{assertModule(id);return serviceManager.config(id);},ensure:id=>{assertModule(id);return serviceManager.ensure(id);},status:async()=>Promise.all([...ids].map(async id=>({extension:id,...assertModule(id),status:(await serviceManager.capabilities(id))?'running':'stopped'}))),stop:async()=>{throw Error('此夹具的服务只由启动器在退出后清理');}};
const transport=async()=>{throw Error('此原生/人工夹具不提供 Agent 业务执行；真实模型验收须在正常 ERP 中进行');};
const actors=()=>principal.requireMember(principal.localActor('ui'),true);
const noEngine={check:async()=>({available:false,configured:false,reason:'SOURCE_NATIVE_FIXTURE_NO_MODEL'})};
runtime=createAgentRuntime({storeDir:path.join(fixtureRoot,'agent-runtime'),resolveActor:principal.resolveActor,
  adapters:[purchase.createPurchaseAgentAdapter({transport}),sales.createSalesAgentAdapter({transport}),overview.createOverviewAgentAdapter({transport})],engines:{codex:noEngine,hermes:noEngine},
  secretStore:{has:()=>false,get:async()=>undefined,set:async()=>{throw Error('隔离验收夹具禁止保存公司密钥');}},
  environment:{mode:'test',label:'隔离合成账本 · 源码验收'},extensions:{'connection.get':async()=>({connection:{mode:'standalone',canConfigure:false,detail:'仅连接本次临时三台服务，不接公司私网'}})}
});
const report=(type,value={})=>fs.appendFileSync(path.join(manifest.output,'native-events.jsonl'),JSON.stringify({type,at:new Date().toISOString(),...value})+'\n');
report('fixture.created',{sourceFixture:true,packagedBeta:false,identityType:'windows',identitySha256:createHash('sha256').update(actors().id).digest('hex'),companyCredentialsLoaded:false});
// Let Electron finish evaluating its ESM entry point before waiting for app readiness.
// A top-level readiness await can prevent ready from firing, leaving no window or error.
app.whenReady().then(async()=>{
report('fixture.ready');
const title='五成 ERP · 三合一隔离验收',page=path.join(root,'desktop','launcher','agent-index.html');
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
ipcMain.handle('agent:request',async(event,value)=>{
  try{trusted(event);const {operation,payload}=agentEnvelope(value);if(operation==='settings.save'||operation.startsWith('connection.')&&operation!=='connection.get')throw Error('此夹具不保存公司配置或修改私网；请在正常 ERP 中验收');return await runtime.request(operation,payload,{actor:actors(),trustedUi:true});}
  catch(error){return{ok:false,code:error.code||'SOURCE_FIXTURE_OPERATION_UNAVAILABLE',error:error.message};}
});
win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
win.on('resize',()=>report('window.resized',{bounds:win.getContentBounds(),zoom:win.webContents.getZoomFactor()}));
await win.loadFile(page);
report('launcher.loaded',{url:win.webContents.getURL()});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void(async()=>{try{await runtime.close();}catch(error){report('fixture.close-failed',{code:error.code||'SOURCE_FIXTURE_CLOSE_FAILED'});}finally{report('fixture.closed',{acceptancePassed:false});app.quit();}})();});
}).catch(async error=>{
  const failure={code:error.code||'SOURCE_FIXTURE_STARTUP_FAILED',message:error.message,stack:error.stack};
  try{report('fixture.startup-error',failure);}catch{}
  process.stderr.write('[hybrid-source-fixture] '+JSON.stringify(failure)+'\n');
  try{await runtime.close();}catch{}
  app.exit(1);
});
