import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {validateOrder,dateValue,statusValue,backfillItemUnits} from './importer.mjs';
import {preserveShipments} from '../public/shipments.mjs';
import {integrationHash as hash,integrationError as fail} from './local-integration.mjs';

export const transferPlatforms={taobao:'淘宝',alibaba:'1688',pdd:'拼多多',jd:'京东',xianyu:'闲鱼'};
const mutable=['date','paidAt','supplier','status','amountCents','refundCents','shippingCents','recipient','phone','address','logisticsCompany','trackingNo','note','items','classification'];
const comparable=['platform','account','orderNo',...mutable,'excludedFromSpend','supplierContact','attachmentIds'];
const clean=o=>Object.fromEntries(comparable.map(k=>[k,k==='attachmentIds'?(o[k]||[]):k==='excludedFromSpend'?!!o[k]:o[k]??null]));
const placeholder=x=>!String(x||'').trim()||['当前账号','默认账号','待补充'].includes(String(x).trim());
const clone=x=>JSON.parse(JSON.stringify(x));
const money=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e12;
const now=()=>new Date().toISOString();
const safeDate=value=>{try{return dateValue(value);}catch{return '';}};

export function openOrderTransfers(store,{afterWrite,afterCommit}={}){
  const {db,dir}=store;let committing=false;
  db.exec(`CREATE TABLE IF NOT EXISTS integration_transfers(
    id TEXT PRIMARY KEY,source_hash TEXT UNIQUE NOT NULL,source_json TEXT NOT NULL,
    decisions_json TEXT NOT NULL DEFAULT '{}',state TEXT NOT NULL DEFAULT 'draft',
    review_json TEXT,review_session TEXT,receipt TEXT,expires_at INTEGER,result_json TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_accounts(platform TEXT NOT NULL,identity TEXT NOT NULL,account TEXT NOT NULL,PRIMARY KEY(platform,identity));
    CREATE TABLE IF NOT EXISTS integration_order_sources(batch_id TEXT NOT NULL,order_id TEXT NOT NULL,source_order_id TEXT NOT NULL,source_json TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,PRIMARY KEY(batch_id,order_id));
    CREATE TABLE IF NOT EXISTS integration_events(id INTEGER PRIMARY KEY,transfer_id TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const event=(id,action,payload)=>db.prepare('INSERT INTO integration_events(transfer_id,action,payload,created_at) VALUES(?,?,?,?)').run(id,action,JSON.stringify(payload),now());
  const get=id=>{const row=db.prepare('SELECT * FROM integration_transfers WHERE id=?').get(id);if(!row)throw fail('导入批次不存在',404);return {...row,source:JSON.parse(row.source_json),decisions:JSON.parse(row.decisions_json),review:row.review_json?JSON.parse(row.review_json):null,result:row.result_json?JSON.parse(row.result_json):null};};
  const accountChoices=platform=>db.prepare('SELECT DISTINCT account FROM orders WHERE platform=? ORDER BY account').all(platform).map(r=>r.account);
  function create(source){
    if(source?.schema!=='order-transfer/v1'||!transferPlatforms[source.task?.platform]||!Array.isArray(source.orders)||!source.orders.length||source.orders.length>20000)throw fail('不支持的数据协议、平台或订单数量');
    if(source.digest!==hash({task:source.task,orders:source.orders}))throw fail('采集快照校验失败');
    if(typeof source.task.id!=='string'||!source.task.id)throw fail('缺少采集任务标识');
    const prior=db.prepare('SELECT id FROM integration_transfers WHERE source_hash=?').get(source.digest);if(prior)return preview(prior.id);
    const id=randomUUID(),platform=transferPlatforms[source.task.platform];
    const identity=/^[a-f0-9]{64}$/.test(source.task.accountKey||'')?source.task.accountKey:'';
    const remembered=identity&&db.prepare('SELECT account FROM integration_accounts WHERE platform=? AND identity=?').get(platform,identity)?.account;
    const decisions={account:remembered||'',rows:{}};
    db.prepare('INSERT INTO integration_transfers(id,source_hash,source_json,decisions_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,source.digest,JSON.stringify(source),JSON.stringify(decisions),now(),now());
    event(id,'snapshot.received',{digest:source.digest,count:source.orders.length});return preview(id);
  }
  function preview(id){
    let d=get(id);
    if(d.state==='committed'&&!d.result?.postVerified&&!d.result?.recoveryRequired){try{completeVerification(id,d.result);}catch{}d=get(id);}
    const {task,orders}=d.source,platform=transferPlatforms[task.platform],errors=[];
    if(d.source_hash!==hash({task,orders}))errors.push('原始快照已变化，禁止导入');
    if(task.status==='running'||task.listOutcome!=='complete')errors.push('采集范围尚未确认完整，请回导出台重新完成列表采集');
    if(task.plan?.buckets?.some(b=>b.status!=='completed'))errors.push('采集计划仍有未完成范围');
    if(task.count!==orders.length)errors.push('采集笔数与实际明细不一致');
    if(new Set(orders.map(o=>o.id)).size!==orders.length)errors.push('本批存在重复订单编号');
    const account=String(d.decisions.account||'').trim();if(placeholder(account))errors.push('请选择或填写真实采购账号');
    if(!task.from||!task.to||safeDate(task.from)!==task.from||safeDate(task.to)!==task.to||task.from>task.to)errors.push('采集日期范围无效');
    const rows=orders.map((s,index)=>{
      const choices=d.decisions.rows?.[s.id]||{},issues=[],warnings=[];
      if(typeof s.id!=='string'||!s.id)issues.push('订单编号必须为文本');
      if(s.platform!==task.platform)issues.push('订单平台与任务不一致');
      if(!s.createdAt||s.createdAt.slice(0,10)<task.from||s.createdAt.slice(0,10)>task.to)issues.push('下单时间缺失或不在采集范围');
      if(!placeholder(s.account)&&s.account!==account)warnings.push('来源账号显示名不同，请确认账号归属');
      if(!money(s.paidFen))issues.push('整单实付缺失或无效');
      let refund=s.refundFen;
      if(refund==null){
        if(!money(choices.refundCents)||!String(choices.refundEvidence||'').trim())issues.push('请逐单核实退款金额并填写核对依据（无退款填 0）');
        else refund=choices.refundCents;
      }else if(!money(refund))issues.push('来源退款金额无效');
      for(const[k,label]of [['receiver','收货人'],['phone','电话'],['address','地址'],['tracking','运单号']])if(!s[k])warnings.push(label+'未获取');
      if(s.freightFen==null)warnings.push('独立运费未知；实付按来源整单金额记录，不另加运费');
      if(s.paidAt==null||s.paidAt==='')warnings.push('付款日期缺失，沿用采购台按下单日暂估归月');
      if(s.items?.some(i=>!i.imageUrl))warnings.push('部分商品图片未获取');
      let old=null,proposed=null,normalized=null,differences=[];
      const sourceOrder={
        platform,account,orderNo:s.id,date:safeDate(s.createdAt),paidAt:s.paidAt?safeDate(s.paidAt):'',
        supplier:s.shop||s.sellerId||'',status:statusValue(s.status),amountCents:s.paidFen,refundCents:refund,
        shippingCents:s.freightFen??0,recipient:s.receiver||'',phone:s.phone||'',address:s.address||'',
        logisticsCompany:s.logistics||'',trackingNo:s.tracking||'',note:s.remark||'',
        items:(s.items||[]).map(i=>({title:i.title,spec:i.spec||'',sku:i.extra?.sku||'',qty:i.quantity,unitPriceCents:i.unitPriceFen,unit:i.extra?.unit||'',trackingNo:i.extra?.tracking||'',logisticsCompany:i.extra?.logistics||''}))
      };
      if(!s.status||sourceOrder.status==='待核对')issues.push('订单状态尚未核实，请先在来源平台补齐');
      if(s.items?.some(i=>typeof i.quantity!=='number'||!Number.isFinite(i.quantity)||i.quantity<=0))issues.push('商品数量缺失或无效');
      try{
        old=store.find({platform,account,orderNo:s.id});
        if(old&&(old.account!==account||old.platform!==platform))throw Error('历史对应账号与当前账号不同，须先在采购台核实账号');
        normalized=validateOrder(sourceOrder);
        // The legacy ledger defaults omitted refunds to zero; transfer drafts must keep unknowns explicit.
        if(refund==null)normalized.refundCents=null;
        proposed=old?clone(old):clone(normalized);
        for(const key of mutable){
          if(key==='classification')continue;
          const value=normalized[key];
          if(old&&(value===''||value==null||(key==='shippingCents'&&s.freightFen==null)))continue;
          if(old&&hash(old[key]??null)!==hash(value??null)){
            const pick=choices.fields?.[key]||(key==='note'?'keep':null);
            differences.push({field:key,before:old[key],source:value,choice:pick||null});
            if(!['keep','source'].includes(pick))issues.push(`请确认变更字段：${key}`);
            if(pick==='source')proposed[key]=value;
          }
        }
        if(choices.classification)proposed.classification=choices.classification;
        if(old)proposed.items=preserveShipments(backfillItemUnits(proposed.items,{items:old.items}),old.items);
        proposed=validateOrder(proposed);
        if(refund==null&&!old)proposed.refundCents=null;
        const action=old?(hash(clean(old))===hash(clean(proposed))?'skip':'update'):'new';
        if(action!=='skip')store.monthLocks.assertWritable(old?[old,proposed]:[proposed]);
      }catch(e){issues.push(e.message==='MONTH_LOCKED'?'所涉月份已锁定，请先取消月度确认':e.message);}
      const action=old&&proposed?(hash(clean(old))===hash(clean(proposed))?'skip':'update'):'new';
      return {index,orderNo:s.id,source:s,normalized,existing:old,proposed,action,issues,warnings,differences,refundUnknown:s.refundFen==null,decision:choices};
    });
    const total={orders:rows.length,items:0,new:0,update:0,skip:0,sourcePaidCents:0,sourceRefundCents:0,proposedPaidCents:0,proposedRefundCents:0,deltaPaidCents:0,deltaRefundCents:0};
    for(const r of rows){total[r.action]++;total.items+=r.proposed?.items?.length||r.source.items?.length||0;total.sourcePaidCents+=r.source.paidFen||0;total.sourceRefundCents+=r.normalized?.refundCents||0;total.proposedPaidCents+=r.proposed?.amountCents||0;total.proposedRefundCents+=r.proposed?.refundCents||0;if(r.action!=='skip'){total.deltaPaidCents+=(r.proposed?.amountCents||0)-(r.existing?.amountCents||0);total.deltaRefundCents+=(r.proposed?.refundCents||0)-(r.existing?.refundCents||0);}}
    total.deltaNetCents=total.deltaPaidCents-total.deltaRefundCents;
    if(Object.values(total).some(n=>!Number.isSafeInteger(n)))errors.push('本批金额或数量超过可精确处理的范围，请缩小采集范围');
    if(rows.some(r=>!money(r.source.paidFen))){total.sourcePaidCents=null;total.proposedPaidCents=null;total.deltaPaidCents=null;total.deltaNetCents=null;}
    if(rows.some(r=>r.normalized?.refundCents==null)){total.sourceRefundCents=null;total.proposedRefundCents=null;total.deltaRefundCents=null;total.deltaNetCents=null;}
    total.sourceItems=rows.reduce((n,r)=>n+(r.source.items?.length||0),0);
    total.beforePaidCents=rows.reduce((n,r)=>n+(r.existing?.amountCents||0),0);
    total.beforeRefundCents=rows.reduce((n,r)=>n+(r.existing?.refundCents||0),0);
    total.beforeNetCents=total.beforePaidCents-total.beforeRefundCents;
    total.sourceNetCents=total.sourcePaidCents==null||total.sourceRefundCents==null?null:total.sourcePaidCents-total.sourceRefundCents;
    total.proposedNetCents=total.proposedPaidCents==null||total.proposedRefundCents==null?null:total.proposedPaidCents-total.proposedRefundCents;
    if(Object.values(total).some(n=>n!==null&&!Number.isSafeInteger(n)))errors.push('合计超出可精确处理的范围');
    const revision=hash({source:d.source_hash,decisions:d.decisions,rows:rows.map(r=>({old:r.existing?clean(r.existing):null,version:r.existing?.updatedAt,proposed:r.proposed?clean(r.proposed):null,issues:r.issues})),errors,total});
    return {id,state:d.state,task,platform,account,accounts:accountChoices(platform),rows,errors,total,revision,canConfirm:!errors.length&&rows.every(r=>!r.issues.length),result:d.result};
  }
  function save(id,input){
    const d=get(id);if(d.state==='committed'||d.state==='rolled_back')throw fail('本批已经结束，请保留结果并重新采集新任务',409);
    if(input.revision!==preview(id).revision)throw fail('数据已变化，请刷新核对',409,'REVIEW_CHANGED');
    if(!input.decisions||typeof input.decisions!=='object')throw fail('缺少核对内容');
    db.prepare("UPDATE integration_transfers SET decisions_json=?,state='draft',review_json=NULL,review_session=NULL,receipt=NULL,updated_at=? WHERE id=?").run(JSON.stringify(input.decisions),now(),id);
    return preview(id);
  }
  function review(id,revision,session){
    if(!session)throw fail('须在核对界面确认',403);
    const p=preview(id);if(p.state==='committed')return p;if(p.state==='rolled_back')throw fail('本批已经撤销，请重新采集新任务',409);
    if(p.revision!==revision||!p.canConfirm)throw fail('本批仍有问题或数据已变化，请重新核对',409,'REVIEW_CHANGED');
    db.prepare("UPDATE integration_transfers SET state='reviewed',review_json=?,review_session=?,receipt=NULL,expires_at=?,updated_at=? WHERE id=?").run(JSON.stringify(p),session,Date.now()+1800000,now(),id);
    event(id,'review.first',{revision,session});return p;
  }
  function confirm(id,revision,session){
    const d=get(id),p=preview(id);
    if(d.state==='committed')return {result:d.result};
    if(d.state!=='reviewed'||!session||d.review_session!==session||d.expires_at<Date.now()||d.review?.revision!==revision||p.revision!==revision||!p.canConfirm)throw fail('第一次确认已失效，请返回明细核对',409,'REVIEW_CHANGED');
    const receipt=randomBytes(32).toString('hex');
    db.prepare('UPDATE integration_transfers SET receipt=?,updated_at=? WHERE id=?').run(hash(receipt),now(),id);event(id,'review.second',{revision,session});
    return {receipt};
  }
  async function commit(id,receipt,session,actor){
    const initial=get(id);if(initial.state==='committed')return initial.result?.postVerified||initial.result?.recoveryRequired?initial.result:completeVerification(id,initial.result);
    if(committing)throw fail('另一批正在保存，请稍后重试',409,'IMPORT_BUSY');
    const check=()=>{const d=get(id),p=preview(id);if(!session||d.review_session!==session||!receipt||d.receipt!==hash(receipt)||d.expires_at<Date.now()||p.revision!==d.review?.revision||!p.canConfirm)throw fail('确认已失效，请重新进行两次核对',409,'REVIEW_CHANGED');return p;};
    committing=true;
    try{
      check();
      const backupFile=path.join(dir,'backups',`before-transfer-${id}-${Date.now()}.sqlite`);await store.backup(backupFile);
      const originalPath=`originals/order-transfer-${id}.json`,absolute=path.join(dir,originalPath);
      if(!fs.existsSync(absolute))fs.writeFileSync(absolute,initial.source_json,{flag:'wx'});
      if(hash(JSON.parse(fs.readFileSync(absolute,'utf8')))!==hash(initial.source))throw fail('原始采集文件校验失败');
      let result;
      store.transaction(()=>{
        const p=check(),written=[];
        db.prepare('INSERT INTO imports(id,filename,hash,file_path,created_at,imported,skipped,line_count,metadata) VALUES(?,?,?,?,?,?,?,?,?)').run(id,`历史订单-${p.platform}-${p.task.from}-${p.task.to}.json`,initial.source_hash,originalPath,now(),p.total.new,p.total.skip,p.total.items,JSON.stringify({method:'order-transfer/v1',taskId:p.task.id,summary:p.total}));
        for(const r of p.rows){
          let saved=r.existing;
          if(r.action==='new')saved=store.insert(r.proposed,id,{transfer:id,source:r.source});
          if(r.action==='update')saved=store.update(r.existing.id,{...r.proposed,updatedAt:r.existing.updatedAt});
          db.prepare('INSERT INTO integration_order_sources VALUES(?,?,?,?,?,?)').run(id,saved.id,r.orderNo,JSON.stringify(r.source),r.existing?JSON.stringify(r.existing):null,JSON.stringify(saved));
          if(r.action!=='skip')db.prepare('INSERT INTO order_origins(order_id,channel,username) VALUES(?,?,?) ON CONFLICT(order_id) DO NOTHING').run(saved.id,'order-transfer',actor?.id||'本机人工核对');
          written.push({id:saved.id,action:r.action,expected:clean(saved)});
          if(hash(clean(saved))!==hash(clean(r.proposed)))throw fail('写入内容与已确认内容不同：'+r.orderNo,409,'VERIFY_FAILED');
        }
        afterWrite?.({db,written});
        for(const w of written)if(hash(clean(store.get(w.id)))!==hash(w.expected))throw fail('写后逐单校验失败，整批未入账',409,'VERIFY_FAILED');
        result={id,ok:true,verified:false,transactionVerified:true,postVerified:false,summary:p.total,backup:backupFile,sourceDigest:initial.source_hash,revision:p.revision,orders:written.map(({id,action},i)=>({id,action,orderNo:p.rows[i].orderNo,reason:action==='skip'?'与原记录一致，或已确认保留原值':'明细、字段与金额已逐项校验'})),checkedAt:now()};
        db.prepare("UPDATE integration_transfers SET state='committed',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(result),now(),id);
        if(/^[a-f0-9]{64}$/.test(initial.source.task.accountKey||''))db.prepare('INSERT INTO integration_accounts VALUES(?,?,?) ON CONFLICT(platform,identity) DO UPDATE SET account=excluded.account').run(p.platform,initial.source.task.accountKey,p.account);
        event(id,'commit.verified',{...result,actor:actor||null});
      });
      afterCommit?.({db,id});
      return completeVerification(id,result);
    }catch(e){event(id,'commit.failed',{code:e.code||'FAILED',message:e.message});throw e;}
    finally{committing=false;}
  }
  function completeVerification(id,result){
      const mismatches=verify(id);
      if(mismatches.length){
        try{rollback(id,'提交后校验异常',true);}
        catch(e){db.prepare('UPDATE integration_transfers SET result_json=? WHERE id=?').run(JSON.stringify({...result,ok:false,verified:false,recoveryRequired:true,differences:mismatches,reason:e.message}),id);throw e;}
        throw fail('提交后校验发现差异，本批已撤销',409,'VERIFY_FAILED');
      }
      const verified={...result,verified:true,postVerified:true,checkedAt:now()};
      db.prepare('UPDATE integration_transfers SET result_json=? WHERE id=?').run(JSON.stringify(verified),id);
      event(id,'commit.post-verified',{checkedAt:verified.checkedAt});return verified;
  }
  function verify(id){
    return db.prepare('SELECT * FROM integration_order_sources WHERE batch_id=?').all(id).filter(r=>{const actual=store.get(r.order_id);return !actual||hash(clean(actual))!==hash(clean(JSON.parse(r.after_json)));}).map(r=>({orderId:r.order_id,orderNo:r.source_order_id,reason:'当前订单与该批确认结果不一致'}));
  }
  function rollback(id,reason,automatic=false){
    const d=get(id);if(d.state!=='committed')throw fail('本批尚未入账或已经撤销');
    if(!reason?.trim())throw fail('请填写撤销原因');
    const entries=db.prepare('SELECT * FROM integration_order_sources WHERE batch_id=?').all(id);
    store.transaction(()=>{
      for(const r of entries){
        const current=store.get(r.order_id),saved=JSON.parse(r.after_json);
        const before=r.before_json?JSON.parse(r.before_json):null;
        if(before&&hash(clean(before))===hash(clean(saved)))continue;
        // Never overwrite subsequent edits, including during automatic recovery.
        if(!current||current.updatedAt!==saved.updatedAt)throw fail(`订单 ${r.source_order_id} 已有后续修改，禁止自动覆盖，请按差异报告处理`,409,'ROLLBACK_CONFLICT');
        store.monthLocks.assertWritable([current]);
      }
      for(const r of entries){
        const before=r.before_json?JSON.parse(r.before_json):null,saved=JSON.parse(r.after_json);
        if(before&&hash(clean(before))===hash(clean(saved)))continue;
        const current=store.get(r.order_id);
        if(before)store.update(r.order_id,{...before,updatedAt:current.updatedAt});
        else {
          const linked=db.prepare('SELECT COUNT(*) n FROM order_attachments WHERE order_id=?').get(r.order_id).n;
          if(linked)throw fail('新增订单已有附件关联，请人工处理',409,'ROLLBACK_CONFLICT');
          db.prepare('DELETE FROM order_origins WHERE order_id=?').run(r.order_id);
          db.prepare('DELETE FROM orders WHERE id=?').run(r.order_id);
        }
        db.prepare('INSERT INTO audit(order_id,action,before_json,after_json,created_at,batch_id,reason) VALUES(?,?,?,?,?,?,?)').run(r.order_id,'integration-rollback',JSON.stringify(current),JSON.stringify(before||{deleted:true}),now(),id,reason);
      }
      db.prepare("UPDATE integration_transfers SET state='rolled_back',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({...d.result,ok:false,verified:false,rolledBack:true,reason}),now(),id);
      event(id,'rollback',{reason,automatic});
    });
    return {id,rolledBack:true};
  }
  return {create,preview,save,review,confirm,commit,rollback,verify,busy:()=>committing,
    list:()=>db.prepare('SELECT id,state,created_at,updated_at,result_json FROM integration_transfers ORDER BY created_at DESC LIMIT 100').all().map(r=>({...r,result:r.result_json?JSON.parse(r.result_json):null,result_json:undefined}))};
}
