import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {backup} from 'node:sqlite';
import JSZip from 'jszip';
import {openStore} from './db.mjs';import {id,now,hash,month,date,required,fail,money,monthsBetween,shiftMonth,beijing} from './util.mjs';
import {addLedger,editLedger,deleteLedger,createMatch,removeMatch,setCoverage,insertObject} from './ledger.mjs';
import {createPersonnel} from './personnel.mjs';import {deleteEmptyShop} from './shops.mjs';
import {report,reconciliationDetail,monthData} from './report.mjs';import {closePreview,lockMonth,unlockMonth} from './close.mjs';
import {stageImport,previewImport,commitImport,rollbackImport,readTable,FIELDS} from './importer.mjs';
import {stageTaobao,commitTaobao,taobaoFunds,taobaoStatement,taobaoMovements,taobaoMovement,taobaoMovementRows} from './taobao.mjs';
import {stagePdd,pddPreview,commitPdd,pddFundsReport,pddStatementYear,setAttribution,unassignedBatches,movementsPage,movementDetail,saveReference} from './pdd.mjs';
import {freightReport,freightList,freightRecord,saveFreight,voidFreight,freightAttachment,exportFreight} from './freight.mjs';
import {sourceStatus,runJob} from './jobs.mjs';import {fetchRates} from './fx.mjs';
import {listBackups,verifyBackup,restoreBackup,makeBackup} from './backup.mjs';import {exportWorkbook,exportPddMovements} from './export.mjs';

const financial=new Set(['report','reconciliation','taobao-funds','taobao-statement','taobao-movements','taobao-movement','taobao-export','pdd-funds','pdd-statement','pdd-movements','pdd-movement','pdd-export','close-preview','close-history','audit','jobs','job-report','report-history','export','backups','backup-verify','rates','shop-create','shop-delete','match-create','match-delete','pdd-reference','month-lock','month-unlock','rates-refresh','job-create','import-rollback','backup','restore-copy']);
export function authorizeSalesAgent(actor,cap,_phase,input){const name=cap.id.replace(/^sales\./,'');if(financial.has(name)&&actor.role!=='admin')throw fail('此项工作需要实际老板账号复核',403,'BOSS_REQUIRED');if(name==='staff-handoff'&&actor.role!=='editor')throw fail('请由员工交接准备资料',403,'EMPLOYEE_REQUIRED');if(name==='coverage'&&actor.role!=='admin'&&!['operations','expense'].includes(input.dataset))throw fail('资金覆盖确认需要老板账号',403,'BOSS_REQUIRED');}
const request=ctx=>({headers:{},workbenchActor:ctx.actor});
function file(value,{max=50*1024*1024,extensions=/\.(csv|tsv|xlsx|zip|png|jpg|jpeg|webp|pdf|xls)$/i}={}){if(!value||typeof value.filename!=='string'||!extensions.test(value.filename)||typeof value.dataBase64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64))throw fail('请提供已上传的有效业务原件');const buffer=Buffer.from(value.dataBase64,'base64');if(!buffer.length||buffer.length>max||hash(buffer)!==value.sha256)throw fail('原件大小或 SHA-256 不符');return {buffer,originalname:path.basename(value.filename)};}
const safeInput=value=>{if(Array.isArray(value))return value.map(safeInput);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='dataBase64').map(([k,v])=>[k,safeInput(v)]));};

