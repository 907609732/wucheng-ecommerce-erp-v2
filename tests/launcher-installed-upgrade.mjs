import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const services=new ServiceManager();
const version=JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8')).version;
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
  assert.equal(await app.evaluate(({app})=>app.getVersion()),version);
  const page=await app.firstWindow();
  await page.locator('#cards article').first().waitFor();
  assert.equal(await page.title(),'五成电子商务工作台');
  assert.deepEqual(await page.locator('#cards .card h3').allTextContents(),['菜鸟云仓同步','经营收支总览','销售台','采购台']);
  assert.deepEqual(await page.locator('#cards button').allTextContents(),['打开','打开','打开','打开']);
  await page.screenshot({path:'dist/module-verification/installed-launcher.png'});
}finally{
  await Promise.race([app.close(),new Promise(resolve=>setTimeout(resolve,5000))]);
}
for(const previous of before)assert.equal((await services.capabilities(previous.id)).pid,previous.pid);
const report={ok:true,installedVersion:version,originalProfile:true,homeEntries:4,backgroundServices:preserved,checkedAt:new Date().toISOString()};
fs.writeFileSync('dist/module-verification/installed-upgrade.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
