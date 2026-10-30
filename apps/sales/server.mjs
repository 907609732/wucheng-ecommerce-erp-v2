import {stageTaobao,commitTaobao,taobaoFunds,taobaoStatement,taobaoMovements,taobaoMovement,taobaoMovementRows} from './lib/taobao.mjs';
import {installLocalIntegration} from './lib/local-integration.mjs';
import {installWorkbenchMigration} from './lib/workbench-migration-routes.mjs';
import {createWorkbenchMigration} from './lib/workbench-migration.mjs';
import {installWorkbenchAudit} from './lib/workbench-module.mjs';
import {installSalesEdits} from './lib/integration-edits.mjs';
import {installAgentService} from './lib/agent-service.mjs';
import {createSalesAgentActions,authorizeSalesAgent} from './lib/agent-actions.mjs';
import {salesModuleCapabilities} from './lib/agent-adapter.mjs';
import {createSalesCainiao} from './lib/agent-cainiao.mjs';
import {createSalesDomainPeople} from './lib/agent-people.mjs';
import {createArchiveHandoffs} from './lib/agent-archive-bridge.mjs';
import {ServiceManager} from './lib/service-manager.mjs';
import {createPersonnel} from './lib/personnel.mjs';
import {deleteEmptyShop} from './lib/shops.mjs';
import express from 'express';
import {installFreightRoutes} from './lib/freight-routes.mjs';
import multer from 'multer';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {openStore} from './lib/db.mjs';
import {SHOPS,KINDS,DATASETS,CURRENCIES} from './lib/config.mjs';
import {beijing,shiftMonth,month,fail,monthsBetween,money,hash,id,now,required} from './lib/util.mjs';
import {addLedger,editLedger,deleteLedger,createMatch,removeMatch,setCoverage} from './lib/ledger.mjs';
import {report,reconciliationDetail,monthData} from './lib/report.mjs';
import {stageImport,previewImport,commitImport,rollbackImport,FIELDS} from './lib/importer.mjs';
import {makeBackup,verifyBackup,listBackups,restoreBackup} from './lib/backup.mjs';
import {closePreview,lockMonth,unlockMonth} from './lib/close.mjs';
import {fetchRates} from './lib/fx.mjs';
import {exportWorkbook,exportPddMovements} from './lib/export.mjs';
import {runJob,sourceStatus,duePeriods} from './lib/jobs.mjs';
import {stagePdd,pddPreview,commitPdd,pddFundsReport,pddStatementYear,setAttribution,unassignedBatches,movementsPage,movementRows,movementDetail,saveReference} from './lib/pdd.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export function createApp({dataDir=path.join(root,'data'),port=17869,demo=false,cainiaoBrowser,cainiaoOptions={}}={}) {
  const s=openStore(dataDir),app=express(),token=randomBytes(32).toString('hex'),personnel=createPersonnel(s);
  const domainPeople=createSalesDomainPeople(s);
  const archiveHandoffs=createArchiveHandoffs(s);
  const cainiao=createSalesCainiao({store:s,browser:cainiaoBrowser,...cainiaoOptions});
  s.agentTransactionGuard=()=>{if(cainiao.manager.active)throw fail('云仓下载仍在归档，请完成或暂停后提交业务',409,'BACKGROUND_TASK_BUSY');};
  const integration=installLocalIntegration(app,{id:'wucheng-sales-desk',version:JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version,root,dataDir,authorize:personnel.authorize,busy:()=>edits.busy()||!!s.get("SELECT 1 FROM jobs WHERE state IN ('running','pending') LIMIT 1"),capabilities:['report.read','ledger.read','overview.open','edits.prepare','edits.review-ui']});
  const edits=installSalesEdits(integration,s);
  integration.agentBlocked=()=>edits.busy()||!!s.get("SELECT 1 FROM jobs WHERE state='running' LIMIT 1");
  integration.router.get('/report',(q,r)=>r.json(report(s,q.query)));
  integration.router.get('/ledger',(q,r)=>r.json({rows:monthData(s,month(q.query.month)).ledger}));
  integration.router.post('/overview/open',async(q,r)=>r.json(q.workbenchActor?{route:'/apps/overview/'}:await new ServiceManager().ensure('overview')));
  installWorkbenchMigration(integration,s,createWorkbenchMigration);installWorkbenchAudit(integration,s);
  integration.finish();
  const agent=installAgentService({app,integration,store:s,module:'sales',capabilities:salesModuleCapabilities,actions:createSalesAgentActions({store:s,personnel,cainiao,domainPeople,archiveHandoffs}),authorize:authorizeSalesAgent,backup:()=>makeBackup(s,'before-agent-commit')});
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const allowed=[`127.0.0.1:${port}`,`localhost:${port}`];
    if(!allowed.includes(req.headers.host))return res.status(403).json({error:'仅允许本机访问'});
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');
    res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if(!req.workbenchActor&&req.headers['x-sales-token']!==token)return res.status(403).json({error:'页面已过期，请刷新后重试'});
      if(req.headers.origin&&!allowed.map(x=>'http://'+x).includes(req.headers.origin))return res.status(403).json({error:'来源不符'});
    }
    next();
  });
  app.use(express.json({limit:'3mb'}));
  const multipart=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1}});
  const upload={single:field=>[multipart.single(field),(q,_r,next)=>{
    if(q.file){const original=q.file.originalname,decoded=Buffer.from(original,'latin1').toString('utf8');if(!decoded.includes('\uFFFD')&&Buffer.from(decoded,'utf8').toString('latin1')===original)q.file.originalname=decoded;}
    next();
  }]};
  installFreightRoutes(app,s);
  app.get('/api/health',(q,r)=>r.json({ok:true,app:'wucheng-sales-desk',version:integration.state.version,demo}));
  app.get('/api/bootstrap',(q,r)=>{const identity=personnel.current(q);r.json({token,personnel:identity,shops:identity.selected?s.shops():[],kinds:KINDS,datasets:DATASETS,currencies:CURRENCIES,fields:FIELDS,month:shiftMonth(beijing().month,-1),today:beijing().date,demo,pendingEdits:identity.canReconcile?s.get("SELECT COUNT(*) count FROM integration_edit_drafts WHERE state='draft'").count:0,schedule:{enabled:s.setting('schedulerEnabled',false),time:'每月 15 日 20:00（北京时间）',due:identity.canReviewReport?duePeriods(s):[]},notices:identity.canReconcile?s.all('SELECT * FROM notices ORDER BY created_at DESC LIMIT 20'):[]});});
  app.get('/api/personnel/session',(q,r)=>r.json(personnel.current(q)));
  app.post('/api/personnel/session',(q,r)=>r.json(personnel.select(q,r,q.body.role)));
  app.get('/api/task-center',(q,r)=>r.json(personnel.taskCenter(q,month(q.query.month))));
  app.post('/api/personnel/handoff',(q,r)=>r.json(personnel.handoff(q,q.body)));
  app.get('/api/manual-summary',(q,r)=>r.json(personnel.manualSummary(month(q.query.month),q.query.shop||'all')));
  app.delete('/api/shops/:id',(q,r)=>{if(!personnel.current(q).canReconcile)throw fail('只有老板可以删除店铺',403,'BOSS_REQUIRED');r.json(deleteEmptyShop(s,q.params.id,q.body));});
  app.post('/api/shops',(q,r)=>{const name=required(q.body.name,'店铺名称',80),platform=required(q.body.platform,'平台');if(!['淘宝','拼多多','京东','闲鱼','抖店','Ozon','线下','代发'].includes(platform))throw fail('不支持的平台');if(s.get('SELECT 1 FROM shops WHERE platform=? AND name=?',platform,name))throw fail('店铺名称已存在');const shopId='shop-'+id(),manual=['线下','代发'].includes(platform);s.transaction(()=>{s.run('INSERT INTO shops VALUES(?,?,?,?,?)',shopId,platform,name,'待核实',+manual);s.audit('shop.create',shopId,{name,platform});});r.json({id:shopId,name,platform,manual});});
  app.get('/api/report',(q,r)=>r.json(report(s,q.query)));
  app.get('/api/reconciliation',(q,r)=>r.json(reconciliationDetail(s,month(q.query.month),q.query.shop||'all')));
  app.get('/api/ledger',(q,r)=>{const data=monthData(s,month(q.query.month));r.json(personnel.ledgerRows(q,data.ledger.filter(x=>(!q.query.shop||q.query.shop==='all'||x.shop_id===q.query.shop)&&x.date.startsWith(q.query.month))));});
  app.post('/api/ledger',(q,r)=>{personnel.ledgerWrite(q,q.body);r.json(addLedger(s,q.body));});
  app.put('/api/ledger/:id',(q,r)=>{personnel.ledgerWrite(q,q.body,q.params.id);r.json(editLedger(s,q.params.id,q.body));});
  app.delete('/api/ledger/:id',(q,r)=>{personnel.ledgerWrite(q,q.body,q.params.id);r.json(deleteLedger(s,q.params.id,q.body.reason));});
  app.post('/api/matches',(q,r)=>r.json(createMatch(s,q.body)));
  app.delete('/api/matches/:id',(q,r)=>r.json(removeMatch(s,q.params.id,q.body.reason)));
  app.post('/api/coverage',(q,r)=>{personnel.coverage(q,q.body);r.json(setCoverage(s,q.body));});
  app.get('/api/sources',(q,r)=>r.json(personnel.sources(q,month(q.query.month))));
  app.get('/api/history-coverage',(q,r)=>{const end=shiftMonth(beijing().month,-1);r.json(monthsBetween('2025-01',end).map(m=>({month:m,full:s.get("SELECT COUNT(*) n FROM coverage WHERE month=? AND status='full'",m).n,expected:s.shops().reduce((n,x)=>n+(x.manual?3:4),0),locked:!!s.get('SELECT 1 FROM month_locks WHERE month=?',m)})));});
  app.post('/api/imports',upload.single('file'),async(q,r)=>{if(!q.file)throw fail('请选择文件');r.json(await stageImport(s,q.file.buffer,q.file.originalname,q.body));});
  app.post('/api/pdd/import',upload.single('file'),async(q,r)=>{if(!q.file)throw fail('请选择拼多多 ZIP 账单');r.json(await stagePdd(s,q.file.buffer,q.file.originalname,{shop_id:q.body.shop_id}));});
  app.get('/api/pdd/import/:id',(q,r)=>r.json(pddPreview(s,q.params.id)));
  app.post('/api/pdd/import/:id/commit',async(q,r)=>{await makeBackup(s,'before-pdd-import');r.json(commitPdd(s,q.params.id,q.body.revision));});
  app.post('/api/taobao/import',upload.single('file'),async(q,r)=>{if(!q.file)throw fail('请选择淘宝交易货款 CSV');r.json(await stageTaobao(s,q.file.buffer,q.file.originalname,q.body.shop_id));});
  app.post('/api/taobao/import/:id/commit',async(q,r)=>{await makeBackup(s,'before-taobao-import');r.json(commitTaobao(s,q.params.id,q.body.revision));});
  app.get('/api/taobao/funds',(q,r)=>r.json(taobaoFunds(s,q.query.period,q.query.grain||'month',q.query.shop_id)));
  app.get('/api/taobao/statement',(q,r)=>r.json(taobaoStatement(s,q.query.year,q.query.shop_id)));
  app.get('/api/taobao/movements',(q,r)=>r.json(taobaoMovements(s,q.query)));
  app.get('/api/taobao/movements-export',async(q,r)=>{r.attachment('taobao-movements.xlsx');r.send(await exportPddMovements(s,q.query,taobaoMovementRows));});
  app.get('/api/taobao/movements/:id',(q,r)=>r.json(taobaoMovement(s,q.params.id,q.query)));
  app.get('/api/pdd/funds',(q,r)=>{const period=q.query.period||q.query.month,grain=q.query.grain||'month';r.json(pddFundsReport(s,period,grain,q.query.shop_id));});
  app.get('/api/pdd/statement',(q,r)=>r.json(pddStatementYear(s,q.query.year,q.query.shop_id)));
  app.get('/api/pdd/movements',(q,r)=>r.json(movementsPage(s,q.query)));
  app.get('/api/pdd/movements/:id',(q,r)=>r.json(movementDetail(s,q.params.id,q.query)));
  app.get('/api/pdd/movements-export',async(q,r)=>{r.set('Content-Disposition','attachment; filename="pdd-movements.xlsx"');r.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await exportPddMovements(s,q.query));});
  app.get('/api/pdd/unassigned',(q,r)=>r.json(unassignedBatches(s)));
  app.post('/api/imports/:id/attribution',async(q,r)=>{await makeBackup(s,'before-batch-attribution');r.json(setAttribution(s,q.params.id,q.body));});
  app.post('/api/pdd/shops',(q,r)=>{const name=required(q.body.name,'店铺名称',80);if(s.get("SELECT 1 FROM shops WHERE platform='拼多多' AND name=?",name))throw fail('店铺名称已存在');const shopId='pdd-'+id();s.transaction(()=>{s.run('INSERT INTO shops VALUES(?,?,?,?,?)',shopId,'拼多多',name,'待核实',0);s.audit('shop.create',shopId,{name,platform:'拼多多'});});r.json({id:shopId,name,platform:'拼多多',manual:false});});
  app.post('/api/pdd/references',upload.single('file'),(q,r)=>{
    let evidence_path=null;if(q.file){if(!['image/png','image/jpeg','image/webp'].includes(q.file.mimetype))throw fail('参考截图请使用 PNG、JPEG 或 WebP');const ext=q.file.mimetype==='image/png'?'.png':q.file.mimetype==='image/webp'?'.webp':'.jpg';evidence_path=path.join('originals',hash(q.file.buffer)+ext);writeFileSync(path.join(s.dir,evidence_path),q.file.buffer);}
    const input={shop_id:q.body.shop_id,month:q.body.month,cutoff:String(q.body.cutoff||'').slice(0,10)+' 23:59:59',evidence_path,evidence_name:q.file?.originalname||'平台人工参考'};
    for(const key of ['income','expense','opening_balance','closing_balance'])input[key]=money(q.body[key],true);
    for(const key of ['income_count','expense_count']){input[key]=q.body[key]==null||q.body[key]===''?null:Number(q.body[key]);}
    r.json(saveReference(s,input));
  });
  app.get('/api/pdd/references/:id/evidence',(q,r)=>{const ref=s.get('SELECT payload FROM platform_references WHERE id=?',q.params.id),relative=ref&&JSON.parse(ref.payload).evidence_path;if(!relative)throw fail('没有参考截图',404);const file=path.resolve(s.dir,relative);if(!file.startsWith(path.resolve(s.dir,'originals')+path.sep))throw fail('原件路径无效');r.sendFile(file);});
  app.get('/api/report-history',(q,r)=>r.json(s.all('SELECT * FROM report_history ORDER BY created_at DESC')));
  app.get('/api/imports',(q,r)=>r.json(s.all("SELECT i.id,i.shop_id,i.dataset,i.filename,i.sha256,i.created_at,i.status,i.context_json,COALESCE(a.status,'confirmed') attribution FROM imports i LEFT JOIN batch_attributions a ON a.import_id=i.id ORDER BY i.created_at DESC LIMIT 200")));
  app.post('/api/imports/:id/preview',async(q,r)=>r.json(await previewImport(s,q.params.id,q.body)));
  app.post('/api/imports/:id/commit',async(q,r)=>{await makeBackup(s,'before-import');r.json(commitImport(s,q.params.id,q.body.revision));});
  app.post('/api/imports/:id/rollback',async(q,r)=>{await makeBackup(s,'before-import-rollback');r.json(rollbackImport(s,q.params.id,q.body.reason));});
  app.get('/api/imports/:id/original',(q,r)=>{const b=s.get('SELECT * FROM imports WHERE id=?',q.params.id);if(!b)throw fail('原件不存在',404);r.download(path.join(s.dir,b.original_path),b.filename);});
  app.get('/api/template/:type',(q,r)=>{const fields=FIELDS[q.params.type];if(!fields)throw fail('模板不存在');r.set('Content-Disposition',`attachment; filename="${q.params.type}-template.csv"`);r.type('text/csv').send('\ufeff'+Object.keys(fields).join(',')+'\r\n');});
  app.get('/api/close',(q,r)=>r.json(closePreview(s,month(q.query.month))));
  app.post('/api/close/lock',async(q,r)=>r.json(await lockMonth(s,q.body)));
  app.post('/api/close/unlock',async(q,r)=>r.json(await unlockMonth(s,q.body)));
  app.get('/api/close/history',(q,r)=>r.json(s.all('SELECT id,month,action,reason,created_at FROM month_history ORDER BY created_at DESC LIMIT 100')));
  app.get('/api/audit',(q,r)=>r.json(s.all('SELECT * FROM audit ORDER BY id DESC LIMIT 200')));
  app.post('/api/rates',async(q,r)=>{const m=month(q.body.month),data=monthData(s,m);const dates=[...data.operations.filter(x=>x.currency!=='CNY').map(x=>x.end),...data.ledger.filter(x=>x.date.startsWith(m)&&x.currency!=='CNY').map(x=>x.date)];r.json(await fetchRates(s,dates));});
  app.get('/api/export',async(q,r)=>{const buf=await exportWorkbook(s,q.query);r.set('Content-Disposition',`attachment; filename="sales-${q.query.period}.xlsx"`);r.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);});
  app.get('/api/backups',(q,r)=>r.json(listBackups(s).map(({name,files,created_at,bytes,reason})=>({name,files:files.length,created_at,bytes,reason}))));
  app.post('/api/backups',async(q,r)=>r.json(await makeBackup(s)));
  app.post('/api/backups/:name/verify',(q,r)=>r.json(verifyBackup(s,q.params.name)));
  app.post('/api/backups/:name/restore-copy',(q,r)=>r.json(restoreBackup(s,q.params.name,path.join(s.dir,'recovered',q.params.name))));
  app.get('/api/jobs',(q,r)=>r.json(s.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').map(j=>({...j,report_status:s.get('SELECT status FROM report_history WHERE filename=?',(()=>{try{return JSON.parse(j.detail).file||'';}catch{return '';}})())?.status||'current'}))));
  app.post('/api/jobs',async(q,r)=>r.json(await runJob(s,{period:q.body.period,trigger:'manual'})));
  app.get('/api/jobs/:id/report',(q,r)=>{const job=s.get('SELECT * FROM jobs WHERE id=?',q.params.id);const file=job&&JSON.parse(job.detail).file;if(!file)throw fail('报告尚未生成',404);r.download(path.join(s.dir,'reports',path.basename(file)),`sales-${job.period}.xlsx`);});
  app.use('/vendor/chart',express.static(path.join(root,'node_modules/chart.js/dist')));
  app.use('/vendor/tabulator',express.static(path.join(root,'node_modules/tabulator-tables/dist')));
  app.use(express.static(path.join(root,'public')));integration.workbench.finalize();
  app.use((err,q,r,next)=>{const msg=String(err.message||'');const locked=msg.includes('MONTH_LOCKED'),constraint=msg.includes('constraint');const status=err.status||err.statusCode;const message=locked?'月份已锁定，原件可保留待处理；如需改动请先明确解锁。':constraint?'记录重复或存在关联关系，请核对业务编号与匹配记录。':status?msg:err.code==='LIMIT_FILE_SIZE'?'文件超过 25 MB':['LIMIT_FILE_COUNT','LIMIT_UNEXPECTED_FILE'].includes(err.code)?'附件数量超限或附件字段无效': '操作未完成，请检查文件格式和填写内容。';if(!status&&!locked&&!constraint)console.error(err.stack);r.status(locked?423:status||400).json({error:message,code:locked?'MONTH_LOCKED':err.code||'FAILED',...(err.details?{details:err.details}:{})});});
  return {app,store:s,integration,agent,cainiao};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.SALES_PORT||17869),{app,store,integration,cainiao}=createApp({port,dataDir:process.env.SALES_DATA_DIR||path.join(root,'data'),demo:process.env.SALES_DEMO==='1'});
  const server=app.listen(port,'127.0.0.1',err=>{
    if(err){console.error(`Sales desk failed to listen on ${port}: ${err.code||err.message}`);store.close();process.exitCode=1;return;}
    console.log(`灵兔电商销售台 http://127.0.0.1:${port}`);
  });
  integration.attach(server);
  const shutdown=()=>server.close(async()=>{await cainiao.close();store.close();process.exit(0);});integration.onStop=shutdown;process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