export function createSalesAgentActions({store:s,personnel,cainiao}){
 const hydrate=(input,c)=>({...input,...(input.file?.id?{file:c.resolveFile(input.file.id)}:{}),...(input.files?{files:input.files.map(f=>f.id?c.resolveFile(f.id):f)}:{})});
 const pFor=t=>t===s?personnel:createPersonnel(t);
 const rawFile=(relative,filename,mime)=>{const absolute=path.resolve(s.dir,relative);if(!absolute.startsWith(path.resolve(s.dir)+path.sep))throw fail('原件路径越界');return {filename,mime,bytes:fs.readFileSync(absolute)};};
 const queries={
  shops:()=>s.shops(),'task-center':(i,c)=>personnel.taskCenter(request(c),month(i.month)),'manual-summary':i=>personnel.manualSummary(month(i.month),i.shop||'all'),sources:(i,c)=>personnel.sources(request(c),month(i.month)),
  'history-coverage':()=>monthsBetween('2025-01',shiftMonth(beijing().month,-1)).map(m=>({month:m,full:s.get("SELECT COUNT(*) n FROM coverage WHERE month=? AND status='full'",m).n,locked:!!s.get('SELECT 1 FROM month_locks WHERE month=?',m)})),
  report:i=>report(s,i),reconciliation:i=>reconciliationDetail(s,month(i.month),i.shop||'all'),ledger:(i,c)=>personnel.ledgerRows(request(c),monthData(s,month(i.month)).ledger.filter(r=>!i.shop||i.shop==='all'||r.shop_id===i.shop)),
  imports:()=>s.all('SELECT id,shop_id,dataset,filename,sha256,status,context_json,created_at FROM imports ORDER BY created_at DESC LIMIT 200'),
  original:i=>{const r=s.get('SELECT * FROM imports WHERE id=?',i.id);if(!r)throw fail('原件不存在',404);return rawFile(r.original_path,r.filename);},
  'file-inspect':async(i,c)=>{const f=file(hydrate(i,c).file,{extensions:/\.(csv|tsv|xlsx)$/i});const table=await readTable(f.buffer,f.originalname,i.sheet,i.header_row||1);return {headers:table.headers,sheets:table.sheets,sheet:table.sheet,total:table.rows.length,sample:table.rows.slice(0,5),fields:FIELDS};},
  'taobao-funds':i=>taobaoFunds(s,i.period,i.grain||'month',i.shop_id),'taobao-statement':i=>taobaoStatement(s,i.year,i.shop_id),'taobao-movements':i=>taobaoMovements(s,i),'taobao-movement':i=>taobaoMovement(s,i.id,i),'taobao-export':async i=>({filename:'taobao-movements.xlsx',bytes:Buffer.from(await exportPddMovements(s,i,taobaoMovementRows))}),
  'pdd-funds':i=>pddFundsReport(s,i.period,i.grain||'month',i.shop_id),'pdd-statement':i=>pddStatementYear(s,i.year,i.shop_id),'pdd-movements':i=>movementsPage(s,i),'pdd-movement':i=>movementDetail(s,i.id,i),'pdd-export':async i=>({filename:'pdd-movements.xlsx',bytes:Buffer.from(await exportPddMovements(s,i))}),'pdd-unassigned':()=>unassignedBatches(s),
  'freight-report':i=>freightReport(s,i),'freight-records':i=>freightList(s,i),'freight-record':i=>freightRecord(s,i.id),'freight-attachment':i=>{const a=freightAttachment(s,i.id);return {filename:a.filename,mime:a.mime,bytes:fs.readFileSync(a.absolute)};},'freight-export':async i=>({filename:'freight.xlsx',bytes:Buffer.from(await exportFreight(s,i))}),
  'close-preview':i=>closePreview(s,month(i.month)),'close-history':()=>s.all('SELECT id,month,action,reason,created_at FROM month_history ORDER BY created_at DESC LIMIT 100'),audit:()=>s.all('SELECT * FROM audit ORDER BY id DESC LIMIT 200'),jobs:()=>s.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100'),'job-report':i=>{const r=s.get('SELECT detail,period FROM jobs WHERE id=?',i.id),name=r&&JSON.parse(r.detail).file;if(!name)throw fail('报告尚未生成',404);return rawFile(path.join('reports',path.basename(name)),'sales-'+r.period+'.xlsx');},'report-history':()=>s.all('SELECT * FROM report_history ORDER BY created_at DESC'),
  export:async i=>({filename:'sales-'+i.period+'.xlsx',bytes:Buffer.from(await exportWorkbook(s,i))}),template:i=>{if(!FIELDS[i.type])throw fail('模板类型无效');return {filename:i.type+'-template.csv',mime:'text/csv',bytes:Buffer.from('\ufeff'+Object.keys(FIELDS[i.type]).join(',')+'\r\n')};},backups:()=>listBackups(s).map(({name,created_at,reason})=>({name,created_at,reason})),'backup-verify':i=>verifyBackup(s,i.name),rates:()=>s.all('SELECT * FROM rates ORDER BY date,currency'),
  skill:()=>({id:'cainiao-freight-import',available:true,files:['SKILL.md','references/browser.md','references/import.md'].map(name=>({name,text:fs.readFileSync(new URL('../public/skills/cainiao-freight-import/'+name,import.meta.url),'utf8')})),platforms:[{id:'warehouse',available:true},{id:'merchant',available:false},{id:'sf',available:false}]})
 };
 async function perform(t,name,i,c){
  const p=pFor(t),q=request(c);
  if(name==='shop-create'){const platform=required(i.platform,'平台'),name=required(i.name,'店铺名称',80);if(!['淘宝','拼多多','京东','闲鱼','抖店','Ozon','线下','代发'].includes(platform))throw fail('平台未开通');if(t.get('SELECT 1 FROM shops WHERE platform=? AND name=?',platform,name))throw fail('店铺名称已存在');const shop={id:id(),platform,name,receipts:'待核实',manual:['线下','代发'].includes(platform)};t.transaction(()=>{t.run('INSERT INTO shops VALUES(?,?,?,?,?)',shop.id,platform,name,shop.receipts,+shop.manual);t.audit('shop.create',shop.id,shop);});return shop;}
  if(name==='shop-delete')return deleteEmptyShop(t,i.id,{name:i.name,confirm:true});
  if(name==='ledger-create'){p.ledgerWrite(q,i);return addLedger(t,i);}
  if(name==='ledger-update'){p.ledgerWrite(q,i,i.id);return editLedger(t,i.id,i);}
  if(name==='ledger-delete'){p.ledgerWrite(q,{},i.id);return deleteLedger(t,i.id,i.reason);}
  if(name==='match-create')return createMatch(t,i);if(name==='match-delete')return removeMatch(t,i.id,i.reason);
  if(name==='coverage'){p.coverage(q,i);return setCoverage(t,i);}
  if(['import','taobao-import','pdd-import'].includes(name)){
   const f=file(i.file,{extensions:name==='pdd-import'?/\.zip$/i:name==='taobao-import'?/\.csv$/i:/\.(csv|tsv|xlsx)$/i});
   if(name==='import'){const staged=await stageImport(t,f.buffer,f.originalname,i.context||{}),preview=await previewImport(t,staged.id,i.options||{});return {preview,batchId:staged.id,...commitImport(t,staged.id,preview.revision)};}
   const preview=name==='taobao-import'?await stageTaobao(t,f.buffer,f.originalname,i.shop_id):await stagePdd(t,f.buffer,f.originalname,{shop_id:i.shop_id});
   if(preview.status==='committed')return {skipped:true,batchId:preview.id};
   if(name==='pdd-import'&&i.shop_id==='__unassigned__')return {preview,stagedOnly:true,batchId:preview.id};
   return {preview,batchId:preview.id,...(name==='taobao-import'?commitTaobao:commitPdd)(t,preview.id,preview.revision)};
  }
  if(name==='import-rollback')return rollbackImport(t,i.id,i.reason);if(name==='batch-attribution')return setAttribution(t,i.id,i);
  if(name==='pdd-reference'){const input={...i};if(i.file){const f=file(i.file,{extensions:/\.(png|jpg|jpeg|webp)$/i});const rel=path.join('originals',hash(f.buffer)+path.extname(f.originalname));fs.writeFileSync(path.join(t.dir,rel),f.buffer);input.evidence_path=rel;input.evidence_name=f.originalname;}return saveReference(t,input);}
  if(name==='freight-create'||name==='freight-update')return saveFreight(t,{...i,request_id:'agent-'+hash(c.idempotencyKey||id()).slice(0,64)},(i.files||[]).map(f=>file(f)),name==='freight-update'?i.id:null);
  if(name==='freight-void')return voidFreight(t,i.id,{...i,request_id:'agent-'+hash(c.idempotencyKey||id()).slice(0,64)});
  if(name==='month-lock')return lockMonth(t,{month:i.month,revision:i.revision,confirmation:'锁定 '+i.month},{skipBackup:true});
  if(name==='month-unlock')return unlockMonth(t,{month:i.month,reason:i.reason,confirmation:'解锁 '+i.month},{skipBackup:true});
  if(name==='rates-refresh'){const data=monthData(t,month(i.month)),dates=[...data.operations.filter(x=>x.currency!=='CNY').map(x=>x.end),...data.ledger.filter(x=>x.date.startsWith(i.month)&&x.currency!=='CNY').map(x=>x.date)];return fetchRates(t,dates);}
  if(name==='job-create')return runJob(t,{period:i.period,trigger:'manual'});if(name==='staff-handoff')return p.handoff(q,i);
  if(name==='backup')return c.backup||{preview:'创建一致性备份'};
  if(name==='restore-copy')return restoreBackup(t,i.name,path.join(t.dir,'recovered',path.basename(i.name)));
  throw fail('业务能力未实现',501);
 }
 async function preview(name,input,c){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sales-agent-preview-'));let clone;
  try{await backup(s.db,path.join(dir,'sales.sqlite'));for(const name of ['originals','reports','backups'])if(fs.existsSync(path.join(s.dir,name)))fs.cpSync(path.join(s.dir,name),path.join(dir,name),{recursive:true});clone=openStore(dir);const result=await perform(clone,name,input,{...c,idempotencyKey:'preview-'+id()});const rates=name==='rates-refresh'?clone.all('SELECT * FROM rates ORDER BY date,currency'):null;return {result,rates};}
  finally{clone?.close();if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'sales-agent-preview-'))fs.rmSync(dir,{recursive:true,force:true});}
 }
 return {
  query(name,input,c){const key=name.replace(/^sales\./,'');if(key.startsWith('cainiao-'))return cainiao.query(name,input||{},c);const fn=queries[key];if(!fn)throw fail('查询能力未实现',501);return fn(input||{},c);},
  async prepare(name,input,c){const key=name.replace(/^sales\./,'');
   if(key==='cainiao-posting'){const draft=await cainiao.preview(input);return {summary:draft.summary,scope:draft.scope,blocks:draft.blocks,evidence:draft.evidence,issues:draft.issues,changes:[{operation:'freight-'+draft.postingAction,input:safeInput(draft.freightInput),sourceFingerprint:draft.sourceFingerprint,attachments:draft.uploads.map(({filename,sha256})=>({filename,sha256}))}],commitData:{operation:key,input,sourceFingerprint:draft.sourceFingerprint}};}
   if(key.startsWith('cainiao-'))return cainiao.prepare(name,input,c);
   if(key==='file-stage'){const artifact=c.stageFile(input.file);return {summary:'原件已保存，尚未入账',blocks:[{type:'download',...artifact}],evidence:[{fileId:artifact.id,sha256:artifact.sha256}],changes:[]};}
   if(key==='backup'){const result=await makeBackup(s,'agent-backup'),verified=verifyBackup(s,result.name),zip=new JSZip(),root=path.join(s.dir,'backups',result.name);const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));for(const f of manifest.files)zip.file(f.path,fs.readFileSync(path.join(root,f.path)));zip.file('manifest.json',JSON.stringify(manifest,null,2));const artifact=c.publishFile({filename:result.name+'.zip',bytes:await zip.generateAsync({type:'nodebuffer'}),mime:'application/zip'},'sales.backup');return {summary:'一致性备份已创建并校验',blocks:[{type:'download',...artifact},{type:'table',rows:[{...result,...verified}]}],evidence:[{sha256:artifact.sha256}],changes:[]};}
   input=hydrate(input,c);const {result,rates}=await preview(key,input,c);if(key==='rates-refresh'&&result.some(r=>['failed','locked'].includes(r.status)))throw fail('官方汇率获取失败或月份锁定，请处理后重新准备',409);const response=safeInput(result);return {summary:'复核销售业务：'+key,scope:{module:'sales',month:input.month||input.period||input.context?.month,shop:input.shop_id||input.context?.shop_id||'all'},blocks:[{type:'table',title:'业务预演结果',rows:[response]}],evidence:[...(input.file?[{filename:input.file.filename,sha256:input.file.sha256}]:[]),...(input.files||[]).map(f=>({filename:f.filename,sha256:f.sha256}))],changes:[{operation:key,input:safeInput(input),preview:response}],issues:[],commitData:{operation:key,input,...(rates?{rates}:{} )}};},
  async commit(data,c){if(data.operation==='cainiao-posting'){const draft=await cainiao.preview(data.input);if(!draft.ready||draft.sourceFingerprint!==data.sourceFingerprint)throw fail('云仓原件、分类或记录版本已改变，请重新复核',409,'CAINIAO_PREVIEW_CHANGED');return saveFreight(s,draft.freightInput,draft.uploads.map(f=>file(f)),draft.postingAction==='update'?draft.recordId:null);}if(data.operation==='rates-refresh'){return s.transaction(()=>{for(const r of data.rates){if(s.get('SELECT 1 FROM month_locks WHERE month=?',r.date.slice(0,7)))throw fail('月份已锁定',423,'MONTH_LOCKED');s.run('INSERT OR IGNORE INTO rates VALUES(?,?,?,?,?,?)',r.date,r.currency,r.rate,r.effective_date,r.source,r.sha256);}s.audit('fx.agent-commit',c.taskId,{count:data.rates.length});return {rates:data.rates.length};});}return perform(s,data.operation,data.input,c);},
  verify(data,result){const op=data.operation,i=data.input;let row,ok=false;
   if(['shop-create','ledger-create','ledger-update','match-create','job-create'].includes(op)){const table=op.startsWith('shop')?'shops':op.startsWith('ledger')?'ledger':op.startsWith('match')?'matches':'jobs';row=s.get('SELECT * FROM '+table+' WHERE id=?',result.id);ok=!!row;}
   else if(['shop-delete','ledger-delete','match-delete'].includes(op)){const table=op.startsWith('shop')?'shops':op.startsWith('ledger')?'ledger':'matches';ok=!s.get('SELECT 1 FROM '+table+' WHERE id=?',i.id);}
   else if(op==='coverage'){row=s.get('SELECT * FROM coverage WHERE shop_id=? AND month=? AND dataset=?',i.shop_id,i.month,i.dataset);ok=row?.status===i.status;}
   else if(['import','taobao-import','pdd-import','import-rollback'].includes(op)){row=s.get('SELECT * FROM imports WHERE id=?',result.batchId||i.id);ok=!!row&&(op==='import-rollback'?row.status!=='committed':result.stagedOnly||row.status==='committed');if(row)ok=ok&&hash(fs.readFileSync(path.join(s.dir,row.original_path)))===row.sha256;}
   else if(op==='batch-attribution'){row=s.get('SELECT * FROM batch_attributions WHERE import_id=?',i.id);ok=!!row;}
   else if(op==='pdd-reference'){row=s.get('SELECT * FROM platform_references WHERE shop_id=? AND month=?',i.shop_id,i.month);ok=!!row;}
   else if(op.startsWith('freight-')||op==='cainiao-posting'){row=freightRecord(s,result.id||i.id);ok=op==='freight-void'?row.status==='void':row.status==='active';for(const a of row.attachments||[]){const f=freightAttachment(s,a.id);ok=ok&&hash(fs.readFileSync(f.absolute))===a.sha256;}}
   else if(op==='month-lock'||op==='month-unlock'){row=s.get('SELECT * FROM month_locks WHERE month=?',i.month);ok=op==='month-lock'?!!row:!row;}
   else if(op==='rates-refresh'){ok=data.rates.every(r=>s.get('SELECT rate FROM rates WHERE date=? AND currency=?',r.date,r.currency)?.rate===r.rate);}
   else if(op==='staff-handoff'){row=s.get('SELECT * FROM sales_staff_handoffs WHERE month=?',i.month);ok=!!row;}
   else if(op==='restore-copy'){ok=fs.existsSync(path.join(result.path,'sales.sqlite'))&&verifyBackup(s,i.name).ok;}
   if(row&&result?.id===row.id)for(const [key,value]of Object.entries(result))if(Object.hasOwn(row,key)&&(value===null||typeof value!=='object'))ok=ok&&(row[key]===value||(typeof value==='boolean'&&row[key]===Number(value)));
   const integrity=s.get('PRAGMA integrity_check').integrity_check==='ok'&&s.all('PRAGMA foreign_key_check').length===0;return {ok:!!ok&&integrity,operation:op,recordId:row?.id||result.id||i.id||null,integrity};
  }
 };
}
