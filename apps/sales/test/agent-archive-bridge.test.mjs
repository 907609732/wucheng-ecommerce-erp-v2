import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {createApp} from '../server.mjs';
import {createSalesAgentAdapter} from '../lib/agent-adapter.mjs';
import {normalizedOverviewManifest,overviewManifestDigest} from '../lib/agent-archive-bridge.mjs';
import {signWorkbenchActor} from '../lib/workbench-actor.mjs';
import {signAgentApproval,agentDigest,approvalHeaders} from '../lib/agent-approval.mjs';
import {beijing,shiftMonth,bounds,hash} from '../lib/util.mjs';

// FUTURE TESTS: written for the consolidated acceptance run; not executed while
// the cross-module bridge is being integrated. The overview handoff transport
// and trusted runtime artifact resolver are MOCK boundaries. Sales uses a real
// loopback HTTP server, signed identities/approvals, SQLite, chunk upload files,
// immutable original manifests, saveFreight and artifact download/readback.
// There is no real overview account, browser, platform export or production data.
const period=shiftMonth(beijing().month,-1),taskId='archive-bridge-task',actorId='archive-bridge-owner';
const clone=value=>JSON.parse(JSON.stringify(value));
async function xlsx(headers,rows){const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('官方格式原件');sheet.addRow(headers);for(const row of rows)sheet.addRow(row);return Buffer.from(await book.xlsx.writeBuffer());}
async function zip(files,{forceChunks=false}={}){const archive=new JSZip();for(const [filename,bytes]of Object.entries(files))archive.file(filename,bytes);if(forceChunks)archive.file('导出说明.txt',Buffer.alloc(1024*1024+31,65));return archive.generateAsync({type:'nodebuffer',compression:'STORE'});}
async function sourceFixtures(){
 const [from,to]=bounds(period),suffix=from.replaceAll('-','')+'_'+to.replaceAll('-','');
 const costs=[['正向配送费','1000.00'],['包装物料费','20.00'],['订单处理费','50.00'],['货值赔付','-100.00']];
 const transactions=await xlsx(['交易单号','ERP单号','物流履约单号','计费金额合计(CNY)'],costs.map(([,amount],index)=>['0000000000000000000'+index,'ERP'+index,'L'+index,amount]));
 const details=await xlsx(['物流履约单号','费用项','计费金额','计费币种','业务时间'],costs.map(([name,amount],index)=>['L'+index,name,amount,'CNY',from+' 12:00:00']));
 const goods=await xlsx(['物流履约单号','货品ID','货品件数'],[['L0','000000000000000000001',2]]);
 const fees=await xlsx(['费用项','主单行数量','计费金额'],costs.map(([name,amount])=>[name,1,amount]));
 const members={['交易账单_'+suffix+'.xlsx']:transactions,['计费明细_'+suffix+'.xlsx']:details,['货品信息_'+suffix+'.xlsx']:goods};
 const exports=[{role:'transactions',filename:'交易导出_'+suffix+'.zip',bytes:await zip(members,{forceChunks:true})},{role:'fees',filename:'费用导出_'+suffix+'.zip',bytes:await zip({['费用项汇总_'+suffix+'.xlsx']:fees,['计费明细_'+suffix+'.xlsx']:details})}];
 return {from,to,members,exports};
}

