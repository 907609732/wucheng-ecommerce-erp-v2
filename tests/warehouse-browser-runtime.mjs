// Blank-page checks only: never loads saved login state or navigates to a platform.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

if(process.argv[2]==='--worker') {
  const appRoot=process.argv[3];
  const require=createRequire(path.join(appRoot,'package.json'));
  const {chromium}=require('playwright');
  const {browserLaunchOptions}=await import(pathToFileURL(path.join(appRoot,'core','browser-launch.js')));
  const options=browserLaunchOptions();
  assert.equal(options.executablePath,fs.realpathSync.native(process.env.LINGTU_BROWSER_PATH));
  const results=[];
  for(const mode of ['sync','login']) {
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'warehouse-browser-check-'));
    let browser;
    try {
      const config={...options,headless:false,timeout:15000,args:['--no-proxy-server']};
      browser=mode==='login'?await chromium.launchPersistentContext(fs.realpathSync.native(profile),config):await chromium.launch(config);
      const page=await browser.newPage();
      await page.setContent('<h1>Browser runtime check</h1>');
      assert.equal(await page.locator('h1').textContent(),'Browser runtime check');
      results.push({mode,ok:true});
    } finally {await browser?.close();fs.rmSync(profile,{recursive:true,force:true});}
  }
  console.log(JSON.stringify({ok:true,packaged:appRoot.endsWith('.asar'),results}));
} else {
  const {ServiceManager}=await import('../desktop/shared/service-manager.mjs');
  const config=new ServiceManager().config('warehouse');
  const exe=process.env.WAREHOUSE_TEST_EXE;
  const appRoot=exe?path.join(path.dirname(path.resolve(exe)),'resources','app.asar'):path.resolve('.');
  const {stdout}=await promisify(execFile)(exe||process.execPath,[fileURLToPath(import.meta.url),'--worker',appRoot],{
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LINGTU_BROWSER_PATH:config.browserPath},
    windowsHide:true,timeout:60000,maxBuffer:1024*1024
  });
  const result=JSON.parse(stdout.trim());assert.equal(result.ok,true);
  fs.mkdirSync('dist/module-verification',{recursive:true});
  fs.writeFileSync('dist/module-verification/browser-runtime-'+(exe?'packaged':'source')+'.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
