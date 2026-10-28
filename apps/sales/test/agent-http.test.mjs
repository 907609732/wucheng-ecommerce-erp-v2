import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash,randomUUID}from'node:crypto';
import {createApp}from'../server.mjs';import{signWorkbenchActor}from'../lib/workbench-actor.mjs';import{signAgentApproval,agentDigest,approvalHeaders}from'../lib/agent-approval.mjs';
import{createSalesAgentAdapter,salesAgentCapabilities}from'../lib/agent-adapter.mjs';

async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-agent-http-'));let app=createApp({dataDir:dir,port:0,demo:true}),server=app.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim();
 const call=async(route,{method='GET',body,actor='boss',role='admin',headers={}}={})=>{const url='/api/integration/v1/agent/'+route,at=Date.now();return fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{...signWorkbenchActor({v:1,id:actor,login:actor,role,channel:'mcp',modules:['sales'],module:'sales',canRunTasks:true,sessionId:'test-session',requestId:randomUUID(),issuedAt:at,expiresAt:at+60000,method,path:url},key),'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});};
 const prepare=async(capabilityId,input,options={})=>{const binding=await(await call('binding',options)).json(),response=await call('prepare',{...options,method:'POST',body:{taskId:'task-sales',capabilityId,input}});assert.equal(response.status,200,await response.clone().text());return {binding,capabilityId,input,...await response.json()};};
 const proof=(p,k,extra={})=>signAgentApproval({v:1,approvalId:'review-sales',actorId:'boss',module:'sales',capabilityId:p.capabilityId,taskId:'task-sales',resultId:'result-sales',resultVersion:1,...p.binding,changeDigest:agentDigest({capabilityId:p.capabilityId,input:p.input,commitData:p.commitData,changes:p.changes}),idempotencyKey:k,issuedAt:Date.now(),expiresAt:Date.now()+60000,...extra},key);
 const commit=(p,k,options={})=>call('commit',{method:'POST',body:{prepared:p},...options,headers:{'Idempotency-Key':k,...approvalHeaders(proof(p,k)),...options.headers}});
 const restart=async()=>{await new Promise(r=>server.close(r));app.store.close();app=createApp({dataDir:dir,port:0,demo:true});server=app.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));};
 t.after(async()=>{await new Promise(r=>server.close(r));app.store.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'sales-agent-http-')));fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,key,call,prepare,proof,commit,restart,get app(){return app;},get base(){return 'http://127.0.0.1:'+server.address().port;}};
}
const freight={channel:'warehouse',entry_mode:'month',period:'2026-06',shipping:'1051.20',materials:'25.01',other:'-232.32',other_note:'服务费扣除已确认赔付',bill_no:'CAINIAO-BIZ-2026-06'};

test('central review books real compensated freight exactly once, persists receipt and rejects unsigned/forged/crossactor/stale writes',async t=>{
 const f=await setup(t);
 const unsigned=await fetch(f.base+'/api/integration/v1/agent/binding',{headers:{Authorization:'Bearer '+fs.readFileSync(path.join(f.dir,'.integration-key'),'utf8').trim()}});assert.equal(unsigned.status,403);
 const csv=Buffer.from('month,amount\n2026-06,843.89'),file={filename:'云仓凭证.csv',dataBase64:csv.toString('base64'),sha256:createHash('sha256').update(csv).digest('hex')};
 const p=await f.prepare('sales.freight-create',{...freight,files:[file]});assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);assert.ok(p.changes[0].preview.total===84389);
 let r=await f.call('commit',{method:'POST',body:{prepared:p},headers:{'Idempotency-Key':'fr-1'}});assert.equal(r.status,403);
 r=await f.commit(p,'fr-1',{actor:'other'});assert.equal(r.status,404);
 r=await f.commit(p,'fr-1',{body:{prepared:{...p,input:{...p.input,shipping:'1'}}}});assert.equal(r.status,409);
 r=await f.commit(p,'fr-1');assert.equal(r.status,200,await r.clone().text());const booked=await r.json();assert.equal(booked.receipt.result.total,84389);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,1);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_attachments').n,1);
 r=await f.commit(p,'fr-1');assert.deepEqual(await r.json(),booked);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,1);
 const stale=await f.prepare('sales.freight-create',{...freight,period:'2026-07',bill_no:'JUL'});f.app.store.audit('concurrent-test','change',{});r=await f.commit(stale,'stale-key');assert.equal(r.status,409);
 await f.restart();r=await f.call('receipts/fr-1');assert.equal((await r.json()).receipt.id,booked.receipt.id);
 const artifacts=await f.call('query?'+new URLSearchParams({capabilityId:'sales.freight-attachment',input:JSON.stringify({id:booked.receipt.result.attachments[0].id})}));assert.equal(artifacts.status,200);const {artifact}=await artifacts.json();assert.equal(artifact.sha256,file.sha256);const downloaded=await f.call('files/'+artifact.id);assert.ok(Buffer.from(await downloaded.arrayBuffer()).equals(csv));
});

