import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {createApp} from '../server.mjs';
import {signWorkbenchActor} from '../lib/workbench-actor.mjs';
import {signAgentApproval,agentDigest,approvalHeaders} from '../lib/agent-approval.mjs';
import {addLedger,setCoverage} from '../lib/ledger.mjs';
import {beijing} from '../lib/util.mjs';

async function setup(t,appOptions={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-agent-remaining-')),{app,store,cainiao}=createApp({dataDir:dir,port:0,demo:true,...appOptions}),server=app.listen(0,'127.0.0.1');
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 const key=fs.readFileSync(path.join(dir,'.workbench-key'),'utf8').trim(),nativeFetch=globalThis.fetch,taskId='remaining-business-task';let sequence=0;
 const call=async(route,{method='GET',body,actor='boss',role='admin',headers={}}={})=>{
  const url='/api/integration/v1/agent/'+route,at=Date.now();
  return nativeFetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{...signWorkbenchActor({v:1,id:actor,login:actor,role,channel:'mcp',modules:['sales'],module:'sales',canRunTasks:true,sessionId:'remaining-session',requestId:randomUUID(),issuedAt:at,expiresAt:at+60000,method,path:url},key),'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 };
 const json=async(response,label)=>{assert.equal(response.status,200,label+': '+await response.clone().text());return response.json();};
 const query=async(name,input={},options={})=>json(await call('query?'+new URLSearchParams({capabilityId:'sales.'+name,taskId,input:JSON.stringify(input)}),options),name);
 const prepare=async(name,input,options={})=>{const binding=await json(await call('binding',options),'binding'),value=await json(await call('prepare',{...options,method:'POST',body:{taskId,capabilityId:'sales.'+name,input}}),name);return {binding,capabilityId:'sales.'+name,input,...value};};
 const commit=async(prepared,idempotencyKey,options={})=>{
  const at=Date.now(),actor=options.actor||'boss',claims={v:1,approvalId:'remaining-review-'+sequence,actorId:actor,module:'sales',capabilityId:prepared.capabilityId,taskId,resultId:'remaining-result-'+sequence,resultVersion:1,...prepared.binding,changeDigest:agentDigest({capabilityId:prepared.capabilityId,input:prepared.input,commitData:prepared.commitData,changes:prepared.changes}),idempotencyKey,issuedAt:at,expiresAt:at+60000};
  return json(await call('commit',{...options,method:'POST',body:{prepared},headers:{'Idempotency-Key':idempotencyKey,...approvalHeaders(signAgentApproval(claims,key))}}),prepared.capabilityId);
 };
 const book=async(name,input,options={})=>{const prepared=await prepare(name,input,options),output=await commit(prepared,'remaining-'+(++sequence),options);assert.equal(output.receipt.verification.ok,true,name);return output.receipt.result;};
 t.after(async()=>{await cainiao?.close();await new Promise(resolve=>server.close(resolve));store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sales-agent-remaining-'));fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,store,call,query,prepare,commit,book};
}

test('skill query returns the packaged actual guide and keeps merchant and SF collection unavailable',async t=>{
 const f=await setup(t),result=await f.query('skill',{}, {actor:'employee',role:'editor'});
 assert.equal(result.id,'cainiao-freight-import');assert.equal(result.available,true);
 assert.deepEqual(result.files.map(file=>file.name),['SKILL.md','references/browser.md','references/import.md']);
 assert.ok(result.files.every(file=>typeof file.text==='string'&&file.text.length>50));
 assert.equal(result.platforms.find(platform=>platform.id==='warehouse').available,true);
 assert.equal(result.platforms.find(platform=>platform.id==='merchant').available,false);
 assert.equal(result.platforms.find(platform=>platform.id==='sf').available,false);
});

async function pddFile(){
 const csv='拼多多店铺账务明细查询\n\n起始时间：2026-03-01 00:00:00  终止时间：2026-03-31 23:59:59\n----------交易记录明细列表---------\n商户订单号,发生时间,收入金额（+元）,支出金额（-元）,账务类型,备注,业务描述\nPDD-REMAINING,2026-03-02 12:00:00,100.00,0,交易收入,合成原件,0010002|交易收入-订单收入\n\n#收入合计：1笔100.00元\n#支出合计：0笔0.00元\n#总计：100.00元\n';
 const zip=new JSZip();zip.file('official.csv',csv);const bytes=await zip.generateAsync({type:'nodebuffer'});
 return {filename:'pdd-remaining.zip',dataBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
}

test('batch attribution crosses real central review while preserving every ledger row and original byte',async t=>{
 const f=await setup(t);
 for(const id of ['remaining-pdd-one','remaining-pdd-two'])f.store.run('INSERT INTO shops VALUES(?,?,?,?,?)',id,'拼多多','合成店铺 '+id,'合成官方原件',0);
 const file=await pddFile(),imported=await f.book('pdd-import',{shop_id:'remaining-pdd-one',file});
 const before=f.store.all('SELECT id,amount,batch_id FROM ledger WHERE batch_id=?',imported.batchId),original=f.store.get('SELECT original_path FROM imports WHERE id=?',imported.batchId).original_path;
 assert.equal(before.length,1);assert.equal(before[0].amount,10000);
 await f.book('batch-attribution',{id:imported.batchId,status:'unassigned',reason:'合成复核发现来源尚待确认'});
 assert.equal(f.store.get('SELECT COUNT(*) n FROM active_ledger WHERE batch_id=?',imported.batchId).n,0);
 const unassigned=await f.query('pdd-unassigned');assert.ok(unassigned.data.some(batch=>batch.id===imported.batchId));
 await f.book('batch-attribution',{id:imported.batchId,status:'confirmed',shop_id:'remaining-pdd-two',reason:'已核对合成后台店铺与原件'});
 assert.equal(f.store.get('SELECT shop_id FROM imports WHERE id=?',imported.batchId).shop_id,'remaining-pdd-two');
 assert.equal(f.store.get('SELECT status FROM batch_attributions WHERE import_id=?',imported.batchId).status,'confirmed');
 assert.deepEqual(f.store.all('SELECT id,amount,batch_id FROM ledger WHERE batch_id=?',imported.batchId),before);
 assert.equal(f.store.get('SELECT shop_id FROM active_ledger WHERE batch_id=?',imported.batchId).shop_id,'remaining-pdd-two');
 assert.deepEqual(fs.readFileSync(path.join(f.dir,original)),Buffer.from(file.dataBase64,'base64'));
 assert.equal((await f.query('pdd-unassigned')).data.length,0);
});

test('rates refresh parses mocked official CBR XML and commits fixed-point rates through central review',async t=>{
 const f=await setup(t),nativeFetch=globalThis.fetch,xml='<?xml version="1.0"?><ValCurs Date="02.03.2026"><Valute ID="CNY"><CharCode>CNY</CharCode><Nominal>10</Nominal><Value>100,0000</Value></Valute><Valute ID="USD"><CharCode>USD</CharCode><Nominal>1</Nominal><Value>90,0000</Value></Valute><Valute ID="EUR"><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>100,0000</Value></Valute></ValCurs>';let officialRequests=0;
 t.mock.method(globalThis,'fetch',async(input,options)=>{
  if(String(input).startsWith('https://www.cbr.ru/scripts/XML_daily.asp?')){assert.match(String(input),/date_req=02\/03\/2026$/);officialRequests++;return new Response(Buffer.from(xml),{status:200,headers:{'Content-Type':'text/xml; charset=windows-1251'}});}
  return nativeFetch(input,options);
 });
 addLedger(f.store,{shop_id:'offline',date:'2026-03-02',kind:'sale',amount:'100',currency:'RUB',external_id:'remaining-fx-sale'});
 const prepared=await f.prepare('rates-refresh',{month:'2026-03'});assert.equal(officialRequests,1);
 assert.equal(f.store.get('SELECT COUNT(*) n FROM rates').n,0,'预演只更新隔离副本');
 const first=await f.commit(prepared,'remaining-rates-once');assert.equal(first.receipt.verification.ok,true);
 const rows=f.store.all('SELECT * FROM rates ORDER BY currency');assert.equal(rows.length,3);
 const byCode=Object.fromEntries(rows.map(row=>[row.currency,row]));assert.equal(byCode.RUB.rate,10000000);assert.equal(byCode.USD.rate,900000000);assert.equal(byCode.EUR.rate,1000000000);
 assert.ok(rows.every(row=>row.date==='2026-03-02'&&row.effective_date==='2026-03-02'&&row.source.startsWith('https://www.cbr.ru/')&&row.sha256===createHash('sha256').update(xml).digest('hex')));
 const replay=await f.commit(prepared,'remaining-rates-once');assert.deepEqual(replay,first);assert.equal(officialRequests,1);assert.equal(f.store.get('SELECT COUNT(*) n FROM rates').n,3);
 const queried=await f.query('rates');assert.equal(queried.data.length,3);
});

test('ready employee handoff persists actual employee identity and reviewed receipt without approving funds',async t=>{
 const f=await setup(t),month='2026-03',employee={actor:'actual-employee',role:'editor'};
 const person=await f.query('personnel-state',{},employee);await f.book('personnel-link',{domainPersonId:person.newPersonId,displayName:'明确确认的员工',reason:'本人选择新建领域身份',revision:person.revision},employee);
 for(const shop of f.store.shops())for(const dataset of ['operations','expense'])setCoverage(f.store,{shop_id:shop.id,month,dataset,status:'full',evidence:'合成完整月资料，核对真实零业务'});
 const before=await f.query('task-center',{month},employee);assert.equal(before.employeeReady,true);assert.equal(before.submission.state,'draft');
 const submitted=await f.book('staff-handoff',{month,revision:before.staffRevision},employee);assert.equal(submitted.submission.state,'submitted');assert.equal(submitted.submission.submittedBy,employee.actor);
 const stored=f.store.get('SELECT * FROM sales_staff_handoffs WHERE month=?',month);assert.equal(stored.submitted_by,employee.actor);assert.equal(stored.staff_revision,before.staffRevision);
 const after=await f.query('task-center',{month},employee);assert.equal(after.submission.state,'submitted');assert.equal(after.staffRevision,before.staffRevision);
 assert.equal(f.store.get("SELECT COUNT(*) n FROM coverage WHERE dataset IN ('settlement','receipt') AND status='full'").n,0);
 assert.equal(f.store.get('SELECT COUNT(*) n FROM month_locks').n,0);
 assert.equal(f.store.get('SELECT COUNT(*) n FROM agent_receipts WHERE actor_id=? AND preparation_id IS NOT NULL',employee.actor).n,2);
});

test('current-month cutoff reaches the real Cainiao domain through signed HTTP and cannot include today',async t=>{
 const cainiaoBrowser={status:()=>({status:'connected',account:'remaining-cainiao'}),async disconnect(){},async run(){throw Error('截止日无效时不得访问平台');}},f=await setup(t,{cainiaoBrowser}),today=beijing();
 for(const cutoffInput of [{cutoff:today.date},{cutoffs:{[today.month]:today.date}}]){
  const response=await f.call('prepare',{method:'POST',body:{taskId:'remaining-business-task',capabilityId:'sales.cainiao-download-start',input:{account:'remaining-cainiao',from:today.month,...cutoffInput}}});
  assert.equal(response.status,409,await response.clone().text());const failure=await response.json();assert.equal(failure.code,'CAINIAO_CUTOFF_INVALID');assert.match(failure.error,/北京时间昨天/);
 }
 assert.equal(f.store.get('SELECT COUNT(*) n FROM sales_cainiao_jobs').n,0);
});
