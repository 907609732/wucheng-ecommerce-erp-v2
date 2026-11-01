import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedSalesRole,canOpenSalesView,personnelCoverageDatasets,salesIdentityFromURL,personnelChoiceMarkup} from '../public/personnel.js';
import {monthlyTaskModel,taskFlowStages,personnelTaskFlow,createTaskCenter} from '../public/task-center.js';

const month='2026-09',shops=[{id:'pdd',name:'隔离拼多多',platform:'拼多多',manual:false},{id:'offline',name:'隔离线下',platform:'线下',manual:true}];
const employee={selected:true,role:'employee'},boss={selected:true,role:'boss'};
const emptyModel=monthlyTaskModel({month,shops,closeInfo:{month,coverage:[]}});
const baseSummary={month,closeInfo:{month,locked:false,coverage:[],freight:{count:0}},sources:[],pending:[],jobs:[],statements:[],submission:{state:'draft'},staffRevision:'fixture-revision',employeeReady:false};

function fixture(role,patch={},taskShops=shops){
  const content={innerHTML:''},monthNode={value:month},shopNode={value:'all'},heroHost={innerHTML:''},detailTitle={textContent:''},buttons=new Map(),requests=[],messages=[];
  let rendered=0;
  const $=selector=>selector==='#content'?content:selector==='#task-month'?monthNode:selector==='#task-shop'?shopNode:selector==='#task-hero-host'?heroHost:selector==='#task-detail-title'?detailTitle:content.innerHTML.includes('id="'+selector.slice(1)+'"')?(buttons.has(selector)?buttons.get(selector):buttons.set(selector,{disabled:false,isConnected:true}).get(selector)):null;
  const summary={...baseSummary,...patch,personnel:{selected:true,role}};
  const api=async(url,body)=>{requests.push({url,body});if(url.startsWith('/api/task-center?'))return summary;if(url==='/api/personnel/handoff')return {submission:{state:'submitted'}};throw Error('Unexpected API '+url);};
  const ui=createTaskCenter({$,esc:value=>String(value??''),money:value=>'MONEY:'+value,api,boot:{shops:taskShops,personnel:{selected:true,role}},state:{period:month,shop:'all'},toast:message=>messages.push(message),render:async()=>{rendered++;}});
  return {ui,content,heroHost,detailTitle,requests,messages,buttons,get rendered(){return rendered;}};
}

test('身份选择直接进入工作，不包含登录或密码字段',()=>{
  const html=personnelChoiceMarkup();assert.match(html,/data-personnel-role="employee"/);assert.match(html,/data-personnel-role="boss"/);assert.doesNotMatch(html,/<input|<form|type="password"/);
  assert.doesNotMatch(html,/店铺准备|准备店铺|登记店铺/);
  assert.equal(selectedSalesRole({role:'boss',selected:false}),null);assert.equal(selectedSalesRole(employee),'employee');
  assert.equal(salesIdentityFromURL('http://127.0.0.1/?identity=employee#tasks'),'employee');assert.equal(salesIdentityFromURL('http://127.0.0.1/?identity=admin'),null);
});

test('员工直接访问老板页面时不能通过前端路由守卫',()=>{
  for(const view of ['operations','reconciliation','pdd-details','tb-details','close','settings'])assert.equal(canOpenSalesView(employee,view),false,view);
  for(const view of ['tasks','freight','manual','sources','imports'])assert.equal(canOpenSalesView(employee,view),true,view);
  for(const view of ['reconciliation','close','settings'])assert.equal(canOpenSalesView(boss,view),true);
  assert.equal(canOpenSalesView({role:null,selected:false},'tasks'),false);
  assert.deepEqual(personnelCoverageDatasets(employee,{operations:'运营',settlement:'结算',receipt:'收款',expense:'费用'}).map(([key])=>key),['operations','expense']);
});

test('员工从导入账单开始两步，老板资金、月报和交付三步保持不变',()=>{
  assert.deepEqual(taskFlowStages(emptyModel,{role:'employee'}).map(step=>step.key),['import','records']);
  assert.deepEqual(taskFlowStages(emptyModel,{role:'employee'}).map(step=>step.number),[1,2]);
  assert.equal(taskFlowStages(emptyModel,{role:'employee'}).find(step=>step.key==='records').title,'补齐经营和费用资料');
  assert.equal(taskFlowStages(emptyModel).find(step=>step.key==='records').title,'补齐经营、收款和费用');
  assert.deepEqual(taskFlowStages(emptyModel,{role:'boss'}).map(step=>step.key),['reconcile','report','delivery']);
  assert.equal(taskFlowStages(emptyModel).length,5);
  assert.equal(personnelTaskFlow(emptyModel,{role:'employee',employeeReady:true}).next,'handoff');
  assert.equal(personnelTaskFlow(emptyModel,{role:'employee',employeeReady:true,submission:{state:'submitted'}}).next,'submitted');
  assert.equal(personnelTaskFlow(emptyModel,{role:'boss',submission:{state:'submitted'}}).next,'reconcile');
  assert.equal(personnelTaskFlow(monthlyTaskModel({month}),{role:'employee',employeeReady:true}).next,'import');
});

