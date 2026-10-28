import fs from 'node:fs';
import {normalizeSettings} from '../shared/settings.mjs';

/** Read only: never flips the formal 22:00 switches or creates a second timer. */
export function readWarehouseLegacySchedules({settingsPath,dailyConfig,configurationRevision,localTimeZone=new Intl.DateTimeFormat().resolvedOptions().timeZone,agentManaged=process.env.LINGTU_AGENT_MANAGED==='1'}){
  let raw;try{raw=JSON.parse(fs.readFileSync(settingsPath,'utf8'));}catch(e){throw Object.assign(Error('旧云仓设置缺失或无法解析，不能推断调度计划'),{code:'WAREHOUSE_SCHEDULE_SETTINGS_INVALID',statusCode:409});}
  const s=normalizeSettings(raw),time=value=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Object.assign(Error('旧调度时间格式无效'),{code:'WAREHOUSE_SCHEDULE_SETTINGS_INVALID',statusCode:409});const[h,m]=value.split(':').map(Number);return {h,m};};
  const daily=time(s.scheduleTime),monthly=time(s.monthlySalesTime),candidates=[];
  const template=(migrationKey,title,enabled,cron,timezone,goal)=>({migrationKey,title,sourceEnabled:enabled,schedulerInput:{goal,engine:'codex',scope:{modules:['warehouse']},cron,timezone,noOverlap:true,misfirePolicy:'once',enabled},approvalPolicy:'正式入库和发送进入中央结果页复核；不可把定时触发当人审',configurationRevision});
  candidates.push(template('warehouse.legacy.inventory.daily','每日库存同步',s.scheduleEnabled,`${daily.m} ${daily.h} * * *`,localTimeZone,'采集并校验最新菜鸟库存原件，生成库存入库复核结果；入库获批准后再生成并复核钉钉报告，不重复发送未知回执。'));
  candidates.push(template('warehouse.legacy.sales.monthly','每月同步上月销量',s.monthlySalesEnabled,`${monthly.m} ${monthly.h} 1 * *`,localTimeZone,'按北京时间确定上一个完整自然月，采集并校验菜鸟月销量原件，生成正式入库复核结果；月报发送另行复核，不自动补发历史报告。'));
  // One unified sweep, not a cron per employee: the domain retains each person's
  // workdays/deadline/channels, completed-state exclusion and daily channel uniqueness.
  candidates.push(template('warehouse.legacy.reminder.sweep','员工逾期催办检查',dailyConfig.autoRemind===true,'*/5 * * * *','Asia/Shanghai','查询云仓日结；仅对已启用、今天工作且截止后未完成的员工，按已配置渠道生成催办复核结果。已有unknown/accepted回执不重发，短信和电话不自动重试。'));
  return {schemaVersion:1,configurationRevision,schedulingOwner:agentManaged?'agent':'legacy',legacyTimersDisabled:agentManaged,businessTimeZone:'Asia/Shanghai',localTimeZone,source:{scheduleEnabled:s.scheduleEnabled,scheduleTime:s.scheduleTime,monthlySalesEnabled:s.monthlySalesEnabled,monthlySalesTime:s.monthlySalesTime,startAtLogin:s.startAtLogin,autoRemind:dailyConfig.autoRemind===true,employees:dailyConfig.employees.map(e=>({login:e.login,enabled:e.enabled,deadline:e.deadline,workdays:e.workdays,channels:e.channels}))},candidates,takeover:{requiresAdmin:true,requiresVerifiedDisabledLegacyTimers:true,idempotencyBasis:'migrationKey + configurationRevision + creatingActor',steps:['保存本次source及configurationRevision作为可核对的来源，不改旧配置文件','仅Beta模块启用LINGTU_AGENT_MANAGED=1，确认模块状态已停用旧timer','按migrationKey查重，创建或更新唯一统一计划，创建者为当前真实管理员','核对计划时区、enabled与实际nextRunAt后持久记录接管映射']}};
}
