import test from 'node:test';
import assert from 'node:assert/strict';
import {monthlyTaskModel,createTaskCenter,taskFlowStages} from '../public/task-center.js';

const shops=[{id:'pdd',name:'测试拼多多',platform:'拼多多',manual:false},{id:'tb',name:'测试淘宝',platform:'淘宝',manual:false},{id:'offline',name:'线下测试',platform:'线下',manual:true}];
const month='2026-09';
const allFull=shops.flatMap(shop=>['operations','settlement','receipt','expense'].filter(dataset=>!(shop.manual&&dataset==='settlement')).map(dataset=>({shop_id:shop.id,month,dataset,status:'full'})));
const statement=(shop_id,m,patch={})=>({shop_id,months:[{month:m,income:30000,expense:-12000,coverage:{status:'partial',sources:[{id:'fixture'}]},comparison:'no_reference',...patch}]});

test('空账本保留待取得和待核对状态，不凭空完成任务',()=>{
  const model=monthlyTaskModel({month,shops,closeInfo:{month,coverage:[]}});
  assert.equal(model.required,11);assert.equal(model.reviewed,0);assert.equal(model.imported,0);assert.equal(model.next,'import');assert.equal(model.rows[0].imported,false);assert.equal(model.rows[0].statementLabel,'先取得本月原件');
  assert.equal(monthlyTaskModel({month}).next,'import');
});

test('文件范围完整、参考相符和人工覆盖核对保持独立',()=>{
  const model=monthlyTaskModel({month,shops,closeInfo:{month,coverage:[{shop_id:'pdd',month,dataset:'settlement',status:'partial'}]},statements:[statement('pdd',month,{coverage:{status:'full',sources:[]},comparison:'match'}),statement('tb',month)]});
  assert.equal(model.imported,2);assert.equal(model.reviewed,0);assert.equal(model.rows[0].statementLabel,'文件日期覆盖完整');assert.equal(model.rows[0].comparisonLabel,'平台参考相符');assert.equal(model.rows[1].statementLabel,'已导入，完整性待核对');assert.equal(model.next,'reconcile');
});

test('线下不要求平台结算；费用和经营仍需人工确认',()=>{
  const model=monthlyTaskModel({month,shops:[shops[2]],closeInfo:{month,coverage:allFull.filter(row=>row.shop_id==='offline')}});
  assert.equal(model.required,3);assert.equal(model.reviewed,3);assert.equal(model.fundsRequired,1);assert.equal(model.next,'report');assert.equal(model.officialCount,0);
});

test('带缺口锁定不会将前序覆盖和导入自动标成完成',()=>{
  const model=monthlyTaskModel({month,shops,closeInfo:{month,locked:true,coverage:[]},sources:shops.map(shop=>({...shop,datasets:Object.keys({operations:1,receipt:1,settlement:1,expense:1}).map(dataset=>({dataset,status:'full'}))}))});
  assert.equal(model.locked,true);assert.equal(model.gaps,11);assert.equal(model.reviewed,0);assert.equal(model.imported,0);assert.equal(model.next,'delivery');
});

test('锁定后新增店铺不改变旧月份快照的任务范围和缺口',()=>{
  const closeInfo={month,locked:true,coverage:allFull.filter(row=>row.shop_id==='offline'),report:{operations:[{shop_id:'offline'}],reconciliation:[{shop_id:'offline'}]}};
  const model=monthlyTaskModel({month,shops,closeInfo});
  assert.equal(model.required,3);assert.equal(model.reviewed,3);assert.equal(model.gaps,0);assert.equal(model.rows.length,1);
  assert.equal(model.rows[0].id,'offline');
  assert.equal(monthlyTaskModel({month,shops,closeInfo:{...closeInfo,locked:false}}).required,11);
});

test('月份切换隔离账单、生成记录、待归属和覆盖结果',()=>{
  const model=monthlyTaskModel({month,shops,closeInfo:{month,coverage:allFull.map(row=>({...row,month:'2026-08'}))},statements:[statement('pdd','2026-08')],jobs:[{id:'old',period:'2026-08',state:'complete'},{id:'invalid',period:month,state:'complete',report_status:'before_attribution_correction'}],pending:[{id:'old',scope:{start:'2026-08-01 00:00:00',end:'2026-08-31 23:59:59'}},{id:'spanning',scope:{start:'2026-08-31 00:00:00',end:'2026-09-02 23:59:59'}}]});
  assert.equal(model.imported,0);assert.equal(model.latestJob,null);assert.equal(model.reviewed,0);assert.deepEqual(model.pending.map(row=>row.id),['spanning']);
  assert.throws(()=>monthlyTaskModel({month,closeInfo:{month:'2026-08'}}),/月份已变化/);
  assert.throws(()=>monthlyTaskModel({month:'2026-19'}),/有效月份/);
});

test('空但完整覆盖的官方账单仍算已取得，不把缺失零笔当已导入',()=>{
  const model=monthlyTaskModel({month,shops:shops.slice(0,2),statements:[statement('pdd',month,{income:0,expense:0,count:0,coverage:{status:'full',sources:[]}}),statement('tb',month,{income:null,expense:null,count:0,coverage:{status:'missing',sources:[]}})]});
  assert.equal(model.imported,1);assert.equal(model.rows[1].imported,false);
});