async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-archive-bridge-')),source=await sourceFixtures();
 const app=createApp({dataDir:dir,port:0,demo:true}),server=app.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim(),base='http://127.0.0.1:'+server.address().port,sourceDir=path.join(dir,'mock-central-source'),outputDir=path.join(dir,'central-results');fs.mkdirSync(sourceDir);fs.mkdirSync(outputDir);
 const artifacts=new Map(),manifestFiles=[];
 for(const original of source.exports){
  const artifactId=randomUUID(),overviewFileId=randomUUID(),target=path.join(sourceDir,artifactId+'.zip');fs.writeFileSync(target,original.bytes);
  const sha256=hash(original.bytes);artifacts.set(artifactId,{id:artifactId,name:original.filename,path:target,size:original.bytes.length,mimeType:'application/zip',sha256,taskId,ownerId:actorId,sourceModule:'overview',sourceCapabilityId:'overview.cainiao-file'});
  manifestFiles.push({fileId:overviewFileId,role:original.role,postingRelevant:true,filename:original.filename,sha256,bytes:original.bytes.length,account:'mock-cn-official-account',from:source.from,cutoff:source.to,expected:{count:4,amountCents:97000},verification:{verified:true}});
 }
 const originalManifest={version:1,module:'overview',jobId:randomUUID(),month:period,account:'mock-cn-official-account',basis:'业务时间',from:source.from,cutoff:source.to,ready:true,complete:true,files:manifestFiles,issues:[],evidence:[]};
 let manifest=clone(originalManifest);const calls=[],registrations=[];
 const context=({actor={},task=taskId}={})=>{
  const ctx={actor:{id:actorId,login:actorId,role:'admin',modules:['sales','overview'],canRunTasks:true,...actor},taskId:task};
  ctx.resolveTaskArtifact=async id=>{
   await Promise.resolve();const item=artifacts.get(id);
   // Models do not construct this runtime metadata. The real resolver enforces
   // current ownership, task scope, module permission and actual-byte digest.
   if(!item||item.ownerId!==ctx.actor.id||item.taskId!==ctx.taskId||!ctx.actor.modules.includes(item.sourceModule))throw Object.assign(Error('产物不属于当前人员、任务或模块权限范围'),{code:'TASK_ARTIFACT_SCOPE',status:403});
   if(hash(fs.readFileSync(item.path))!==item.sha256)throw Object.assign(Error('中央原件内容发生变化'),{code:'TASK_ARTIFACT_CHANGED',status:409});
   const {ownerId,...resolved}=item;return {...resolved};
  };
  ctx.registerArtifact=async({path:target,name,mimeType})=>{assert.ok(path.resolve(target).startsWith(path.resolve(outputDir)+path.sep));const bytes=fs.readFileSync(target),artifact={id:randomUUID(),name,mimeType,sha256:hash(bytes),size:bytes.length,taskId:ctx.taskId};registrations.push({...artifact,path:target});return artifact;};
  return ctx;
 };
 const raw=async(route,{method='GET',body,ctx=context(),headers={}}={})=>{
  const issuedAt=Date.now(),url=route.startsWith('/api/')?route:'/api/integration/v1/agent/'+route,a=ctx.actor;
  return fetch(base+url,{method,headers:{...signWorkbenchActor({v:1,id:a.id,login:a.login||a.id,role:a.role,channel:'mcp',modules:a.modules,module:'sales',canRunTasks:a.canRunTasks!==false,sessionId:'archive-bridge-session',requestId:randomUUID(),issuedAt,expiresAt:issuedAt+60000,method,path:url},key),'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 };
 const transport=async(module,route,options={})=>{
  calls.push({module,route,method:options.method||'GET',body:options.body,taskId:options.ctx?.taskId,actorId:options.ctx?.actor?.id});
  if(module==='overview'){
   assert.ok(options.ctx.actor.modules.includes('overview'),'mock overview transport also checks actual module permission');
   const parsed=new URL('http://mock-overview'+route);assert.equal(parsed.pathname,'/api/integration/v1/agent/query');assert.equal(parsed.searchParams.get('capabilityId'),'overview.cainiao-handoff');assert.equal(parsed.searchParams.get('taskId'),options.ctx.taskId);
   return clone(manifest);
  }
  assert.equal(module,'sales');const response=await raw(route,{method:options.method,body:options.body,ctx:options.ctx,headers:{...(options.approval?approvalHeaders(options.approval):{}),...(options.idempotencyKey?{'Idempotency-Key':options.idempotencyKey}:{})}}),value=await response.json();
  if(!response.ok)throw Object.assign(Error(value.error||'销售HTTP请求被拒绝'),{code:value.code,status:response.status,response:value});return value;
 };
 transport.download=async(module,route,{ctx,expectedSha256,filename,maxBytes})=>{assert.equal(module,'sales');const response=await raw(route,{ctx});assert.equal(response.status,200,await response.clone().text());const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<=maxBytes);assert.equal(hash(bytes),expectedSha256);const target=path.join(outputDir,randomUUID()+'-'+path.basename(filename));fs.writeFileSync(target,bytes);return ctx.registerArtifact({path:target,name:filename,mimeType:response.headers.get('content-type')});};
 const adapter=createSalesAgentAdapter({transport}),input={sourceJobId:originalManifest.jobId,month:period,artifactIds:[...artifacts.keys()]};
 const stage=async(ctx=context(),selected=input)=>{const result=await adapter.prepare('sales.cainiao-archive-stage',selected,ctx),reference=result.blocks.find(block=>block.id==='sales.cainiao-archive-reference');return {result,handoffId:reference?.rows[0].handoffId};};
 const preparation=async(handoffId,ctx=context())=>{const input={handoffId},binding=await adapter.binding(ctx);return {binding,capabilityId:'sales.cainiao-archive-posting',input,...await adapter.prepare('sales.cainiao-archive-posting',input,ctx)};};
 const approved=(prepared,ctx=context(),idempotencyKey='archive-'+randomUUID())=>{const issuedAt=Date.now(),approval=signAgentApproval({v:1,approvalId:'archive-bridge-central-review',actorId:ctx.actor.id,module:'sales',capabilityId:prepared.capabilityId,taskId:ctx.taskId,resultId:'archive-bridge-result',resultVersion:1,...prepared.binding,changeDigest:agentDigest({capabilityId:prepared.capabilityId,input:prepared.input,commitData:prepared.commitData,changes:prepared.changes}),idempotencyKey,issuedAt,expiresAt:issuedAt+60000},key);return {...ctx,approval,idempotencyKey};};
 t.after(async()=>{await app.cainiao.close();await new Promise(resolve=>server.close(resolve));app.store.close();const target=path.resolve(dir);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep+'sales-archive-bridge-'));fs.rmSync(target,{recursive:true,force:true});});
 return {app,dir,adapter,transport,context,raw,stage,preparation,approved,input,source,artifacts,calls,registrations,originalManifest,get manifest(){return manifest;},set manifest(value){manifest=value;}};
}
const business=store=>hash(['freight_records','freight_attachments','freight_requests','ledger','operations','matches','coverage','shops','month_locks','jobs','audit'].map(name=>[name,store.all('SELECT * FROM '+name)]));

