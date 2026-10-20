import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {atomicJson} from './module-manager.mjs';
import {fail, inside} from './package-format.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readRegistry=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};

export function withElectronLifecycle(serviceLifecycle,{services,backupRoot,getInstalled}) {
  const ids=new Set(['warehouse','exporter']);
  const running=cap=>!!cap?.running;
  async function stop(id){
    const cap=await services.capabilities(id);
    if(!running(cap))return;
    if(cap.busy)throw fail('SERVICE_BUSY','模块有正在执行的任务');
    // The old standalone exporter also exposes this authenticated stop route.
    await services.request(id,'/stop',{method:'POST',body:{confirm:true}});
    for(let i=0;i<100;i++){
      if(!running(await services.capabilities(id))){
        for(let attempt=0;attempt<100;attempt++){
          try{process.kill(cap.pid,0);}catch(error){if(error.code==='ESRCH'){await wait(1000);return;}throw error;}
          await wait(100);
        }
        throw fail('STOP_TIMEOUT','接口已关闭，但模块进程尚未完全退出');
      }
      await wait(100);
    }
    throw fail('STOP_TIMEOUT','模块未能退出，安装已停止');
  }
  const electron={
    async checkIdle(id){
      const cap=await services.capabilities(id);
      if(cap?.busy)throw fail('SERVICE_BUSY','模块有正在执行的任务');
    },
    async backup(id){
      const config=services.config(id),registry=readRegistry(services.registryFile);
      if(registry[id]&&config.allowInitialize!==true&&!fs.existsSync(config.dataDir))throw fail('MISSING_LEDGER','原数据目录不存在，已阻止创建空数据');
      await stop(id);
      if(process.platform==='win32'){
        const probe=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
          '@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:LINGTU_CHECK_EXE }).Count'],
          {env:{...process.env,LINGTU_CHECK_EXE:config.exe},encoding:'utf8',windowsHide:true,timeout:15000});
        if(probe.status!==0)throw fail('PROCESS_CHECK_FAILED','无法确认旧模块已退出');
        if(Number(probe.stdout.trim())>0)throw fail('LEGACY_APP_RUNNING','旧版窗口仍在运行，请退出对应软件后重试安装');
      }
      const directory=path.join(backupRoot,id+'-'+randomUUID());
      fs.mkdirSync(directory,{recursive:true});
      // The cloud profile also contains the launcher's own state. Back up only
      // cloud-owned entries, never recursively copy the module store into itself.
      const entries=id==='warehouse'?['workspace','settings.json','secrets.bin','Partitions','Network','Local State','Local Storage','Session Storage','IndexedDB','Preferences','Secure Preferences']:
        (fs.existsSync(config.dataDir)?fs.readdirSync(config.dataDir).filter(n=>!['SingletonLock','SingletonCookie','SingletonSocket','lockfile','.integration-runtime.json'].includes(n)):[]);
      const present=[];
      for(const name of entries){
        const source=inside(config.dataDir,name);
        if(!fs.existsSync(source))continue;
        fs.cpSync(source,inside(directory,name),{recursive:true,filter:file=>{
          if(fs.lstatSync(file).isSymbolicLink())throw fail('UNSAFE_DATA_PATH','数据目录包含链接，无法安全备份');
          return true;
        }});
        present.push(name);
      }
      const backup={directory,dataDir:config.dataDir,entries:present,ownedEntries:entries,hadProfile:fs.existsSync(config.dataDir),
        previousRegistry:registry[id]||null,previousConfig:config,createdAt:new Date().toISOString()};
      atomicJson(path.join(directory,'backup.json'),backup);
      return backup;
    },
    async activate(candidate,_previous,backup){
      const registry=readRegistry(services.registryFile),config=services.config(candidate.id);
      const browser=getInstalled('browser-runtime');
      registry[candidate.id]={...config,root:candidate.root,exe:inside(candidate.root,candidate.entry),
        version:candidate.version,dataDir:backup.dataDir,managed:true,uninstalled:false,maintenance:true,
        ...(candidate.id==='warehouse'?{browserPath:inside(browser.root,browser.entry)}:{})};
      atomicJson(services.registryFile,registry);
      await services.ensure(candidate.id);
    },
    async health(candidate){
      const cap=await services.capabilities(candidate.id);
      if(!running(cap)||!cap.maintenance||cap.version!==candidate.version)throw fail('HEALTH_CHECK_FAILED','模块未进入安全检查状态');
      const config=services.config(candidate.id);
      const ledger=path.join(config.dataDir,candidate.id==='warehouse'?'workspace/data/erp.sqlite':'orders.sqlite');
      if(candidate.id==='exporter'&&!fs.existsSync(ledger))throw fail('MISSING_LEDGER','导出台账本未创建');
      if(fs.existsSync(ledger)){
        const check=spawnSync(config.exe,['--input-type=module','-e',
          "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});if(d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(2);d.close();",
          ledger],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true,timeout:30000});
        if(check.status!==0)throw fail('DATABASE_CHECK_FAILED','模块账本完整性检查失败');
      }
    },
    async complete(candidate){
      await services.request(candidate.id,'/maintenance/activate',{method:'POST',body:{confirm:true}});
      const registry=readRegistry(services.registryFile);
      registry[candidate.id].maintenance=false;
      registry[candidate.id].allowInitialize=false;
      atomicJson(services.registryFile,registry);
    },
    async recover(journal){
      const cap=await services.capabilities(journal.id);
      if(running(cap)&&!cap.maintenance)throw fail('RECOVERY_REVIEW_REQUIRED','模块已开放编辑，不能自动覆盖原数据');
      await stop(journal.id);
      const b=journal.backup;
      if(!b?.directory||!path.resolve(b.directory).startsWith(path.resolve(backupRoot)+path.sep)||
        path.resolve(b.dataDir)!==path.resolve(services.config(journal.id).dataDir))throw fail('INVALID_RECOVERY_PATH','恢复路径与原数据目录不符');
      // Rename only these validated, module-owned top-level entries; keep failed
      // files alongside the profile for diagnosis instead of deleting them.
      for(const name of b.ownedEntries){
        const target=inside(b.dataDir,name);
        if(fs.existsSync(target))fs.renameSync(target,target+'.failed-'+randomUUID());
        if(b.entries.includes(name))fs.cpSync(inside(b.directory,name),target,{recursive:true});
      }
      const registry=readRegistry(services.registryFile);
      registry[journal.id]=b.previousRegistry||b.previousConfig;
      atomicJson(services.registryFile,registry);
    },
    async deactivate(candidate){
      await stop(candidate.id);
      const registry=readRegistry(services.registryFile);
      registry[candidate.id].uninstalled=true;
      atomicJson(services.registryFile,registry);
    }
  };
  return Object.fromEntries(['checkIdle','backup','activate','health','complete','recover','deactivate'].map(method=>[method,(...args)=>{
    const id=typeof args[0]==='string'?args[0]:args[0]?.id;
    return (ids.has(id)?electron:serviceLifecycle)[method](...args);
  }]));
}
