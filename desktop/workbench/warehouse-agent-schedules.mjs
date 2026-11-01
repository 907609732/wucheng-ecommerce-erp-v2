import fs from 'node:fs';
import {normalizeSettings} from '../shared/settings.mjs';
/** Read deterministic business schedules; never creates a timer or changes configuration. */
export function readWarehouseLegacySchedules({settingsPath,configurationRevision,dataSetId,requestedBy,localTimeZone=new Intl.DateTimeFormat().resolvedOptions().timeZone}){
 if(!dataSetId||!requestedBy?.id)throw Object.assign(Error('缺少账本或读取人员身份'),{code:'WAREHOUSE_SCHEDULE_IDENTITY_REQUIRED',statusCode:409});
 let raw;try{raw=JSON.parse(fs.readFileSync(settingsPath,'utf8'));}catch{throw Object.assign(Error('云仓设置无法读取'),{code:'WAREHOUSE_SCHEDULE_SETTINGS_INVALID',statusCode:409});}
 const s=normalizeSettings(raw),disabled=process.env.LINGTU_TEST_LEDGER==='1';
 return {schemaVersion:2,module:'warehouse',dataSetId,configurationRevision,schedulingOwner:'business',legacyTimersDisabled:disabled,businessTimeZone:'Asia/Shanghai',localTimeZone,source:{scheduleEnabled:s.scheduleEnabled,scheduleTime:s.scheduleTime,monthlySalesEnabled:s.monthlySalesEnabled,monthlySalesTime:s.monthlySalesTime,startAtLogin:s.startAtLogin},candidates:[],schedules:[{id:'inventory.daily',enabled:s.scheduleEnabled&&!disabled,time:s.scheduleTime,timezone:localTimeZone},{id:'sales.monthly',enabled:s.monthlySalesEnabled&&!disabled,time:s.monthlySalesTime,timezone:localTimeZone}],testLedger:disabled};
}
