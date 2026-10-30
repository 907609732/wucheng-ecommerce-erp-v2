import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Real persistent task/review/scheduler runtime, synthetic business ledger and
// deterministic engine. Live model and domain acceptance remain separate gates.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=process.env.AGENT_RUNTIME_ROOT || root;
const {createAgentRuntime}=await import(pathToFileURL(path.join(runtimeRoot,'desktop/agent-runtime/index.mjs')));
const {signAgentApproval,verifyAgentApproval}=await import(pathToFileURL(path.join(runtimeRoot,'desktop/agent-runtime/approval.mjs')));
const require=createRequire(path.join(process.env.AGENT_UI_DEPENDENCY_ROOT || root,'package.json'));
const {chromium}=require('playwright');
const storeDir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-ui-runtime-'));
const actor={id:'ui-test-admin',login:'ui-test@example.test',label:'合成测试审核员',enabled:true,role:'admin',modules:['sales'],canRunTasks:true,channel:'ui'};
const assignee={...actor,id:'ui-test-assignee',login:'assignee@example.test',label:'合成接收员工',role:'editor'};
const viewer={...actor,id:'ui-test-viewer',login:'viewer@example.test',label:'合成只读员工',role:'viewer',canRunTasks:false};
const people=new Map([actor,assignee,viewer].map(person=>[person.id,person]));
let currentActor=actor;
const meta={actor,trustedUi:true};
let revision=1,commits=0,loseReceipt=false,wrongReceipt=false,assignmentTarget=null;
const attachmentReads=[];
const receipts=new Map(),key=randomBytes(32).toString('hex'),secrets=new Map([['company-api-key','synthetic-only-not-a-valid-api-key']]);
const secretStore={has:name=>secrets.has(name),get:async name=>secrets.get(name),set:async(name,value)=>secrets.set(name,value),delete:async name=>secrets.delete(name)};
const adapter={id:'sales',capabilities:[{id:'synthetic-import',kind:'prepare',title:'合成账单导入',inputSchema:{type:'object',properties:{amount:{type:'integer'},attachmentId:{type:'string'}},required:['amount'],additionalProperties:false}},{id:'synthetic-query',kind:'query',title:'合成只读查询',inputSchema:{type:'object',properties:{},additionalProperties:false}}],binding:async()=>({dataSetId:'synthetic-ledger',revision}),query:async()=>({summary:'已读取合成账本',blocks:[{type:'text',text:'只读查询结果：140000 分'}]}),prepare:async(_id,input,ctx)=>{
  if(input.attachmentId){const source=ctx.resolveAttachment(input.attachmentId);attachmentReads.push({taskId:ctx.taskId,actorId:ctx.actor.id,content:fs.readFileSync(source.path,'utf8')});}
  const file=path.join(storeDir,'tasks',ctx.taskId,'synthetic-result.csv');fs.writeFileSync(file,'amount\n'+input.amount);const artifact=ctx.registerArtifact({path:file,name:'synthetic-result.csv',mimeType:'text/csv'});
  return {summary:'合成账本已准备，等待人员确认',blocks:[{type:'table',title:'待提交金额',columns:[{key:'amount',label:'金额（分）',type:'money'}],rows:[{amount:input.amount}]},{type:'files',files:[{artifactId:artifact.id,name:artifact.name}]}],changes:[{label:'合成费用',before:'未入账',after:input.amount+' 分'}],evidence:[{title:'合成账单来源',artifactId:artifact.id}],commitData:{amount:input.amount}};
},commit:async(step,ctx)=>{
  const claims=JSON.parse(Buffer.from(ctx.approval.payload,'base64url').toString());
  verifyAgentApproval(ctx.approval,key,{actorId:ctx.actor.id,module:'sales',capabilityId:step.capabilityId,taskId:ctx.taskId,resultId:claims.resultId,resultVersion:claims.resultVersion,dataSetId:'synthetic-ledger',revision,changeDigest:step.changeDigest,idempotencyKey:ctx.idempotencyKey});
  if(receipts.has(ctx.idempotencyKey))return{receipt:receipts.get(ctx.idempotencyKey)};
  commits++;revision++;const receipt={id:'synthetic-receipt-'+commits,idempotencyKey:ctx.idempotencyKey,state:'completed',amount:step.commitData.amount};receipts.set(ctx.idempotencyKey,receipt);
  if(loseReceipt)throw new Error('synthetic lost submission response');return{receipt};
},receipt:async id=>receipts.has(id)?{state:'completed',idempotencyKey:wrongReceipt?'wrong-business-key':id,receipt:receipts.get(id)}:{state:'unknown',idempotencyKey:id}};
const engine={supportedModels:['synthetic-model','synthetic-alternative'],check:async()=>({available:true,version:'synthetic-adapter',supportedModels:['synthetic-model','synthetic-alternative']}),run:async({invoke,task})=>{
  if(task.goal.startsWith('仅查询'))await invoke('erp_query',{module:'sales',capabilityId:'synthetic-query',input:{}});
  else if(task.goal.startsWith('请分派'))await invoke('erp_prepare',{module:'system',capabilityId:'tasks.assign',input:{taskId:assignmentTarget,assigneeId:assignee.id}});
  else if(task.goal.startsWith('等待分派')&&!task.assigneeId)await invoke('erp_ask',{question:'此任务正在等待指定接收员工'});
  else await invoke('erp_prepare',{module:'sales',capabilityId:'synthetic-import',input:{amount:140000,...(task.attachments[0]?{attachmentId:task.attachments[0].id}:{})}});
  return{text:'合成工具调用完成',usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
}};
let openedArtifact=null;
const config={storeDir,resolveActor:async id=>people.get(id),adapters:[adapter],engines:{codex:engine,hermes:engine},secretStore,signApproval:async claims=>signAgentApproval(claims,key),environment:{mode:'test',label:'测试账本'},extensions:{'artifacts.open':async artifact=>{openedArtifact=artifact;return{saved:true,message:'测试产物已验证：'+artifact.name};},'connection.get':async()=>({connection:{mode:'standalone',canConfigure:false,detail:'合成主机连接'}})}};
let runtime=createAgentRuntime(config);
await runtime.request('settings.save',{company:{model:'synthetic-model'}},meta);
const mime={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.png':'image/png'};
const server=http.createServer((req,res)=>{const target=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[path.extname(target)] || 'application/octet-stream');res.end(fs.readFileSync(target));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const hostCalls=[];
  await page.exposeFunction('__erpHostRequest',async({operation,payload})=>{hostCalls.push({operation,payload});try{return await runtime.request(operation,payload,{actor:currentActor,trustedUi:true});}catch(error){return{ok:false,error:error.message,code:error.code};}});
  await page.addInitScript(()=>{window.launcher={agentRequest:request=>window.__erpHostRequest(request),ready:async()=>({ready:true})};});
  await page.goto('http://127.0.0.1:'+server.address().port+'/desktop/launcher/agent-index.html');
  await page.waitForFunction(()=>!document.querySelector('#submit-goal').disabled);
  await page.locator('#goal-files').setInputFiles({name:'input.csv',mimeType:'text/csv',buffer:Buffer.from('amount\n140000')});await page.locator('#goal-attachments li').waitFor();
  await page.locator('#goal').fill('准备合成运费导入，先复核再入账');await page.locator('#submit-goal').click();
  await page.locator('#review-panel').waitFor({state:'visible'});assert.equal(commits,0);assert.match(await page.locator('#result-content').textContent(),/140000/);
  const taskId=runtime.store.list('task')[0].id;
  assert.equal(attachmentReads[0].content,'amount\n140000');
  const historical=await page.locator('#result-history option').nth(1).getAttribute('value');
  await page.locator('#result-history').selectOption(historical);await page.locator('#historical-result-note').waitFor({state:'visible'});
  assert.equal(await page.locator('#review-panel').isHidden(),true,'Historical result cannot be approved');
  await page.getByRole('button',{name:'刷新结果',exact:true}).click();assert.equal(await page.locator('#result-history').inputValue(),historical,'Polling preserves the selected result version');
  await page.locator('#result-history').selectOption('');await page.locator('#review-panel').waitFor({state:'visible'});
  await page.locator('#review-check').check();await page.locator('#approve-result').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已完成');
  assert.equal(commits,1);assert.equal(runtime.store.get('task',taskId).status,'completed');assert.match(await page.locator('.receipt').textContent(),/提交结果已核对/);
  await page.locator('.file-list').first().getByRole('button',{name:'下载',exact:true}).click();assert.equal(openedArtifact.taskId,taskId);assert.equal(fs.readFileSync(openedArtifact.path,'utf8'),'amount\n140000');
  await page.locator('.main-nav [data-view=settings]').click();await page.waitForFunction(()=>document.querySelector('#company-model').value==='synthetic-model');
  assert.deepEqual(await page.locator('#company-model option').evaluateAll(options=>options.map(option=>option.value)),['','synthetic-model','synthetic-alternative']);
  await page.locator('#new-schedule').click();await page.locator('#schedule-goal').fill('每个工作日准备合成账单');await page.locator('#schedule-frequency').selectOption('weekdays');await page.locator('#schedule-time').fill('09:30');await page.locator('#save-schedule').click();await page.locator('.schedule-row').waitFor();
  const schedule=runtime.store.list('schedule')[0];assert.equal(schedule.cron,'30 9 * * 1-5');assert.equal(schedule.timezone,'Asia/Shanghai');
  await page.locator('.schedule-row').getByRole('button',{name:'暂停',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.schedule-row').textContent.includes('已暂停'));assert.equal(runtime.store.get('schedule',schedule.id).enabled,false);
  await runtime.request('schedules.update',{id:schedule.id,version:runtime.store.get('schedule',schedule.id).version,timezone:'Asia/Tokyo'},meta);await page.locator('#refresh-settings').click();await page.waitForFunction(()=>document.querySelector('.schedule-row').textContent.includes('Asia/Tokyo'));
  await page.locator('.schedule-row').getByRole('button',{name:'修改',exact:true}).click();assert.equal(await page.locator('#schedule-frequency').inputValue(),'weekdays');assert.equal(await page.locator('#schedule-timezone').inputValue(),'Asia/Tokyo');await page.locator('#schedule-goal').fill('修改后仍暂停的合成计划');await page.locator('#save-schedule').click();await page.waitForFunction(()=>document.querySelector('.schedule-row').textContent.includes('修改后仍暂停'));assert.equal(runtime.store.get('schedule',schedule.id).enabled,false,'Editing a paused schedule must not resume it');assert.equal(runtime.store.get('schedule',schedule.id).timezone,'Asia/Tokyo');
  await runtime.close();runtime=createAgentRuntime(config);await page.reload();await page.waitForFunction(()=>document.querySelector('#recent-tasks').textContent.includes('准备合成运费导入'));
  await page.locator('#recent-tasks .task-row').first().click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已完成');assert.match(await page.locator('.receipt').textContent(),/提交结果已核对/);
  loseReceipt=true;await page.locator('.main-nav [data-view=home]').click();await page.locator('#goal').fill('测试提交响应丢失后的回执核对');await page.locator('#submit-goal').click();await page.locator('#review-panel').waitFor({state:'visible'});await page.locator('#review-check').check();await page.locator('#approve-result').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='核对提交状态');assert.equal(commits,2);
  await runtime.close();runtime=createAgentRuntime(config);await page.getByRole('button',{name:'核对提交回执',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已完成');assert.equal(commits,2,'Readback after restart must not duplicate the business write');
  loseReceipt=false;wrongReceipt=true;
  await page.locator('.main-nav [data-view=home]').click();await page.locator('#goal').fill('测试不匹配的业务回执不能被认作完成');await page.locator('#submit-goal').click();await page.locator('#review-panel').waitFor({state:'visible'});await page.locator('#review-check').check();await page.locator('#approve-result').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='核对提交状态');assert.equal(commits,3);
  const unknownTask=runtime.store.list('task').find(task=>task.goal.startsWith('测试不匹配'));
  const inputCalls=hostCalls.filter(call=>call.operation==='tasks.input').length;
  await page.locator('#task-input').fill('不能在回执未知时重新生成');await page.locator('#task-input').press('Control+Enter');assert.equal(hostCalls.filter(call=>call.operation==='tasks.input').length,inputCalls,'Keyboard cannot bypass unknown-outcome guard');assert.equal(await page.locator('#task-input').inputValue(),'不能在回执未知时重新生成');
  await page.getByRole('button',{name:'核对提交回执',exact:true}).click();assert.equal(runtime.store.get('task',unknownTask.id).status,'unknown');assert.equal(commits,3);
  wrongReceipt=false;await page.getByRole('button',{name:'核对提交回执',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已完成');assert.equal(commits,3,'Correct receipt readback reconciles without another write');

  await page.locator('.main-nav [data-view=home]').click();await page.locator('#goal').fill('测试复核过程中账本版本发生变化');await page.locator('#submit-goal').click();await page.locator('#review-panel').waitFor({state:'visible'});revision++;
  await page.locator('#review-check').check();await page.locator('#approve-result').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='需要补充');assert.equal(commits,3);assert.equal(await page.locator('#review-panel').isHidden(),true);assert.match(await page.locator('#error-message').innerText(),/账本已变化/);
  await page.locator('#task-input').fill('按照最新数据重新准备');await page.locator('#submit-input').click();await page.locator('#review-panel').waitFor({state:'visible'});assert.equal(await page.locator('#review-check').isChecked(),false);
  const historyValues=await page.locator('#result-history option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean));assert.equal(historyValues.length,2);assert.notEqual(JSON.parse(historyValues[0]).resultId,JSON.parse(historyValues[1]).resultId,'Result identity distinguishes repeated version 1 after supplementary instructions');
  await page.locator('#result-history').selectOption(historyValues[1]);await page.locator('#historical-result-note').waitFor({state:'visible'});assert.equal(await page.locator('#review-panel').isHidden(),true);await page.locator('#result-history').selectOption('');await page.locator('#review-panel').waitFor({state:'visible'});
  await page.locator('#reject-result').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='需要补充');

  await page.locator('.main-nav [data-view=home]').click();await page.locator('#goal-files').setInputFiles({name:'delegated.csv',mimeType:'text/csv',buffer:Buffer.from('owner attachment for assigned task')});await page.locator('#goal-attachments li').waitFor();await page.locator('#goal').fill('等待分派：核对合成资料');await page.locator('#submit-goal').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='需要补充');
  assignmentTarget=runtime.store.list('task').find(task=>task.goal.startsWith('等待分派')).id;
  await page.locator('.main-nav [data-view=home]').click();await page.locator('#goal').fill('请分派任务 '+assignmentTarget+' 给合成接收员工');await page.locator('#submit-goal').click();await page.locator('#review-panel').waitFor({state:'visible'});assert.match(await page.locator('#result-content').innerText(),/任务负责人/);assert.match(await page.locator('#result-content').innerText(),/ui-test-assignee/);
  await page.locator('#review-check').check();await page.locator('#approve-result').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已完成');assert.equal(runtime.store.get('task',assignmentTarget).assigneeId,assignee.id);assert.equal(runtime.store.get('task',assignmentTarget).status,'paused');
  currentActor=assignee;await page.reload();await page.waitForFunction(()=>document.querySelector('#actor').textContent==='合成接收员工');await page.locator('#recent-tasks [data-task-id="'+assignmentTarget+'"]').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已暂停');assert.match(await page.locator('#task-scope').innerText(),/当前负责人/);
  await page.getByRole('button',{name:'继续处理',exact:true}).click();await page.locator('#review-panel').waitFor({state:'visible'});assert.equal(attachmentReads.at(-1).actorId,assignee.id);assert.equal(attachmentReads.at(-1).content,'owner attachment for assigned task');

  currentActor=viewer;await page.reload();await page.waitForFunction(()=>document.querySelector('#actor').textContent==='合成只读员工');assert.equal(await page.locator('#submit-goal').isEnabled(),true);assert.equal(await page.locator('#recent-tasks .task-row').count(),0,'Viewer cannot read another employee task');
  await page.locator('#goal').fill('仅查询当前合成账本');await page.locator('#submit-goal').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已完成');assert.match(await page.locator('#result-content').innerText(),/只读查询结果/);assert.equal(await page.locator('#review-panel').isHidden(),true);
  await page.locator('.main-nav [data-view=home]').click();await page.locator('#goal').fill('尝试导入合成账单');await page.locator('#submit-goal').click();await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='已暂停');assert.equal(commits,3);assert.match(await page.locator('#task-attention').innerText(),/不能调用此能力/);
  await page.locator('.main-nav [data-view=settings]').click();await page.waitForFunction(()=>document.querySelector('#company-model').value==='synthetic-model');assert.equal(await page.locator('#save-model').isDisabled(),true);assert.equal(await page.locator('#new-schedule').isDisabled(),true);
  currentActor=actor;await page.reload();await page.waitForFunction(()=>document.querySelector('#actor').textContent==='合成测试审核员');await page.locator('.main-nav [data-view=settings]').click();await page.waitForFunction(()=>document.querySelector('.schedule-row'));
  page.once('dialog',dialog=>dialog.accept());await page.locator('.schedule-row').getByRole('button',{name:'删除',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.schedule-row'));assert.equal(runtime.store.get('schedule',schedule.id),null);assert.ok(hostCalls.filter(call=>call.operation==='schedules.delete').at(-1).payload.version);
  assert.deepEqual(errors,[]);
  const out=path.join(root,'.codex-artifacts','agent-workspace-ui');fs.mkdirSync(out,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(out,'runtime-contract-settings.png'),fullPage:true});
  console.log(JSON.stringify({ok:true,scope:'Real SQLite task/review/scheduler runtime with synthetic business adapter and deterministic engine; no external model or formal ledger access',receiptVerified:true,persistedAcrossRestart:true,unknownReadbackNoDuplicate:true,mismatchedReceiptRejected:true,unknownKeyboardGuard:true,registeredArtifact:true,attachmentOwnershipTransfer:true,assignmentReview:true,viewerQuery:true,viewerWriteRejected:true,historicalReadOnly:true,reviewDataChangeRefresh:true,engineCatalog:true,cronParser:true,pausedSchedulePreserved:true,existingTimezonePreserved:true,scheduleVersionDelete:true}));
}finally{
  await browser.close();await runtime.close();await new Promise(resolve=>server.close(resolve));
  const resolved=path.resolve(storeDir),allowed=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(allowed)||!path.basename(resolved).startsWith('erp-ui-runtime-'))throw new Error('Unsafe test cleanup path');fs.rmSync(resolved,{recursive:true,force:true});
}
