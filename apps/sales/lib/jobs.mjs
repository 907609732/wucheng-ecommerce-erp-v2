import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {SHOPS,DATASETS} from './config.mjs';
import {id,now,month,beijing,shiftMonth,monthsBetween,fail} from './util.mjs';
import {exportWorkbook} from './export.mjs';

export function duePeriods(s,at=new Date()) {
  const b=beijing(at),last=shiftMonth(b.month,b.day>15||(b.day===15&&b.hour>=20)?-1:-2);
  return monthsBetween(s.setting('scheduleStart','2026-09'),last).filter(m=>!s.get("SELECT 1 FROM jobs WHERE period=? AND trigger='scheduled' AND state IN ('complete','needs_action')",m));
}
export function sourceStatus(s,m) {
  return s.shops().map(shop=>({ ...shop,status:shop.manual?'manual':['淘宝','拼多多'].includes(shop.platform)?'access_blocked':shop.platform==='抖店'?'month_unverified':'unverified',message:shop.manual?'在销售台登记并核对完整月份':shop.platform==='淘宝'?'浏览器站点安全策略拦截；尚未取得报表':shop.platform==='拼多多'?'后台自动访问受限；官方货款账务 ZIP 已支持店铺归属、完整度及逐笔核对':shop.platform==='抖店'?'本人曾完成登录并核实店名；尚未验证完整月导出':'尚未验证账号、报表字段和导出流程',datasets:Object.keys(DATASETS).map(dataset=>({dataset,...(s.get('SELECT status,evidence FROM coverage WHERE shop_id=? AND month=? AND dataset=?',shop.id,m,dataset)||{status:'missing',evidence:'尚未取得'})}))}));
}
export async function runJob(s,{period,trigger='manual'}={}) {
  month(period);if(trigger==='scheduled'&&!s.setting('schedulerEnabled',false))return {state:'disabled',message:'定时任务尚未启用：等待真实店铺整月验收'};
  const owner=id();
  s.transaction(()=>{s.run('DELETE FROM mutex WHERE expires_at<?',Date.now());if(s.get('SELECT 1 FROM mutex WHERE name=\'monthly\''))throw fail('已有月报任务运行中',409);s.run('INSERT INTO mutex VALUES(?,?,?)','monthly',owner,Date.now()+1800000);});
  const jobId=id();
  s.run('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)',jobId,period,trigger,'running','准备检查数据覆盖',now(),null);
  try {
    const sources=sourceStatus(s,period),missing=sources.flatMap(shop=>shop.datasets.filter(d=>d.status!=='full'&&!(shop.manual&&d.dataset==='settlement')).map(d=>({shop:shop.name,dataset:DATASETS[d.dataset],status:shop.status})));
    const file=`${period}-${jobId}.xlsx`;writeFileSync(path.join(s.dir,'reports',file),await exportWorkbook(s,{period,grain:'month',shop:'all'}));
    const state=missing.length?'needs_action':'complete',detail={missing,sources,file,collection:'未执行未验证的后台采集；报表来自已保存数据'};
    s.run('UPDATE jobs SET state=?,detail=?,finished_at=? WHERE id=?',state,JSON.stringify(detail),now(),jobId);
    s.notice(`${period} 月报${missing.length?'草稿已生成，'+missing.length+' 项数据待取得或核对':'已生成，待你确认锁定'}`);s.audit('job.finish',jobId,{period,state,missing:missing.length});return {id:jobId,state,...detail};
  }catch(e){s.run('UPDATE jobs SET state=?,detail=?,finished_at=? WHERE id=?','failed',JSON.stringify({message:e.message}),now(),jobId);s.notice(`${period} 月报生成失败：${e.message}`);throw e;}
  finally{s.run('DELETE FROM mutex WHERE name=? AND owner=?','monthly',owner);}
}
