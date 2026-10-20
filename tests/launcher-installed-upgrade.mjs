import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const services=new ServiceManager();
const before=JSON.parse(fs.readFileSync('dist/module-verification/pre-install-pids.json','utf8'));
const preserved=[];
for(const previous of before){
  const current=await services.capabilities(previous.id);
  assert.equal(current.pid,previous.pid,'Installer stopped background service '+previous.id);
  preserved.push({id:previous.id,version:current.version,pidUnchanged:true});
}
const exe=path.join(process.env.LOCALAPPDATA,'Programs/wucheng-ecommerce-erp-v2/云仓库存同步.exe');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:exe,env});
try{
  assert.equal(await app.evaluate(({app})=>app.getVersion()),'0.8.0');
  const page=await app.firstWindow();
  await page.locator('#cards article').first().waitFor();
  assert.deepEqual(await page.locator('#cards h2').allTextContents(),['云仓同步','采购台','销售台']);
  assert.deepEqual(await page.locator('#cards button').allTextContents(),['打开','打开','打开']);
  await page.screenshot({path:'dist/module-verification/installed-launcher.png'});
}finally{
  await Promise.race([app.close(),new Promise(resolve=>setTimeout(resolve,5000))]);
}
for(const previous of before)assert.equal((await services.capabilities(previous.id)).pid,previous.pid);
const report={ok:true,installedVersion:'0.8.0',originalProfile:true,homeEntries:3,backgroundServices:preserved,checkedAt:new Date().toISOString()};
fs.writeFileSync('dist/module-verification/installed-upgrade.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
