import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// Consolidated acceptance only: real production DOM/ECharts, synthetic authenticated host responses.
// This file intentionally does not operate a formal ledger, call a model, or contact a platform.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dependencies=createRequire(path.join(process.env.AGENT_UI_DEPENDENCY_ROOT||root,'package.json'));
const {chromium}=dependencies('playwright');
const imageBytes=fs.readFileSync(path.join(root,'desktop/assets/lingtu-icon.png'));
const image={name:'synthetic-source.png',mimeType:'image/png',size:imageBytes.length,sha256:createHash('sha256').update(imageBytes).digest('hex'),bytes:imageBytes.toString('base64')};
const output=path.join(root,'.codex-artifacts','agent-result-tools-ui');fs.mkdirSync(output,{recursive:true});
const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const server=http.createServer((request,response)=>{
  let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname));}catch{response.writeHead(400).end();return;}
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end();return;}
  response.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');response.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true}),errors=[];
try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(({image})=>{
    const f=window.resultFixture={calls:[],version:1,status:'waiting_review',role:sessionStorage.getItem('result-fixture-role')||'admin',amount:12300,previewMode:'valid',image,createdUrls:[],revokedUrls:[],delayedPreview:false};
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=create(blob);f.createdUrls.push(url);return url;};URL.revokeObjectURL=url=>{f.revokedUrls.push(url);return revoke(url);};
    const task=()=>({id:'result-task-1',goal:'合成结果工作面验收',status:f.status,engine:'codex',scope:{modules:['purchase','overview']},createdAt:'2026-10-29T10:00:00Z'});
    const chart=(id,title,extra={})=>({id,type:'chart',title,chartType:'line',dimension:{key:'month',label:'月份'},series:[{key:'cny',label:'人民币费用',unit:'fen',currency:'CNY'},{key:'usd',label:'美元费用',unit:'fen',currency:'USD'}],rows:[{month:'2026-07',cny:0,usd:250},{month:'2026-08',cny:null,usd:300},{month:'2026-09',cny:12300,usd:null}],sourceRefs:['source-1'],scope:{timezone:'Asia/Shanghai'},completeness:{state:'partial',message:'8月人民币费用尚未取得'},...extra});
    const current=()=>({id:'result-1',version:f.version,summary:'仅供隔离验收的草稿',blocks:[{type:'table',id:'draft-orders',title:'可更正采购草稿',rowKey:'id',sourceModule:'purchase',sourceCapabilityId:'order.create',editableFields:['amountCents','note'],columns:[{key:'id',label:'业务行'},{key:'amountCents',label:'金额（分）'},{key:'note',label:'说明'},{key:'sha256',label:'原件摘要'}],rows:[{id:'order-1',amountCents:f.amount,note:'原始说明',sha256:'read-only-source-hash'}]},{type:'table',id:'query-only',title:'只读查询',columns:['amountCents'],rows:[{amountCents:500}]},{type:'files',files:[{artifactId:'artifact-image-1',name:'合成原件.png',sourceLabel:'合成任务原件'}]},chart('split-currency','按币种分开的部分数据'),chart('missing-source','来源未登记的图表',{sourceRefs:['not-registered']}),chart('missing-data','缺少全部数据的图表',{completeness:{state:'missing',message:'来源尚未取得'}})],evidence:[{id:'source-1',title:'合成数据来源',artifactId:'artifact-image-1'}],issues:[{code:'BACKGROUND_PENDING',message:'历史采集处理中',blocking:false,resolved:true},{code:'SOURCE_PENDING',message:'另一来源仍未取得',blocking:true}],...(f.status==='completed'?{receipt:{state:'verified',receipts:[{id:'synthetic-receipt'}]}}:{})});
    const detail=payload=>({task:task(),events:[],result:payload?.resultVersion?{...current(),version:payload.resultVersion,summary:'历史合成草稿'}:current(),resultVersions:[{id:'result-1',version:1,createdAt:'2026-10-29T10:00:00Z'}],review:payload?.resultVersion?null:{id:'review-'+f.version,resultVersion:f.version,revision:f.version,canApprove:true}});
    // The native bridge is a contract stub; native occlusion has a separate gate.
    window.launcher={ready:async()=>({ready:true}),open:async id=>({id}),hide:async()=>{},bounds:async()=>{},agentRequest:async({operation,payload={}})=>{
      f.calls.push({operation,payload});
      if(operation==='skills.list')return {skills:[]};
      if(operation==='status')return {actor:{id:'synthetic-actor',label:'合成审核员',role:f.role,canRunTasks:f.role!=='viewer',modules:['purchase','overview']},environment:{mode:'test',label:'合成测试账本'},engines:[],capabilities:[{module:'purchase',id:'order.create',kind:'prepare',resultEditFields:['amountCents','note']}]};
      if(operation==='tasks.list')return {tasks:[task()]};
      if(operation==='tasks.get')return detail(payload);
      if(operation==='tasks.input'){f.status='running';return {task:task()};}
      if(operation==='artifacts.preview'){
        if(f.delayedPreview)await new Promise(resolve=>{f.resolvePreview=resolve;});
        if(f.previewMode==='denied')throw new Error('原件权限已失效，请刷新任务');
        if(f.previewMode==='hash')return {preview:{...f.image,sha256:'0'.repeat(64)}};
        if(f.previewMode==='unsupported')return {preview:{...f.image,mimeType:'text/html'}};
        return {preview:f.image};
      }
      if(operation==='artifacts.open')return {saved:true,name:f.image.name};
      if(operation==='reviews.approve')throw new Error('此验收脚本不允许正式提交');
      throw new Error('未声明的合成操作：'+operation);
    }};
  },{image});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/desktop/launcher/agent-index.html');
  await page.locator('#view-business').waitFor({state:'visible'});await page.locator('.main-nav [data-view=home]').click();
  await page.locator('#recent-tasks [data-task-id="result-task-1"]').click();
  const section=title=>page.locator('.result-block').filter({has:page.getByRole('heading',{name:title,exact:true})});
  const draft=section('可更正采购草稿'),query=section('只读查询');
  await draft.getByRole('button',{name:'更正草稿',exact:true}).waitFor();
  assert.equal(await query.getByRole('button',{name:'更正草稿'}).count(),0);
  await page.locator('#review-check').check();assert.equal(await page.locator('#approve-result').isEnabled(),true);
  await draft.getByRole('button',{name:'更正草稿',exact:true}).click();
  assert.equal(await draft.locator('input[data-field=sha256]').count(),0,'Source digest is not declared editable');
  await draft.locator('input[data-field=amountCents]').fill('12500');
  assert.match(await draft.locator('.correction-differences').innerText(),/12300.*12500/);
  assert.equal(await page.locator('#approve-result').isDisabled(),true,'Old review cannot be approved while corrections are pending');
  await draft.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await draft.locator('input').count(),0);assert.equal(await page.locator('#approve-result').isEnabled(),true);
  await draft.getByRole('button',{name:'更正草稿',exact:true}).click();await draft.locator('input[data-field=amountCents]').fill('12600');
  await page.evaluate(()=>window.resultFixture.version=2);await page.getByRole('button',{name:'刷新结果',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#result-version').textContent==='版本 2');
  assert.equal(await draft.locator('input').count(),0);assert.match(await page.locator('#notice').innerText(),/结果已更新.*未提交的更正未应用/);
  assert.equal(await page.evaluate(()=>window.resultFixture.calls.filter(item=>item.operation==='tasks.input').length),0,'Stale draft is never automatically replayed');
  await page.locator('#result-history').selectOption(JSON.stringify({resultId:'result-1',resultVersion:1}));
  await page.waitForFunction(()=>!document.querySelector('#historical-result-note').hidden);
  assert.equal(await page.getByRole('button',{name:'更正草稿',exact:true}).count(),0,'Historical result is read-only');
  assert.equal(await page.locator('#review-panel').isVisible(),false);
  await page.locator('#result-history').selectOption('');await draft.getByRole('button',{name:'更正草稿',exact:true}).waitFor();
  await draft.getByRole('button',{name:'更正草稿',exact:true}).click();await draft.locator('input[data-field=note]').fill('用户更正说明');await draft.getByRole('button',{name:'提交更正',exact:true}).click();
  await page.waitForFunction(()=>window.resultFixture.calls.some(item=>item.operation==='tasks.input'));
  const correction=await page.evaluate(()=>window.resultFixture.calls.find(item=>item.operation==='tasks.input').payload);
  assert.equal(correction.taskId,'result-task-1');assert.equal(correction.corrections.resultVersion,2);assert.deepEqual(correction.corrections.edits,[{blockId:'draft-orders',rowKey:'order-1',field:'note',before:'原始说明',after:'用户更正说明'}]);
  assert.equal(Object.hasOwn(correction,'confirmed'),false);assert.match(await page.locator('#notice').innerText(),/更正已提交.*重新生成/);
  await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='执行中');assert.equal(await page.getByRole('button',{name:'更正草稿',exact:true}).count(),0,'Running result cannot retain a stale correction entry');

  await page.evaluate(()=>{window.resultFixture.status='waiting_review';window.resultFixture.version=3;});await page.getByRole('button',{name:'刷新结果',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#result-version').textContent==='版本 3');
  assert.match(await page.locator('.issue-resolved').innerText(),/已解决.*历史采集处理中/);assert.match(await page.locator('.result-issues').innerText(),/另一来源仍未取得/);
  const chart=section('按币种分开的部分数据');
  await chart.locator('.result-chart svg').first().waitFor();assert.equal(await chart.locator('.result-chart').count(),2,'Distinct currencies get separate charts');
  assert.match(await chart.innerText(),/8月人民币费用尚未取得/);assert.match(await chart.innerText(),/fen · CNY/);assert.match(await chart.innerText(),/fen · USD/);
  await chart.getByText('查看数据',{exact:true}).click();assert.match(await chart.locator('table').innerText(),/2026-08/);assert.match(await chart.locator('table').innerText(),/—/);
  const chartOptions=await page.evaluate(async()=>{const echarts=await import('/node_modules/echarts/dist/echarts.esm.min.js');return [...document.querySelectorAll('.result-chart')].map(element=>echarts.getInstanceByDom(element)?.getOption()).filter(Boolean).map(option=>({data:option.series[0].data,connectNulls:option.series[0].connectNulls}));});
  assert.deepEqual(chartOptions[0].data,[0,null,12300]);assert.equal(chartOptions[0].connectNulls,false,'Unknown values are not joined into a measured trend');
  assert.equal(await section('来源未登记的图表').locator('.result-chart').count(),0);assert.match(await section('来源未登记的图表').innerText(),/来源尚未登记/);
  assert.equal(await section('缺少全部数据的图表').locator('.result-chart').count(),0);assert.match(await section('缺少全部数据的图表').innerText(),/数据尚未齐全/);

  const previewButton=page.locator('.file-list').first().getByRole('button',{name:'预览',exact:true});
  await previewButton.click();await page.locator('dialog[open] img').waitFor();
  await page.waitForFunction(()=>document.querySelector('dialog img')?.naturalWidth>0);
  assert.match(await page.locator('.preview-metadata').innerText(),new RegExp(image.sha256));
  assert.match(await page.locator('dialog img').getAttribute('src'),/^blob:/);
  await page.getByRole('button',{name:'放大',exact:true}).click();assert.equal(await page.locator('dialog img').evaluate(element=>element.style.width),'125%');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog').open);
  assert.equal(await previewButton.evaluate(element=>document.activeElement===element),true);
  assert.equal(await page.evaluate(()=>window.resultFixture.revokedUrls.includes(window.resultFixture.createdUrls.at(-1))),true);

  await page.evaluate(()=>window.resultFixture.previewMode='hash');await previewButton.click();await page.getByText('原件完整性校验失败，请重新取得原件。',{exact:true}).waitFor();assert.equal(await page.locator('dialog img').count(),0);await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>window.resultFixture.previewMode='unsupported');await previewButton.click();await page.getByText('原件预览信息无效，请刷新任务后重试。',{exact:true}).waitFor();assert.equal(await page.locator('dialog iframe').count(),0);await page.getByRole('button',{name:'关闭',exact:true}).click();
  const urlsBeforeLate=await page.evaluate(()=>window.resultFixture.createdUrls.length);
  await page.evaluate(()=>{window.resultFixture.previewMode='valid';window.resultFixture.delayedPreview=true;});await previewButton.click();await page.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>window.resultFixture.resolvePreview());
  await page.waitForFunction(()=>!document.querySelector('.artifact-dialog').open&&!document.querySelector('.preview-body').childElementCount);
  assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('.preview-image-viewport img').count(),0,'Late response cannot reopen a closed original');assert.equal(await page.evaluate(()=>window.resultFixture.createdUrls.length),urlsBeforeLate,'Closed delayed response must not create a new preview URL');
  await page.evaluate(()=>window.resultFixture.delayedPreview=false);await previewButton.click();await page.locator('dialog img').waitFor();await page.getByRole('button',{name:'下载',exact:true}).last().click();assert.equal((await page.evaluate(()=>window.resultFixture.calls.filter(item=>item.operation==='artifacts.open').at(-1))).payload.id,'artifact-image-1');await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'result-tools-390px.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>sessionStorage.setItem('result-fixture-role','viewer'));await page.reload();await page.locator('#view-business').waitFor({state:'visible'});await page.locator('.main-nav [data-view=home]').click();await page.locator('#recent-tasks [data-task-id="result-task-1"]').click();assert.equal(await page.getByRole('button',{name:'更正草稿',exact:true}).count(),1,'Every authenticated employee may correct declared draft fields despite deprecated role flags');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,scope:'Production Agent workspace DOM and actual ECharts with synthetic host; no formal ledger or external API',draftReadonly:true,staleDraftNotReplayed:true,versionBoundCorrections:true,sourceIntegrityPreview:true,blobRevoked:true,closedLatePreviewIgnored:true,chartMissingNotZero:true,currencyIsolation:true,sourceReferencesRequired:true,resolvedIssueVisible:true}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
