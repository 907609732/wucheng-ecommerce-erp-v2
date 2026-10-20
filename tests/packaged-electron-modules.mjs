import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron,chromium} from 'playwright';
const report=JSON.parse(fs.readFileSync('dist/module-verification/services.json','utf8'));
assert.ok(report.ok);
const configs=JSON.parse(fs.readFileSync(report.registryFile,'utf8')),results=[];
const out=path.resolve('dist/module-verification');
const browser=await chromium.launch({executablePath:configs.warehouse.browserPath,headless:true});
try{
  const page=await browser.newPage();await page.setContent('<h1>离线浏览器验收</h1>');
  assert.equal(await page.locator('h1').textContent(),'离线浏览器验收');
  results.push('packaged browser starts without system Chrome');
}finally{await browser.close();}
for(const id of ['warehouse','exporter']){
  const c=configs[id],errors=[];
  const env={...process.env,LINGTU_MANAGED_MODULE:'1',LINGTU_MAINTENANCE:'0',LINGTU_REGISTRY_PATH:report.registryFile,
    LINGTU_EXPORTER_DATA_DIR:c.dataDir,LINGTU_BROWSER_PATH:configs.warehouse.browserPath};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({executablePath:c.exe,args:id==='warehouse'?['--user-data-dir='+c.dataDir]:[],env});
  try{
    const page=await app.firstWindow();page.setDefaultTimeout(30000);
    page.on('pageerror',e=>errors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    if(id==='warehouse'){
      if(await page.locator('#firstRunSetup').isVisible()){
        await page.locator('[data-setup-mode="standalone"]').click();
        await page.locator('#finishFirstRun').click();
        await page.locator('#firstRunSetup').waitFor({state:'hidden'});
      }
      await page.locator('#backHome').waitFor();
    }else await page.getByText('采购台',{exact:false}).first().waitFor();
    await page.screenshot({path:path.join(out,id+'-packaged.png')});
    assert.deepEqual(errors,[]);
    results.push(id+' packaged window loads without renderer errors');
  }finally{await app.close();}
}
fs.writeFileSync(path.join(out,'electron-ui.json'),JSON.stringify({ok:true,results,scope:'isolated synthetic profiles'},null,2));
console.log(JSON.stringify({ok:true,results}));
