import {app, BrowserWindow, ipcMain, dialog, shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModuleManager} from '../modules/module-manager.mjs';
import {ServiceManager} from '../shared/service-manager.mjs';
import {createServiceLifecycle} from '../modules/service-lifecycle.mjs';
import {withElectronLifecycle} from '../modules/electron-lifecycle.mjs';
import {installDeskViews} from '../local-desks.mjs';
import {canonicalUserDataPath, requestedUserDataPath} from '../shared/user-data-path.mjs';
import {parseCliRequest} from '../shared/ai-interface.mjs';
import {createUpdater} from '../updater.mjs';
import {spawn} from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = requestedUserDataPath(process.argv) || canonicalUserDataPath(app.getPath('appData'));
app.setPath('userData', path.join(profile, 'launcher'));
const cliIndex=process.argv.indexOf('--cli'),mcpMode=process.argv.includes('--mcp-stdio'),headless=cliIndex>=0||mcpMode;
const acquired = headless || app.requestSingleInstanceLock();
if (!acquired) app.quit();
let win, modules, services, desks, updater, recoveryError;
const names = {warehouse: '云仓同步', purchase: '采购台', sales: '销售台', overview: '经营收支总览', exporter: '历史订单导出台', 'node-runtime': '共享运行环境', 'browser-runtime': '浏览器组件'};
const catalogUrl = 'https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/download/modules-stable/catalog.json';
const publicKeysFile = path.join(here, 'public-keys.json');
function trusted(event) {
  if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('调用来源不符');
}
function external(id) {
  if (!['purchase', 'sales', 'overview', 'exporter'].includes(id)) return null;
  const c = services.config(id);
  if (c.managed || c.uninstalled) return null;
  if (id === 'exporter') return fs.existsSync(c.exe) ? c : null;
  return fs.existsSync(path.join(c.root, 'package.json')) && fs.existsSync(path.join(c.dataDir, c.db)) ? c : null;
}
function list() {
  return modules.list().map(row => ({...row, name: names[row.id], external: external(row.id)}));
}
async function refresh() {
  const response = await fetch(catalogUrl, {signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw Error('暂时无法获取官方扩展目录，可重试或导入离线包');
  const final = new URL(response.url);
  if (final.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(final.hostname)) throw Error('扩展目录来源无效');
  let bytes = 0, chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 3 * 1024 ** 2) throw Error('扩展目录过大');
    chunks.push(chunk);
  }
  modules.setCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  return list();
}
if (acquired) app.whenReady().then(async () => {
  app.setAppUserModelId('com.wucheng.ecommerce.erp.v2');
  services = new ServiceManager();
  const ensureService=services.ensure.bind(services);
  const verifyProfile=id=>{
    if(!['warehouse','exporter'].includes(id))return;
    const c=services.config(id);
    if(c.managed&&c.allowInitialize===false&&!fs.existsSync(c.dataDir))throw Error('原数据目录不存在，已阻止创建空数据；请在设置中核对数据位置。');
  };
  services.ensure=id=>{verifyProfile(id);return ensureService(id);};
  const store = path.join(profile, 'modules');
  modules = new ModuleManager({
    root: store, hostVersion: '0.8.0',
    publicKeys: fs.existsSync(publicKeysFile) ? JSON.parse(fs.readFileSync(publicKeysFile, 'utf8')) : {},
    onProgress: progress => {if(progress.phase==='installed')desks?.invalidate(progress.id);win?.webContents.send('modules:progress', progress);}
  });
  const lifecycleOptions = {
    services, dataRoot: path.join(profile, 'module-data'), backupRoot: path.join(profile, 'module-backups'),
    getInstalled: id => modules.state().packages[id]
  };
  modules.lifecycle = withElectronLifecycle(createServiceLifecycle(lifecycleOptions), lifecycleOptions);
  if(fs.existsSync(modules.journalFile)){
    try { await modules.exclusive(async()=>{}); }
    catch(error){recoveryError=error.message;}
  }
  const bundledCatalog = path.join(here, 'catalog.json');
  if (!modules.catalog && fs.existsSync(bundledCatalog)) modules.setCatalog(JSON.parse(fs.readFileSync(bundledCatalog, 'utf8')));
  if(headless){
    if(mcpMode){
      const child=spawn(process.execPath,[path.join(here,'../mcp-stdio-entry.mjs')],{
        windowsHide:true,stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',
          CAINIAO_ASSISTANT_EXE:process.execPath,CAINIAO_ASSISTANT_APP_PATH:app.isPackaged?'':path.resolve(here),
          CAINIAO_ASSISTANT_USER_DATA:profile,CAINIAO_ASSISTANT_VERSION:'0.8.0'}
      });
      child.once('error',()=>app.exit(1));child.once('close',code=>app.exit(code??0));
      return;
    }
    try {
      const args=process.argv.slice(cliIndex+1).filter(x=>!x.startsWith('--user-data-dir'));
      const request=parseCliRequest(args);
      if(fs.existsSync(modules.journalFile)&&!['status','capabilities','extensions'].includes(request.command))throw Object.assign(Error('模块正在更新或等待恢复检查'),{code:'MODULE_UPDATING'});
      if(request.command==='status'&&!modules.state().packages.warehouse)console.log(JSON.stringify({ok:true,status:{modules:list()}}));
      else if(request.command==='capabilities')console.log(JSON.stringify({ok:true,capabilities:{apiVersion:'1.0.0',modules:list(),moduleApiVersion:1,importConfirmation:'two-ui-confirmations-required'}}));
      else if(request.command==='extensions')console.log(JSON.stringify({ok:true,extensions:[{id:'lingtu.desks',trusted:true,actions:['status','query','prepare','start','stop']}]}));
      else if(request.command==='extension-call'){
        if(request.id!=='lingtu.desks'||!['status','query','prepare','start','stop'].includes(request.action))throw Error('不支持的扩展操作');
        if(!['status','query'].includes(request.action)&&!request.confirmSideEffect)throw Error('修改操作需要本次明确确认');
        if(request.action!=='status'&&!modules.state().packages[request.params.desk]&&!external(request.params.desk))throw Object.assign(Error('请先在启动台安装此模块'),{code:'MODULE_NOT_INSTALLED'});
        if(request.params?.desk)verifyProfile(request.params.desk);
        const {actions}=await import('../extensions/lingtu-desks/extension.mjs');
        console.log(JSON.stringify({ok:true,response:await actions[request.action](request.params)}));
      }else{
        const cloud=modules.state().packages.warehouse;
        if(!cloud)throw Object.assign(Error('请先在启动台安装云仓同步模块'),{code:'MODULE_NOT_INSTALLED'});
        verifyProfile('warehouse');
        const env={...process.env,LINGTU_MANAGED_MODULE:'1'};delete env.ELECTRON_RUN_AS_NODE;
        const child=spawn(services.config('warehouse').exe,['--cli',...args,`--user-data-dir=${services.config('warehouse').dataDir}`],{env,stdio:'inherit',windowsHide:true});
        const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
        app.exit(code??1);return;
      }
      app.exit(0);
    }catch(error){console.log(JSON.stringify({ok:false,code:error.code||'REQUEST_FAILED',error:error.message}));app.exit(1);}
    return;
  }
  win = new BrowserWindow({
    width: 1240, height: 850, minWidth: 900, minHeight: 650, title: '云仓库存同步',
    icon: path.join(here, '../assets/lingtu-icon.png'),
    webPreferences: {preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true}
  });
  const rawEnsure = services.ensure.bind(services);
  services.ensure = id => {
    if (!modules.state().packages[id] && !external(id)) return Promise.reject(Error('MODULE_NOT_INSTALLED：请先下载对应模块'));
    return rawEnsure(id);
  };
  desks = installDeskViews(win, {manager: services, includeWarehouse:true, notify: message => win.webContents.send('modules:message', message)});
  const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => { trusted(event); return fn(...args); });
  handle('modules:list', list);
  updater=createUpdater({app,getToken:async()=>'',onState:state=>win.webContents.send('launcher:update',state),log:message=>win.webContents.send('modules:message',message)});
  handle('launcher:update-check',()=>updater.check());
  handle('launcher:update-install',()=>updater.install());
  handle('modules:refresh', refresh);
  handle('modules:plan', id => modules.plan(id));
  handle('modules:install', id => modules.install(id));
  handle('modules:cancel', id => modules.cancel(id));
  handle('modules:uninstall', async id => {const result=await modules.uninstall(id);desks.invalidate(id);return result;});
  handle('modules:open', async (id, route) => {
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
    const result = await dialog.showOpenDialog(win, {title: '导入完整离线扩展包', properties: ['openFile'], filters: [{name: '灵兔离线扩展包', extensions: ['zip']}]});
    if (result.canceled) return null;
    return modules.inspectOffline(result.filePaths[0]);
  });
  handle('modules:offline-install', ({token, id}) => modules.installOffline(token, id));
  handle('modules:offline-plan',({token,id})=>modules.planOffline(token,id));
  handle('modules:offline-close', token => modules.discardOffline(token));
  handle('modules:open-data', async id => {
    if (!['purchase', 'sales', 'overview', 'exporter','warehouse'].includes(id)) throw Error('未知模块');
    const directory = services.config(id).dataDir;
    if (!fs.existsSync(directory)) throw Error('此模块还没有本地数据');
    await shell.openPath(directory);
  });
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.on('close',event=>{if(modules.pending.size){event.preventDefault();win.webContents.send('modules:message','模块正在安装，请等待完成，或取消下载后再退出。');}});
  win.webContents.on('will-navigate', event => event.preventDefault());
  await win.loadFile(path.join(here, 'index.html'));
  if(recoveryError)win.webContents.send('modules:message','上次模块更新需要恢复检查：'+recoveryError);
});
app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('window-all-closed', () => app.quit());
