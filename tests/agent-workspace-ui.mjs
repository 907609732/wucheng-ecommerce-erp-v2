import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {reviewBinding,scheduleCron,createAgentApi,betaServerUrl} from '../desktop/launcher/agent-api.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dependencies=createRequire(path.join(process.env.AGENT_UI_DEPENDENCY_ROOT || root,'package.json'));
const {chromium}=dependencies('playwright');
const evidence=path.join(root,'.codex-artifacts','agent-workspace-ui');fs.mkdirSync(evidence,{recursive:true});
const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const server=http.createServer((request,response)=>{
  const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname),file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end();return;}
  response.setHeader('Content-Type',types[path.extname(file)] || 'application/octet-stream');response.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
const errors=[];
try{
  assert.equal(scheduleCron('weekdays','09:30'),'30 9 * * 1-5');
  assert.equal(betaServerUrl(' https://company.example.ts.net:9443/ '),'https://company.example.ts.net:9443');
  for(const url of ['https://company.example.ts.net:8443','http://company.example.ts.net:9443','https://company.example.ts.net','https://user@company.example.ts.net:9443','https://company.example.ts.net:9443/path'])assert.throws(()=>betaServerUrl(url));
  assert.equal(reviewBinding({task:{id:'t'},result:{version:2},review:{id:'r',resultVersion:1,revision:3}}),null);
  await assert.rejects(createAgentApi(null).request('status'),/尚未连接/);
  await assert.rejects(createAgentApi(async()=>({})).request('permissions.get'),/未支持/);
  await assert.rejects(createAgentApi(async()=>({})).request('permissions.save',{policy:{}}),/未支持/);
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{
    window.fixture={role:'admin',calls:[],offline:false,version:1,status:'waiting_review',canApprove:true,approved:0,attachments:[],schedules:[],connection:{mode:'client',networkProvider:'system',serverUrl:'https://company.example.ts.net:9443',canConfigure:true},connectionPlans:0,connectionSaves:0,connectionPlanExpired:false,connectionFailure:false,connectionAdds:['HTTPS 9443 → http://127.0.0.1:27330']};
    const f=window.fixture;
    if(sessionStorage.getItem('fixture-role')==='viewer')f.role='viewer';
    const task=()=>({id:'task-1',goal:'整理云仓运费并核对赔付',status:f.status,engine:'codex',createdAt:'2026-10-28T10:00:00Z',updatedAt:'2026-10-28T10:10:00Z',scope:{label:'2026 年 9 月 · 测试账本'}});
    const detail=()=>({task:task(),events:[{sequence:1,type:'created',message:'已接收目标',createdAt:'2026-10-28T10:00:00Z'},{sequence:2,type:'progress',message:'已核对 3 份合成账单',createdAt:'2026-10-28T10:05:00Z'}],result:{id:'result-1',version:f.version,summary:'已准备 3 条运费记录。<img src=x onerror=alert(1)>',scope:{label:'2026 年 9 月 · 测试账本'},blocks:[{type:'table',title:'费用明细',columns:[{key:'month',label:'月份'},{key:'gross',label:'运费（元）',type:'money'},{key:'compensation',label:'赔付抵扣（元）',type:'money'},{key:'net',label:'应记费用（元）',type:'money'}],rows:[{month:'2026-09',gross:'1,500.00',compensation:'100.00',net:'1,400.00'}]},{type:'files',files:[{artifactId:'artifact-1',name:'运费核对结果.xlsx'}]}],changes:[{label:'9 月运费',before:'未导入',after:'1,400.00 元'}],evidence:[{title:'合成官方账单',artifactId:'source-1'}],issues:[{message:'合成测试样本，不是真实账本'}],...(f.status==='completed'?{receipt:{id:'receipt-1',message:'模拟服务回执已核对',state:'verified',receipts:[{id:'synthetic-receipt',state:'completed',idempotencyKey:'synthetic-business-key'}]}}:{})},review:{id:'review-'+f.version,resultVersion:f.version,revision:f.version,canApprove:f.canApprove}});
    window.launcher={ready:async()=>({ready:true}),agentRequest:async({operation,payload})=>{
      f.calls.push({operation,payload});if(f.offline)throw new Error('公司主机暂不可用，已有任务仍保留');
      if(operation==='status')return{actor:{id:'person-1',label:'测试审核员',role:f.role,canCreateTasks:true,canRunTasks:f.role!=='viewer'},environment:{mode:'test',label:'测试账本'},engines:[{id:'codex',available:true,configured:true,supportedModels:['company-model','company-model-alternative']},{id:'hermes',available:true,configured:true}]};
      if(operation==='tasks.list')return{tasks:[task()]};
      if(operation==='tasks.get')return detail();
      if(operation==='tasks.create'){f.status='running';return{task:task()};}
      if(operation==='tasks.input'){f.status='running';return{task:task()};}
      if(operation==='tasks.control'){f.status={pause:'paused',resume:'running',cancel:'cancelled'}[payload.action];return detail();}
      if(operation==='reviews.approve'){if(payload.resultVersion!==f.version)throw new Error('结果版本已变化，请重新核对');f.approved++;f.status='completed';return detail();}
      if(operation==='reviews.reject'){f.status='waiting_input';return detail();}
      if(operation==='attachments.upload'){const a={id:'attachment-'+(f.attachments.length+1),name:payload.name,size:payload.bytes.length};f.attachments.push(a);return a;}
      if(operation==='artifacts.open')return{opened:true,message:'已打开登记的结果文件'};
      if(operation==='settings.get'||operation==='settings.save')return{settings:{defaultEngine:'codex',company:{baseUrl:'https://api.example.test/v1',model:'company-model',budgetLimit:100,hasKey:true},engines:{codex:{available:true,configured:true,version:'test'},hermes:{available:true,configured:true,version:'test'}}}};
      if(operation==='connection.get')return{connection:f.connection};
      if(operation==='connection.plan'){f.connectionPlans++;return{token:'plan-'+f.connectionPlans,difference:{add:f.connectionAdds,preserve:['company.example.ts.net:443','company.example.ts.net:8443'],funnel:false},backup:'C:/server-only/connection-backup.json'};}
      if(operation==='connection.save'){
        if(f.connectionFailure)throw new Error('连接暂不可用，请稍后重试');
        if(payload.mode==='server' && (f.connectionPlanExpired || payload.networkToken!=='plan-'+f.connectionPlans)){f.connectionPlanExpired=false;throw Object.assign(new Error('请先审查本次私网配置差异'),{code:'NETWORK_PLAN_EXPIRED'});}
        f.connectionSaves++;f.connection={...f.connection,...payload,...(payload.mode==='server'?{serverUrl:'https://company.example.ts.net:9443'}:{})};return{connection:f.connection};
      }
      if(operation==='connection.check')return{detail:'合成连接检查成功'};
      if(operation==='schedules.list')return{schedules:f.schedules};
      if(operation==='schedules.create'){f.schedules.push({...payload,id:'schedule-1'});return{schedule:f.schedules.at(-1)};}
      if(operation==='schedules.update'){Object.assign(f.schedules.find(s=>s.id===payload.id),payload);return{updated:true};}
      if(operation==='schedules.delete'){f.schedules=f.schedules.filter(s=>s.id!==payload.id);return{deleted:true};}
      throw new Error('测试未声明操作 '+operation);
    }};
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/desktop/launcher/agent-index.html');
  await page.getByRole('button',{name:'开始处理'}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('#submit-goal').disabled);
  await page.screenshot({path:path.join(evidence,'home-desktop.png'),fullPage:true});
  assert.equal(await page.locator('#environment').textContent(),'测试账本');
  assert.equal(await page.locator('#personnelBoss').count(),0,'No self-selected admin role');
  await page.locator('#goal-files').setInputFiles({name:'synthetic-bill.csv',mimeType:'text/csv',buffer:Buffer.from('month,amount\n2026-09,1400')});
  await page.locator('#goal-attachments li').waitFor();
  await page.locator('#goal').fill('整理附件中的运费，准备待确认结果');await page.locator('#goal').press('Control+Enter');
  await page.locator('#view-task').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='执行中');
  assert.equal(await page.locator('#task-loading progress.lt-loading__progress').count(),1);
  assert.equal(await page.locator('#task-loading progress').getAttribute('value'),null,'Unknown progress has no invented percentage');
  const create=await page.evaluate(()=>window.fixture.calls.find(call=>call.operation==='tasks.create'));
  assert.deepEqual(create.payload.attachmentIds,['attachment-1']);assert.equal(Object.hasOwn(create.payload,'actor'),false);
  await page.getByRole('button',{name:'暂停',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已暂停');
  await page.getByRole('button',{name:'继续处理',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='执行中');
  await page.evaluate(()=>window.fixture.status='waiting_review');await page.getByRole('button',{name:'刷新结果',exact:true}).click();
  await page.locator('#review-panel').waitFor({state:'visible'});
  assert.equal(await page.locator('#result-content img').count(),0,'Untrusted result content is text, not executable HTML');
  assert.equal(await page.locator('#approve-result').isDisabled(),true);
  await page.locator('#review-check').check();assert.equal(await page.locator('#approve-result').isEnabled(),true);
  await page.evaluate(()=>window.fixture.version=2);await page.getByRole('button',{name:'刷新结果',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#result-version').textContent==='版本 2');
  assert.equal(await page.locator('#review-check').isChecked(),false,'Changed result invalidates previous acknowledgement');
  assert.match(await page.locator('#notice').textContent(),/重新核对/);
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'task-review-desktop.png'),fullPage:true});
  await page.locator('#review-check').check();await page.locator('#approve-result').dblclick();
  await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已完成');
  assert.equal(await page.evaluate(()=>window.fixture.approved),1,'Double action cannot submit twice');
  assert.match(await page.locator('.receipt').textContent(),/提交结果已核对/);
  await page.locator('.file-list').first().getByRole('button',{name:'下载',exact:true}).click();assert.equal((await page.evaluate(()=>window.fixture.calls.filter(call=>call.operation==='artifacts.open').at(-1))).payload.id,'artifact-1');
  await page.locator('#input-files').setInputFiles({name:'supplement.csv',mimeType:'text/csv',buffer:Buffer.from('note\nsynthetic supplement')});await page.locator('#input-attachments li').waitFor();
  await page.locator('#task-input').fill('补充附件，请重新核对');await page.locator('#submit-input').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='执行中');
  assert.deepEqual((await page.evaluate(()=>window.fixture.calls.filter(call=>call.operation==='tasks.input').at(-1))).payload.attachmentIds,['attachment-2']);
  await page.evaluate(()=>window.fixture.status='completed');await page.getByRole('button',{name:'刷新结果',exact:true}).click();
  await page.locator('.main-nav [data-view=settings]').click();await page.locator('#company-model').waitFor();await page.waitForFunction(()=>document.querySelector('#company-model').value==='company-model');
  assert.equal(await page.locator('#company-model').evaluate(element=>element.tagName),'SELECT');
  assert.deepEqual(await page.locator('#company-model option').evaluateAll(options=>options.map(option=>option.value)),['','company-model','company-model-alternative']);
  await page.locator('#default-engine').selectOption('hermes');assert.equal(await page.locator('#company-model').evaluate(element=>element.tagName),'INPUT');await page.locator('#company-model').fill('hermes-provider-model');await page.locator('#default-engine').selectOption('codex');assert.equal(await page.locator('#company-model').inputValue(),'hermes-provider-model','Engine switch never silently changes the company model');
  await page.locator('#save-model').click();assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call.operation==='settings.save').length),0,'Incompatible model is rejected before settings save');assert.match(await page.locator('#company-model-hint').innerText(),/不兼容/);await page.locator('#company-model').selectOption('company-model');
  assert.equal(await page.locator('#company-api-key').inputValue(),'');
  await page.locator('#company-api-key').fill('synthetic-never-real-key');await page.locator('#save-model').click();await page.waitForFunction(()=>document.querySelector('#company-api-key').value==='');
  assert.ok(!(await page.locator('body').innerText()).includes('synthetic-never-real-key'),'Secret never rendered back');
  assert.equal(await page.locator('#permissions-form,#member-rows,#add-member').count(),0,'Removed permission management has no placeholder UI');
  assert.equal(await page.evaluate(()=>window.fixture.calls.some(call=>call.operation.startsWith('permissions.'))),false,'Settings never reads or saves removed permission management');
  await page.locator('#connection-url').fill('https://company.example.ts.net:8443');await page.locator('#save-connection').click();
  assert.match(await page.locator('#error-message').textContent(),/9443/);assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.operation==='connection.save').length),0,'Production port is rejected before the host API');
  assert.equal(await page.locator('#connection-url').inputValue(),'https://company.example.ts.net:8443');
  await page.locator('#connection-mode').selectOption('server');await page.locator('#save-connection').click();await page.locator('#connection-review').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.fixture.connectionSaves),0,'Planning never changes company connection');
  const connectionReview=await page.locator('#connection-review').innerText();assert.match(connectionReview,/HTTPS 9443/);assert.match(connectionReview,/company.example.ts.net:8443/);assert.match(connectionReview,/不对公网开放/);assert.ok(!/127\.0\.0\.1|27330|Funnel|server-only|plan-/.test(connectionReview),'Review explains business changes without local paths or implementation details');
  await page.locator('#connection-review').screenshot({path:path.join(evidence,'connection-review-desktop.png')});
  await page.locator('#connection-mode').selectOption('standalone');assert.equal(await page.locator('#connection-review').isVisible(),false,'Editing form invalidates the previous proposal');
  await page.locator('#connection-mode').selectOption('server');await page.evaluate(()=>window.fixture.offline=true);await page.locator('#save-connection').click();
  assert.equal(await page.locator('#connection-mode').inputValue(),'server');assert.equal(await page.locator('#connection-review').isVisible(),false);assert.equal(await page.evaluate(()=>window.fixture.connectionSaves),0);
  await page.evaluate(()=>window.fixture.offline=false);await page.locator('#save-connection').click();await page.locator('#connection-review').waitFor({state:'visible'});
  await page.evaluate(()=>window.fixture.connectionPlanExpired=true);await page.locator('#confirm-connection').click();await page.waitForFunction(()=>document.querySelector('#connection-review-note').textContent.includes('方案已更新'));
  assert.equal(await page.evaluate(()=>window.fixture.connectionSaves),0,'Expired proposal is replanned without an automatic save');
  await page.setViewportSize({width:390,height:844});await page.locator('#connection-review').screenshot({path:path.join(evidence,'connection-review-mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.locator('#confirm-connection').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>window.fixture.connectionSaves===1);await page.waitForFunction(()=>document.querySelector('#connection-review').hidden);
  const connectionSave=await page.evaluate(()=>window.fixture.calls.filter(c=>c.operation==='connection.save').at(-1));assert.equal(connectionSave.payload.networkToken,'plan-3');assert.equal(connectionSave.payload.serverUrl,'','Server address comes from host and cannot reuse the previous production URL');
  await page.evaluate(()=>window.fixture.connectionAdds=[]);await page.locator('#save-connection').click();await page.locator('#connection-review').waitFor({state:'visible'});assert.match(await page.locator('#connection-review').innerText(),/入口已存在/);await page.locator('#cancel-connection').click();assert.equal(await page.evaluate(()=>window.fixture.connectionSaves),1);
  await page.locator('#connection-mode').selectOption('client');await page.locator('#connection-url').fill('https://other.example.ts.net:9443');await page.locator('#connection-provider').selectOption('embedded');await page.evaluate(()=>window.fixture.connectionFailure=true);await page.locator('#save-connection').click();
  assert.equal(await page.locator('#connection-url').inputValue(),'https://other.example.ts.net:9443');assert.equal(await page.locator('#connection-provider').inputValue(),'embedded');assert.equal(await page.locator('#save-connection').isEnabled(),true,'Connection failure preserves editable inputs');
  await page.evaluate(()=>window.fixture.connectionFailure=false);await page.locator('#save-connection').click();await page.waitForFunction(()=>window.fixture.connectionSaves===2);await page.setViewportSize({width:1440,height:1000});
  await page.locator('#new-schedule').click();await page.locator('#schedule-goal').fill('每个工作日核对库存');await page.locator('#schedule-frequency').selectOption('weekdays');await page.locator('#schedule-time').fill('09:30');await page.locator('#save-schedule').click();await page.locator('.schedule-row').waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.schedules[0].cron),'30 9 * * 1-5');assert.equal(await page.evaluate(()=>window.fixture.schedules[0].timezone),'Asia/Shanghai');
  await page.locator('.schedule-row').getByRole('button',{name:'暂停',exact:true}).click();await page.waitForFunction(()=>window.fixture.schedules[0].enabled===false);
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'settings-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Settings fit narrow screen');
  await page.locator('.main-nav [data-view=home]').click();await page.screenshot({path:path.join(evidence,'home-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Home fits narrow screen');
  await page.locator('#recent-tasks .task-row').first().click();await page.locator('#result-version').waitFor();await page.screenshot({path:path.join(evidence,'result-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Wide result table scrolls inside its own container');
  await page.evaluate(()=>{window.fixture.status='unknown';});await page.getByRole('button',{name:'刷新结果',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='核对提交状态');
  assert.equal(await page.getByRole('button',{name:'继续处理',exact:true}).count(),0,'Unknown submission does not offer blind retry');
  const inputCallCount=await page.evaluate(()=>window.fixture.calls.filter(call=>call.operation==='tasks.input').length);await page.locator('#task-input').fill('回执未知不能补充');await page.locator('#task-input').press('Control+Enter');assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call.operation==='tasks.input').length),inputCallCount);
  await page.evaluate(()=>{window.fixture.offline=true;});await page.getByRole('button',{name:'刷新结果',exact:true}).click();await page.locator('#error-banner').waitFor({state:'visible'});assert.match(await page.locator('#error-message').textContent(),/主机暂不可用/);assert.equal(await page.locator('#result-version').textContent(),'版本 2','Last visible result preserved on network failure');
  await page.evaluate(()=>{window.fixture.offline=false;sessionStorage.setItem('fixture-role','viewer');});
  await page.reload();await page.waitForFunction(()=>document.querySelector('#actor').textContent==='测试审核员');
  assert.equal(await page.locator('#submit-goal').isEnabled(),true,'Every authenticated employee may describe business work despite legacy role flags');
  await page.locator('#pending-tasks .task-row').first().click();await page.locator('#review-panel').waitFor({state:'visible'});assert.equal(await page.locator('#review-check').isEnabled(),true);assert.equal(await page.locator('#approve-result').isDisabled(),true,'Result acknowledgement is still required');await page.locator('#review-check').check();assert.equal(await page.locator('#approve-result').isEnabled(),true);
  await page.locator('.main-nav [data-view=settings]').click();await page.waitForFunction(()=>document.querySelector('#company-model').value==='company-model');assert.equal(await page.locator('#save-model').isEnabled(),true);assert.equal(await page.locator('#new-schedule').isEnabled(),true);assert.equal(await page.locator('#save-connection').isEnabled(),true);assert.equal(await page.locator('#add-member').count(),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,scope:'Browser interaction against synthetic API contract; not live engine/business acceptance',reviewVersionBinding:true,noDuplicateApproval:true,attachments:true,schedules:true,permissionManagementRemoved:true,authenticatedEmployeeFullAccess:true,networkFailure:true,connectionDifferenceReview:true,connectionExpiryReplan:true,productionPortRejected:true,connectionInputPreserved:true,unknownNoBlindRetry:true,narrowViewport:true,sharedProgress:true,evidence}));
  await context.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
