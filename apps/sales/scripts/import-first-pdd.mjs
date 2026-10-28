import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../lib/db.mjs';
import {stagePdd,pddPreview,commitPdd,pddFundsReport} from '../lib/pdd.mjs';
import {makeBackup} from '../lib/backup.mjs';
const input=process.argv[2],shop=process.argv[3];if(!shop)throw Error('Provide the confirmed PDD shop ID as the second argument.');if(!input)throw Error('Provide the user-selected official ZIP path.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),s=openStore(path.join(root,'data'));
try{
  const b=await stagePdd(s,readFileSync(input),path.basename(input),{shop_id:shop}),p=pddPreview(s,b.id);
  if(!p.summary.footer_verified)throw Error('Official footer verification required');
  if(p.status==='previewed'){await makeBackup(s,'before-first-official-pdd-import');console.log(JSON.stringify({result:commitPdd(s,b.id,p.revision)}));}
  const totals=p.months.map(m=>({month:m,...pddFundsReport(s,m,'month',shop)}));
  const summary={batch_id:b.id,scope:p.scope,summary:p.summary,months:totals.map(({month,count,income,expense})=>({month,count,income,expense,net:income+expense})),classification:'平台货款账户动账；缺少完整自然月范围；不计运营销售、净结算或银行到账'};
  writeFileSync(path.join(s.dir,'reports','首份拼多多账务核对.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{s.close();}