test('employee expense/manual receivables operate with actual permissions; financial review and privilege injection fail',async t=>{
 const f=await setup(t),employee={actor:'employee',role:'editor'};
 let r=await f.call('prepare',{...employee,method:'POST',body:{taskId:'task-sales',capabilityId:'sales.match-create',input:{}}});assert.equal(r.status,403);
 r=await f.call('prepare',{method:'POST',body:{taskId:'task-sales',capabilityId:'sales.freight-create',input:{...freight,confirmed:true}}});assert.equal(r.status,400);
 const input={shop_id:'offline',date:'2026-06-01',kind:'sale',amount:'100',currency:'CNY',external_id:'SYNTHETIC-ORDER',source:'合成业务'},p=await f.prepare('sales.ledger-create',input,employee);
 r=await f.call('commit',{...employee,method:'POST',body:{prepared:p},headers:{'Idempotency-Key':'employee-sale',...approvalHeaders(f.proof(p,'employee-sale',{actorId:'employee'}))}});assert.equal(r.status,200,await r.clone().text());assert.equal(f.app.store.get('SELECT amount FROM ledger WHERE external_id=?',input.external_id).amount,10000);
 const refund=await f.prepare('sales.ledger-create',{...input,kind:'refund',external_id:'SYNTHETIC-REFUND',order_ref:'SYNTHETIC-ORDER',amount:'30'},employee);r=await f.call('commit',{...employee,method:'POST',body:{prepared:refund},headers:{'Idempotency-Key':'employee-refund',...approvalHeaders(f.proof(refund,'employee-refund',{actorId:'employee'}))}});assert.equal(r.status,200);
 r=await f.call('query?'+new URLSearchParams({capabilityId:'sales.report',input:JSON.stringify({period:'2026-06'})}),employee);assert.equal(r.status,403);
});

test('real file mapping preview commits operations with source retained; duplicate skips and month-lock guards remain',async t=>{
 const f=await setup(t);f.app.store.run("INSERT INTO shops VALUES('synthetic-shop','淘宝','合成店铺','合成来源',0)");
 const bytes=Buffer.from('date,sales,orders\n2026-05-01,100,2\n'),file={filename:'operations.csv',dataBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
 const input={file,context:{shop_id:'synthetic-shop',month:'2026-05',dataset:'operations'},options:{mapping:{start:'0',end:'0',sales:'1',orders:'2'},source:'合成官方报表',definition:'支付日期、含运费',compatible:'0'}};
 const p=await f.prepare('sales.import',input);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM operations').n,0);let r=await f.commit(p,'operations');assert.equal(r.status,200,await r.clone().text());assert.equal(f.app.store.get('SELECT sales FROM operations').sales,10000);const first=await r.json();assert.ok(fs.existsSync(path.join(f.dir,f.app.store.get('SELECT original_path FROM imports WHERE id=?',first.receipt.result.batchId).original_path)));
 const again=await f.prepare('sales.import',input);r=await f.commit(again,'duplicate-operations');assert.equal(r.status,200);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM operations').n,1);
 const lockQuery=await f.call('query?'+new URLSearchParams({capabilityId:'sales.close-preview',input:JSON.stringify({month:'2026-05'})}));const close=await lockQuery.json();const lock=await f.prepare('sales.month-lock',{month:'2026-05',revision:close.revision});r=await f.commit(lock,'lock-month');assert.equal(r.status,200,await r.clone().text());assert.equal(f.app.store.get('SELECT COUNT(*) n FROM month_locks').n,1);
 r=await f.call('prepare',{method:'POST',body:{taskId:'task-sales',capabilityId:'sales.import',input}});assert.equal(r.status,423);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM operations').n,1);
});

test('managed sources and nonreview backup expose owned hash-checked downloads without business writes',async t=>{
 const f=await setup(t),bytes=Buffer.from('date,sales\n2026-05-01,100\n'),file={filename:'source.csv',dataBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
 const staged=await f.prepare('sales.file-stage',{file});assert.equal(staged.commitData,undefined);const artifact=staged.blocks[0];assert.equal(artifact.sha256,file.sha256);
 let r=await f.call('query?'+new URLSearchParams({capabilityId:'sales.file-inspect',taskId:'task-sales',input:JSON.stringify({file:{id:artifact.id}})}));assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).total,1);
 r=await f.call('query?'+new URLSearchParams({capabilityId:'sales.file-inspect',taskId:'wrong-task',input:JSON.stringify({file:{id:artifact.id}})}));assert.equal(r.status,403);
 r=await f.call('files/'+artifact.id,{actor:'other'});assert.equal(r.status,404);
 const backed=await f.prepare('sales.backup',{});assert.equal(backed.commitData,undefined);const download=backed.blocks[0];r=await f.call('files/'+download.id);assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),download.sha256);
 r=await f.call('files/'+download.id,{role:'editor'});assert.equal(r.status,403);
 assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);
});

