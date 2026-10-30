import {createDiagnostics,safeLogText} from './diagnostics.mjs';
import {app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage, net, Tray, Menu, clipboard} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModuleManager} from '../modules/module-manager.mjs';
import {ServiceManager} from '../shared/service-manager.mjs';
import {createServiceLifecycle} from '../modules/service-lifecycle.mjs';
import {withElectronLifecycle} from '../modules/electron-lifecycle.mjs';
import {installDeskViews} from '../local-desks.mjs';
import {createPersonnelSelection,personnelPartition,decoratePersonnelURL,assertPersonnelSupport} from './personnel.mjs';
import {requestedUserDataPath} from '../shared/user-data-path.mjs';
import {parseCliRequest} from '../shared/ai-interface.mjs';
import {readCliChildResult} from '../shared/cli-child-result.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {externalLink} from '../shared/external-links.mjs';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ConnectionStore,MODULE_IDS,serverAddress} from '../workbench-client/connection.mjs';
import {serverConnectionHealth,clientConnectionFailure} from '../workbench-client/connection-health.mjs';
import {SnapshotCache} from '../workbench-client/cache.mjs';
import {WorkbenchTransport,RemoteServiceManager} from '../workbench-client/transport.mjs';
import {ensureTailnetSessionDirect,fetchFromTailnetSession,forgetDirectTailnetSession} from '../workbench-client/tailnet-session.mjs';
import {prepareEmbeddedSession,fetchFromEmbeddedSession,resetEmbeddedSession} from '../workbench-client/embedded-session.mjs';
import {TailnetRuntime,existingTailnetRuntimes} from '../workbench-client/tailnet-runtime.mjs';
import {inspectLocalLedgers,backupLocalLedgers} from '../workbench-client/inventory.mjs';
import {runRemoteCommand} from '../workbench-client/cli.mjs';
import {tailscaleHost} from '../workbench-client/gateway-lifecycle.mjs';
import {collectMigrationSource,freezeMigrationSource,releaseMigrationSource} from '../workbench-client/migration-source.mjs';
import {prepareServe,enableServe} from '../workbench-client/tailscale-serve.mjs';
import {agentBetaPaths,prepareAgentProfile,guardAgentServices,assertBetaServerAddress} from '../agent-host/isolation.mjs';
import {createHostIdentity} from '../agent-host/identity.mjs';
import {createAgentHost} from '../agent-host/index.mjs';
import {assertLauncherSender,agentEnvelope} from '../agent-host/trust.mjs';
import {saveArtifactDownload} from '../agent-host/artifacts.mjs';
import {assertLauncherOperationAllowed,assertLegacyAgentReadOnly} from '../agent-host/launcher-policy.mjs';
import {betaProcessesRunning} from '../agent-host/startup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostVersion=JSON.parse(fs.readFileSync(path.join(here,'package.json'),'utf8')).version;
let location,agentPaths,agentHost,agentGateway,hostIdentity,agentHostStarting;
try{
  agentPaths=agentBetaPaths();
  const registryArgument=process.argv.find(value=>value.startsWith('--registry-file='))?.slice('--registry-file='.length);
  if(registryArgument&&!path.isAbsolute(registryArgument))throw Error('注册表必须使用完整路径');
  if(registryArgument&&path.resolve(registryArgument)!==agentPaths.registryFile)throw Error('测试版不能使用正式账本注册表');
  const requestedProfile=requestedUserDataPath(process.argv);
  if(requestedProfile&&path.resolve(requestedProfile)!==agentPaths.profile)throw Error('测试版必须使用独立用户配置');
  location=prepareAgentProfile(agentPaths);
}
catch(error){
  if(process.argv.includes('--cli')||process.argv.includes('--mcp-stdio'))process.stderr.write('工作台数据位置需要核对：'+error.message+'\n');
  else{await app.whenReady();dialog.showErrorBox('工作台数据位置需要核对',error.message);}
  process.exit(1);
}
const profile=location.profile;
if(location.registryFile)process.env.LINGTU_REGISTRY_PATH=location.registryFile;
app.setPath('userData', path.join(profile, 'launcher'));
const cliIndex=process.argv.indexOf('--cli'),mcpMode=process.argv.includes('--mcp-stdio'),headless=cliIndex>=0||mcpMode;
const acquired = headless || app.requestSingleInstanceLock();
if (!acquired) app.quit();
let win, modules, services, desks, updater, recoveryError, tray, quitting=false, preparation, preparationStatus, rendererReady=false, previousCloudExecutable;
const moduleArgument=args=>args.find(value=>/^--open-module=(warehouse|purchase|sales|overview|exporter)$/.test(value))?.split('=')[1];
let requestedModule=headless?undefined:moduleArgument(process.argv);
function deliverRequestedModule(){if(rendererReady&&personnel.state().selected&&requestedModule){const id=requestedModule;requestedModule=undefined;send('desks:navigate',{id});}}
function reportPreparation(value){
  if(headless||process.argv.includes('--hidden')||process.env.LINGTU_SKIP_BUNDLED_ACTIVATION)return;
  const label=value.phase==='ready'?'准备完成':'正在准备工作台';
  preparationStatus={label,detail:value.component?('正在准备 '+(names[value.component]||value.component)+' · '+value.version):'正在校验程序与本机数据，请稍候。'};
  if(!preparation){
    preparation=new BrowserWindow({width:960,height:600,minWidth:480,minHeight:300,resizable:true,maximizable:false,minimizable:true,title:'准备五成电子商务工作台',icon:path.join(here,'../assets/lingtu-icon.png'),webPreferences:{preload:path.join(here,'preparing-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    preparation.webContents.setWindowOpenHandler(()=>({action:'deny'}));preparation.webContents.on('will-navigate',event=>event.preventDefault());
    preparation.webContents.on('did-finish-load',()=>{if(preparation&&!preparation.isDestroyed())preparation.webContents.send('launcher:preparation',preparationStatus);});
    preparation.on('close',event=>{if(!quitting){event.preventDefault();preparation.hide();}});
    preparation.on('closed',()=>{preparation=undefined;});void preparation.loadFile(path.join(here,'preparing.html'));
  }else if(!preparation.isDestroyed())preparation.webContents.send('launcher:preparation',preparationStatus);
}
const send=(channel,value)=>{if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send(channel,value);};
const showWindow=()=>{const target=win&&!win.isDestroyed()?win:preparation&&!preparation.isDestroyed()?preparation:null;if(target){if(target.isMinimized())target.restore();target.show();target.focus();}};
const preferencesFile=path.join(profile,'launcher-settings.json');
function legacyCloudSettings(){try{return JSON.parse(fs.readFileSync(path.join(services.config('warehouse').dataDir,'settings.json'),'utf8'));}catch{return {};}}
function launcherPreferences(){
  try{return JSON.parse(fs.readFileSync(preferencesFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const legacy=legacyCloudSettings();return {schemaVersion:1,startAtLogin:legacy.startAtLogin===true};
}
function persistPreferences(value){fs.mkdirSync(profile,{recursive:true});const temp=preferencesFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,preferencesFile);}
function configureLauncherLogin(value){
  if(agentPaths||headless||!app.isPackaged||process.env.LINGTU_ISOLATED_TEST==='1')return;
  // Normal launches resolve the authoritative Documents binding themselves. Keep
  // the Windows Run command below its documented 260-character limit instead of
  // repeating the long physical MSIX authentication profile in the command line.
  const canonical=location;
  const canonicalBinding=path.resolve(canonical.profile).toLowerCase()===path.resolve(profile).toLowerCase()&&path.resolve(canonical.registryFile).toLowerCase()===path.resolve(location.registryFile).toLowerCase();
  const args=canonicalBinding?['--hidden']:['--hidden','--user-data-dir='+profile,'--registry-file='+location.registryFile];
  if(value.startAtLogin&&('"'+process.execPath+'" '+args.map(a=>'"'+a+'"').join(' ')).length>260)throw Error('自定义启动配置的路径过长，请从正式工作台入口设置开机启动');
  app.setLoginItemSettings({name:'五成电子商务工作台',path:process.execPath,args,openAtLogin:value.startAtLogin,enabled:value.startAtLogin});
  // Only retire this project's old per-user item, never another application's entry.
  try{
    const raw=execFileSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','云仓库存同步'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']});
    const command=raw.split('REG_SZ')[1]?.trim()||'';
    const executable=(command.match(/^"([^"]+)"/)||command.match(/^(.*?\.exe)(?:\s|$)/i))?.[1];
    const cloud=services.config('warehouse');
    const ownedOldWorker=executable&&path.basename(executable).toLowerCase()==='lingtuwarehousemodule.exe'&&path.resolve(executable).toLowerCase().startsWith((path.join(profile,'modules/packages/warehouse')+path.sep).toLowerCase());
    if(executable&&(ownedOldWorker||[process.execPath,cloud.exe,previousCloudExecutable].filter(Boolean).some(item=>path.resolve(item).toLowerCase()===path.resolve(executable).toLowerCase())))execFileSync('reg.exe',['delete','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','云仓库存同步','/f'],{windowsHide:true,stdio:'ignore'});
  }catch{}
}
function integrationConfiguration(){
  const args=[...(!app.isPackaged?[here]:[]),'--mcp-stdio','--user-data-dir='+profile,'--registry-file='+location.registryFile];
  return {version:hostVersion,mcp:{mcpServers:{wucheng:{command:process.execPath,args}}},cli:{command:process.execPath,args:[...(!app.isPackaged?[here]:[]),'--cli','workbench','capabilities','--user-data-dir='+profile,'--registry-file='+location.registryFile]}};
}
const connection=new ConnectionStore(profile);
const diagnostics=createDiagnostics({profile,services:{config:id=>services.config(id),status:options=>services.status(options)},mode:()=>connection.read().mode,version:hostVersion});
if(acquired&&!headless)diagnostics.write('info','workbench','工作台启动 · '+hostVersion);
process.on('uncaughtExceptionMonitor',error=>diagnostics.write('error','workbench',error.stack||error.message));
process.on('warning',warning=>diagnostics.write('warn','workbench',warning.message));
app.on('web-contents-created',(_event,contents)=>{contents.on('render-process-gone',(_e,details)=>diagnostics.write('error','workbench','页面进程退出 · '+details.reason));contents.on('did-fail-load',(_e,code,description,url)=>{if(code!==-3)diagnostics.write('error','workbench','页面加载失败 · '+code+' '+description+' '+url);});});
let transport,remoteManager,clientSession,cache;
const tailnetRuntimes=new Map();
const privateSessionWrites=new Map();
let activeNetworkRequests=0;
let networkConfigurationBusy=false;
let networkConfigurationToken;
const networkChangeContext=new AsyncLocalStorage();
let networkProposal;
const remote=()=>connection.read().mode==='client';
const embedded=()=>remote()&&connection.read().networkProvider==='embedded';
const clientPartition=()=> 'persist:workbench-'+crypto.createHash('sha256').update(connection.read().serverUrl).digest('hex').slice(0,24);
const salesPageSessions=new Set();
const deskPartition=(id,role=personnel.requireSelected())=>personnelPartition(id,remote()?clientPartition():'persist:lingtu-'+id,role);
const personnel=createPersonnelSelection({
  resetViews:()=>desks?.reset(),
  clearPages:async({next})=>{
    if(next)salesPageSessions.add(session.fromPartition(deskPartition('sales',next)));
    // These are sales-only partitions. Tailnet's transport Session and its
    // authentication/proxy credentials are intentionally left intact.
    for(const target of salesPageSessions){
      await target.clearCache();
      await target.clearStorageData({storages:['cookies','localstorage','indexdb','cachestorage','serviceworkers']});
    }
  }
});
const safeEncrypt=async plain=>{
  if(!safeStorage.isEncryptionAvailable())throw Error('Windows 安全存储不可用，不能保存私网连接信息');
  return safeStorage.encryptStringAsync?await safeStorage.encryptStringAsync(plain):safeStorage.encryptString(plain);
};
const safeDecrypt=async bytes=>{
  if(!safeStorage.isEncryptionAvailable())throw Error('Windows 安全存储不可用，不能读取私网连接信息');
  const value=safeStorage.decryptStringAsync?await safeStorage.decryptStringAsync(bytes):safeStorage.decryptString(bytes);return typeof value==='string'?value:value.result;
};
function embeddedRuntime(){
  if(!embedded())throw Error('请先选择客户端与内置私网连接');
  const origin=serverAddress(connection.read().serverUrl);
  let runtime=tailnetRuntimes.get(origin);
  if(!runtime){
    const root=app.isPackaged?path.join(process.resourcesPath,'tailnet-runtime'):path.resolve(here,'../../dist/tailnet-runtime');
    const sidecarPath=path.join(root,'lingtu-tailnet.exe'),manifestFile=path.join(root,'manifest.json');
    if(!fs.existsSync(sidecarPath)||!fs.existsSync(manifestFile))throw Object.assign(Error('内置私网组件尚未安装，请安装包含连接组件的新版工作台'),{code:'TAILNET_COMPONENT_MISSING'});
    let manifest;try{manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));}catch{}
    const bytes=fs.readFileSync(sidecarPath);
    if(manifest?.schemaVersion!==1||manifest.protocolVersion!==1||manifest.platform!=='win32'||manifest.arch!=='x64'||manifest.file!=='lingtu-tailnet.exe'||manifest.bytes!==bytes.length||manifest.sha256!==crypto.createHash('sha256').update(bytes).digest('hex'))throw Object.assign(Error('内置私网组件校验失败，已阻止运行'),{code:'TAILNET_COMPONENT_INVALID'});
    runtime=new TailnetRuntime({profile,origin,sidecarPath,execPath:process.execPath,encrypt:safeEncrypt,decrypt:safeDecrypt});
    tailnetRuntimes.set(origin,runtime);
  }
  return runtime;
}
function publicNetworkStatus(value){
  const state=typeof value?.state==='string'?value.state:'stopped';
  return {state,loginAvailable:!!value?.loginURL,...(Array.isArray(value?.nodeIPs)?{nodeIPs:value.nodeIPs}:{}),connected:embedded()&&!!transport?.identity};
}
async function embeddedConnection(){
  if(connection.read().networkSuspended)throw Object.assign(Error('已暂停私网连接，请在设置中重新连接或登录'),{code:'TAILNET_SUSPENDED'});
  const runtime=embeddedRuntime(),status=await runtime.start();
  if(status.state!=='running'){
    const messages={'needs-login':'请先在工作台设置中登录私网','needs-approval':'此私网设备正在等待管理员批准','logged-out':'请重新登录私网',starting:'正在连接私网，请稍候重试',stopped:'私网尚未连接'};
    throw Object.assign(Error(messages[status.state]||'私网连接尚未就绪，请检查连接状态'),{code:'TAILNET_NOT_READY'});
  }
  return runtime.connection();
}
async function preparePrivateSession(targetSession){
  assertPrivateRequestAllowed();
  activeNetworkRequests++;
  try{
    if(!embedded())return await ensureTailnetSessionDirect(targetSession);
    return await prepareEmbeddedSession(targetSession,await embeddedConnection(),{requestImpl:options=>net.request(options)});
  }finally{activeNetworkRequests--;}
}
async function changePrivateConnection(operation){
  if(networkConfigurationBusy)throw Error('连接设置正在更新，请稍后重试');
  networkConfigurationBusy=true;
  networkConfigurationToken=Symbol('connection-change');
  try{return await networkChangeContext.run(networkConfigurationToken,operation);}finally{networkConfigurationToken=undefined;networkConfigurationBusy=false;}
}
function assertPrivateRequestAllowed(){
  if(networkConfigurationBusy&&networkChangeContext.getStore()!==networkConfigurationToken)throw Object.assign(Error('连接设置正在更新，请稍后重新打开模块'),{code:'CONNECTION_CHANGED'});
}
async function resetPrivateConnection(){
  if(activeNetworkRequests||[...privateSessionWrites.values()].some(set=>set.size))throw Error('主服务器请求尚未结束，请稍后切换连接');
  desks?.reset();
  for(const target of new Set([clientSession,...salesPageSessions].filter(Boolean))){forgetDirectTailnetSession(target);await resetEmbeddedSession(target);}
  transport=null;remoteManager=null;
}
function guardPrivateSession(target){
  if(privateSessionWrites.has(target))return;
  const writes=new Set();privateSessionWrites.set(target,writes);
  target.webRequest.onBeforeRequest((details,callback)=>{
    const state=connection.read(),write=!['GET','HEAD','OPTIONS'].includes(details.method);
    const migration=details.url.startsWith(state.serverUrl+'/api/workbench/v1/migrations/');
    const agent=details.url===state.serverUrl+'/api/workbench/v1/agent/request';
    const foreign=embedded()&&/^https?:/.test(details.url)&&new URL(details.url).origin!==state.serverUrl;
    const cancel=foreign||remote()&&(state.networkSuspended||!connection.canWrite()&&write&&!migration&&!agent);
    if(!cancel&&write)writes.add(details.id);callback({cancel});
  });
  const finished=details=>writes.delete(details.id);
  target.webRequest.onCompleted(finished);target.webRequest.onErrorOccurred(finished);
}
function remoteConnection(channel='ui'){
  assertPrivateRequestAllowed();
  assertBetaServerAddress(connection.read().serverUrl);
  if(transport&&transport.channel===channel)return transport;
  clientSession=session.fromPartition(clientPartition());
  // Retain the same migration and origin fence for transport and sales views.
  guardPrivateSession(clientSession);
  const tailnetSession=clientSession;
  const useEmbedded=embedded();
  transport=new WorkbenchTransport({connection,cache,channel,fetchImpl:async(url,options)=>useEmbedded?fetchFromEmbeddedSession(tailnetSession,url,options,await embeddedConnection(),{requestImpl:requestOptions=>net.request(requestOptions)}):fetchFromTailnetSession(tailnetSession,url,options)});
  const request=transport.request.bind(transport);
  const currentTransport=transport;
  transport.request=async(...args)=>{
    assertPrivateRequestAllowed();
    activeNetworkRequests++;
    try{return await request(...args);}
    catch(error){if(['SERVER_UNAVAILABLE','TLS_INVALID','DATASET_CHANGED','VERSION_INCOMPATIBLE','CONNECTION_CHANGED'].includes(error.code)||/^(?:TAILNET_|EMBEDDED_)/.test(error.code||'')){currentTransport.identity=null;currentTransport.moduleConnections.clear();}if(error.code==='CONNECTION_CHANGED'&&transport===currentTransport){transport=null;remoteManager=null;}throw error;}
    finally{activeNetworkRequests--;}
  };
  const connect=currentTransport.connect.bind(currentTransport);
  currentTransport.connect=async()=>{try{return await connect();}catch(error){currentTransport.identity=null;currentTransport.moduleConnections.clear();if(['DATASET_CHANGED','CONNECTION_CHANGED'].includes(error.code)&&transport===currentTransport){transport=null;remoteManager=null;}throw error;}};
  remoteManager=new RemoteServiceManager(transport);return transport;
}
function requireHost(){if(remote())throw Error('此操作仅能在主服务器执行');hostIdentity?.requireAdmin(hostIdentity.localActor(),true);}
function betaTailnetHost(){const ts=tailscaleHost(),url=new URL(ts.origin);url.port='9443';return {...ts,origin:url.origin};}
const betaServeOptions=()=>({httpsPort:9443,targetPort:agentPaths.gatewayPort});
async function ensureGateway(){
  requireHost();if(agentGateway)return {ok:true,serverId:agentGateway.serverId,dataSetId:agentGateway.dataSetId,port:agentPaths.gatewayPort};
  const ts=betaTailnetHost();
  const {runWorkbenchServer}=await import('../workbench/server.mjs'),host=await getAgentHost();
  agentGateway=await runWorkbenchServer({storeDir:path.join(profile,'workbench-server'),publicOrigin:ts.origin,registryFile:services.registryFile,port:agentPaths.gatewayPort,agentPaths,agentRuntime:host.runtime});return {ok:true,serverId:agentGateway.serverId,dataSetId:agentGateway.dataSetId,port:agentPaths.gatewayPort};
}
async function getAgentHost(){
  if(agentHost)return agentHost;
  if(!agentHostStarting)agentHostStarting=createAgentHost({paths:agentPaths,services,safeStorage,identity:hostIdentity,...(app.isPackaged?{engineResourceDir:path.join(process.resourcesPath,'agent-engines')}:{}),onError:error=>diagnostics.write('error','workbench','定时任务检查未完成 · '+error.code)}).then(value=>agentHost=value).finally(()=>{agentHostStarting=null;});
  return agentHostStarting;
}
const names = {warehouse: '云仓同步', purchase: '采购台', sales: '销售台', overview: '经营收支总览', exporter: '历史订单导出台', 'node-runtime': '共享运行环境', 'browser-runtime': '浏览器组件'};
const publicKeysFile = path.join(here, 'public-keys.json');
function trusted(event) {
  assertLauncherSender(event,win,[path.join(here,'agent-index.html'),path.join(here,'index.html')]);
}
function external(id) {
  if (!['purchase', 'sales', 'overview', 'exporter'].includes(id)) return null;
  const c = services.config(id);
  if (c.managed || c.uninstalled) return null;
  if (id === 'exporter') return fs.existsSync(c.exe) ? c : null;
  return fs.existsSync(path.join(c.root, 'package.json')) && fs.existsSync(path.join(c.dataDir, c.db)) ? c : null;
}
function localList() {
  return modules.list().map(row => ({...row, name: names[row.id], external: external(row.id)}));
}
async function list(){
  assertPrivateRequestAllowed();
  if(!remote())return localList();
  const current=remoteConnection(),found=await current.modules();
  return MODULE_IDS.map(id=>{const row=found.find(row=>(row.id||row.extension)===id);return {id,name:names[id],remote:true,authorized:!!row,status:row?.status||'unavailable',...row};});
}
async function refresh(){throw Error('测试版使用本包冻结组件，不连接稳定版组件目录');}
if (acquired) app.whenReady().then(async () => {
  app.setAppUserModelId(agentPaths.appId);
  hostIdentity=createHostIdentity({storeDir:path.join(profile,'agent-host')});
  let activation,activationError;
  if(app.isPackaged){
    reportPreparation({phase:'preparing'});
    try{
      const pin=JSON.parse(fs.readFileSync(path.join(here,'../agent-host/packaged-manifest.json'),'utf8'));
      const {createAgentActivation}=await import('../agent-host/activation.mjs');
      activation=await createAgentActivation({paths:agentPaths,resourcesDir:process.resourcesPath,expectedManifestSha256:pin.sha256,isBusy:()=>betaProcessesRunning(agentPaths)})();
      reportPreparation({phase:'ready'});
    }catch(error){activationError=error;recoveryError='测试组件尚未就绪：'+error.message;diagnostics.write('error','workbench',recoveryError);}
  }
  services = guardAgentServices(new ServiceManager({registryFile:location.registryFile}),agentPaths);
  if(activationError){const blocked=()=>{throw Object.assign(Error(recoveryError),{code:'BETA_COMPONENTS_NOT_READY'});};services.ensure=blocked;services.start=blocked;}
  previousCloudExecutable=services.config('warehouse').exe;
  cache=new SnapshotCache({root:path.join(profile,'client-cache'),encrypt:async plain=>{
    if(!safeStorage.isEncryptionAvailable())throw Error('Windows 安全存储不可用，不能保存离线缓存');
    return safeStorage.encryptStringAsync?await safeStorage.encryptStringAsync(plain):safeStorage.encryptString(plain);
  },decrypt:async encrypted=>{
    if(!safeStorage.isEncryptionAvailable())throw Error('Windows 安全存储不可用，不能读取离线缓存');
    const value=safeStorage.decryptStringAsync?await safeStorage.decryptStringAsync(encrypted):safeStorage.decryptString(encrypted);return typeof value==='string'?value:value.result;
  }});
  const ensureService=services.ensure.bind(services);
  const verifyProfile=id=>{
    if(!['warehouse','exporter'].includes(id))return;
    const c=services.config(id);
    if(c.managed&&c.allowInitialize===false&&!fs.existsSync(c.dataDir))throw Error('原数据目录不存在，已阻止创建空数据；请在设置中核对数据位置。');
  };
  services.ensure=id=>{verifyProfile(id);return ensureService(id);};
  const store = path.join(profile, 'modules');
  modules = new ModuleManager({
    root: store, hostVersion,
    publicKeys: fs.existsSync(publicKeysFile) ? JSON.parse(fs.readFileSync(publicKeysFile, 'utf8')) : {},
    onProgress: progress => {if(progress.phase==='installed')desks?.invalidate(progress.id);send('modules:progress', progress);}
  });
  const lifecycleOptions = {
    services, dataRoot: agentPaths.data, backupRoot: path.join(profile, 'module-backups'),
    getInstalled: id => modules.state().packages[id]
  };
  modules.lifecycle = withElectronLifecycle(createServiceLifecycle(lifecycleOptions), lifecycleOptions);
  if(fs.existsSync(modules.journalFile))recoveryError='测试版检测到旧组件更新记录，请重新运行测试包验收工具。';
  // Only pinned Beta programs are activated here; ledger copies are provisioned separately.
  const suiteState={ready:activation?.ready===true&&!activation.missingData.length,setupRequired:activation?.ready!==true||!!activation.missingData.length};
  if(headless){
    const {createWorkbenchDispatcher,legacyCliArgs}=await import('../shared/workbench-dispatcher.mjs');
    let localAgentActions;
    const executeLegacy=async request=>{
      assertLegacyAgentReadOnly(request);
      if(request.command==='debug-logs'){const result=await diagnostics.read({query:request.query,level:request.level,limit:request.limit});return {ok:true,lines:result.entries.map(r=>'['+r.source+'] '+r.text)};}
      if(request.command==='debug-bundle'){const bundle=await diagnostics.bundle(),text=JSON.stringify(bundle,null,2),directory=path.join(diagnostics.directory,'reports');await fs.promises.mkdir(directory,{recursive:true});const file=path.join(directory,'diagnostic-'+Date.now()+'-'+crypto.randomUUID()+'.json');await fs.promises.writeFile(file,text,{encoding:'utf8',mode:0o600,flag:'wx'});return {ok:true,bundle,path:file,size:Buffer.byteLength(text),sha256:crypto.createHash('sha256').update(text).digest('hex')};}
      if(suiteState.setupRequired&&!['help','status','capabilities','extensions'].includes(request.command)&&!(request.command==='extension-call'&&request.action==='status'))throw Object.assign(Error('请先打开工作台完成本机程序初始化'),{code:'SUITE_SETUP_REQUIRED'});
      if(remote()||connection.read().mode==='server'&&!['help','extension-trust','debug-bundle','debug-logs'].includes(request.command)&&!['start','stop'].includes(request.action))return runRemoteCommand(request,remoteConnection(mcpMode?'mcp':'cli'));
      if(fs.existsSync(modules.journalFile)&&!['status','capabilities','extensions'].includes(request.command))throw Object.assign(Error('程序正在更新或等待恢复检查'),{code:'MODULE_UPDATING'});
      if(request.command==='help')return {ok:true,help:'使用 workbench capabilities 查看五个业务功能；正式写入仍需相应确认。'};
      if(request.command==='status')return {ok:true,status:{modules:localList(),mode:connection.read().mode}};
      if(request.command==='capabilities')return {ok:true,capabilities:{apiVersion:'1.0.0',modules:localList(),moduleApiVersion:1,importConfirmation:'agent-result-review-required'}};
      if(request.command==='extensions')return {ok:true,extensions:[{id:'lingtu.desks',trusted:true,actions:['status','query']}]};
      if(request.command==='extension-call'){
        if(request.id!=='lingtu.desks'||!['status','query','prepare','start','stop'].includes(request.action))throw Error('不支持的扩展操作');
        if(!['status','query'].includes(request.action)&&!request.confirmSideEffect)throw Error('修改操作需要本次明确确认');
        if(request.action!=='status'&&!modules.state().packages[request.params.desk]&&!external(request.params.desk))throw Object.assign(Error('工作台程序文件不完整，请更新或修复工作台'),{code:'MODULE_NOT_INSTALLED'});
        if(request.params?.desk)verifyProfile(request.params.desk);
        const {createActions}=await import('../extensions/lingtu-desks/extension.mjs');
        const {createLocalWorkbenchManager}=await import('../shared/local-workbench-adapter.mjs');
        localAgentActions??=createActions(createLocalWorkbenchManager(services,{channel:mcpMode?'mcp':'cli'}));
        return {ok:true,response:await localAgentActions[request.action](request.params)};
      }
      if(!modules.state().packages.warehouse)throw Object.assign(Error('云仓程序文件缺失，请更新或修复工作台'),{code:'MODULE_NOT_INSTALLED'});
      verifyProfile('warehouse');
      const env={...process.env,LINGTU_MANAGED_MODULE:'1'};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(services.config('warehouse').exe,['--cli',...legacyCliArgs(request),'--user-data-dir='+services.config('warehouse').dataDir],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
      return readCliChildResult(child);
    };
    const dispatch=createWorkbenchDispatcher({executeLegacy,version:hostVersion});
    if(mcpMode){const {startWorkbenchMcpRuntime}=await import('../shared/workbench-mcp-runtime.mjs');await startWorkbenchMcpRuntime({version:hostVersion,dispatch,onClose:()=>app.exit(0)});return;}
    try{const args=process.argv.slice(cliIndex+1).filter(x=>!x.startsWith('--user-data-dir')&&!x.startsWith('--registry-file='));const result=await dispatch(parseCliRequest(args));console.log(JSON.stringify(result));app.exit(result?.ok===false?1:0);}
    catch(error){console.log(JSON.stringify({ok:false,code:error.code||'REQUEST_FAILED',error:error.message}));app.exit(1);}
    return;
  }
  win = new BrowserWindow({
    show:false,width: 1240, height: 850, minWidth: 900, minHeight: 650, title: '五成电子商务工作台',
    icon: path.join(here, '../assets/lingtu-icon.png'),
    webPreferences: {preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true}
  });
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  const verifySalesPersonnel=async(id,cap)=>{
    if(id!=='sales')return cap;
    try{
      let info;
      if(remote())info=await remoteConnection().call('sales','/api/personnel/session');
      else{
        const response=await fetch(cap.url+'/api/personnel/session',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
        if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return assertPersonnelSupport(null);
        info=await response.json();
      }
      assertPersonnelSupport(info);return cap;
    }catch(error){
      if(error.code==='PERSONNEL_UPDATE_REQUIRED')throw error;
      throw Object.assign(Error('销售台身份接口尚未就绪，请更新工作台和销售台后重试。'),{code:'PERSONNEL_UPDATE_REQUIRED',cause:error});
    }
  };
  const viewManager={registryFile:services.registryFile,config:id=>{requireHost();return services.config(id);},
    ensure:async id=>{if(remote()){remoteConnection();await preparePrivateSession(clientSession);return verifySalesPersonnel(id,await remoteManager.ensure(id));}if(services.config(id).maintenance)throw Error('模块处于维护或恢复窗口，请稍后重试');return verifySalesPersonnel(id,await services.ensure(id));},
    status:options=>remote()?(remoteConnection(),remoteManager.status()):services.status(options),stop:id=>{requireHost();return services.stop(id);}};
  desks = installDeskViews(win, {manager:viewManager,isRemote:remote,partitionFor:deskPartition,includeWarehouse:true,
    beforeOpen:async id=>{
      personnel.requireSelected();
      if(id==='sales'){
        const target=session.fromPartition(deskPartition(id));salesPageSessions.add(target);
        if(remote()){guardPrivateSession(target);await preparePrivateSession(target);}
      }
    },
    decorateURL:(id,url)=>decoratePersonnelURL(id,url,personnel.requireSelected()),
    notify:message=>send('modules:message',message)});
  const legacyHandlers=new Map();
  const handle = (name, fn) => {legacyHandlers.set(name,fn);ipcMain.handle(name, async (event, ...args) => {
    trusted(event);assertLauncherOperationAllowed(name);const started=Date.now(),requestId=crypto.randomUUID().slice(0,8),logSource=name.startsWith('modules:')&&['warehouse','purchase','sales','overview','exporter'].includes(args[0])?args[0]:name.startsWith('connection:')||name.startsWith('tailnet:')?'network':'workbench';
    if(name!=='agent:request'&&/^(?:personnel:select|launcher:preferences-save|connection:(?:save|network-plan)|tailnet:(?:login|logout|connect))/.test(name))hostIdentity.requireAdmin(hostIdentity.localActor(),true);
    try{const result=await fn(...args);if(!/^(?:diagnostics:|connection:(?:get|status|cached)|tailnet:status|modules:list|desks:bounds|launcher:(?:ready|preferences|integration-config))/.test(name))diagnostics.write('info',logSource,name+' 完成 · '+(Date.now()-started)+'ms · '+requestId);return result;}
    catch(error){diagnostics.write('error',logSource,name+' 失败 · '+requestId+' · '+(error.stack||error.message));if(name==='agent:request')return {ok:false,code:error.code||'AGENT_REQUEST_FAILED',error:safeLogText(error.message)};throw Error(safeLogText(error.message));}
  });};
  handle('diagnostics:read',options=>diagnostics.read(options));
  handle('diagnostics:copy',async options=>{const result=await diagnostics.read(options);clipboard.writeText(result.entries.map(r=>'['+r.source+'] '+r.text).join('\n'));return {copied:result.entries.length};});
  handle('diagnostics:open-folder',async()=>{await fs.promises.mkdir(diagnostics.directory,{recursive:true});const problem=await shell.openPath(diagnostics.directory);if(problem)throw Error(problem);return {opened:true};});
  handle('diagnostics:export',async()=>{const result=await dialog.showSaveDialog(win,{title:'导出日志与诊断报告',defaultPath:path.join(app.getPath('downloads'),'五成工作台-诊断-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'),filters:[{name:'诊断报告',extensions:['json']}]});if(result.canceled)return {cancelled:true};const report=await diagnostics.bundle();await fs.promises.writeFile(result.filePath,JSON.stringify(report,null,2),{encoding:'utf8',mode:0o600});diagnostics.write('info','workbench','已导出本地诊断报告');return {exported:true,filename:path.basename(result.filePath)};});
  let diagnosticWindow=0,diagnosticCount=0;
  handle('diagnostics:event',value=>{if(Date.now()-diagnosticWindow>60000){diagnosticWindow=Date.now();diagnosticCount=0;}if(++diagnosticCount>50)return {limited:true};if(!value||typeof value.text!=='string'||value.text.length>6000||!['info','warning','error'].includes(value.level))throw Error('日志事件无效');diagnostics.write(value.level==='warning'?'warn':value.level,value.source==='network'?'network':'workbench',value.text);return {recorded:true};});
  handle('modules:list', list);
  handle('personnel:state',()=>personnel.state());
  handle('personnel:select',async role=>{if(remote()){const status=await remoteConnection().request('/agent/request',{method:'POST',body:{operation:'status',payload:{}},migration:true});if(role==='boss'&&status.actor.role!=='admin')throw Error('当前成员不是管理员');}return personnel.select(role);});
  handle('launcher:ready',()=>{rendererReady=true;deliverRequestedModule();return {ready:true};});
  handle('launcher:preferences',()=>launcherPreferences());
  handle('launcher:preferences-save',value=>{if(typeof value?.startAtLogin!=='boolean')throw Error('开机启动设置无效');const next={schemaVersion:1,startAtLogin:value.startAtLogin};configureLauncherLogin(next);persistPreferences(next);return next;});
  handle('launcher:integration-config',()=>integrationConfiguration());
  handle('launcher:copy-integration',kind=>{if(!['mcp','cli'].includes(kind))throw Error('未知配置类型');const config=integrationConfiguration()[kind];clipboard.writeText(JSON.stringify(config,null,2));return {copied:true};});
  handle('connection:get',()=>{const state=connection.read();if(!state.serverUrl&&state.mode!=='client')try{state.suggestedServerUrl=betaTailnetHost().origin;}catch{}return {...state,canWrite:connection.canWrite(),connected:!!transport?.identity};});
  handle('connection:status',async()=>{
    const state=connection.read(),started=Date.now();let result;
    if(networkConfigurationBusy)result={state:'checking',label:'正在切换连接',detail:'正在保存和核对连接设置。'};
    else if(state.mode==='standalone')result={state:'local',label:'单机模式',detail:'使用本机账本，无需连接主服务器。'};
    else if(state.mode==='server'){
      let identity;try{identity=JSON.parse(fs.readFileSync(path.join(profile,'workbench-server','identity.json'),'utf8'));}catch{}
      result=await serverConnectionHealth({state,identity,fetchImpl:(url,options)=>fetch(url.replace('http://127.0.0.1:17330','http://127.0.0.1:'+agentPaths.gatewayPort),options)});
    }else if(state.networkSuspended)result={state:'paused',label:'私网连接已暂停',detail:'请在设置中重新连接或登录。'};
    else if(!transport?.identity)result={state:'unverified',label:'尚未连接主服务器',detail:'请检查连接或在设置中完成私网登录和设备批准。'};
    else{
      try{
        // Authenticated GET checks current member permissions without starting a
        // business service, renewing a session, or trusting a cached identity.
        const discovery=await remoteConnection().request('/modules');
        if(!Array.isArray(discovery.modules))throw Error('服务器模块状态格式无效');
        if(discovery.serverId!==state.pins?.serverId||discovery.dataSetId!==state.pins?.dataSetId){connection.lockCache();throw Object.assign(Error('正式账本已更换'),{code:'DATASET_CHANGED'});}
      }catch(error){result=clientConnectionFailure(error);}
      if(!result)result={state:'connected',label:'已连接主服务器',detail:(state.networkProvider==='embedded'?'内置私网':'系统 Tailscale')+' · 已验证当前成员与账本身份。'};
    }
    connection.assertConfiguration(state);
    return {...result,mode:state.mode,configurationId:state.configurationId,checkedAt:new Date().toISOString(),latencyMs:Date.now()-started};
  });
  handle('connection:network-plan',()=>{
    requireHost();const plan=prepareServe({...betaServeOptions(),origin:betaTailnetHost().origin,backupRoot:path.join(profile,'workbench-server','network-backups')});
    networkProposal={...plan,token:crypto.randomUUID(),expiresAt:Date.now()+300000};return {token:networkProposal.token,difference:plan.difference,backup:plan.file};
  });
  async function saveConnectionValue(value,{connect=true}={}){
    if(value.serverUrl)assertBetaServerAddress(value.serverUrl);
    if(agentHostStarting)await agentHostStarting.catch(()=>{});
    const previousMode=connection.read().mode;
    if(value.mode!==previousMode&&agentHost?.runtime.store.list('task').some(task=>['queued','running','committing'].includes(task.status)))throw Error('请先暂停或完成正在执行的任务，再切换连接模式');
    if(modules.pending.size)throw Error('请等待当前模块安装完成');
    if(activeNetworkRequests||[...privateSessionWrites.values()].some(set=>set.size))throw Error('主服务器请求尚未结束，请稍后切换连接');
    if(value.mode==='client')serverAddress(value.serverUrl);
    // Beta client mode never folds a local ledger into the company host. Migration
    // only uses the explicitly staged formal-ledger copy on the host.
    const inventory=[];
    if(value.mode==='server'){
      if(!networkProposal||networkProposal.token!==value.networkToken||networkProposal.expiresAt<Date.now())throw Error('请先审查本次私网配置差异');
      value={...value,serverUrl:betaTailnetHost().origin};
      const fresh=prepareServe({...betaServeOptions(),origin:value.serverUrl,backupRoot:path.join(profile,'workbench-server','network-backups')});
      if(JSON.stringify(fresh.before)!==JSON.stringify(networkProposal.before))throw Error('网络配置已变化，请重新审查');
    }
    await resetPrivateConnection();
    if(value.mode!==previousMode&&agentGateway){await agentGateway.stop();agentGateway=null;}
    if(value.mode==='client'&&agentHost){await agentHost.close();agentHost=null;}
    const state=connection.configure(value,inventory);
    if(state.mode==='server'){await ensureGateway();enableServe({...betaServeOptions(),origin:state.serverUrl,backupRoot:path.join(profile,'workbench-server','network-backups')});networkProposal=null;}
    if(state.mode==='client'&&connect)await remoteConnection().connect();
    return {...state,canWrite:connection.canWrite()};
  }
  handle('connection:save',value=>changePrivateConnection(()=>saveConnectionValue(value)));
  handle('connection:check',async()=>{
    if(networkConfigurationBusy)throw Error('连接设置正在更新，请稍后检查');
    if(remote()){
      if(embedded()&&clientSession&&!transport?.identity&&!activeNetworkRequests&&![...privateSessionWrites.values()].some(set=>set.size))await resetEmbeddedSession(clientSession);
      return remoteConnection().connect();
    }
    return connection.read().mode==='server'?ensureGateway():{mode:connection.read().mode,local:true};
  });
  handle('tailnet:status',async()=>{
    if(!embedded())return {state:'stopped',connected:false};
    try{return publicNetworkStatus(await embeddedRuntime().status());}
    catch(error){return {state:'unavailable',connected:false,message:error.message};}
  });
  async function selectEmbedded(value){
    if(value?.mode!=='client'||value?.networkProvider!=='embedded')throw Error('请选择客户端与内置私网连接');
    const origin=serverAddress(value.serverUrl),previous=connection.read();
    if(previous.mode!=='client'||previous.networkProvider!=='embedded'||previous.serverUrl!==origin)await saveConnectionValue({mode:'client',networkProvider:'embedded',serverUrl:origin},{connect:false});
    else{await resetPrivateConnection();connection.resumeNetwork();}
    return embeddedRuntime();
  }
  handle('tailnet:connect',value=>changePrivateConnection(async()=>{
    const runtime=await selectEmbedded(value),status=await runtime.start();
    return publicNetworkStatus(status);
  }));
  handle('tailnet:login',value=>changePrivateConnection(async()=>{
    const runtime=await selectEmbedded(value);
    let status=await runtime.login();
    for(let i=0;!status.loginURL&&!['running','needs-approval','error'].includes(status.state)&&i<60;i++){
      await new Promise(resolve=>setTimeout(resolve,250));status=await runtime.status();
    }
    let loginOpened=false;
    if(status.loginURL){
      const login=new URL(status.loginURL);
      if(login.protocol!=='https:'||login.hostname!=='login.tailscale.com'||login.port||login.username||login.password||!/^\/a\/[a-zA-Z0-9_-]+$/.test(login.pathname)||login.search||login.hash)throw Error('私网登录地址不属于官方授权页面，已阻止打开');
      await shell.openExternal(login.href);loginOpened=true;
    }
    return {...publicNetworkStatus(status),loginOpened};
  }));
  handle('tailnet:logout',()=>changePrivateConnection(async()=>{
    if(!embedded())throw Error('当前未使用内置私网连接');
    if(activeNetworkRequests||[...privateSessionWrites.values()].some(set=>set.size))throw Error('主服务器请求尚未结束，请稍后退出私网');
    connection.suspendNetwork();
    // A persisted Cookie jar exists before this launch creates a Transport.
    // Always clear the selected origin's Session, including that cold case.
    clientSession=session.fromPartition(clientPartition());
    await resetPrivateConnection();
    await clientSession.clearStorageData({storages:['cookies']});
    const status=await embeddedRuntime().logout();
    return publicNetworkStatus(status);
  }));
  handle('connection:cached',async id=>{
    personnel.requireSelected();if(id==='sales')personnel.requireBoss();
    assertPrivateRequestAllowed();
    if(!remote()||!MODULE_IDS.includes(id)||!connection.read().pins)throw Error('没有对应身份的离线缓存');
    return cache.get(connection.cacheScope(id),id);
  });
  const migrationRequest=(route,options)=>remoteConnection().request('/migrations'+route,{...options,migration:true});
  handle('migration:stage',()=>{if(!remote())throw Error('请在需要迁移旧账本的来源客户端准备资料；主机可以读取待核对批次');return collectMigrationSource({services,connection,profile,transport:remoteConnection()});});
  handle('migration:list',()=>migrationRequest(''));
  handle('migration:get',id=>migrationRequest('/'+encodeURIComponent(id)));
  handle('migration:select',({id,...body})=>migrationRequest('/'+encodeURIComponent(id)+'/selections',{method:'PUT',body}));
  handle('migration:confirm',({id,...body})=>migrationRequest('/'+encodeURIComponent(id)+'/confirm',{method:'POST',body}));
  handle('migration:commit',({id,...body})=>migrationRequest('/'+encodeURIComponent(id)+'/commit',{method:'POST',body}));
  handle('migration:recover',id=>migrationRequest('/'+encodeURIComponent(id)+'/recover',{method:'POST',body:{}}));
  handle('migration:archive',async id=>{if(!remote())throw Error('旧账本只能在来源客户端封存');const result=await migrationRequest('/'+encodeURIComponent(id)+'/result');if(result.status!=='completed')throw Error('服务器迁移尚未完整完成，不能封存旧账本');await freezeMigrationSource(services,connection,profile);return connection.archiveMigration(result.receipt);});
  handle('migration:release-source',()=>{if(!remote())throw Error('请在来源客户端处理封存准备');return releaseMigrationSource(services,connection,profile);});
  handle('links:open', name => shell.openExternal(externalLink(name)));
  updater={check:async()=>({status:'disabled',channel:'agent-beta'}),getState:()=>({status:'disabled'})};
  handle('launcher:update-check',()=>updater.check());
  handle('launcher:update-install',()=>changePrivateConnection(async()=>{
    if(modules.pending.size)throw Error('请等待模块安装完成后更新工作台');
    if(!remote()){
      const states=await Promise.all(MODULE_IDS.map(id=>services.capabilities(id)));
      if(states.some(state=>state?.busy))throw Object.assign(Error('有采集、导入或保存任务正在执行，请完成后再更新工作台'),{code:'SERVICE_BUSY'});
    }
    if(updater.getState().status!=='ready')throw Error('尚无已下载的更新');
    await resetPrivateConnection();
    // The shared broker uses this Electron executable and bundled Go resource.
    // Release those files before the installer replaces them; business services
    // use their own runtimes and continue to run.
    const existing=await existingTailnetRuntimes({profile,sidecarPath:path.join(app.isPackaged?path.join(process.resourcesPath,'tailnet-runtime'):path.resolve(here,'../../dist/tailnet-runtime'),'lingtu-tailnet.exe'),execPath:process.execPath,encrypt:safeEncrypt,decrypt:safeDecrypt});
    for(const runtime of existing)await runtime.shutdown();
    return updater.install();
  }));
  handle('modules:refresh', () => {requireHost();return refresh();});
  handle('modules:plan', id => {requireHost();return modules.plan(id);});
  handle('modules:install', id => {requireHost();return modules.install(id);});
  handle('modules:cancel', id => {requireHost();return modules.cancel(id);});
  handle('modules:uninstall', async id => {requireHost();const result=await modules.uninstall(id);desks.invalidate(id);return result;});
  handle('modules:open', async (id, route) => {
    personnel.requireSelected();
    assertPrivateRequestAllowed();
    if(remote()){
      await remoteConnection().connect();const result=await desks.open(id,route);
      // Cache only successful, authenticated business reads. Never cache secrets or attachments implicitly.
      if(id!=='sales'||personnel.state().role==='boss')void transport.snapshot(id).catch(()=>{});return result;
    }
    if(fs.existsSync(modules.journalFile))throw Error('模块正在激活或等待恢复检查，请稍后打开');
    if (['exporter','warehouse'].includes(id)) {
      const cap=await services.ensure(id);
      if(services.config(id).managed)return services.request(id,'/open',{method:'POST',body:{confirm:true}});
      if(cap?.running){
        const env={...process.env,LINGTU_REGISTRY_PATH:services.registryFile};delete env.ELECTRON_RUN_AS_NODE;
        const child=spawn(services.config(id).exe,[],{env,detached:true,stdio:'ignore',windowsHide:true});
        await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
      }
      return {opened:true};
    }
    if (['purchase', 'sales', 'overview'].includes(id)) return desks.open(id, route);
    throw Error('此模块尚未接入启动适配');
  });
  handle('modules:offline', async () => {
    requireHost();
    const result = await dialog.showOpenDialog(win, {title: '导入完整离线扩展包', properties: ['openFile'], filters: [{name: '灵兔离线扩展包', extensions: ['zip']}]});
    if (result.canceled) return null;
    return modules.inspectOffline(result.filePaths[0]);
  });
  handle('modules:offline-install', ({token, id}) => {requireHost();return modules.installOffline(token,id);});
  handle('modules:offline-plan',({token,id})=>{requireHost();return modules.planOffline(token,id);});
  handle('modules:offline-close', token => modules.discardOffline(token));
  handle('modules:open-data', async id => {
    requireHost();
    if (!['purchase', 'sales', 'overview', 'exporter','warehouse'].includes(id)) throw Error('未知模块');
    const directory = services.config(id).dataDir;
    if (!fs.existsSync(directory)) throw Error('此模块还没有本地数据');
    await shell.openPath(directory);
  });
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  tray=new Tray(path.join(here,'../assets/lingtu-icon.png'));
  tray.setToolTip('五成电子商务工作台');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开工作台',click:showWindow},{label:'日志与诊断',click:()=>{showWindow();send('desks:navigate',{id:'logs'});}},{label:'设置',click:()=>{showWindow();send('desks:navigate',{id:'settings'});}},{label:'使用说明',click:()=>{showWindow();send('desks:navigate',{id:'help'});}},{type:'separator'},{label:'退出工作台并暂停任务主机',click:()=>{if(modules.pending.size){showWindow();send('modules:message','正在准备程序文件，请等待完成后退出。');return;}quitting=true;app.quit();}}]));
  tray.on('double-click',showWindow);tray.on('click',showWindow);
  win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();}});
  const preferences=launcherPreferences();configureLauncherLogin(preferences);persistPreferences(preferences);
  win.webContents.on('will-navigate', event => event.preventDefault());
  handle('agent:request',async value=>{
    const {operation,payload}=agentEnvelope(value);
    if(operation==='connection.get'){const state=await legacyHandlers.get('connection:get')();return {connection:{...state,canConfigure:true,detail:state.mode==='standalone'?'使用独立测试账本':'测试版私网入口必须为 9443'}};}
    if(operation==='connection.check')return legacyHandlers.get('connection:check')();
    if(operation==='connection.plan'){hostIdentity.requireAdmin(hostIdentity.localActor(),true);return legacyHandlers.get('connection:network-plan')();}
    if(operation==='connection.save'){hostIdentity.requireAdmin(hostIdentity.localActor(),true);return legacyHandlers.get('connection:save')(payload);}
    let result;
    if(remote())result=await remoteConnection().request('/agent/request',{method:'POST',body:{operation,payload},migration:true});
    else{const host=await getAgentHost();result=await host.request(operation,payload,{actor:host.identity.localActor(),trustedUi:true});}
    if(operation==='status'&&result.environment?.mode!=='test')throw Error('服务器不是独立测试环境，已阻止连接');
    return operation==='artifacts.open'?saveArtifactDownload(result,{dialog,window:win,downloads:app.getPath('downloads')}):result;
  });
  await win.loadFile(path.join(here, 'agent-index.html'));
  if(preparation&&!preparation.isDestroyed())preparation.destroy();
  if(!process.argv.includes('--hidden')||moduleArgument(process.argv))showWindow();
  if(!remote())try{await getAgentHost();}catch(error){send('modules:message','任务主机尚未就绪：'+error.message);}
  if(connection.read().mode==='server')try{await ensureGateway();}catch(error){send('modules:message',error.message);}
  if(recoveryError)send('modules:message','上次模块更新需要恢复检查：'+recoveryError);
}).catch(error=>{diagnostics.write('error','workbench','启动失败 · '+(error.stack||error.message));if(headless)console.log(JSON.stringify({ok:false,code:error.code||'STARTUP_FAILED',error:error.message}));else dialog.showErrorBox('工作台准备未完成','请重新打开工作台重试。若仍然失败，请保留原数据并联系管理员处理。\n\n'+error.message);app.exit(1);});
app.on('second-instance',(_event,args)=>{const id=moduleArgument(args);if(id){requestedModule=id;deliverRequestedModule();}if(id||!args.includes('--hidden'))showWindow();});
let agentShutdownDone=false;
app.on('before-quit',event=>{
  quitting=true;tray?.destroy();
  if(!agentShutdownDone&&(agentHost||agentGateway)){event.preventDefault();agentShutdownDone=true;void(async()=>{await agentGateway?.stop();await agentHost?.close();app.quit();})().catch(error=>{diagnostics.write('error','workbench','任务主机退出未完成 · '+error.code);app.quit();});}
});
app.on('window-all-closed',()=>{if(headless||quitting)app.quit();});