test('员工任务只读取角色化摘要，不读取资金、月报或金额',async()=>{
  const f=fixture('employee');await f.ui.render();const html=f.content.innerHTML;
  assert.deepEqual(f.requests.map(request=>request.url),['/api/task-center?month='+month]);
  assert.equal((html.match(/data-task-step=/g)||[]).length,2);assert.match(html,/data-task-step="import"/);assert.match(html,/data-task-step="records"/);assert.doesNotMatch(html,/data-task-step="shops"|data-task-stage="shops"|shop-create|登记店铺|新增店铺|店铺准备/);
  assert.doesNotMatch(html,/href="#reconciliation|href="#close|href="\/api\/export|\/api\/jobs|data-action="job"|data-task-step="reconcile"|MONEY:/);
  assert.match(html,/class="task-workspace"/);assert.match(html,/class="task-flow"/);assert.match(html,/class="task-hero-main"/);assert.match(html,/class="task-hero-copy"/);assert.match(html,/class="task-target"/);assert.match(html,/class="task-micro-steps"/);
  assert.equal((html.match(/data-task-stage=/g)||[]).length,2);assert.equal((html.match(/data-task-step="[^"]+" open/g)||[]).length,1);assert.equal((html.match(/data-task-step="[^"]+" hidden/g)||[]).length,1);assert.match(html,/共 2 步/);
  assert.match(html,/class="button primary task-primary-action" data-task-import="pdd"/);assert.doesNotMatch(html,/task-next-symbol/);
  assert.match(html,/补齐经营和费用资料/);assert.doesNotMatch(html,/补齐经营、收款和费用/);
});

test('员工提交使用服务端资料版本，成功后重新读取任务',async()=>{
  const f=fixture('employee',{employeeReady:true,submission:{state:'changed'}});await f.ui.render();assert.match(f.content.innerHTML,/资料有变动/);assert.match(f.content.innerHTML,/重新提交给老板/);
  const button=f.buttons.get('#task-handoff');assert.ok(button);await button.onclick({currentTarget:button});
  assert.match(f.content.innerHTML,/class="button primary task-primary-action" id="task-handoff"/);
  assert.deepEqual(f.requests.at(-1),{url:'/api/personnel/handoff',body:{month,revision:'fixture-revision'}});assert.equal(f.rendered,1);assert.match(f.messages[0],/已提交/);
});

test('已提交员工页只等待老板，不显示老板后续操作',async()=>{
  const f=fixture('employee',{employeeReady:true,submission:{state:'submitted',submittedAt:'2026-10-01T12:00:00Z'}});await f.ui.render();
  assert.match(f.content.innerHTML,/资料已提交，等待老板处理/);assert.doesNotMatch(f.content.innerHTML,/id="task-handoff"|data-action="job"|href="#reconciliation|href="#close/);
  assert.match(f.content.innerHTML,/class="task-workspace"/);assert.match(f.content.innerHTML,/task-next is-waiting/);assert.equal((f.content.innerHTML.match(/data-task-stage=/g)||[]).length,2);assert.doesNotMatch(f.content.innerHTML,/task-primary-action/);
});

test('锁定月份员工不再出现提交按钮，也不误称资料已提交',async()=>{
  const f=fixture('employee',{employeeReady:true,closeInfo:{month,locked:true,coverage:[]},submission:{state:'draft'}});await f.ui.render();
  assert.match(f.content.innerHTML,/本月已锁定，资料准备已结束/);assert.doesNotMatch(f.content.innerHTML,/id="task-handoff"|id="task-handoff-bottom"|资料已提交，等待老板处理/);
});

test('老板任务显示员工交接状态，交接不等于资金核对已完成',async()=>{
  const f=fixture('boss',{submission:{state:'submitted',submittedAt:'2026-10-01T12:00:00Z'}});await f.ui.render();const html=f.content.innerHTML;
  assert.equal((html.match(/data-task-step=/g)||[]).length,3);assert.match(html,/员工已提交/);assert.match(html,/data-task-step="reconcile" open/);assert.match(html,/data-task-step="report"/);assert.match(html,/data-task-step="delivery"/);
  assert.doesNotMatch(html,/data-task-step="shops"|data-task-step="import"|data-task-step="records"|data-task-import=/);
  assert.match(html,/class="task-workspace"/);assert.match(html,/class="task-hero-main"/);assert.equal((html.match(/data-task-stage=/g)||[]).length,3);assert.match(html,/class="button primary task-primary-action" href="#reconciliation/);
});

test('真实员工流程可切换右侧步骤并返回当前任务',async()=>{
  const f=fixture('employee');await f.ui.render();
  f.content.onclick({target:{closest:()=>({dataset:{taskStage:'records'},hasAttribute:()=>false})}});
  assert.match(f.heroHost.innerHTML,/data-current-task="import" data-view-task="records"/);assert.match(f.heroHost.innerHTML,/data-task-resume/);assert.match(f.heroHost.innerHTML,/查看缺口，开始补齐/);
  f.content.onclick({target:{closest:()=>({dataset:{},hasAttribute:attribute=>attribute==='data-task-resume'})}});
  assert.match(f.heroHost.innerHTML,/data-current-task="import" data-view-task="import"/);assert.match(f.heroHost.innerHTML,/data-task-import="pdd"/);
});

test('空店铺员工任务仍从导入开始，只提示管理员配置且没有创建入口',async()=>{
  const f=fixture('employee',{},[]);await f.ui.render();const html=f.content.innerHTML;
  assert.match(html,/data-current-task="import" data-view-task="import"/);assert.match(html,/联系管理员在设置中维护店铺/);assert.match(html,/等待管理员配置店铺/);
  assert.equal((html.match(/data-task-stage=/g)||[]).length,2);assert.doesNotMatch(html,/shop-create|data-task-stage="shops"|登记店铺|新增店铺|task-primary-action/);
});