test('reviewed shop and ledger lifecycle, coverage, month unlock and restore copy persist verified receipts',async t=>{
 const f=await setup(t);let serial=0;
 const book=async(name,input)=>{const p=await f.prepare('sales.'+name,input),r=await f.commit(p,'lifecycle-'+(++serial));assert.equal(r.status,200,await r.clone().text());const output=await r.json();assert.equal(output.receipt.verification.ok,true);return output.receipt.result;};
 const shop=await book('shop-create',{platform:'线下',name:'合成独立店'});await book('shop-delete',{id:shop.id,name:shop.name});
 const input={shop_id:'offline',date:'2026-04-01',kind:'sale',amount:'100',currency:'CNY',external_id:'LIFECYCLE',source:'合成业务'};
 const record=await book('ledger-create',input);await book('ledger-update',{id:record.id,date:input.date,currency:'CNY',amount:'120',reason:'修正合成金额'});await book('ledger-delete',{id:record.id,reason:'删除合成测试'});
 await book('coverage',{shop_id:'offline',month:'2026-04',dataset:'operations',status:'full',evidence:'合成完整月核对'});
 const q=await f.call('query?'+new URLSearchParams({capabilityId:'sales.close-preview',input:JSON.stringify({month:'2026-04'})}));const close=await q.json();await book('month-lock',{month:'2026-04',revision:close.revision});await book('month-unlock',{month:'2026-04',reason:'合成测试恢复可编辑'});
 const backup=await f.prepare('sales.backup',{}),name=backup.blocks[1].rows[0].name;await book('restore-copy',{name});assert.ok(fs.existsSync(path.join(f.dir,'recovered',name,'sales.sqlite')));
});

test('adapter uses only frozen trusted transport and exact module APIs, propagating approval out of model input',async()=>{
 const calls=[],transport=async(module,route,options)=>{calls.push({module,route,options});return {ok:true};},a=createSalesAgentAdapter({transport}),ctx={actor:{id:'real'},taskId:'t',approval:{payload:'proof'},idempotencyKey:'k'};
 await a.binding(ctx);await a.query('sales.shops',{},ctx);await a.prepare('sales.backup',{},ctx);await a.commit({commitData:{preparationId:'p'}},ctx);await a.receipt('k',ctx);
 assert.ok(calls.every(c=>c.module==='sales'&&c.route.startsWith('/api/integration/v1/agent/')));assert.equal(calls[2].options.body.taskId,'t');assert.equal(calls[3].options.approval,ctx.approval);assert.equal(calls[2].options.body.input.approval,undefined);assert.ok(salesAgentCapabilities.every(c=>c.kind==='query'||typeof c.requiresReview==='boolean'));
});

