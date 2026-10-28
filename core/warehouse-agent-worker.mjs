// Isolated domain process: existing collectors/importers retain their environment
// contract without mutating the multi-module host's process.env or singleton DB.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {getDb,closeDb} from './erp/db.js';
import {importInventoryFile} from './erp/importers.js';
import {getInventoryNotificationGate,validateCainiaoInventoryFile,recordInventoryValidation,findLatestPriorCainiaoFile} from './erp/inventory-validation.js';
import {validateWarehouseMonthlySalesFile,importWarehouseMonthlySalesFile,getWarehouseMonthlySales,monthBounds,latestCompleteMonth,buildWarehouseMonthlySalesMarkdown,sendWarehouseMonthlySalesReport} from './erp/warehouse-monthly-sales.js';
import {buildInventoryMarkdown} from './erp/reports.js';
import {sendInventoryDingTalkMarkdown,inventoryDeliveryAccepted} from './dingtalk.js';
import {createWarehouseDaily,expectedInventoryDate,businessDate} from './erp/warehouse-daily.js';
import {readCainiaoInventory,inventorySnapshotFingerprint} from '../desktop/shared/inventory-store.mjs';

const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function executeWarehouseDomain({op,input={},databasePath,workspace,now:newNow}){
  if(!fs.existsSync(databasePath)||path.resolve(databasePath)!==path.join(path.resolve(process.env.ERP_DATA_DIR||''),'erp.sqlite'))throw Error('云仓子进程账本绑定不符');
  const now=()=>new Date(newNow||Date.now());
  function validate(a){
    if(a.kind==='sales')return validateWarehouseMonthlySalesFile({file:a.file,month:a.month,now:now()});
    const expectedSourceDate=expectedInventoryDate(now());
    const preliminary=validateCainiaoInventoryFile({file:a.file,expectedSourceDate,minRows:10});
    const previousFile=preliminary.sourceDate?findLatestPriorCainiaoFile({dir:path.join(workspace,'downloads'),currentFile:a.file,sourceDate:preliminary.sourceDate}):'';
    const v=validateCainiaoInventoryFile({file:a.file,expectedSourceDate,previousFile,minRows:10});
    if(v.sourceDate>businessDate(now())){v.ok=false;v.errors.push('库存来源日期不能晚于业务日');}return v;
  }
  function report(kind,month){
    if(kind==='sales'){const r=buildWarehouseMonthlySalesMarkdown(month);const originals=getDb().prepare("SELECT DISTINCT source_file,source_file_hash FROM warehouse_monthly_sales WHERE warehouse_id='cainiao' AND month=?").all(month),artifacts=getDb().prepare('SELECT payload FROM warehouse_agent_artifacts').all().map(row=>JSON.parse(row.payload));for(const source of originals){const collected=artifacts.find(a=>a.kind==='sales'&&a.month===month&&a.hash===source.source_file_hash),file=path.isAbsolute(source.source_file)?source.source_file:collected?.file||path.join(workspace,'downloads',source.source_file);if(!fs.existsSync(file)||!fs.realpathSync(file).startsWith(fs.realpathSync(workspace)+path.sep)||hash(file)!==source.source_file_hash)throw Object.assign(Error('月销量原件缺失或摘要变化，禁止发送'),{code:'WAREHOUSE_SOURCE_CHANGED'});}return {title:r.title,text:r.text,month,kind,sourceDigest:createHash('sha256').update(JSON.stringify(r.data)).digest('hex')};}
    const gate=getInventoryNotificationGate(),inventory=readCainiaoInventory(databasePath);
    if(!gate.ok||!inventory.validation?.matchesSnapshot||inventory.sourceDate<expectedInventoryDate(now())||inventory.sourceDate>businessDate(now()))throw Object.assign(Error('当前库存尚未通过最新来源及内容校验，不能发送'),{code:'WAREHOUSE_REPORT_INVALID'});
    const sourceRun=getDb().prepare('SELECT payload FROM warehouse_sync_runs ORDER BY started_at DESC,rowid DESC').all().map(r=>JSON.parse(r.payload)).find(r=>r.snapshotHash===inventorySnapshotFingerprint(inventory)&&r.validationId===gate.validation.id);
    const original=gate.validation.sourceFile,pathToOriginal=path.isAbsolute(original||'')?original:path.join(workspace,'downloads',original||'');
    if(!sourceRun?.fileHash||!fs.existsSync(pathToOriginal)||!fs.realpathSync(pathToOriginal).startsWith(fs.realpathSync(workspace)+path.sep)||hash(pathToOriginal)!==sourceRun.fileHash)throw Object.assign(Error('库存原件缺失或摘要变化，禁止发送'),{code:'WAREHOUSE_SOURCE_CHANGED'});
    const r=buildInventoryMarkdown('table');return {kind,title:r.title,text:r.shouldNotify?r.text:`### 云仓每日同步完成\n\n来源日期：${inventory.sourceDate}\n\n已校验入库 ${inventory.skuCount} 个 SKU，库存合计 ${inventory.totalQuantity}。当前无严重缺货预警。`,sourceDigest:inventorySnapshotFingerprint(inventory),validationId:gate.validation.id};
  }
  switch(op){
    case 'login':{const result=spawnSync(process.execPath,[fileURLToPath(new URL('./playwright-login.js',import.meta.url))],{env:process.env,cwd:workspace,stdio:'ignore',windowsHide:true,timeout:180000});if(result.error||result.status!==0)throw Object.assign(Error('登录未完成，需要主机本人处理验证码或授权'),{code:'CAINIAO_AUTH_REQUIRED'});return {status:'completed',message:'登录流程已结束；采集时仍须核对线上会话'};}
    case 'collect':{
      // Platform sessions/challenges remain in the established official collector.
      const {exportWithSingleAuthRecovery,exportFromCainiao}=await import('./sync-cainiao-inventory.js');
      const file=input.kind==='sales'?await exportFromCainiao({startDate:monthBounds(input.month).start,endDate:monthBounds(input.month).end}):await exportWithSingleAuthRecovery();
      if(!file||!fs.existsSync(file))throw Error('未采集到新原件，未入库或发送');return {file};}
    case 'validate':return validate(input);
    case 'sales.query':{
      if(input.from&&input.to){monthBounds(input.from);monthBounds(input.to);const start=Number(input.from.slice(0,4))*12+Number(input.from.slice(5)),end=Number(input.to.slice(0,4))*12+Number(input.to.slice(5));if(end<start||end-start>=120)throw Error('每次查询最多120个月');}return getWarehouseMonthlySales(input);}
    case 'missing-months':{
      monthBounds(input.from);monthBounds(input.to);if(input.from>input.to||input.to>latestCompleteMonth(now()))throw Error('补齐范围必须为已经结束的完整月份');
      const start=Number(input.from.slice(0,4))*12+Number(input.from.slice(5)),end=Number(input.to.slice(0,4))*12+Number(input.to.slice(5));if(end-start>=120)throw Error('每批补齐最多120个月');const report=getWarehouseMonthlySales(input);return report.monthly.filter(m=>m.completeness!=='valid').map(m=>m.month);}
    case 'report':return report(input.kind,input.month);
    case 'import':{
      // Validate the complete batch before the first write. Individual existing
      // importers own transactions; preserve explicit partial receipts on failure.
      const checked=input.artifacts.map(a=>{if(hash(a.file)!==a.hash)throw Error('原件摘要变化');const v=validate(a);if(!(v.ok??v.valid))throw Object.assign(Error('原件校验失败'),{code:'WAREHOUSE_VALIDATION_FAILED'});return {a,v};});
      const results=[];
      for(const {a,v}of checked){try{
        if(a.kind==='sales'){const result=importWarehouseMonthlySalesFile({file:a.file,month:a.month,now:now()});results.push({artifactId:a.id,month:a.month,unchanged:result.unchanged});}
        else{
          recordInventoryValidation({...v,file:a.file});const db=getDb(),validationId=Number(db.prepare("SELECT MAX(id) AS id FROM inventory_data_validations WHERE warehouse_id='cainiao'").get().id);
          const result=importInventoryFile({file:a.file,warehouseId:'cainiao',snapshotDate:v.sourceDate});
          db.prepare("UPDATE skus SET status='inactive' WHERE source='inventory' AND status='active' AND sku NOT IN(SELECT sku FROM inventory_snapshots WHERE warehouse_id='cainiao' AND snapshot_date=?)").run(v.sourceDate);
          const daily=createWarehouseDaily({databasePath,now});try{const runId=daily.beginRun({expectedSourceDate:v.expectedSourceDate});daily.updateRun(runId,{collectedAt:a.createdAt,collectionStatus:'success',fileHash:a.hash,sourceDate:v.sourceDate,validationId,rowCount:v.rowCount,totalQuantity:v.totalQuantity,validationStatus:'success',validatedAt:now().toISOString(),importedAt:now().toISOString()});results.push({artifactId:a.id,runId,...result});}finally{daily.close();}
        }
      }catch(e){return {status:'partial',results,failedArtifactId:a.id,errorCode:e.code||'WAREHOUSE_IMPORT_FAILED',backupId:path.basename(input.backupPath)};}}
      return {status:'completed',results,backupId:path.basename(input.backupPath)};}
    case 'send':{
      const current=report(input.kind,input.month);if(current.sourceDigest!==input.report.sourceDigest||current.title!==input.report.title||current.text!==input.report.text)throw Error('报告或来源指纹变化，请重新复核');
      if(input.kind==='sales'){const r=await sendWarehouseMonthlySalesReport(input.month);return {status:r.sent?'accepted':r.delivery?.status==='sent'?'accepted':'unknown',deduplicated:Boolean(r.skipped)};}
      const db=getDb(),runs=db.prepare('SELECT id,payload FROM warehouse_sync_runs ORDER BY started_at DESC,rowid DESC').all().map(r=>({...r,data:JSON.parse(r.payload)})),matching=r=>r.data.snapshotHash===current.sourceDigest&&r.data.validationId===current.validationId;
      const previous=runs.find(r=>matching(r)&&['unknown','accepted'].includes(r.data.deliveryStatus));if(previous)return {status:previous.data.deliveryStatus,deduplicated:true,runId:previous.id};
      const run=runs.find(r=>matching(r));if(!run)throw Error('缺少与原件及校验批次匹配的同步记录，禁止发送');
      const daily=createWarehouseDaily({databasePath,now});try{daily.updateRun(run.id,{deliveryStatus:'unknown'});const r=await sendInventoryDingTalkMarkdown({title:current.title,text:current.text,shouldNotify:true});const accepted=inventoryDeliveryAccepted(r);daily.updateRun(run.id,{deliveryStatus:accepted?'accepted':'unknown',...(accepted?{sentAt:now().toISOString()}:{}),deliveryReceipt:JSON.stringify(r).slice(0,2000)});return {status:accepted?'accepted':'unknown',runId:run.id};}finally{daily.close();}}
    default:throw Error('未知云仓领域命令');
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [, ,job,output]=process.argv;
  try{const value=await executeWarehouseDomain(JSON.parse(fs.readFileSync(job)));fs.writeFileSync(output,JSON.stringify({ok:true,value}),{flag:'wx'});}
  catch(e){fs.writeFileSync(output,JSON.stringify({ok:false,code:e.code||'WAREHOUSE_DOMAIN_ERROR',message:'云仓领域任务失败；请核对原件、登录状态和任务回执'}),{flag:'wx'});process.exitCode=1;}
  finally{closeDb();}
}
