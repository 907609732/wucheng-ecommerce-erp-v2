import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
import {createSessionFetch} from './helpers.mjs';
import {signWorkbenchActor} from '../lib/workbench-actor.mjs';
import {addLedger,setCoverage,createMatch} from '../lib/ledger.mjs';
import {closePreview,lockMonth} from '../lib/close.mjs';

async function fixture(t,port){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-personnel-')),{app,store}=createApp({dataDir:dir,port,demo:true});
 const server=app.listen(port,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'sales-personnel-'));fs.rmSync(resolved,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`,bootstrap=await(await fetch(base+'/api/bootstrap')).json();
 const json=body=>({method:'POST',headers:{'Content-Type':'application/json','x-sales-token':bootstrap.token},body:JSON.stringify(body)});
 return {base,store,dir,json,token:bootstrap.token};
}
const body=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};

test('personnel cookies isolate concurrent roles; no identity or forged role cannot open boss APIs',async t=>{
 const f=await fixture(t,18874);
 const boot=await body(await fetch(f.base+'/api/bootstrap'));
 assert.equal(boot.personnel.selected,false);assert.equal(boot.personnel.role,null);assert.deepEqual(boot.shops,[]);assert.deepEqual(boot.notices,[]);
 const metadata=await body(await fetch(f.base+'/api/personnel/session'));assert.equal(metadata.required,true);assert.equal(metadata.protocolVersion,1);
 assert.equal((await fetch(f.base+'/api/ledger?month=2025-09')).status,403);
 const employee=await createSessionFetch(f.base,'employee'),boss=await createSessionFetch(f.base,'boss');
 for(const route of ['/api/report?period=2025-09','/API/REPORT/?period=2025-09','/API/REPORT-HISTORY/','/api/reconciliation?month=2025-09','/api/close/history/','/api/jobs','/api/export?period=2025-09','/api/pdd/statement?year=2025','/api/taobao/movements?shop_id=x','/api/integration/v1/report?period=2025-09','/api/integration/v1/ledger?month=2025-09','/api/integration/v1/review-session']){
  const response=await employee(f.base+route,{headers:{'x-role':'boss','x-sales-role':'boss'}});
  assert.equal(response.status,403,route);assert.equal((await response.json()).code,'BOSS_REQUIRED');
 }
 assert.equal((await employee(f.base+'/api/report?period=2025-09',{method:'HEAD'})).status,403);
 for(const route of ['/api/close/lock/','/API/CLOSE/UNLOCK/','/api/jobs','/api/matches','/api/integration/v1/edits/missing/commit'])assert.equal((await employee(f.base+route,f.json({month:'2025-09'}))).status,403,route);
 assert.equal((await employee(f.base+'/api/coverage',f.json({shop_id:'offline',month:'2025-09',dataset:'receipt',status:'full',evidence:'员工不能审批资金'}))).status,403);
 assert.equal((await employee(f.base+'/api/coverage',f.json({shop_id:'offline',month:'2025-09',dataset:'operations',status:'full',evidence:'整月真实零业务已核对'}))).status,200);
 assert.equal((await boss(f.base+'/api/report?period=2025-09')).status,200);
 assert.equal((await boss(f.base+'/api/coverage',f.json({shop_id:'offline',month:'2025-09',dataset:'receipt',status:'full',evidence:'老板已核对实际收款'}))).status,200);
 assert.equal((await body(await employee(f.base+'/api/personnel/session'))).role,'employee');
 assert.equal((await body(await boss(f.base+'/api/personnel/session'))).role,'boss');
 assert.equal((await fetch(f.base+'/api/report?period=2025-09',{headers:{'x-role':'boss','x-sales-token':f.token}})).status,403);
 const selection=await fetch(f.base+'/api/personnel/session',f.json({role:'employee'}));assert.equal(selection.status,200);assert.match(selection.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
});

function signedClient(f,{role='admin',id='tailscale:boss@test',sessionId='test-ui-session',channel='ui',initialCookies=[]}={}){
 const key=fs.readFileSync(path.join(f.dir,'.workbench-key'),'utf8').trim(),integrationKey=fs.readFileSync(path.join(f.dir,'.integration-key'),'utf8').trim(),cookies=new Map(initialCookies);
 const request=async(route,options={})=>{
  const method=options.method||'GET',at=Date.now(),actor={v:1,id,login:id,role,modules:['sales'],canRunTasks:true,channel,sessionId,requestId:randomUUID(),issuedAt:at,expiresAt:at+30000,module:'sales',method,path:route};
  const response=await fetch(f.base+route,{...options,headers:{...options.headers,Authorization:'Bearer '+integrationKey,...signWorkbenchActor(actor,key),...(cookies.size?{Cookie:[...cookies].map(([name,value])=>name+'='+value).join('; ')}:{})}});
  for(const value of response.headers.getSetCookie()){const [name,data]=value.split(';')[0].split('=');cookies.set(name,data);}
  return response;
 };
 request.cookies=cookies;return request;
}

test('signed UI roles cap selections and bind cookies to actor sessions; trusted owner CLI stays compatible',async t=>{
 const f=await fixture(t,18875),admin=signedClient(f),editor=signedClient(f,{role:'editor',id:'tailscale:employee@test',sessionId:'employee-session'});
 assert.equal((await admin('/api/report?period=2025-09')).status,403);
 assert.equal((await editor('/api/personnel/session',f.json({role:'boss'}))).status,403);
 assert.equal((await editor('/api/personnel/session',f.json({role:'employee'}))).status,200);
 assert.equal((await editor('/api/report?period=2025-09')).status,403);
 assert.equal((await admin('/api/personnel/session',f.json({role:'boss'}))).status,200);
 assert.equal((await admin('/api/report?period=2025-09')).status,200);
 const differentSession=signedClient(f,{sessionId:'other-ui-session',initialCookies:[...admin.cookies]});
 assert.equal((await differentSession('/api/report?period=2025-09')).status,403);
 const differentActor=signedClient(f,{id:'tailscale:other-admin@test',initialCookies:[...admin.cookies]});
 assert.equal((await differentActor('/api/report?period=2025-09')).status,403);
 // Even an admin acting as employee cannot use the gateway's Bearer header to bypass the choice.
 assert.equal((await admin('/api/personnel/session',f.json({role:'employee'}))).status,200);
 assert.equal((await admin('/api/report?period=2025-09')).status,403);
 const cli=signedClient(f,{channel:'mcp'});assert.equal((await cli('/api/integration/v1/report?period=2025-09')).status,200);
 assert.equal((await cli('/api/integration/v1/edits/missing/commit',f.json({}))).status,403);
 const record=addLedger(f.store,{shop_id:'offline',date:'2025-09-01',kind:'sale',amount:'87654.32',external_id:'owner-draft-source'});
 const draft=await body(await cli('/api/integration/v1/edits',f.json({type:'ledger',target:record.id,patch:{note:'老板核对草稿'},reason:'隔离员工审核数据'})));
 for(const route of ['/api/integration/v1/edits','/API/INTEGRATION/V1/EDITS/',`/api/integration/v1/edits/${draft.id}`]){
  assert.equal((await editor(route)).status,403,route);
  assert.equal((await editor(route,{method:'HEAD'})).status,403,route);
 }
 assert.equal((await editor('/api/integration/v1/edits',f.json({type:'ledger',target:record.id,patch:{note:'尝试读取原记录'},reason:'不能通过准备草稿读老板记录'}))).status,403);
 assert.equal((await admin('/api/integration/v1/edits/'+draft.id)).status,403);
 assert.equal((await admin('/api/integration/v1/workbench/migration/export')).status,403);
 assert.equal((await cli('/api/integration/v1/edits/'+draft.id)).status,200);
 const owner=fs.readFileSync(path.join(f.dir,'.integration-key'),'utf8').trim();
 assert.equal((await fetch(f.base+'/api/integration/v1/ledger?month=2025-09',{headers:{Authorization:'Bearer '+owner}})).status,200);
 assert.equal((await fetch(f.base+'/api/report?period=2025-09',{headers:{Authorization:'Bearer undefined'}})).status,403);
 const viewer=signedClient(f,{role:'viewer',id:'tailscale:viewer@test',sessionId:'viewer-session'});
 assert.equal((await viewer('/api/personnel/session',f.json({role:'employee'}))).status,403);
});

function prepare(s,m){
 for(const [id,platform]of [['test-pdd','拼多多'],['test-tb','淘宝']])s.run('INSERT INTO shops VALUES(?,?,?,?,?)',id,platform,id,'合成原件',0);
 const scope={start:m+'-01 00:00:00',end:m+'-30 23:59:59'};
 for(const [id,shop_id,dataset,source]of [['pdd-original','test-pdd','pdd_funds','拼多多货款账务明细'],['tb-original','test-tb','ledger','淘宝官方交易货款账单（账期口径）']]){
  fs.writeFileSync(path.join(s.dir,'originals',id),'isolated official evidence fixture');
  s.run('INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)',id,shop_id,dataset,id+'.csv','a'.repeat(64),'originals/'+id,'2025-09-01T00:00:00Z','committed',JSON.stringify({month:m,months:[m],source,scope}),JSON.stringify({summary:{count:0},scope}));
 }
 for(const shop of s.shops())for(const dataset of ['operations','expense'])setCoverage(s,{shop_id:shop.id,month:m,dataset,status:'full',evidence:'合成整月资料，真实零业务证据'});
}

test('employee task summary has evidence but no boss amounts; handoff is persistent, versioned, and ignores boss matching',async t=>{
 const f=await fixture(t,18876),m='2025-09',employee=await createSessionFetch(f.base,'employee'),boss=await createSessionFetch(f.base,'boss');
 let summary=await body(await employee(f.base+'/api/task-center?month='+m));
 assert.equal(summary.employeeReady,false);assert.equal(summary.submission.state,'draft');
 assert.equal((await employee(f.base+'/api/personnel/handoff',f.json({month:m,revision:summary.staffRevision}))).status,409);
 prepare(f.store,m);
 addLedger(f.store,{shop_id:'offline',date:'2025-08-01',kind:'sale',amount:'50',external_id:'prior-sale'});
 addLedger(f.store,{shop_id:'offline',date:'2025-09-01',kind:'receipt',amount:'10',external_id:'later-receipt',order_ref:'prior-sale'});
 const left=addLedger(f.store,{shop_id:'test-pdd',date:'2025-09-02',kind:'settlement',amount:'12345.67',external_id:'private-settlement',source:'官方合成'});
 const right=addLedger(f.store,{shop_id:'test-pdd',date:'2025-09-03',kind:'receipt',amount:'12345.67',external_id:'private-receipt',source:'银行合成'});
 summary=await body(await employee(f.base+'/api/task-center?month='+m));
 assert.equal(summary.employeeReady,true);assert.equal(summary.statements.length,2);assert.ok(summary.statements.every(row=>row.months[0].coverage.sources.length>0));
 assert.equal(summary.statements[0].months[0].income,null);assert.equal(summary.closeInfo.report,undefined);assert.equal(summary.closeInfo.freight.total,undefined);assert.deepEqual(summary.jobs,[]);assert.ok(!JSON.stringify(summary).includes('1234567'));
 const manual=await body(await employee(f.base+'/api/manual-summary?month='+m+'&shop=offline'));assert.equal(manual.reconciliation[0].receivable,4000);assert.ok(manual.reconciliation.every(row=>['offline','dropship'].includes(row.shop_id)));
 assert.equal((await boss(f.base+'/api/personnel/handoff',f.json({month:m,revision:summary.staffRevision}))).status,403);
 const submitted=await body(await employee(f.base+'/api/personnel/handoff',f.json({month:m,revision:summary.staffRevision})));assert.equal(submitted.submission.state,'submitted');
 assert.equal(f.store.get('SELECT month FROM sales_staff_handoffs WHERE month=?',m).month,m);
 const bossSummary=await body(await boss(f.base+'/api/task-center?month='+m));assert.ok(bossSummary.closeInfo.report);assert.equal(bossSummary.submission.state,'submitted');
 createMatch(f.store,{left_id:left.id,right_id:right.id,left_amount:'12345.67',right_amount:'12345.67',reason:'老板核对实际流水'});
 setCoverage(f.store,{shop_id:'test-pdd',month:m,dataset:'receipt',status:'full',evidence:'老板核对实际到账12345.67'});
 const checked=await body(await employee(f.base+'/api/task-center?month='+m));assert.equal(checked.staffRevision,summary.staffRevision);assert.equal(checked.submission.state,'submitted');assert.ok(!JSON.stringify(checked).includes('12345.67'));
 addLedger(f.store,{shop_id:'offline',date:'2025-09-04',kind:'sale',amount:'9',external_id:'staff-changed'});
 const changed=await body(await employee(f.base+'/api/task-center?month='+m));assert.equal(changed.submission.state,'changed');assert.notEqual(changed.staffRevision,summary.staffRevision);
 assert.equal((await employee(f.base+'/api/personnel/handoff',f.json({month:m,revision:summary.staffRevision}))).status,409);
 assert.equal((await body(await employee(f.base+'/api/personnel/handoff',f.json({month:m,revision:changed.staffRevision})))).submission.state,'submitted');
 const close=closePreview(f.store,m);await lockMonth(f.store,{month:m,revision:close.revision,confirmation:'锁定 '+m});
 const locked=await body(await employee(f.base+'/api/task-center?month='+m));assert.equal(locked.closeInfo.locked,true);
 assert.equal((await employee(f.base+'/api/personnel/handoff',f.json({month:m,revision:locked.staffRevision}))).status,423);
});

test('employee ledger APIs cannot expose or manually alter online funds or clear boss coverage',async t=>{
 const f=await fixture(t,18877),m='2025-09',employee=await createSessionFetch(f.base,'employee'),boss=await createSessionFetch(f.base,'boss');
 f.store.run('INSERT INTO shops VALUES(?,?,?,?,?)','online-test','拼多多','隔离资金权限测试店','官方原件',0);
 const record=addLedger(f.store,{shop_id:'online-test',date:m+'-02',kind:'settlement',amount:'98765.43',external_id:'boss-online-record',source:'老板对账依据'});
 setCoverage(f.store,{shop_id:'online-test',month:m,dataset:'receipt',status:'full',evidence:'老板实际到账98765.43已核对'});
 const employeeRows=await body(await employee(f.base+'/api/ledger?month='+m));assert.ok(!employeeRows.some(row=>row.id===record.id));
 assert.ok((await body(await boss(f.base+'/api/ledger?month='+m))).some(row=>row.id===record.id));
 assert.equal((await employee(f.base+'/api/ledger',f.json({shop_id:'online-test',date:m+'-03',kind:'settlement',amount:'1',external_id:'forged-online'}))).status,403);
 assert.equal((await employee(f.base+'/api/ledger/'+record.id,{...f.json({amount:'1'}),method:'PUT'})).status,403);
 assert.equal((await employee(f.base+'/api/ledger/'+record.id,{...f.json({reason:'员工不能删除老板资金记录'}),method:'DELETE'})).status,403);
 assert.equal(f.store.get('SELECT amount FROM ledger WHERE id=?',record.id).amount,9876543);
 for(const status of ['full','partial','missing'])assert.equal((await employee(f.base+'/api/coverage',f.json({shop_id:'online-test',month:m,dataset:'receipt',status,evidence:'员工不能改老板审核状态'}))).status,403);
 const visibleSources=await body(await employee(f.base+'/api/sources?month='+m));assert.ok(!JSON.stringify(visibleSources).includes('98765.43'));assert.equal(visibleSources.find(row=>row.id==='online-test').datasets.find(row=>row.dataset==='receipt').status,'full');
 assert.equal((await employee(f.base+'/api/ledger',f.json({shop_id:'offline',date:m+'-03',kind:'sale',amount:'2',external_id:'staff-manual-sale'}))).status,200);
 assert.equal((await employee(f.base+'/api/ledger',f.json({shop_id:'online-test',date:m+'-03',kind:'expense',category:'平台服务费',amount:'3',external_id:'staff-shop-expense'}))).status,200);
});

test('real multipart preserves official Chinese Taobao filenames and still rejects renamed files',async t=>{
 const f=await fixture(t,18878),employee=await createSessionFetch(f.base,'employee');
 f.store.run('INSERT INTO shops VALUES(?,?,?,?,?)','multipart-tb','淘宝','隔离中文文件名测试店','官方原件',0);
 const filename='交易货款_202609_202609.csv';
 const header='账期,账单大类,业务大类,业务小类,订单号,子订单号,下单时间,确认收货时间,商品ID,sku,商品名称,数量,单价（元）,订单实际金额（元）,退款单号,退款金额（元）,收/付渠道,业务流水号,商户订单号,打款时间,打款更新时间,备注';
 const line=['20260910','货款收入','交易货款','五金','5127708816041067500','child1','2026-09-01 00:00:00','2026-09-10 00:00:00','item','sku','五金产品',1,10,10,'',0,'支付宝','flow1','merchant1','2026-09-10 01:00:00','',''].join(',');
 const upload=async name=>{const form=new FormData();form.set('shop_id','multipart-tb');form.append('file',new Blob([header+'\n'+line],{type:'text/csv'}),name);return employee(f.base+'/api/taobao/import',{method:'POST',headers:{'x-sales-token':f.token},body:form});};
 const preview=await body(await upload(filename));assert.equal(preview.status,'previewed');
 assert.equal(f.store.get('SELECT filename FROM imports WHERE id=?',preview.id).filename,filename);
 assert.equal((await employee(f.base+`/api/taobao/import/${preview.id}/commit`,f.json({revision:preview.revision}))).status,200);
 const invalid=await upload('重新命名_202609.csv');assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/官方单月文件名/);
});
