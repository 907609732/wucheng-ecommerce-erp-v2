import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../lib/db.mjs';
import {makeBackup} from '../lib/backup.mjs';
import {setAttribution,saveReference,pddStatementYear} from '../lib/pdd.mjs';
import {exportWorkbook,exportPddMovements} from '../lib/export.mjs';
import {hash,now} from '../lib/util.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),s=openStore(path.join(root,'data'));
try{
  const name='pdd-mall-bill-detail(wso87wmp8flavabt4)_2026-10-16-01-28-39_7092.zip',batch=s.get("SELECT * FROM imports WHERE filename=? AND dataset='pdd_funds'",name);
  if(!batch||JSON.parse(batch.preview_json).summary.count!==1064)throw Error('Expected user-confirmed other-shop batch not found');
  if(hash(readFileSync(path.join(s.dir,batch.original_path)))!==batch.sha256)throw Error('Original source hash mismatch');
  if(s.get('SELECT status FROM batch_attributions WHERE import_id=?',batch.id)?.status!=='unassigned'){
    await makeBackup(s,'before-confirmed-other-shop-batch-isolation');
    const reason='用户确认旧 ZIP 属于另一家店铺，店名待确认；从米配匠和全部店铺汇总移出，保留全部原始流水';
    for(const filename of readdirSync(path.join(s.dir,'reports')).filter(x=>/\.(xlsx|json)$/i.test(x)))s.run('INSERT OR IGNORE INTO report_history VALUES(?,?,?,?)',filename,'before_attribution_correction','归属纠正前的历史草稿，仅供追溯',now());
    setAttribution(s,batch.id,{status:'unassigned',reason});
  }
  const screenshot=process.argv[2]||'C:/Users/90760/AppData/Local/Temp/codex-clipboard-b61fe93e-06fa-4399-b0bc-b6a47cb21d41.png';
  let evidence_path=null;if(existsSync(screenshot)){const bytes=readFileSync(screenshot);evidence_path=path.join('originals',hash(bytes)+'.png');writeFileSync(path.join(s.dir,evidence_path),bytes);}
  const refs=[['2026-07','2026-07-31',118661,-37966,39,64,0,80695],['2026-08','2026-08-31',164692,-47733,50,93,80695,197654],['2026-09','2026-09-30',501533,-278101,155,253,197654,421086],['2026-10','2026-10-17',589200,-721910,112,178,421086,288376]];
  for(const [month,cutoff,income,expense,income_count,expense_count,opening_balance,closing_balance]of refs){if(!s.get('SELECT 1 FROM platform_references WHERE shop_id=? AND month=?','pdd-mipeijiang',month))saveReference(s,{shop_id:'pdd-mipeijiang',month,cutoff:cutoff+' 23:59:59',income,expense,income_count,expense_count,opening_balance,closing_balance,evidence_path,evidence_name:'用户提供的米配匠拼多多月汇总截图',note:'平台截图人工参考，不生成流水'});}
  const annual=pddStatementYear(s,'2026','pdd-mipeijiang'),sep=annual.months.find(x=>x.month==='2026-09'),oct=annual.months.find(x=>x.month==='2026-10');
  if(sep.count!==408||sep.income!==501533||sep.expense!==-278101||sep.comparison!=='match'||oct.count!==9)throw Error('Corrected monthly acceptance totals failed');
  writeFileSync(path.join(s.dir,'reports','米配匠-2026-09-归属纠正后.xlsx'),await exportWorkbook(s,{period:'2026-09',grain:'month',shop:'pdd-mipeijiang'}));
  writeFileSync(path.join(s.dir,'reports','米配匠-2026-09-逐笔明细.xlsx'),await exportPddMovements(s,{shop_id:'pdd-mipeijiang',month:'2026-09'}));
  writeFileSync(path.join(s.dir,'reports','米配匠-2026-年度账户汇总.xlsx'),await exportWorkbook(s,{period:'2026',grain:'year',shop:'pdd-mipeijiang'}));
  console.log(JSON.stringify({preserved_other_shop:s.get('SELECT COUNT(*) n FROM ledger WHERE batch_id=?',batch.id).n,months:annual.months.filter(x=>x.count!=null).map(x=>({month:x.month,count:x.count,income:x.income,expense:x.expense,coverage:x.coverage.status,comparison:x.comparison})),reports:'纠正后汇总、年度汇总和逐笔明细已生成'},null,2));
}finally{s.close();}