test('任务页一次只默认展开建议步骤，保留店铺和月份跳转',async()=>{
  const content={innerHTML:''};
  const api=async url=>url.startsWith('/api/close')?{month,coverage:[]}:url.startsWith('/api/sources')?[]:url.includes('/statement?')?{shop_id:'pdd',months:[]}:[];
  const ui=createTaskCenter({$:()=>content,esc:value=>String(value??''),money:value=>value==null?'—':String(value/100),api,boot:{shops},state:{period:month,shop:'pdd'}});
  await ui.render();
  assert.equal((content.innerHTML.match(/data-task-step=/g)||[]).length,5);assert.equal((content.innerHTML.match(/ open>/g)||[]).length,1);assert.match(content.innerHTML,/data-task-step="import" open/);assert.match(content.innerHTML,/reconciliation\?month=2026-09&shop_id=pdd/);assert.match(content.innerHTML,/data-task-import="pdd"/);assert.match(content.innerHTML,/草稿 · 待确认/);assert.match(content.innerHTML,/不会自动标记为已交付/);
  assert.doesNotMatch(content.innerHTML,/shop-create|data-task-stage="shops"|登记店铺|新增店铺|店铺准备/);
});

test('任务首屏从导入开始保留五阶段流程，只展示当前面板，主按钮直达缺账单店铺',async()=>{
  const nodes=new Map(),node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',value:''});return nodes.get(key);};
  const api=async url=>url.startsWith('/api/close')?{month,coverage:[]}:url.includes('/statement?')?{shop_id:'pdd',months:[]}:[];
  const ui=createTaskCenter({$:node,esc:value=>String(value??''),money:String,api,boot:{shops},state:{period:month,shop:'all'}});
  await ui.render();const html=node('#content').innerHTML;
  assert.equal((html.match(/data-task-step=/g)||[]).length,5);
  assert.equal((html.match(/ open>/g)||[]).length,1);
  assert.equal((html.match(/data-task-stage=/g)||[]).length,5);
  assert.match(html,/class="button primary task-primary-action" data-task-import="pdd"/);
  assert.match(html,/data-current-task="import" data-view-task="import"/);
  assert.match(html,/<strong>测试拼多多<\/strong>/);
  assert.match(html,/选择账单，开始导入/);
});

test('流程只按可靠依据标记状态，不因步骤靠前或历史草稿而画成已核对',()=>{
  const model=monthlyTaskModel({month,shops,closeInfo:{month,coverage:[],locked:true},statements:[statement('pdd',month)],jobs:[{id:'draft',period:month,state:'complete'}]});
  const stages=taskFlowStages(model);
  assert.equal(stages.some(stage=>stage.key==='shops'),false);
  assert.deepEqual(stages.map(stage=>stage.number),[1,2,3,4,5]);
  assert.equal(stages.find(stage=>stage.key==='import').kind,'');
  assert.equal(stages.find(stage=>stage.key==='reconcile').kind,'');
  assert.equal(stages.find(stage=>stage.key==='report').kind,'ready');
  assert.equal(stages.find(stage=>stage.key==='delivery').evidence,'本月已锁定');
  assert.equal(model.gaps,11);
});

test('空店铺legacy任务只提示配置，不再生成登记任务或创建按钮',async()=>{
  const content={innerHTML:''};
  const ui=createTaskCenter({$:()=>content,esc:value=>String(value??''),money:String,api:async url=>url.startsWith('/api/close')?{month,coverage:[]}:[],boot:{shops:[]},state:{period:month,shop:'all'}});
  await ui.render();
  assert.match(content.innerHTML,/data-current-task="import" data-view-task="import"/);assert.match(content.innerHTML,/等待管理员配置店铺/);
  assert.doesNotMatch(content.innerHTML,/shop-create|data-task-stage="shops"|登记店铺|新增店铺/);
});

test('任务页用路由切换月份与店铺，非法月份不改变任务状态',async t=>{
  const nodes={'#content':{innerHTML:''},'#task-month':{value:month},'#task-shop':{value:'offline'}};
  const state={period:month,shop:'all'},messages=[];
  const previousLocation=globalThis.location;globalThis.location={hash:''};
  t.after(()=>{if(previousLocation===undefined)delete globalThis.location;else globalThis.location=previousLocation;});
  const ui=createTaskCenter({$:selector=>nodes[selector],esc:value=>String(value??''),money:value=>String(value),api:async url=>url.startsWith('/api/close')?{month,coverage:[]}:url.includes('/statement?')?{shop_id:'pdd',months:[]}:[],boot:{shops},state,toast:message=>messages.push(message)});
  await ui.render();
  assert.match(nodes['#content'].innerHTML,/id="task-month"/);assert.match(nodes['#content'].innerHTML,/id="task-shop"/);
  nodes['#task-month'].value='2026-08';nodes['#task-month'].onchange();
  assert.equal(globalThis.location.hash,'#tasks?month=2026-08&shop_id=offline');assert.deepEqual(state,{period:month,shop:'all'});
  nodes['#task-shop'].value='tb';nodes['#task-shop'].onchange();assert.equal(globalThis.location.hash,'#tasks?month=2026-08&shop_id=tb');
  nodes['#task-month'].value='2026-13';nodes['#task-month'].onchange();
  assert.equal(globalThis.location.hash,'#tasks?month=2026-08&shop_id=tb');assert.equal(nodes['#task-month'].value,month);assert.equal(messages.length,1);
});
