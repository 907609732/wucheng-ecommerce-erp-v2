import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

// Renderer-only fixtures: exercise the real controls without touching services,
// installers, accounts, files or business ledgers.
const browser=await chromium.launch({headless:true});
const version=JSON.parse(fs.readFileSync('desktop/launcher/package.json','utf8')).version;
const output=path.resolve('dist/module-verification');fs.mkdirSync(output,{recursive:true});
const report={version,scope:'Real renderer with synthetic preload responses; no real service actions',checks:[]};
try{
  const page=await browser.newPage({viewport:{width:1224,height:785}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const ids=['warehouse','purchase','sales','overview','exporter','node-runtime','browser-runtime'];
    const fixture=window.uxFixture={mode:'server',calls:{open:[],openData:[],uninstall:[],install:[],bounds:[]},confirmAnswers:[],confirmMessages:[]};
    let personnelRole=null;
    const connection=()=>({mode:fixture.mode,serverUrl:'https://synthetic.example.ts.net:8443',configurationId:'synthetic-'+fixture.mode,networkProvider:'system',connected:fixture.mode==='client',canWrite:fixture.mode!=='client'});
    const rows=()=>ids.map(id=>fixture.mode==='client'?{id,remote:true,status:'running',authorized:id!=='purchase',version:'1.0.0'}:{id,installed:{version:'1.0.0'},available:{version:id==='purchase'?'1.1.0':'1.0.0'},updateAvailable:id==='purchase'});
    window.confirm=text=>{fixture.confirmMessages.push(text);return fixture.confirmAnswers.shift()??false;};
    window.launcher={
      personnelState:async()=>({role:personnelRole,selected:!!personnelRole,label:personnelRole==='boss'?'老板':personnelRole==='employee'?'员工':'请选择身份'}),selectPersonnel:async role=>{personnelRole=role;return {role,selected:!!role,label:role==='boss'?'老板':role==='employee'?'员工':'请选择身份'};},
      connection:async()=>connection(),connectionStatus:async()=>({...connection(),state:fixture.mode==='client'?'connected':'ready',label:fixture.mode==='client'?'已连接主服务器':'主服务器已就绪',detail:'合成场景：已完成连接检查。',checkedAt:new Date().toISOString(),latencyMs:12}),
      list:async()=>rows(),hide:async()=>{},bounds:async value=>fixture.calls.bounds.push(value),open:async(id,route)=>fixture.calls.open.push({id,route}),
      openData:async id=>fixture.calls.openData.push(id),uninstall:async id=>fixture.calls.uninstall.push(id),
      plan:async id=>({id,bytes:1024,packages:[{id,version:'1.1.0',bytes:1024}]}),refresh:async()=>{},
      install:async id=>fixture.calls.install.push(id),cancel:async()=>{},offline:async()=>null,
      networkPlan:async()=>({token:'synthetic-plan',difference:{add:[],preserve:[]},backup:'synthetic-backup'}),saveConnection:async value=>{fixture.mode=value.mode;return connection();},checkConnection:async()=>({local:true}),
      networkStatus:async()=>({state:'stopped'}),services:async()=>[],stop:async()=>{},openLink:async()=>{},
      checkUpdate:async()=>{},installUpdate:async()=>{},preferences:async()=>({startAtLogin:false}),savePreferences:async value=>{fixture.preferences=value;return value;},integrationConfig:async()=>({mcp:{},cli:{}}),copyIntegration:async kind=>{fixture.copied=kind;},
      permissions:async()=>({users:{}}),savePermissions:async()=>{},
      onProgress:()=>{},onNavigate:()=>{},onMessage:()=>{},onUpdate:()=>{}
    };
  });
  await page.goto(pathToFileURL(path.resolve('desktop/launcher/index.html')).href);
  await page.locator('#personnelBoss').click();
  await page.locator('#cards [data-module=purchase] button').waitFor();
  await page.locator('#connectionIndicator[data-state=ready]').waitFor();
  assert.deepEqual(await page.locator('.workflowHeading h2').allTextContents(),['每天使用','每月填写']);
  assert.deepEqual(await page.locator('#cards .card h3').allTextContents(),['菜鸟云仓同步','经营收支总览','销售台','采购台']);
  const visibleActions=async()=>{
    const viewport=page.viewportSize();
    for(const id of ['warehouse','overview','sales','purchase']){
      const box=await page.locator(`#cards [data-module=${id}] button`).first().boundingBox();
      assert(box&&box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height-4,id+' action must fit the first screen');
      assert(box.height>=30,'Desktop actions must remain comfortably clickable');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal overflow');
  };
  await visibleActions();
  await page.screenshot({path:path.join(output,`compact-home-${version}.png`)});
  await page.setViewportSize({width:900,height:650});await visibleActions();
  await page.screenshot({path:path.join(output,`compact-home-narrow-${version}.png`)});
  report.checks.push('Four original business actions visible at 1224x785 and 900x650');
  await page.setViewportSize({width:1224,height:785});
  // The compact shell retains settings as a navigation route while hiding its header button.
  await page.evaluate(()=>document.getElementById('settings').click());await page.locator('#settingsPanel').waitFor({state:'visible'});
  const warehouse=page.locator('[data-module-row=warehouse]'),more=warehouse.locator('details.moduleMore'),summary=more.locator('summary');
  assert(await warehouse.getByRole('button',{name:'打开',exact:true}).isVisible());
  assert.equal(await more.getAttribute('open'),null);
  assert.equal(await warehouse.getByRole('button',{name:'卸载',exact:true}).count(),0,'Suite has no per-module uninstall action');
  await summary.focus();await summary.press('Enter');
  await warehouse.getByRole('button',{name:'数据位置',exact:true}).waitFor({state:'visible'});
  await warehouse.getByRole('button',{name:'数据位置',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.uxFixture.calls.openData),['warehouse']);
  const openMore=async()=>{if(await more.getAttribute('open')===null)await summary.click();};
  await openMore();assert.equal(await warehouse.getByRole('button',{name:'诊断',exact:true}).count(),1);
  assert.equal(await page.evaluate(()=>window.uxFixture.calls.uninstall.length),0);
  await openMore();await summary.press('Escape');assert.equal(await more.getAttribute('open'),null);
  await openMore();await page.locator('#settingsPanel h1').click();assert.equal(await more.getAttribute('open'),null);
  report.checks.push('Keyboard More menu, data location and diagnostics, no module uninstall, Escape and outside dismissal');
  await page.locator('#messageClose').click().catch(()=>{});
  await page.screenshot({path:path.join(output,`compact-settings-${version}.png`)});
  assert.equal(await page.locator('#moduleList').getByRole('button',{name:'更新',exact:true}).count(),0);
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#startAtLogin').check();
  await page.waitForFunction(()=>window.uxFixture.preferences?.startAtLogin===true);
  await page.locator('#copyMcp').click();await page.waitForFunction(()=>window.uxFixture.copied==='mcp');
  await page.locator('#copyCli').click();await page.waitForFunction(()=>window.uxFixture.copied==='cli');
  await page.locator('#advancedSettings > summary').click();
  report.checks.push('Unified product updates only, Windows startup toggle and copyable MCP/CLI configuration');
  await page.evaluate(()=>message('已完成合成操作。'));
  await page.locator('#message').waitFor({state:'visible'});
  await page.locator('#message').waitFor({state:'hidden',timeout:8000});
  await page.evaluate(()=>message(new Error('合成错误，需要人工查看。')));
  await page.locator('#message').waitFor({state:'visible'});
  assert.match(await page.locator('#message').innerText(),/合成错误/);
  await page.locator('#messageClose').click();
  await page.locator('#message').waitFor({state:'hidden'});
  report.checks.push('Success messages expire and errors can be dismissed');
  await page.locator('#home').click();await page.locator('#cards [data-module=purchase] button').click();
  await page.locator('#deskPanel').waitFor({state:'visible'});
  await page.evaluate(()=>message('合成操作提示。'));
  await page.waitForFunction(()=>{
    const rect=document.getElementById('extensionFrame').getBoundingClientRect(),last=window.uxFixture.calls.bounds.at(-1);
    return last&&Math.abs(last.y-rect.y)<1&&Math.abs(last.height-rect.height)<1&&rect.bottom<=innerHeight+1;
  });
  await page.locator('#messageClose').click();
  await page.waitForFunction(()=>{
    const rect=document.getElementById('extensionFrame').getBoundingClientRect(),last=window.uxFixture.calls.bounds.at(-1);
    return last&&Math.abs(last.y-rect.y)<1&&Math.abs(last.height-rect.height)<1&&rect.bottom<=innerHeight+1;
  });
  report.checks.push('Embedded view bounds follow document-flow notifications and fit the viewport');
  await page.evaluate(()=>document.getElementById('settings').click());
  await page.evaluate(async()=>{window.uxFixture.mode='client';await loadConnection();await load();await pollConnectionStatus({force:true});});
  assert.equal(await page.locator('#moduleList').getByRole('button',{name:'卸载',exact:true}).count(),0);
  assert.equal(await page.locator('#moduleList').getByRole('button',{name:'数据位置',exact:true}).count(),0);
  assert(await page.locator('[data-module-row=purchase] button.primary').isDisabled());
  assert(await page.locator('#connectionIndicator[data-state=connected]').isVisible());
  report.checks.push('Client mode preserves authorization-disabled buttons and exposes no host uninstall/data paths');
  assert.deepEqual(errors,[]);report.ok=true;report.rendererErrors=errors;
  fs.writeFileSync(path.join(output,`compact-ui-${version}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