test('source mock + real sales HTTP: chunk stage→adopt→preview→central review→SHA readback and receipt replay',async t=>{
 const f=await fixture(t),ctx=f.context(),before=business(f.app.store),staged=await f.stage(ctx);assert.ok(staged.handoffId);assert.equal(staged.result.issues.length,0,JSON.stringify(staged.result.issues));assert.equal(staged.result.commitData,undefined);
 assert.equal(business(f.app.store),before);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM sales_cainiao_jobs').n,0,'复用原件不能创建销售下载任务');
 const starts=f.calls.filter(call=>call.module==='sales'&&call.route.endsWith('/files/upload/start')),parts=f.calls.filter(call=>call.module==='sales'&&call.route.endsWith('/files/upload/part')),finishes=f.calls.filter(call=>call.module==='sales'&&call.route.endsWith('/files/upload/finish'));
 assert.equal(starts.length,2);assert.equal(finishes.length,2);assert.ok(parts.some(call=>call.body.index===1),'真实ZIP原件跨两个1MiB分片');
 assert.ok(f.calls.some(call=>call.body?.capabilityId==='sales.cainiao-archive-adopt'));assert.ok(f.calls.every(call=>!call.body?.input?.dataBase64),'模型能力输入不包含原件Base64，分片协议仅由可信host读取');
 const preview=await f.adapter.query('sales.cainiao-archive-preview',{handoffId:staged.handoffId},ctx);assert.equal(preview.ready,true,JSON.stringify(preview.issues));assert.equal(preview.total,97000);assert.equal(preview.uploads,undefined);assert.equal(preview.freightInput,undefined);assert.equal(preview.sourceJobId,f.input.sourceJobId);
 assert.equal(preview.artifactMappings.length,2);for(const mapping of preview.artifactMappings){const original=f.artifacts.get(mapping.artifactId),source=f.originalManifest.files.find(file=>file.sha256===mapping.sha256),saved=f.app.store.get('SELECT * FROM agent_artifacts WHERE id=?',mapping.fileId);assert.ok(saved);assert.notEqual(mapping.fileId,source.fileId);assert.equal(saved.actor_id,actorId);assert.equal(JSON.parse(saved.grant_json).taskId,taskId);assert.equal(hash(fs.readFileSync(path.join(f.dir,saved.path))),original.sha256);}
 const prepared=await f.preparation(staged.handoffId,ctx);assert.equal(prepared.changes[0].operation,'freight-create');assert.equal(prepared.changes[0].input.shipping,'1000.00');assert.equal(prepared.changes[0].input.other,'-50.00');assert.deepEqual(prepared.changes[0].artifactMappings,preview.artifactMappings);assert.equal(business(f.app.store),before);
 let response=await f.raw('commit',{method:'POST',ctx,body:{prepared},headers:{'Idempotency-Key':'unsigned-archive'}});assert.equal(response.status,403);assert.equal(business(f.app.store),before);
 const reviewed=f.approved(prepared,ctx,'archive-full-flow'),booked=await f.adapter.commit(prepared,reviewed);assert.equal(booked.receipt.verification.ok,true);assert.equal(booked.receipt.result.total,97000);assert.equal(booked.receipt.result.other,-5000);assert.equal(booked.receipt.result.attachments.length,3);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,1);
 const record=f.app.store.get('SELECT * FROM freight_records WHERE id=?',booked.receipt.result.id);assert.match(record.note,new RegExp('CAINIAO-ARCHIVE='+preview.sourceFingerprint));
 for(const attachment of booked.receipt.result.attachments){const db=f.app.store.get('SELECT * FROM freight_attachments WHERE id=?',attachment.id);assert.equal(hash(fs.readFileSync(path.join(f.dir,db.original_path))),db.sha256);assert.ok(Object.values(f.source.members).some(bytes=>hash(bytes)===db.sha256));assert.equal(attachment.url,undefined);assert.equal(attachment.artifact.sha256,db.sha256,'提交回执中的凭证也登记为安全中央产物');assert.ok(f.registrations.some(file=>file.id===attachment.artifact.id));const downloaded=await f.adapter.query('sales.freight-attachment',{id:attachment.id},ctx);assert.equal(downloaded.artifact.sha256,db.sha256);assert.equal(downloaded.artifact.url,undefined);assert.ok(f.registrations.some(file=>file.id===downloaded.artifact.id&&hash(fs.readFileSync(file.path))===db.sha256));}
 // The adapter revalidates overview before commits. Replays query the durable
 // receipt directly: once saved, a fresh preview correctly reports duplicate.
 response=await f.raw('commit',{method:'POST',ctx:reviewed,body:{prepared},headers:{'Idempotency-Key':reviewed.idempotencyKey,...approvalHeaders(reviewed.approval)}});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).receipt.id,booked.receipt.id);
 const receipt=await f.adapter.receipt(reviewed.idempotencyKey,ctx);assert.equal(receipt.receipt.id,booked.receipt.id);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,1);
 const duplicate=await f.adapter.query('sales.cainiao-archive-preview',{handoffId:staged.handoffId},ctx);assert.equal(duplicate.ready,false);assert.equal(duplicate.postingAction,'skip');assert.ok(duplicate.issues.some(issue=>issue.code==='DUPLICATE_SOURCE'));
 const again=await f.preparation(staged.handoffId,ctx);assert.ok(again.issues.some(issue=>issue.blocking));await assert.rejects(f.adapter.commit(again,f.approved(again,ctx,'archive-duplicate')),{code:'AGENT_PREPARATION_BLOCKED'});assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,1);
});

