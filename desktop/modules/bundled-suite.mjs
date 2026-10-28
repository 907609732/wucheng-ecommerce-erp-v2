import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {atomicJson} from './module-manager.mjs';
import {MODULE_IDS,fail,inside,digest} from './package-format.mjs';

const productId='com.wucheng.ecommerce.erp.v2';
const businessIds=['warehouse','purchase','sales','overview','exporter'];
const order=['node-runtime','browser-runtime',...businessIds];
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const running=(id,cap)=>!!cap&&(id==='warehouse'||id==='exporter'?!!cap.running:true);
const samePackage=(installed,spec)=>installed?.version===spec.version&&installed.sha256===spec.sha256&&
  typeof installed.root==='string'&&fs.existsSync(inside(installed.root,spec.entry));

/** Verify the same signed catalog used by downloadable and offline packages.
 * Nothing in this function starts a service, creates a ledger or writes state. */
export function inspectBundledSuite({modules,bundleDirectory}){
  if(!bundleDirectory||!fs.existsSync(path.join(bundleDirectory,'catalog.json')))return null;
  const catalogFile=path.join(bundleDirectory,'catalog.json');
  if(fs.lstatSync(bundleDirectory).isSymbolicLink()||fs.lstatSync(catalogFile).isSymbolicLink()||fs.statSync(catalogFile).size>3*1024**2)throw fail('INVALID_SUITE','一体化套装目录或签名清单无效');
  const bytes=fs.readFileSync(catalogFile),envelope=JSON.parse(bytes),catalog=modules.validate(envelope),suite=catalog.suite;
  if(suite?.format!=='lingtu-suite/v1'||suite.productId!==productId||suite.version!==modules.hostVersion||
    !Array.isArray(suite.components)||suite.components.length!==MODULE_IDS.length||catalog.packages.length!==MODULE_IDS.length||
    new Set(suite.components.map(x=>x.id)).size!==MODULE_IDS.length)throw fail('INCOMPATIBLE_SUITE','完整套装与工作台版本不匹配');
  for(const id of MODULE_IDS){
    const spec=catalog.packages.find(x=>x.id===id),component=suite.components.find(x=>x.id===id);
    if(!spec||!component||component.version!==spec.version||component.sha256!==spec.sha256)throw fail('INVALID_SUITE','完整套装组件清单不一致');
    catalog.compatible(spec);
  }
  return {envelope,catalog,suite,fingerprint:hash(bytes),directory:path.resolve(bundleDirectory)};
}

/** One product activation. A durable product journal and module-owned maintenance
 * fences keep all writes blocked until every component is healthy. Per-module
 * recovery remains delegated to ModuleManager and its existing lifecycle. */
