import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-direct-cloud-'));
const env={...process.env,LINGTU_ISOLATED_TEST:'1',LINGTU_ALLOW_INITIALIZE:'1',LINGTU_MAINTENANCE:'0',LINGTU_REGISTRY_PATH:path.join(root,'registry.json')};
delete env.LINGTU_MANAGED_MODULE;
delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve(process.env.WAREHOUSE_TEST_EXE||'node_modules/electron/dist/electron.exe'),
  args:[...(process.env.WAREHOUSE_TEST_EXE?[]:['.']),'--user-data-dir='+root,'--managed-module=warehouse'],env});
const errors=[];
try{
  const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#dailySyncBadge').waitFor({state:'visible'});
  assert.equal(await page.locator('#featureHome,[data-open-desk],#deskServiceList').count(),0);
  assert.equal(await page.locator('#firstRunSetup').count(),0);
  assert.equal(await page.locator('h1').textContent(),'云仓同步');
  assert.equal(await page.locator('[data-view-panel="dashboard"]').isVisible(),true);
  await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator('#checkUpdate').isVisible(),false);
  assert.equal(await page.locator('#runtimeSettingsForm').count(),0);
  assert.equal(await page.getByText('连接由工作台统一管理',{exact:true}).isVisible(),true);
  await page.locator('[data-view="inventory"]').click();
  assert.equal(await page.locator('[data-view-panel="inventory"]').isVisible(),true);
  await page.locator('[data-view="dashboard"]').click();
  fs.mkdirSync('dist/module-verification',{recursive:true});
  await page.screenshot({path:'dist/module-verification/warehouse-direct-entry.png'});
  // Reproduce the original failure: initialization rejects before it finishes.
  await app.evaluate(({ipcMain})=>ipcMain.removeHandler('settings:get'));
  await page.reload();await page.locator('#logs').filter({hasText:'初始化失败'}).waitFor();
  assert.equal(await page.locator('[data-view-panel="dashboard"]').isVisible(),true);
  assert.equal(await page.locator('#featureHome').count(),0);
  assert.equal(await page.locator('h1').textContent(),'云仓同步');
  assert.equal(await page.locator('#backHome').textContent(),'返回工作台');
  assert.deepEqual(errors,[]);
  fs.mkdirSync('dist/module-verification',{recursive:true});
  await page.screenshot({path:'dist/module-verification/warehouse-init-failure.png'});
  console.log(JSON.stringify({ok:true,noDuplicateHome:true,directBusinessView:true,initializationFailureSafe:true,unifiedModuleUpdates:true,rendererErrors:errors}));
}finally{
  try{execFileSync('taskkill',['/PID',String(app.process().pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}
  await app.close().catch(()=>{});
}
