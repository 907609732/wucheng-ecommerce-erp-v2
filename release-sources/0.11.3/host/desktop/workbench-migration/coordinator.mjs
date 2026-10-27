import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const canonical=value=>JSON.stringify(sort(value));
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;}
export const digest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
const fail=(code,message)=>Object.assign(Error(message),{code});
const ids=['warehouse','purchase','sales','overview','exporter'];
const sequence=['warehouse','exporter','purchase','sales','overview'];
const ordered=bundles=>[...bundles].sort((a,b)=>sequence.indexOf(a.module)-sequence.indexOf(b.module));
function atomic(file,value){const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,canonical(value),{mode:0o600});fs.renameSync(tmp,file);}
function admin(actor){if(actor?.role!=='admin'||actor.channel!=='ui'||!actor.sessionId)throw fail('UI_ADMIN_REQUIRED','迁移确认必须由管理员在页面完成');}
function clean(value){
  if(Array.isArray(value)){value.forEach(clean);return;}
  if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){
    if(/(?:password|cookie|secret|token|dpapi|storageState|loginPartition|privateKey|authorization|sessionReceipt)/i.test(key))throw fail('FORBIDDEN_MIGRATION_DATA','迁移包含登录凭据或授权数据，已拒绝');
    if(['__proto__','prototype','constructor'].includes(key))throw fail('INVALID_MIGRATION_DATA','迁移字段无效');
    clean(child);
  }
}
export class MigrationCoordinator{
  constructor({root,adapters,serverId,dataSetId,audit=()=>{}}){
    Object.assign(this,{root,adapters,serverId,dataSetId,audit});fs.mkdirSync(root,{recursive:true});this.pending=new Map();
    for(const name of fs.readdirSync(root))if(/^[a-f0-9-]{36}$/.test(name)){
      const file=path.join(root,name,'batch.json'),lock=file+'.lock';let alive=false;
      if(fs.existsSync(lock)){try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);alive=true;}catch{fs.unlinkSync(lock);}}
      if(!alive&&fs.existsSync(file)){
        const row=JSON.parse(fs.readFileSync(file,'utf8'));
        if(['committing','verified','releasing'].includes(row.status)){
          if(row.status!=='committing'){row.recoveryMode='release-only';row.releaseFinalStatus=row.releaseFinalStatus||'completed';}
          row.status='recovery-required';row.error={code:'PROCESS_INTERRUPTED',message:row.recoveryMode==='release-only'?'迁移开放过程已中断，只能继续退出维护，不能整库回退':'迁移进程已中断，相关账本保持维护状态；恢复一致性备份后才能开放写入'};atomic(file,row);
        }
      }
    }
  }
  file(id){if(!/^[a-f0-9-]{36}$/.test(id))throw fail('MIGRATION_NOT_FOUND','迁移批次不存在');return path.join(this.root,id,'batch.json');}
  read(id){const row=JSON.parse(fs.readFileSync(this.file(id),'utf8'));if(row.snapshotDigest!==digest(row.bundles))throw fail('SNAPSHOT_CHANGED','原始迁移快照已变化，已阻止操作');return row;}
  save(row){atomic(this.file(row.id),row);return row;}
  list(actor){admin(actor);return fs.readdirSync(this.root).filter(id=>/^[a-f0-9-]{36}$/.test(id)).map(id=>this.read(id)).filter(row=>row.bundles.every(b=>actor.modules.includes(b.module))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(row=>this.public(row));}
  acquireWindow(id){
    for(const other of fs.readdirSync(this.root).filter(v=>/^[a-f0-9-]{36}$/.test(v)))if(other!==id&&this.read(other).status==='recovery-required')throw fail('RECOVERY_REQUIRED','另一批迁移尚未恢复，必须先完成恢复再开始新维护窗口');
    const file=path.join(this.root,'maintenance-window.lock'),token=crypto.randomUUID();let handle;
    try{handle=fs.openSync(file,'wx');}catch(error){
      if(error.code!=='EEXIST')throw error;let alive=false;try{process.kill(JSON.parse(fs.readFileSync(file,'utf8')).pid,0);alive=true;}catch{}
      if(alive)throw fail('MIGRATION_BUSY','已有整批迁移占用维护窗口，请等待同一批结果');fs.unlinkSync(file);handle=fs.openSync(file,'wx');
    }
    fs.writeFileSync(handle,JSON.stringify({pid:process.pid,id,token}));fs.closeSync(handle);
    return ()=>{if(JSON.parse(fs.readFileSync(file,'utf8')).token!==token)throw Error('维护窗口归属已变化');fs.unlinkSync(file);};
  }
  async exclusive(id,fn){
    if(this.pending.has(id))return this.pending.get(id);
    const promise=(async()=>{
      const lock=this.file(id)+'.lock';let opened;
      try{opened=fs.openSync(lock,'wx');fs.writeFileSync(opened,String(process.pid));}
      catch(error){
        if(error.code!=='EEXIST')throw error;let alive=false;
        try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);alive=true;}catch{}
        if(alive)throw fail('MIGRATION_BUSY','此批迁移正在处理，请查询同一批结果');
        fs.unlinkSync(lock);opened=fs.openSync(lock,'wx');fs.writeFileSync(opened,String(process.pid));
      }
      try{return await fn();}finally{fs.closeSync(opened);fs.unlinkSync(lock);}
    })();this.pending.set(id,promise);
    try{return await promise;}finally{this.pending.delete(id);}
  }
  async stage(input,actor){
    if(!actor?.id||!['admin','editor'].includes(actor.role))throw fail('PERMISSION_DENIED','没有迁移资料上传权限');
    clean(input);
    if(!Array.isArray(input.bundles)||!input.bundles.length||input.bundles.length>5||new Set(input.bundles.map(b=>b.module)).size!==input.bundles.length)throw fail('INVALID_MIGRATION_DATA','每批迁移必须包含一至五个不同模块');
    if(!/^[a-f0-9]{64}$/.test(input.sourceDigest||'')||!input.clientId)throw fail('SOURCE_ID_REQUIRED','缺少来源账本清单');
    let count=0;
    for(const bundle of input.bundles){
      if(bundle.schemaVersion!==1||!ids.includes(bundle.module)||!actor.modules?.includes(bundle.module)||!bundle.sourceInstance||!Array.isArray(bundle.records))throw fail('INVALID_MIGRATION_DATA','来源模块、版本或权限无效');
      const seen=new Set();
      for(const record of bundle.records){const key=record.kind+':'+record.sourceId;if(!record.kind||record.sourceId==null||seen.has(key))throw fail('DUPLICATE_SOURCE_ID','来源记录标识缺失或重复');seen.add(key);if(++count>200000)throw fail('MIGRATION_TOO_LARGE','请分批迁移，每批最多二十万条');}
    }
    if(Buffer.byteLength(canonical(input))>100*1024*1024)throw fail('MIGRATION_TOO_LARGE','迁移清单过大');
    const bytes=crypto.createHash('sha256').update(actor.id+'\0'+input.clientId+'\0'+input.sourceDigest+'\0'+digest(input.bundles)).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex'),id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    if(fs.existsSync(this.file(id)))return this.public(this.read(id));
    fs.mkdirSync(path.dirname(this.file(id)),{recursive:true});
    const row={id,schemaVersion:1,serverId:this.serverId,dataSetId:this.dataSetId,clientId:input.clientId,sourceDigest:input.sourceDigest,bundles:input.bundles,snapshotDigest:digest(input.bundles),createdBy:actor.id,createdAt:new Date().toISOString(),status:'staged',revision:1,selections:{},confirmations:[],backups:{}};
    this.save(row);await this.audit({type:'migration.staged',actor:actor.id,id,modules:input.bundles.map(b=>b.module),records:count});return this.public(row);
  }
  async preview(id,actor){
    admin(actor);const row=this.read(id),modules={},references={},plannedSources=[],plannedShops=[];
    for(const original of ordered(row.bundles)){
      const bundle=original.module==='overview'?{...original,references,plannedSources,plannedShops}:original;
      if(!actor.modules.includes(bundle.module))throw fail('PERMISSION_DENIED','没有此模块的迁移权限');
      const preview=await this.adapters[bundle.module].preview(bundle,actor,row.selections?.[bundle.module]);modules[bundle.module]=preview;
      if(bundle.module==='sales')for(const item of preview.rows.filter(r=>r.kind==='shop'&&r.action!=='blocked')){
        const choice=row.selections?.sales?.find(s=>s.kind==='shop'&&String(s.sourceId)===String(item.sourceId)),target=item.existingId||item.plannedTargetId;
        if(!target||choice?.action==='skip'&&!item.existingId)continue;
        references['shop:'+item.sourceId]=target;const payload=item.incoming||item.proposed;plannedShops.push({id:target,name:payload.name,platform:payload.platform});
      }
      if(['purchase','sales'].includes(bundle.module))for(const item of preview.rows){
        if(item.kind!==(bundle.module==='purchase'?'order':'ledger')||item.action==='blocked')continue;
        const choice=row.selections?.[bundle.module]?.find(s=>s.kind===item.kind&&String(s.sourceId)===String(item.sourceId));
        if(choice?.action==='skip'&&!item.existingId)continue;
        const target=item.existingId||item.plannedTargetId;if(!target)continue;
        references[bundle.module+':'+item.sourceId]=bundle.module+':'+target;
        let payload={...(item.existingId?item.proposed:item.incoming||item.proposed)};
        for(const [key,value]of Object.entries(choice?.fields||{}))if(value==='incoming')payload[key]=item.incoming[key];
        const amountCents=bundle.module==='purchase'?payload.amountCents-payload.refundCents:-payload.amount;
        plannedSources.push({key:bundle.module+':'+target,amountCents,currency:payload.currency||'CNY',owner:payload.shop_id||'company',payload,sourceHash:digest(payload),state:'planned'});
      }
    }
    return {...this.public(row),modules,references,plannedSources,plannedShops};
  }
  async select(id,{revision,selections},actor){
    admin(actor);return this.exclusive(id,async()=>{
      const row=this.read(id);if(['committing','completed','recovery-required'].includes(row.status))throw fail('MIGRATION_CLOSED','当前批次不能修改');
      if(row.revision!==revision)throw fail('REVISION_CONFLICT','迁移核对内容已变化，请重新读取');
      const preview=await this.preview(id,actor);this.validateSelections(preview.modules,selections);
      row.selections=selections;row.status='draft';row.confirmations=[];row.revision++;row.reviewedBy=actor.id;row.reviewSession=actor.sessionId;this.save(row);return this.preview(id,actor);
    });
  }
  validateSelections(modules,selections){
    for(const [module,preview]of Object.entries(modules)){
      const chosen=selections?.[module];if(!Array.isArray(chosen)||chosen.length!==preview.rows.length)throw fail('INCOMPLETE_REVIEW','请逐项选择新增、保留或处理差异');
      const seen=new Set();
      for(const decision of chosen){
        const key=decision.kind+':'+decision.sourceId,source=preview.rows.find(r=>r.kind===decision.kind&&String(r.sourceId)===String(decision.sourceId));
        if(seen.has(key)||!source||!['add','update','skip'].includes(decision.action))throw fail('INVALID_SELECTION','迁移选择与来源记录不符');seen.add(key);
        if(decision.action!=='skip'&&(source.action==='blocked'||source.issues?.some(i=>i.blocking)))throw fail('MIGRATION_BLOCKED','请先解决锁月、缺项或原账本约束：'+(source.issues?.map(i=>i.message||i).join('；')||key));
        if(source.action==='duplicate'&&decision.action!=='skip')throw fail('DUPLICATE_RECORD','完全重复的记录必须跳过');
        if(source.action==='new'&&decision.action==='update')throw fail('INVALID_SELECTION','新增记录不能选择更新');
        if(source.action==='conflict'&&decision.action==='add')throw fail('INVALID_SELECTION','存在冲突的记录必须核对更新或保留');
        if(decision.action==='update'&&(source.differences||[]).some(d=>!['existing','incoming'].includes(decision.fields?.[typeof d==='string'?d:d.field])))throw fail('INCOMPLETE_REVIEW','每个差异字段都必须明确选择');
      }
    }
  }
  assertCompleteReview(modules,selections){
    for(const [module,preview]of Object.entries(modules))for(const row of preview.rows){
      const choice=selections[module].find(s=>s.kind===row.kind&&String(s.sourceId)===String(row.sourceId));
      if(row.action==='blocked'||row.action==='new'&&choice.action==='skip')throw fail('MIGRATION_REVIEW_INCOMPLETE','整份来源账本尚未核对完成，不能切换客户端：'+module+' / '+row.kind+' / '+row.sourceId+'。请先处理缺项、锁月或未确认的新增记录');
    }
  }
  async confirm(id,{step,revision,reviewDigest},actor){
    admin(actor);return this.exclusive(id,async()=>{
      const row=this.read(id);if(row.revision!==revision||row.reviewedBy!==actor.id||row.reviewSession!==actor.sessionId)throw fail('RECONFIRM_REQUIRED','内容或核对成员已变化，请重新逐项确认');
      const preview=await this.preview(id,actor);this.validateSelections(preview.modules,row.selections);this.assertCompleteReview(preview.modules,row.selections);
      const revisions=Object.fromEntries(Object.entries(preview.modules).map(([m,p])=>[m,p.revision]));
      const hash=digest({snapshotDigest:row.snapshotDigest,selections:row.selections,revisions,revision:row.revision,references:preview.references,plannedSources:preview.plannedSources,plannedShops:preview.plannedShops});
      if(reviewDigest&&reviewDigest!==hash)throw fail('REVISION_CONFLICT','账本或核对内容已变化，请重新确认');
      if(step===1){row.confirmations=[{step:1,actor:actor.id,session:actor.sessionId,digest:hash,revisions,at:Date.now()}];row.status='first-confirmed';}
      else if(step===2){
        const first=row.confirmations[0];if(first?.step!==1||first.digest!==hash||first.session!==actor.sessionId)throw fail('RECONFIRM_REQUIRED','必须先完成相同数据版本的第一次确认');
        row.confirmations=[first,{step:2,actor:actor.id,session:actor.sessionId,digest:hash,at:Date.now()}];row.status='second-confirmed';
      }else throw fail('INVALID_CONFIRMATION','确认步骤无效');
      this.save(row);await this.audit({type:'migration.confirmed',id,step,actor:actor.id,digest:hash});return {...this.public(row),reviewDigest:hash,modules:preview.modules};
    });
  }
  async commit(id,{revision,reviewDigest},actor){
    admin(actor);return this.exclusive(id,async()=>{
      const row=this.read(id);if(row.status==='completed')return this.public(row);
      const releaseWindow=this.acquireWindow(id);try{
      const second=row.confirmations[1];
      if(row.status!=='second-confirmed'||row.revision!==revision||second?.actor!==actor.id||second.session!==actor.sessionId||second.digest!==reviewDigest||Date.now()-second.at>5*60*1000)throw fail('TWO_CONFIRMATIONS_REQUIRED','请完成本次两次页面确认后提交');
      const preview=await this.preview(id,actor);this.validateSelections(preview.modules,row.selections);this.assertCompleteReview(preview.modules,row.selections);
      const revisions=Object.fromEntries(Object.entries(preview.modules).map(([m,p])=>[m,p.revision]));
      if(digest({snapshotDigest:row.snapshotDigest,selections:row.selections,revisions,revision:row.revision,references:preview.references,plannedSources:preview.plannedSources,plannedShops:preview.plannedShops})!==reviewDigest)throw fail('REVISION_CONFLICT','正式账本在确认后发生变化，请重新核对');
      const order=ordered(row.bundles);let locked=[];
      row.status='committing';this.save(row);
      try{
        for(const bundle of order){await this.adapters[bundle.module].maintenance(true,actor,id);locked.push(bundle.module);row.lockedModules=[...locked];this.save(row);}
        // Capture all affected ledgers before the first business write.
        for(const bundle of order){row.backups[bundle.module]=await this.adapters[bundle.module].backup(actor,id);this.save(row);}
        row.results={};
        for(const source of order){
          const bundle=source.module==='overview'?{...source,references:preview.references,plannedSources:preview.plannedSources,plannedShops:preview.plannedShops}:source;
          const plan={migrationId:id,bundle,revision:revisions[bundle.module],selections:row.selections[bundle.module]};
          const result=await this.adapters[bundle.module].commit(plan,actor,id);
          if(result?.verified!==true&&!result?.verification?.ok)throw fail('VERIFICATION_FAILED','模块写入后校验未通过：'+bundle.module);
          row.results[bundle.module]=result;this.save(row);
        }
        for(const bundle of order)await this.adapters[bundle.module].verify?.(row.results[bundle.module],actor,id);
        row.status='verified';row.completedAt=new Date().toISOString();row.receipt={status:'completed',migrationId:id,serverId:this.serverId,dataSetId:this.dataSetId,clientId:row.clientId,sourceDigest:row.sourceDigest,completedAt:row.completedAt};this.save(row);
        await this.audit({type:'migration.verified',id,actor:actor.id,results:row.results});
      }catch(error){
        row.error={code:error.code||'MIGRATION_FAILED',message:error.message};const recovery=[];
        for(const module of [...locked].reverse())if(row.backups[module])try{await this.adapters[module].restore(row.backups[module],actor,id);}catch(e){recovery.push({module,error:e.message});}
        row.status=recovery.length?'recovery-required':'rolled-back';row.recovery=recovery;this.save(row);await this.audit({type:'migration.failed',id,actor:actor.id,status:row.status,error:row.error});
      }finally{
        if(row.status!=='recovery-required'){
          const finalStatus=row.status==='verified'?'completed':row.status;row.status='releasing';row.releaseStartedAt=new Date().toISOString();row.releaseFinalStatus=finalStatus;this.save(row);
          for(const module of locked)try{await this.adapters[module].maintenance(false,actor,id);}catch(e){
            // Another ledger might already be open for normal edits. From this
            // point a whole-database restore is forbidden, even during recovery.
            row.status='recovery-required';row.recoveryMode='release-only';row.error={code:'MAINTENANCE_RELEASE_FAILED',message:'账本已核验，部分服务尚未退出维护；只能完成开放，不能整库回退'};row.recovery=[...(row.recovery||[]),{module,error:e.message}];this.save(row);
          }
          if(row.status==='releasing'){row.status=finalStatus;row.openedAt=new Date().toISOString();this.save(row);await this.audit({type:'migration.'+finalStatus,id,actor:actor.id});}
        }
      }
      return this.public(row);
      }finally{releaseWindow();}
    });
  }
  async recover(id,actor){
    admin(actor);return this.exclusive(id,async()=>{
      const row=this.read(id);if(row.status!=='recovery-required')throw fail('RECOVERY_NOT_REQUIRED','此批迁移无需中断恢复');
      const releaseWindow=this.acquireWindow(id);try{
      if(row.recoveryMode!=='release-only')for(const module of row.lockedModules||row.bundles.map(b=>b.module)){
        if(row.backups[module])await this.adapters[module].restore(row.backups[module],actor,id);
      }
      if(row.recoveryMode!=='release-only')row.releaseFinalStatus='rolled-back';row.recoveryMode='release-only';this.save(row);
      for(const module of row.lockedModules||row.bundles.map(b=>b.module))try{await this.adapters[module].maintenance(false,actor,id);}catch(error){row.error={code:'MAINTENANCE_RELEASE_FAILED',message:'恢复结果已保存，部分服务尚未退出维护；再次处理只会退出维护，不会整库回退'};this.save(row);throw error;}
      row.status=row.recoveryMode==='release-only'?row.releaseFinalStatus:'rolled-back';row.recoveredAt=new Date().toISOString();row.recovery=[];row.error=null;this.save(row);await this.audit({type:'migration.recovered',id,actor:actor.id});return this.public(row);
      }finally{releaseWindow();}
    });
  }
  public(row){return {id:row.id,serverId:row.serverId,dataSetId:row.dataSetId,status:row.status,revision:row.revision,sourceDigest:row.sourceDigest,clientId:row.clientId,snapshotDigest:row.snapshotDigest,createdAt:row.createdAt,selections:row.selections,confirmations:row.confirmations,results:row.results,error:row.error,recovery:row.recovery,receipt:row.status==='completed'?row.receipt:undefined};}
}
