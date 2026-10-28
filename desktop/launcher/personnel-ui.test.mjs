import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';

test('真实Electron隔离启动：先选身份、切换清缓存、员工IPC拒绝、重启重新选择', {timeout:120000},async()=>{
  const workspace=fileURLToPath(new URL('../../',import.meta.url));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingtu-personnel-ui-')),registry=path.join(root,'registry.json');
  fs.writeFileSync(registry,JSON.stringify(Object.fromEntries(['warehouse','purchase','sales','overview','exporter'].map(id=>[id,{
    managed:true,root:path.join(root,id),dataDir:path.join(root,'data',id),exe:path.join(root,id,'missing.exe')
  }]))));
  const env={...process.env,LINGTU_REGISTRY_PATH:registry,LINGTU_ISOLATED_TEST:'1',LINGTU_SKIP_BUNDLED_ACTIVATION:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>electron.launch({executablePath:path.join(workspace,'node_modules/electron/dist/electron.exe'),args:[path.join(workspace,'desktop/launcher'),'--user-data-dir='+root],env});
  let app=await launch();const errors=[];
  try{
    let page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#personnelPanel').waitFor({state:'visible'});
    assert.equal(await page.locator('#homePanel').isVisible(),false);
    assert.equal(await page.locator('.personnelCard').count(),2);
    assert.deepEqual(await page.evaluate(()=>window.launcher.personnelState()),{role:null,selected:false,label:'请选择身份'});
    const before=await page.evaluate(async()=>{try{await window.launcher.open('sales');return 'opened';}catch(error){return error.message;}});
    assert.match(before,/请先选择/);
    await page.screenshot({path:path.join(root,'personnel-first-start.png')});
    await page.locator('#personnelBoss').click();await page.locator('#homePanel').waitFor({state:'visible'});
    assert.equal((await page.evaluate(()=>window.launcher.personnelState())).role,'boss');
    assert.match(await page.locator('#personnelLabel').textContent(),/老板/);
    const policy=await page.evaluate(()=>window.launcher.permissions());assert.deepEqual(policy,{schemaVersion:1,users:{}});
    await page.locator('#personnelChange').click();await page.locator('#personnelPanel').waitFor({state:'visible'});
    await page.locator('#personnelEmployee').click();await page.locator('#homePanel').waitFor({state:'visible'});
    assert.equal((await page.evaluate(()=>window.launcher.personnelState())).role,'employee');
    assert.match(await page.locator('#personnelLabel').textContent(),/员工/);
    for(const operation of ['permissions','savePermissions','cached']){
      const result=await page.evaluate(async operation=>{try{await window.launcher[operation](operation==='cached'?'sales':{schemaVersion:1,users:{}});return 'allowed';}catch(error){return error.message;}},operation);
      assert.match(result,/仅老板可以查看/,operation+' must be enforced by main IPC');
    }
    await page.evaluate(()=>{document.querySelector('#cacheData').textContent='合成老板快照';});
    await page.locator('#personnelChange').click();await page.locator('#personnelPanel').waitFor({state:'visible'});
    assert.equal(await page.locator('#cacheData').textContent(),'');
    assert.equal((await page.evaluate(()=>window.launcher.personnelState())).selected,false);
    await page.locator('#personnelBoss').click();await page.locator('#homePanel').waitFor({state:'visible'});
    await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#personnelPanel').waitFor({state:'visible'});
    assert.equal((await page.evaluate(()=>window.launcher.personnelState())).selected,false,'same profile must not remember boss role across restarts');
    assert.deepEqual(errors,[]);
    assert.equal(fs.existsSync(path.join(root,'data','sales','sales.sqlite')),false,'fixture never opens or creates a business ledger');
    assert.equal(fs.existsSync(path.join(root,'workbench-server','access-policy.json')),false,'employee denied before policy file writes');
    console.log(JSON.stringify({ok:true,isolatedProfile:root,identityFirst:true,mainIPCGated:true,newStartResetsRole:true,rendererErrors:errors}));
  }finally{await app.close();}
});
