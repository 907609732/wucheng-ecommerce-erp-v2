import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const services=new ServiceManager(),before=JSON.parse(fs.readFileSync('dist/module-verification/workbench-before-install.json','utf8'));
assert.equal((await services.capabilities('warehouse')).pid,before.warehousePid);
const exe=path.join(process.env.LOCALAPPDATA,'Programs/wucheng-ecommerce-erp-v2/云仓库存同步.exe');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:exe,env});
try{
  assert.equal(await app.evaluate(({app})=>app.getVersion()),'0.8.1');
  const page=await app.firstWindow();await page.locator('#cards article').first().waitFor();
  assert.equal(await page.title(),'五成电子商务工作台');
  assert.equal(await page.locator('.brand strong').textContent(),'五成电子商务工作台');
  assert.deepEqual(await page.locator('#cards h2').allTextContents(),['云仓同步','采购台','销售台']);
  assert.equal((await app.windows()).length,1);
  await page.screenshot({path:'dist/module-verification/workbench-installed-0.8.1.png'});
}finally{await Promise.race([app.close(),new Promise(resolve=>setTimeout(resolve,5000))]);}
assert.equal((await services.capabilities('warehouse')).pid,before.warehousePid);
const after=(await services.status()).map(({extension,status,version,error})=>({extension,status,version,error}));
assert.deepEqual(after,before.services,'Unrelated module status changed during installation');
const result={ok:true,installedVersion:'0.8.1',productName:'五成电子商务工作台',warehouseVersion:'0.7.3',warehouseServicePreserved:true,unrelatedServicesUnchanged:true,homeEntries:3,checkedAt:new Date().toISOString()};
fs.writeFileSync('dist/module-verification/workbench-installed-0.8.1.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