test('host attachment ID flows through real chunk HTTP, reviewed import and registered central result download',async t=>{
 const f=await setup(t),taskDir=path.join(f.dir,'central-tasks','task-sales');fs.mkdirSync(taskDir,{recursive:true});
 f.app.store.run("INSERT INTO shops VALUES('pdd','拼多多','合成附件店','合成来源',0)");
 const bytes=Buffer.from('date,sales,orders\n2026-03-01,42.50,2\n'),sourcePath=path.join(f.dir,'trusted-task-attachment.csv');fs.writeFileSync(sourcePath,bytes);
 const registrations=[],ctx={actor:{id:'boss'},taskId:'task-sales',resolveAttachment(id){assert.equal(id,'task-attachment');return {id,name:'operations.csv',path:sourcePath,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};},registerArtifact({path:filePath,name,mimeType}){assert.ok(filePath.startsWith(taskDir+path.sep));const output=fs.readFileSync(filePath),artifact={id:randomUUID(),taskId:'task-sales',name,mimeType,size:output.length,sha256:createHash('sha256').update(output).digest('hex')};registrations.push({...artifact,path:filePath});return artifact;}};
 const transport=async(module,route,options={})=>{assert.equal(module,'sales');const response=await f.call(route.replace('/api/integration/v1/agent/',''),{method:options.method,body:options.body,headers:{...(options.approval?approvalHeaders(options.approval):{}),...(options.idempotencyKey?{'Idempotency-Key':options.idempotencyKey}:{})}});if(!response.ok)throw Object.assign(Error(await response.text()),{status:response.status});return response.json();};
 transport.download=async(module,route,{ctx,expectedSha256,filename,maxBytes})=>{const response=await f.call(route.replace('/api/integration/v1/agent/',''));assert.equal(response.status,200);const output=Buffer.from(await response.arrayBuffer());assert.ok(output.length<=maxBytes);assert.equal(createHash('sha256').update(output).digest('hex'),expectedSha256);const target=path.join(taskDir,randomUUID()+'-'+path.basename(filename));fs.writeFileSync(target,output);return ctx.registerArtifact({path:target,name:filename,mimeType:response.headers.get('content-type')});};
 const adapter=createSalesAgentAdapter({transport});
 const staged=await adapter.prepare('sales.files.stage',{attachmentId:'task-attachment'},ctx),file=staged.blocks[0].rows[0];assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(file.url,undefined);
 await assert.rejects(adapter.prepare('sales.file-stage',{file:{filename:'b.csv',dataBase64:'YQ==',sha256:'a'.repeat(64)}},ctx),{code:'AGENT_INPUT_SCHEMA'});
 const input={file:{id:file.id},context:{shop_id:'pdd',month:'2026-03',dataset:'operations'},options:{mapping:{start:'0',end:'0',sales:'1',orders:'2'},source:'合成官方报表',definition:'支付日期含运费',compatible:'0'}};
 const p={binding:await adapter.binding(ctx),capabilityId:'sales.import',input,...await adapter.prepare('sales.import',input,ctx)};ctx.idempotencyKey='central-attachment-import';ctx.approval=f.proof(p,ctx.idempotencyKey);const committed=await adapter.commit(p,ctx);assert.equal(committed.receipt.verification.ok,true);assert.equal(f.app.store.get('SELECT sales FROM operations WHERE shop_id=?','pdd').sales,4250);
 const exported=await adapter.query('sales.export',{period:'2026-03'},ctx);assert.ok(exported.artifact.id);assert.equal(exported.artifact.url,undefined);assert.ok(registrations.length>=1);const central=registrations.find(r=>r.id===exported.artifact.id);assert.ok(central&&fs.statSync(central.path).size>0);assert.equal(exported.blocks[0].type,'download');assert.equal(exported.blocks[0].id,central.id);
});

test('sales host uploads a real 50MiB attachment with persisted resume after restart and rejects oversized files',async t=>{
 const f=await setup(t),filePath=path.join(f.dir,'central-source.csv'),size=50*1024*1024;fs.writeFileSync(filePath,Buffer.alloc(size,97));
 const sha256=createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),ctx={taskId:'task-sales',resolveAttachment:()=>({name:'large.csv',path:filePath,size,sha256})};
 let disconnect=true,indices=[];
 const transport=async(module,route,options)=>{if(route.endsWith('/part')){if(disconnect&&options.body.index===1){disconnect=false;throw Error('synthetic connection loss');}indices.push(options.body.index);}const response=await f.call(route.replace('/api/integration/v1/agent/',''),{method:options.method,body:options.body});assert.equal(response.status,200,await response.clone().text());return response.json();};
 const adapter=createSalesAgentAdapter({transport});await assert.rejects(adapter.prepare('sales.files.stage',{attachmentId:'large-original'},ctx),/connection loss/);assert.deepEqual(indices,[0]);
 await f.restart();indices=[];const output=await adapter.prepare('sales.files.stage',{attachmentId:'large-original'},ctx),file=output.blocks[0].rows[0];assert.equal(file.bytes,size);assert.equal(file.sha256,sha256);assert.deepEqual(indices,Array.from({length:49},(_,i)=>i+1));assert.equal(f.app.store.get('SELECT COUNT(*) n FROM agent_artifacts').n,1);
 const replay=await adapter.prepare('sales.files.stage',{attachmentId:'large-original'},ctx);assert.equal(replay.blocks[0].rows[0].id,file.id);fs.truncateSync(filePath,size+1);await assert.rejects(adapter.prepare('sales.files.stage',{attachmentId:'too-large'},ctx),{code:'AGENT_ATTACHMENT_SIZE'});
});