export async function ensureBundledSuite({modules,services,profile,bundleDirectory,mode,headless=false,forceVerification=false,onProgress=()=>{},beforeRelease=async()=>{}}){
  // Remote clients must never install local business services or initialize books.
  if(mode==='client')return {ready:true,remote:true,activated:false};
  if(!['server','standalone'].includes(mode))throw fail('INVALID_MODE','工作台运行方式无效');
  const bundle=inspectBundledSuite({modules,bundleDirectory});
  if(!bundle)return {ready:false,setupRequired:true,reason:'bundle-missing'};
  const journalFile=path.join(profile,'suite-activation.json'),receiptFile=path.join(profile,'suite-current.json');
  const locations=Object.fromEntries(businessIds.map(id=>[id,path.resolve(services.config(id).dataDir)]));
  const complete=()=>order.every(id=>samePackage(modules.state().packages[id],bundle.catalog.packages.find(x=>x.id===id)));
  const receipt=read(receiptFile);
  if(!forceVerification&&!fs.existsSync(journalFile)&&receipt?.fingerprint===bundle.fingerprint&&JSON.stringify(receipt.locations)===JSON.stringify(locations)&&complete())return {ready:true,activated:false,version:bundle.suite.version};
  if(headless)return {ready:false,setupRequired:true,reason:fs.existsSync(journalFile)?'activation-pending':'first-run'};
  onProgress({phase:'preparing',version:bundle.suite.version});
  return modules.exclusive(async()=>{
    let journal=read(journalFile);
    if(journal&&journal.fingerprint!==bundle.fingerprint)throw fail('SUITE_RECOVERY_REQUIRED','另一版本的整套升级尚未恢复，请先使用原升级包完成恢复');
    if(journal){
      const markerPaths=new Set(businessIds.map(id=>path.join(services.config(id).dataDir,'.workbench-maintenance.json')));
      if(journal.format!=='lingtu-suite-activation/v1'||!/^[a-f0-9-]{36}$/i.test(journal.suiteId||'')||!['fencing','installing','checking','completing','releasing','committed'].includes(journal.phase)||!Array.isArray(journal.markers)||journal.markers.some(file=>!markerPaths.has(file))||new Set(journal.markers).size!==journal.markers.length||journal.completed&&(!Array.isArray(journal.completed)||journal.completed.some(id=>!order.includes(id))||new Set(journal.completed).size!==journal.completed.length))throw fail('SUITE_RECOVERY_REQUIRED','套装恢复记录与当前数据目录不符，请保留文件并核对');
    }
    const specs=order.map(id=>bundle.catalog.packages.find(x=>x.id===id));
    // Verify all artifacts before any business backup, stop or mutation. A corrupt
    // late package must not leave an otherwise healthy suite half replaced.
    for(const spec of specs){
      const archive=inside(bundle.directory,spec.archive);
      if(!fs.existsSync(archive)||fs.lstatSync(archive).isSymbolicLink()||fs.statSync(archive).size!==spec.bytes||await digest(archive)!==spec.sha256)throw fail('INCOMPLETE_SUITE','完整套装损坏或缺少组件：'+spec.id);
      const installed=modules.state().packages[spec.id];
      if(installed?.version===spec.version&&installed.sha256!==spec.sha256)throw fail('COMPONENT_VERSION_REUSED','组件内容已变化但版本未更新：'+spec.id);
    }
    if(!journal){
      const wasRunning={};
      for(const id of businessIds){await modules.lifecycle.checkIdle(id);wasRunning[id]=running(id,await services.capabilities(id));}
      journal={format:'lingtu-suite-activation/v1',suiteId:randomUUID(),fingerprint:bundle.fingerprint,version:bundle.suite.version,phase:'fencing',wasRunning,markers:[],startedAt:new Date().toISOString()};
      atomicJson(journalFile,journal);
    }
    const save=()=>atomicJson(journalFile,journal);
    const ownMarker=file=>{const marker=read(file);return marker?.suiteId===journal.suiteId&&marker?.format==='lingtu-suite-maintenance/v1';};
    const clearFences=()=>{
      // Validate the whole set before removing any fence. A migration coordinator
      // may have taken ownership since the release phase was interrupted.
      for(const file of journal.markers)if(fs.existsSync(file)&&!ownMarker(file))throw fail('SUITE_RECOVERY_REQUIRED','维护标记已由其他任务接管，请核对后恢复');
      for(const file of journal.markers)if(ownMarker(file))fs.unlinkSync(file);
    };
    const originalLifecycle=modules.lifecycle;
    const releaseForward=async recovered=>{
      // Native cloud/exporter activation correctly refuses a still-present
      // maintenance file. All books are already healthy and beforeRelease has
      // succeeded at this durable point. Never re-install, restore or recompare
      // that old data snapshot after any module has been released for editing.
      if(!complete())throw fail('SUITE_RECOVERY_REQUIRED','放行阶段的程序文件已变化，不能自动重装或覆盖账本');
      clearFences();journal.completed||=[];save();
      for(const spec of specs){
        if(journal.completed.includes(spec.id))continue;
        await originalLifecycle.complete?.(modules.state().packages[spec.id]);
        journal.completed.push(spec.id);save();
      }
      clearFences();
      atomicJson(receiptFile,{format:'lingtu-suite-current/v1',version:bundle.suite.version,fingerprint:bundle.fingerprint,components:bundle.suite.components,locations,activatedAt:new Date().toISOString()});
      journal.phase='committed';save();fs.unlinkSync(journalFile);
      const idleStopWarnings=[];
      // A resumed release may coexist with later legitimate use. Do not stop
      // those services merely because they were idle before the interrupted run.
      if(!recovered){const warehouseSettings=read(path.join(services.config('warehouse').dataDir,'settings.json'))||{};
        for(const id of businessIds)if(!journal.wasRunning[id]&&!(id==='warehouse'&&(warehouseSettings.scheduleEnabled||warehouseSettings.monthlySalesEnabled)))try{await services.stop(id);}catch{idleStopWarnings.push(id);}}
      onProgress({phase:'ready',version:bundle.suite.version});
      return {ready:true,activated:true,recovered,version:bundle.suite.version,idleStopWarnings};
    };
    if(journal.phase==='committed'){
      clearFences();fs.unlinkSync(journalFile);return {ready:true,activated:true,recovered:true,version:bundle.suite.version};
    }
    if(journal.phase==='releasing'){
      try{return await releaseForward(true);}catch(error){journal.error={code:error.code||'SUITE_RELEASE_FAILED',message:error.message};save();throw fail('SUITE_RECOVERY_REQUIRED','整套程序放行尚未完成，请重新打开工作台继续；已开放的账本不会回退。'+error.message);}
    }
    // Only config-owned data directories are accepted. The root migration pass
    // selects/binds these locations before calling this function.
    for(const id of businessIds){
      const config=services.config(id),file=path.join(config.dataDir,'.workbench-maintenance.json');
      if(fs.existsSync(file)&&!ownMarker(file))throw fail('SERVICE_MAINTENANCE','已有迁移或维护任务尚未结束：'+id);
      if(!journal.markers.includes(file)){journal.markers.push(file);save();}
      fs.mkdirSync(config.dataDir,{recursive:true});
      if(!ownMarker(file))atomicJson(file,{format:'lingtu-suite-maintenance/v1',suiteId:journal.suiteId,version:journal.version,maintenance:true});
    }
    journal.phase='installing';save();modules.setCatalog(bundle.envelope);
    modules.lifecycle={...originalLifecycle,complete:async()=>{}};
    try{
      for(const spec of specs){
        onProgress({phase:'installing',component:spec.id,version:spec.version});
        await modules.installOne(spec,{id:spec.id,offlineDirectory:bundle.directory,signal:new AbortController().signal});
      }
      journal.phase='checking';save();
      // All modules must identify the expected original books while fenced.
      for(const id of businessIds){await services.ensure(id);await originalLifecycle.health(modules.state().packages[id]);}
      await beforeRelease({suiteId:journal.suiteId,version:bundle.suite.version});
      journal.phase='releasing';journal.completed=[];save();
      return await releaseForward(false);
    }catch(error){
      journal.error={code:error.code||'SUITE_ACTIVATION_FAILED',message:error.message};save();
      throw fail('SUITE_RECOVERY_REQUIRED',(journal.phase==='releasing'?'整套程序放行尚未完成，重新打开工作台将只向前完成；已开放的账本不会回退。':'整套升级尚未完成，已保持业务维护锁；重新打开工作台可继续恢复。')+error.message);
    }finally{modules.lifecycle=originalLifecycle;}
  });
}
