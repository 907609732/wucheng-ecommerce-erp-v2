import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
export function sourceWarehouse({root,fixtureRoot,report,windowsEnvironment}){
 let child;
 return {async open(){
  if(child&&child.exitCode===null&&!child.killed)return {opened:true,external:true};
  const profile=path.join(fixtureRoot,'warehouse-profile'),workspace=path.join(profile,'workspace'),data=path.join(workspace,'data');fs.mkdirSync(data,{recursive:true});
  const env={...process.env,...windowsEnvironment,ERP_SOURCE_ROOT:root,ERP_SOURCE_BOOT_LOG:path.join(fixtureRoot,'warehouse-source.log'),LINGTU_REGISTRY_PATH:path.join(profile,'registry.json'),CAINIAO_APP_DATA_DIR:workspace,ERP_DATA_DIR:data,LINGTU_BUSINESS_ONLY:'1',LINGTU_TEST_LEDGER:'1',LINGTU_ISOLATED_TEST:'1',LINGTU_MANAGED_MODULE:'1',LINGTU_AGENT_MANAGED:'1'};
  const init=spawnSync(process.execPath,['--input-type=module','-e',"import {getDb,closeDb} from './core/erp/db.js';getDb();closeDb();"],{cwd:root,env:{...env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true});if(init.status!==0)throw Error('云仓测试账本初始化失败：'+init.stderr);
  if(!fs.existsSync(path.join(profile,'settings.json')))fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({runtimeMode:'server',firstRunPending:false,scheduleEnabled:false,monthlySalesEnabled:false,startAtLogin:false}));
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
  delete env.ELECTRON_RUN_AS_NODE;delete env.LINGTU_AUTH_PROFILE_DIR;const log=fs.openSync(path.join(fixtureRoot,'warehouse-source.log'),'a');
  try{child=spawn(process.execPath,[path.join(root,'tests/fixtures/source-warehouse-entry'),'--user-data-dir='+profile,'--managed-module=warehouse','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{cwd:root,env,stdio:['ignore',log,log],windowsHide:false});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}finally{fs.closeSync(log);}
  const receipt={pid:child.pid,debugPort:port,profile,scope:'Source warehouse with temporary test ledger; no platform sync or formal data'};fs.writeFileSync(path.join(fixtureRoot,'warehouse-source.json'),JSON.stringify(receipt));report('warehouse.source-opened',receipt);return {opened:true,external:true};
 },close(){if(child&&child.exitCode===null)child.kill();}};
}
