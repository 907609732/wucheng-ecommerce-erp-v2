import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.pendingOpens={};
    let personnelRole=null;
    window.launcher={
      personnelState:async()=>({role:personnelRole,selected:!!personnelRole,label:personnelRole==='boss'?'老板':'请选择身份'}),selectPersonnel:async role=>{personnelRole=role;return {role,selected:!!role,label:role==='boss'?'老板':'请选择身份'};},
      list:async()=>[
        {id:'overview',external:{dataDir:'fixture-overview'}},
        {id:'warehouse',installed:{version:'0.7.2'}},
        {id:'purchase',external:{dataDir:'fixture-purchase'}},
        {id:'sales',external:{dataDir:'fixture-sales'}}
      ],
      hide:async()=>{},bounds:async()=>{},
      open:id=>new Promise((resolve,reject)=>{window.pendingOpens[id]={resolve,reject};}),
      onProgress:()=>{},onMessage:()=>{},onUpdate:()=>{},onNavigate:()=>{}
    };
  });
  await page.goto(pathToFileURL(path.resolve('desktop/launcher/index.html')).href);
  await page.locator('#personnelBoss').click();
  const loading=page.locator('#openingStatus');
  const warehouse=page.locator('[data-module=warehouse] button');
  await warehouse.click();
  await loading.waitFor({state:'visible'});
  assert.equal(await loading.locator('progress.lt-loading__progress').count(),1,'Module startup uses the shared progress loading');
  assert.equal(await loading.locator('.openingSpinner').count(),0,'Old rotating startup spinner is removed');
  assert.equal(await loading.locator('progress').getAttribute('value'),null,'Unknown startup duration must not invent a percentage');
  assert.match(await loading.innerText(),/正在启动菜鸟云仓同步/);
  assert.equal(await warehouse.isDisabled(),true);
  assert.equal(await page.locator('#cards article').nth(1).locator('button').isDisabled(),true);
  fs.mkdirSync('dist/module-verification',{recursive:true});
  await page.screenshot({path:'dist/module-verification/launcher-loading.png'});
  await page.waitForTimeout(1100);
  assert.match(await page.locator('#openingSeconds').innerText(),/已等待 [1-9]\d* 秒/);
  await page.evaluate(()=>window.pendingOpens.warehouse.resolve({opened:true}));
  await loading.waitFor({state:'hidden'});
  assert.equal(await warehouse.isDisabled(),false);

  const purchase=page.locator('[data-module=purchase]').locator('button');
  await purchase.click();
  await loading.waitFor({state:'visible'});
  await page.locator('#deskPanel').waitFor({state:'visible'});
  assert.match(await loading.innerText(),/正在启动采购台/);
  await page.evaluate(()=>window.pendingOpens.purchase.reject(new Error('模拟服务启动失败')));
  await loading.waitFor({state:'hidden'});
  await page.locator('#homePanel').waitFor({state:'visible'});
  assert.match(await page.locator('#message').innerText(),/模拟服务启动失败/);

  await purchase.click();
  await loading.waitFor({state:'visible'});
  await page.evaluate(()=>window.pendingOpens.purchase.resolve({opened:true}));
  await loading.waitFor({state:'hidden'});
  await page.locator('#deskPanel').waitFor({state:'visible'});
  await page.locator('#home').click();
  await page.locator('[data-module=overview] button').click();
  await loading.waitFor({state:'visible'});
  assert.equal(await page.locator('#deskTitle').textContent(),'经营收支总览');
  await page.evaluate(()=>window.pendingOpens.overview.resolve({opened:true}));
  await loading.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,loadingShown:true,sharedProgressOnly:true,duplicateClickBlocked:true,failureVisible:true}));
}finally{await browser.close();}