test('source mock: missing provenance, old artifacts, cross-task/actor and missing overview permission fail before adoption',async t=>{
 const f=await fixture(t),ids=f.input.artifactIds;
 await t.test('legacy artifact without runtime source stamp',async()=>{const ctx=f.context(),resolver=ctx.resolveTaskArtifact;ctx.resolveTaskArtifact=async id=>{const artifact=await resolver(id);if(id===ids[0]){delete artifact.sourceModule;delete artifact.sourceCapabilityId;}return artifact;};await assert.rejects(f.stage(ctx),{code:'ARTIFACT_SOURCE_REQUIRED'});});
 await t.test('cross task metadata',async()=>{const ctx=f.context(),resolver=ctx.resolveTaskArtifact;ctx.resolveTaskArtifact=async id=>({...await resolver(id),taskId:'another-task'});await assert.rejects(f.stage(ctx),{code:'ARTIFACT_SOURCE_REQUIRED'});});
 await t.test('trusted resolver rejects another owner',async()=>{await assert.rejects(f.stage(f.context({actor:{id:'other-owner',login:'other-owner'}})),{code:'TASK_ARTIFACT_SCOPE'});});
 for(const field of ['actorId','ownerId'])await t.test('optional contradictory '+field+' is also rejected',async()=>{const ctx=f.context(),resolver=ctx.resolveTaskArtifact;ctx.resolveTaskArtifact=async id=>({...await resolver(id),[field]:'other-owner'});await assert.rejects(f.stage(ctx),{code:'ARTIFACT_SOURCE_REQUIRED'});});
 await t.test('actual actor lacks overview module',async()=>{await assert.rejects(f.stage(f.context({actor:{modules:['sales']}})),{code:'CROSS_MODULE_PERMISSION_REQUIRED'});});
 await t.test('overview domain ID is not a central artifact ID',async()=>{await assert.rejects(f.stage(f.context(),{...f.input,artifactIds:f.originalManifest.files.map(file=>file.fileId)}),{code:'TASK_ARTIFACT_SCOPE'});});
 assert.equal(f.app.store.get('SELECT COUNT(*) n FROM agent_cainiao_handoffs').n,0);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);
});

