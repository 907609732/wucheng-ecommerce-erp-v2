import {randomUUID} from 'node:crypto';

// 日活按北京时间归日（与订单、月度确认口径一致）。
const shanghaiDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

export function openUsage(db){
 db.exec(`CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, opens INTEGER NOT NULL DEFAULT 1, UNIQUE(day));`);
 const getSetting=k=>db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
 const setSetting=(k,v)=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(k,v);
 const installId=()=>{let id=getSetting('install-id');if(!id){id=randomUUID();setSetting('install-id',id);}return id;};
 const recordOpen=()=>{
  const id=installId();if(!getSetting('first-used-at'))setSetting('first-used-at',new Date().toISOString());
  const day=shanghaiDay();
  db.prepare('INSERT INTO usage(day,opens) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET opens=opens+1').run(day);
  return {installId:id,day};
 };
 const stats=()=>{
  const rows=db.prepare('SELECT * FROM usage ORDER BY day').all(),day=shanghaiDay();
  return {totalOpens:rows.reduce((s,r)=>s+r.opens,0),activeDays:rows.length,todayOpens:rows.find(r=>r.day===day)?.opens||0,firstUsedAt:getSetting('first-used-at')||null,installId:getSetting('install-id')||null};
 };
 return {recordOpen,stats,installId};
}

// 预留上报到 Cloudflare（未配置端点或未生成安装标识时静默跳过）。调用方需捕获异常。
export async function reportOpen(endpoint,installId){
 if(!endpoint||!installId)return;
 const url=endpoint.replace(/\/+$/,'')+'/api/open';
 await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app:'purchase-desk',installId,day:shanghaiDay(),ts:new Date().toISOString()}),signal:AbortSignal.timeout(6000)});
}
