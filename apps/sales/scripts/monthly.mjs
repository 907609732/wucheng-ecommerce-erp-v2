import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../lib/db.mjs';
import {duePeriods,runJob} from '../lib/jobs.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),s=openStore(process.env.SALES_DATA_DIR||path.join(root,'data'));
try {
  if(!s.setting('schedulerEnabled',false))console.log(JSON.stringify({state:'disabled',message:'真实店铺采集尚未验收，定时保持停用'}));
  else {const periods=duePeriods(s);for(const period of periods)console.log(JSON.stringify(await runJob(s,{period,trigger:'scheduled'})));}
}finally{s.close();}
