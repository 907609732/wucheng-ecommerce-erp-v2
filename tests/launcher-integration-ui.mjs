import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {_electron as electron,chromium} from 'playwright';
import {ServiceManager} from '../desktop/shared/service-manager.mjs';
const report=JSON.parse(fs.readFileSync('dist/module-verification/services.json','utf8'));
assert.ok(report.ok&&report.results.length===5,'Run the complete isolated package installation first');
const registry=JSON.parse(fs.readFileSync(report.registryFile,'utf8'));
const services=new ServiceManager({registryFile:report.registryFile}),checks=[],errors=[];
const stateFile=path.join(report.root,'modules','installed.json'),originalState=fs.readFileSync(stateFile);
let browser,app;
try{
  const purchase=await services.ensure('purchase');
  const beforeCount=(await services.request('purchase','/orders')).orders.length;
  console.log('purchase service ready');
  const {integrationHash}=await import(pathToFileURL(path.join(registry.purchase.root,'lib/local-integration.mjs')));
  const task={id:'packaged-ui-'+Date.now(),platform:'taobao',from:'2026-10-01',to:'2026-10-20',status:'completed',listOutcome:'complete',count:1,accountKey:'a'.repeat(64)};
  const orderId='999999999999999999999'+Date.now();
  const orders=[{platform:'taobao',account:'当前账号',id:orderId,createdAt:'2026-10-05',paidAt:'2026-10-05',status:'交易成功',shop:'隔离测试供应商',paidFen:12345,refundFen:null,freightFen:null,items:[{id:'1',title:'测试商品甲',quantity:2,unitPriceFen:6000},{id:'2',title:'测试商品乙',quantity:1,unitPriceFen:345}]}];
  const draft=await services.request('purchase','/transfers',{method:'POST',body:{schema:'order-transfer/v1',task,orders,digest:integrationHash({task,orders})}});
  browser=await chromium.launch({executablePath:registry.warehouse.browserPath,headless:true});
  const review=await browser.newPage({viewport:{width:1400,height:950}});
  review.on('pageerror',e=>errors.push(e.message));await review.goto(purchase.url+'/integration-review.html?batch='+draft.id);
  await review.locator('[data-refund="0"]').waitFor();assert.equal(await review.locator('[data-refund="0"]').inputValue(),'');
  await review.locator('#account').fill('隔离测试账号');await review.locator('[data-refund="0"]').fill('0');
  await review.locator('[data-evidence="0"]').fill('合成测试：已核实无退款');
  await review.locator('#save').click();await review.getByText('关键字段检查通过，请逐单核对来源与拟入账内容。').waitFor();
  assert.equal((await services.request('purchase','/orders')).orders.length,beforeCount);
  await review.locator('#first-confirm').click();await review.locator('#final-check').waitFor();
  assert.equal((await services.request('purchase','/orders')).orders.length,beforeCount);
  await review.locator('#final-check').check();await review.locator('#commit').click();
  await review.getByRole('heading',{name:'入账完成，校验通过'}).waitFor();
  await review.screenshot({path:'dist/module-verification/two-confirmations.png',fullPage:true});
  const imported=(await services.request('purchase','/orders')).orders;assert.equal(imported.length,beforeCount+1);assert.ok(imported.some(x=>x.amountCents===12345&&x.items.length===2));
  const overview=await services.request('overview','/overview?month=2026-10');
  assert.equal(overview.unavailable,false);assert.equal(overview.totals.purchase,-12345*(beforeCount+1));
  console.log('two confirmations and overview passed');
  checks.push('packaged services: two browser confirmations, multi-item exact amount, overview reconciliation');
  const env={...process.env,LINGTU_ISOLATED_TEST:'1',LINGTU_SKIP_BUNDLED_ACTIVATION:'1',LINGTU_REGISTRY_PATH:report.registryFile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:path.resolve('dist/launcher-release/win-unpacked/云仓库存同步.exe'),args:['--user-data-dir='+report.root],env});
  const page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  console.log('launcher window ready');
  const contents=id=>app.evaluate(({webContents},port)=>webContents.getAllWebContents().filter(w=>w.getURL().startsWith('http://127.0.0.1:'+port+'/')).map(w=>w.id),registry[id].port);
  const waitView=async id=>{for(let i=0;i<100;i++){if((await contents(id)).length)return;await new Promise(r=>setTimeout(r,100));}throw Error('Embedded view missing: '+id);};
  await page.locator('[data-module=purchase]').getByRole('button',{name:'打开'}).click();await waitView('purchase');
  const purchaseId=(await contents('purchase'))[0];
  await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.__retained="yes"'),purchaseId);
  await page.locator('#home').click();await page.locator('[data-module=sales]').getByRole('button',{name:'打开'}).click();await waitView('sales');
  await page.locator('#home').click();await page.locator('[data-module=purchase]').getByRole('button',{name:'打开'}).click();
  assert.equal(await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.__retained'),purchaseId),'yes');
  checks.push('four entries with overview first, embedded purchase and sales, retained state');
  console.log('embedded state retained');
  for(const [id,parent] of [['exporter','purchase'],['overview','sales']]){
    const state=JSON.parse(originalState);delete state.packages[id];fs.writeFileSync(stateFile,JSON.stringify(state));
    await page.locator('#settings').click();await page.locator('#home').click();
    if(id==='overview')assert.equal(await page.locator('[data-module=overview] button').isDisabled(),true);
    else{
      await page.locator(`[data-module=${parent}]`).getByRole('button',{name:'打开'}).click();await waitView(parent);
      const parentId=(await contents(parent))[0];
      await app.evaluate(({webContents},{parentId,id})=>webContents.fromId(parentId).executeJavaScript(`window.lingtuShell.open(${JSON.stringify(id)})`),{parentId,id});
    }
    if(id==='exporter')await page.locator('#message').filter({hasText:'程序文件不完整'}).waitFor({state:'visible'});
    assert.equal(await page.locator('#installDialog').isVisible(),false,'Suite never offers individual downloads');
    fs.writeFileSync(stateFile,originalState);
  }
  checks.push('Missing suite files disable opening or show unified repair, never individual downloads');
  console.log('unified repair states passed');
  await page.locator('#home').click();await page.screenshot({path:'dist/module-verification/launcher-installed.png'});
  const hostPid=app.process().pid;
  await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);
  let alive=true;try{process.kill(hostPid,0);}catch{alive=false;}
  assert.equal(alive,false,'Launcher process must exit');
  app=null;
  assert.equal((await services.capabilities('purchase')).pid,purchase.pid);
  checks.push('background survives launcher closure');
  assert.deepEqual(errors,[]);
  const result={ok:true,scope:'isolated packaged modules and synthetic orders',checks,errors};
  fs.writeFileSync('dist/module-verification/launcher-integration.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(error.stack);throw error;}finally{
  fs.writeFileSync(stateFile,originalState);
  if(app)await Promise.race([app.close(),new Promise(r=>setTimeout(r,5000))]);
  if(browser)await Promise.race([browser.close(),new Promise(r=>setTimeout(r,5000))]);
  for(const id of ['warehouse','purchase','sales','overview','exporter'])try{await services.stop(id);}catch{}
}
