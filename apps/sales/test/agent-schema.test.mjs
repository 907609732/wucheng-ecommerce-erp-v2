import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {salesAgentCapabilities,createSalesAgentAdapter} from '../lib/agent-adapter.mjs';
import {schemaFor,salesCapabilityDefinitions} from '../lib/agent-schemas.mjs';

const ajv=new Ajv({allErrors:true,strict:false});
const file={filename:'官方运营报表.csv',dataBase64:'YQ==',sha256:'a'.repeat(64)};
const staged={id:'10000000-0000-4000-8000-000000000001'};
const m='2026-09',rowId='real-record-id',shop='real-shop-id';
const freight={channel:'warehouse',entry_mode:'month',period:m,shipping:'1051.20',materials:'25.01',other:'-232.32',other_note:'已核对的赔付抵扣'};
const importInput={file,context:{shop_id:shop,month:m,dataset:'operations'},options:{mapping:{start:'0',end:'0',sales:'1',orders:'2'},source:'已确认官方报表',definition:'按支付日期、含买家运费',compatible:'0'}};
const samples={
 'task-center':{month:m},'manual-summary':{month:m,shop:'offline'},sources:{month:m},report:{period:m},reconciliation:{month:m},ledger:{month:m},original:{id:rowId},'file-inspect':{file},
 'freight-report':{period:m},'freight-records':{period:m,page:2,page_size:25},'freight-record':{id:rowId},'freight-attachment':{id:rowId},'freight-export':{period:m,status:'all'},'close-preview':{month:m},'job-report':{id:rowId},export:{period:m},template:{type:'operations'},'backup-verify':{name:'2026-10-28T04-20-00-000Z-a1b2c3d4'},
 'shop-create':{platform:'淘宝',name:'合成真实店名'},'shop-delete':{id:shop,name:'合成真实店名'},'ledger-create':{shop_id:'offline',date:m+'-01',kind:'sale',amount:'100.25',external_id:'001234567890123456789'},'ledger-update':{id:rowId,date:m+'-01',amount:'100.25',currency:'CNY',reason:'按真实凭证更正'},'ledger-delete':{id:rowId,reason:'重复手工记录'},'match-create':{left_id:'left',right_id:'right',left_amount:'100.25',right_amount:'100.25',reason:'按真实结算与到账批次'},'match-delete':{id:rowId,reason:'依据更新重新分配'},coverage:{shop_id:shop,month:m,dataset:'operations',status:'full',evidence:'官方整月汇总已经核对'},import:importInput,
 'taobao-import':{shop_id:shop,file:{...file,filename:'交易货款_202609_202609.csv'}},'pdd-import':{shop_id:shop,file:{...file,filename:'官方拼多多.zip'}},'import-rollback':{id:rowId,reason:'已核实错选原件'},'batch-attribution':{id:rowId,status:'confirmed',shop_id:shop,reason:'核实后台店名与原件'},'pdd-reference':{shop_id:shop,month:m,cutoff:m+'-30 23:59:59',income:10025,expense:-100,income_count:2,expense_count:1,opening_balance:null},
 'freight-create':freight,'freight-update':{...freight,id:rowId,version:2,remove_attachments:['old-attachment']},'freight-void':{id:rowId,version:2,reason:'原始费用已撤销'},'month-lock':{month:m,revision:'b'.repeat(64)},'month-unlock':{month:m,reason:'原件补齐后更正'},'rates-refresh':{month:m},'job-create':{period:m},'staff-handoff':{month:m,revision:'c'.repeat(64)},'restore-copy':{name:'2026-10-28T04-20-00-000Z-a1b2c3d4'},'file-stage':{file},
 'cainiao-job':{jobId:rowId},'cainiao-preview':{jobId:rowId,month:m},'cainiao-file':{fileId:'downloaded-file'},'cainiao-download-start':{account:'confirmed-account',from:m},'cainiao-download-stop':{jobId:rowId},'cainiao-download-resume':{jobId:rowId},'cainiao-posting':{jobId:rowId,month:m}
};
for(const platform of ['pdd','taobao'])Object.assign(samples,{[platform+'-funds']:{shop_id:shop,period:m},[platform+'-statement']:{shop_id:shop,year:'2026'},[platform+'-movements']:{shop_id:shop,month:m,page:1,page_size:50},[platform+'-movement']:{id:rowId,shop_id:shop},[platform+'-export']:{shop_id:shop,month:m}});
function valid(name,input,expected=true){const validate=ajv.compile(schemaFor(name));assert.equal(validate(input),expected,name+' '+JSON.stringify(validate.errors));}

test('every sales capability has a compiled concrete Chinese contract and a valid representative input',()=>{
 const ids=new Set();
 for(const cap of salesAgentCapabilities){
  assert.equal(ids.has(cap.id),false,cap.id);ids.add(cap.id);
  assert.match(cap.title,/[\u3400-\u9fff]/);assert.ok(cap.description.length>10,cap.id);
  assert.equal(cap.inputSchema.type,'object');assert.equal(cap.inputSchema.additionalProperties,false,cap.id);assert.ok(Array.isArray(cap.inputSchema.required),cap.id);
  assert.equal(schemaFor(cap.id),cap.inputSchema);valid(cap.id,samples[cap.id.slice('sales.'.length)]||{});
  valid(cap.id,{...(samples[cap.id.slice('sales.'.length)]||{}),role:'admin'},false);
 }
 assert.equal(ids.size,75);assert.equal(salesCapabilityDefinitions.length,ids.size);
 const previous=['shops','task-center','manual-summary','sources','history-coverage','report','reconciliation','ledger','imports','original','file-inspect','taobao-funds','taobao-statement','taobao-movements','taobao-movement','taobao-export','pdd-funds','pdd-statement','pdd-movements','pdd-movement','pdd-export','pdd-unassigned','freight-report','freight-records','freight-record','freight-attachment','freight-export','close-preview','close-history','audit','jobs','job-report','report-history','export','template','backups','backup-verify','rates','skill','shop-create','shop-delete','ledger-create','ledger-update','ledger-delete','match-create','match-delete','coverage','import','taobao-import','pdd-import','import-rollback','batch-attribution','pdd-reference','freight-create','freight-update','freight-void','month-lock','month-unlock','rates-refresh','job-create','staff-handoff','backup','restore-copy'];
 assert.ok(previous.every(name=>ids.has('sales.'+name)));assert.throws(()=>schemaFor('unlisted'),/缺少明确/);
});