test('source mock: runtime SHA, manifest identity, completeness and source range cannot be replaced by model data',async t=>{
 const f=await fixture(t);
 await t.test('artifact SHA differs from manifest',async()=>{const ctx=f.context(),resolver=ctx.resolveTaskArtifact;ctx.resolveTaskArtifact=async id=>({...await resolver(id),sha256:'0'.repeat(64)});await assert.rejects(f.stage(ctx),{code:'ARTIFACT_MANIFEST_MISMATCH'});});
 await t.test('on-disk bytes changed after trusted metadata resolution',async()=>{const ctx=f.context(),resolver=ctx.resolveTaskArtifact,first=f.artifacts.get(f.input.artifactIds[0]),original=fs.readFileSync(first.path);ctx.resolveTaskArtifact=async id=>{const metadata=await resolver(id);if(id===first.id)fs.writeFileSync(first.path,Buffer.alloc(original.length,66));return metadata;};try{await assert.rejects(f.stage(ctx),{code:'AGENT_ATTACHMENT_CHANGED'});}finally{fs.writeFileSync(first.path,original);}});
 await t.test('incomplete original selection',async()=>{await assert.rejects(f.stage(f.context(),{...f.input,artifactIds:[f.input.artifactIds[0]]}),{code:'AGENT_INPUT_SCHEMA'});});
 await t.test('source job mismatch',async()=>{await assert.rejects(f.stage(f.context(),{...f.input,sourceJobId:'different-source-job'}),{code:'OVERVIEW_SCOPE_CHANGED'});});
 await t.test('manifest missing page evidence',async()=>{f.manifest=clone(f.originalManifest);f.manifest.files[1].expected.amountCents=null;try{await assert.rejects(f.stage(),{code:'OVERVIEW_MANIFEST_INVALID'});}finally{f.manifest=clone(f.originalManifest);}});
 await t.test('per-file range differs from group',async()=>{f.manifest=clone(f.originalManifest);f.manifest.files[0].from=shiftMonth(period,-1)+'-01';try{await assert.rejects(f.stage(),{code:'OVERVIEW_MANIFEST_INVALID'});}finally{f.manifest=clone(f.originalManifest);}});
 await t.test('coherent but false source range is blocked by actual workbook declaration',async()=>{f.manifest=clone(f.originalManifest);const to=period+'-01';f.manifest.cutoff=to;f.manifest.files.forEach(file=>{file.cutoff=to;});try{const staged=await f.stage();assert.ok(staged.handoffId);assert.ok(staged.result.issues.some(issue=>['DECLARED_RANGE_MISMATCH','HISTORICAL_RANGE_INCOMPLETE'].includes(issue.code)));const preview=await f.adapter.query('sales.cainiao-archive-preview',{handoffId:staged.handoffId},f.context());assert.equal(preview.ready,false);}finally{f.manifest=clone(f.originalManifest);}});
 assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);
});

test('real sales HTTP: adopted references and staged originals are scoped to the exact actor and task',async t=>{
 const f=await fixture(t),ctx=f.context(),staged=await f.stage(ctx),input={handoffId:staged.handoffId};
 for(const other of [f.context({task:'another-task'}),f.context({actor:{id:'other-owner',login:'other-owner'}})]){
  await assert.rejects(f.adapter.query('sales.cainiao-archive-preview',input,other),{code:'ARCHIVE_HANDOFF_NOT_FOUND'});
  await assert.rejects(f.adapter.prepare('sales.cainiao-archive-posting',input,other),{code:'ARCHIVE_HANDOFF_NOT_FOUND'});
 }
 const handoff=JSON.parse(f.app.store.get('SELECT payload FROM agent_cainiao_handoffs WHERE id=?',staged.handoffId).payload),salesId=handoff.files[0].id;
 for(const other of [f.context({task:'another-task'}),f.context({actor:{id:'other-owner',login:'other-owner'}})]){
  const response=await f.raw('query?'+new URLSearchParams({capabilityId:'sales.file-inspect',taskId:other.taskId,input:JSON.stringify({file:{id:salesId}})}),{ctx:other});assert.equal(response.status,403,'原件读取也由真实销售服务验证人员和任务');
 }
 assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);
});