test('periods, exact pagination, enums and cents preserve the actual domain input contract',()=>{
 valid('report',{period:'2026',grain:'year'});valid('report',{period:'2026-09-03',grain:'day'});valid('report',{period:'2026'},false);valid('report',{period:'2026-13'},false);valid('report',{period:m,grain:'quarter'},false);
 valid('pdd-movements',{shop_id:shop,page:1,page_size:100});valid('pdd-movements',{shop_id:shop,page_size:25},false);valid('pdd-movements',{shop_id:shop,page:0},false);
 valid('pdd-movements',{attribution:'unassigned',batch_id:'quarantined'});valid('pdd-movements',{attribution:'unassigned',shop_id:shop},false);valid('pdd-movements',{},false);
 valid('pdd-export',{shop_id:shop,page:1},false);valid('freight-records',{period:m,page_size:100});valid('freight-records',{period:m,page_size:200},false);
 valid('shop-create',{platform:'other',name:'店铺'},false);valid('ledger-create',{...samples['ledger-create'],currency:'BTC'},false);valid('ledger-create',{...samples['ledger-create'],amount:'1e3'},false);
 valid('pdd-reference',{...samples['pdd-reference'],income:0.1},false);valid('pdd-reference',{...samples['pdd-reference'],expense:100},false);valid('pdd-reference',{...samples['pdd-reference'],cutoff:m+'-30'},false);
 valid('month-lock',{month:m},false);valid('ledger-update',{id:rowId,amount:'1.00'},false);
});

test('managed files are task-scoped IDs or exact inline originals, without arbitrary paths or hidden data',()=>{
 valid('file-inspect',{file:staged});valid('file-inspect',{file:{id:'C:\\private\\bills.csv'}},false);valid('file-inspect',{file:{...staged,...file}},false);
 valid('file-stage',{file});valid('file-stage',{file:staged},false);valid('file-stage',{file:{...file,filename:'C:\\private\\bills.csv'}},false);valid('file-stage',{file:{...file,filename:'../bills.csv'}},false);
 valid('file-stage',{file:{...file,filename:'C:relative.csv'}},false);valid('file-stage',{file:{...file,filename:'bad'+String.fromCharCode(0)+'.csv'}},false);
 valid('file-stage',{file:{...file,sha256:'not-a-sha256'}},false);valid('file-stage',{file:{...file,dataBase64:'data:text/csv;base64,YQ=='}},false);
 valid('taobao-import',{shop_id:shop,file:staged});valid('taobao-import',{shop_id:shop,file:{...file,filename:'改名.csv'}},false);valid('taobao-import',{shop_id:shop,file:{...file,filename:'交易货款_202609_202610.csv'}},false);
 valid('freight-create',{...freight,files:[staged,file]});valid('freight-create',{...freight,files:Array(6).fill(file)},false);
 valid('import',importInput);valid('import',{...importInput,options:{...importInput.options,mapping:{sql:0}}},false);valid('import',{...importInput,context:{...importInput.context,path:'C:\\private'}},false);
 valid('import',{...importInput,options:{mapping:{start:0,sales:1},source:'实际官方来源'}},false);
});

test('freight periods, source ownership and compensation keep required evidence',()=>{
 valid('freight-create',{...freight,period:m+'-01'},false);valid('freight-create',{...freight,entry_mode:'single',period:m+'-01'});
 valid('freight-create',{...freight,channel:'merchant',shop_id:'shared'},false);valid('freight-create',{...freight,channel:'warehouse',shop_id:shop},false);
 const {other_note,...withoutNote}=freight;valid('freight-create',withoutNote,false);valid('freight-create',{...freight,other_note:'  '},false);
 valid('freight-update',freight,false);valid('freight-update',{...freight,id:rowId,version:1});valid('coverage',{shop_id:shop,month:m,dataset:'receipt',status:'complete',evidence:'无'},false);
});

test('only nonfinancial preparatory steps skip human review and adapter retains task file scope',async()=>{
 const noReview=new Set(['file-stage','backup','cainiao-connect','cainiao-disconnect','cainiao-download-start','cainiao-download-stop','cainiao-download-resume']);
 for(const cap of salesAgentCapabilities.filter(cap=>cap.kind==='prepare'))assert.equal(cap.requiresReview,!noReview.has(cap.id.slice(6)),cap.id);
 valid('cainiao-download-start',{account:'actual-account',from:'2026-99'},false);valid('cainiao-posting',{jobId:rowId},false);
 const calls=[],adapter=createSalesAgentAdapter({transport:async(module,route,options)=>{calls.push({module,route,options});return {};}});
 await adapter.query('sales.file-inspect',{file:staged},{taskId:'actual-task'});
 const route=new URL(calls[0].route,'http://local');assert.equal(route.searchParams.get('taskId'),'actual-task');assert.equal(route.searchParams.get('capabilityId'),'sales.file-inspect');assert.deepEqual(JSON.parse(route.searchParams.get('input')),{file:staged});
});