test('real sales HTTP: direct overview file IDs cannot be adopted as sales file IDs and internal adopt is not model-facing',async t=>{
 const f=await fixture(t),manifest=normalizedOverviewManifest(f.originalManifest),files=manifest.files.map((source,index)=>({id:source.fileId,artifactId:f.input.artifactIds[index],filename:source.filename,sha256:source.sha256,report:source.report,sourceModule:'overview',sourceCapabilityId:'overview.cainiao-file'}));
 const input={manifest,manifestDigest:overviewManifestDigest(manifest),files},response=await f.raw('prepare',{method:'POST',body:{taskId,capabilityId:'sales.cainiao-archive-adopt',input}});assert.equal(response.status,409);assert.equal((await response.json()).code,'ARCHIVE_MANIFEST_CHANGED');
 const wrongDigest=await f.raw('prepare',{method:'POST',body:{taskId,capabilityId:'sales.cainiao-archive-adopt',input:{...input,manifestDigest:'0'.repeat(64)}}});assert.equal(wrongDigest.status,409);assert.equal((await wrongDigest.json()).code,'ARCHIVE_MANIFEST_CHANGED');
 await assert.rejects(f.adapter.prepare('sales.cainiao-archive-adopt',input,f.context()),{code:'AGENT_INPUT_SCHEMA'});assert.equal(f.app.store.get('SELECT COUNT(*) n FROM agent_cainiao_handoffs').n,0);
});

test('source mock: overview source changes after review prevent adapter commit before any financial HTTP write',async t=>{
 const f=await fixture(t),ctx=f.context(),staged=await f.stage(ctx),prepared=await f.preparation(staged.handoffId,ctx),reviewed=f.approved(prepared,ctx,'archive-source-changed');
 const before=business(f.app.store),commitCount=f.calls.filter(call=>call.route.endsWith('/commit')).length;
 f.manifest=clone(f.originalManifest);f.manifest.account='source-account-changed';
 await assert.rejects(f.adapter.commit(prepared,reviewed),{code:'OVERVIEW_SOURCE_CHANGED'});
 assert.equal(f.calls.filter(call=>call.route.endsWith('/commit')).length,commitCount,'来源变化在送销售commit前被主机拒绝');assert.equal(business(f.app.store),before);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM agent_receipts').n,0);
});

test('real sales HTTP: staging-file mutation after review is rejected on fresh preview and creates no receipt',async t=>{
 const f=await fixture(t),ctx=f.context(),staged=await f.stage(ctx),prepared=await f.preparation(staged.handoffId,ctx),reviewed=f.approved(prepared,ctx,'archive-stage-changed');
 const handoff=JSON.parse(f.app.store.get('SELECT payload FROM agent_cainiao_handoffs WHERE id=?',staged.handoffId).payload),file=f.app.store.get('SELECT * FROM agent_artifacts WHERE id=?',handoff.files[0].id),target=path.join(f.dir,file.path),bytes=fs.readFileSync(target);fs.writeFileSync(target,Buffer.alloc(bytes.length,67));
 await assert.rejects(f.adapter.commit(prepared,reviewed),{code:'AGENT_FILE_CHANGED'});assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM agent_receipts').n,0);
});

test('source mock: an explicitly unready overview handoff returns blocking evidence without staging or starting downloads',async t=>{
 const f=await fixture(t);f.manifest={...clone(f.originalManifest),ready:false,issues:[{code:'MOCK_MISSING_ORIGINAL',message:'来源原件未齐',blocking:true}]};
 const staged=await f.stage();assert.equal(staged.handoffId,undefined);assert.ok(staged.result.issues.some(issue=>issue.code==='MOCK_MISSING_ORIGINAL'&&issue.blocking));assert.equal(f.calls.filter(call=>call.module==='sales').length,0);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM sales_cainiao_jobs').n,0);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM freight_records').n,0);
});
