import {month,bounds,beijing,fail,required,hash,id,now} from './util.mjs';
import {monthData} from './report.mjs';

// Keep these predicates in SQLite: imports, migrations and retained native handles
// must obey the same OLD/NEW rule as the interactive editor.
export function installScopedLockSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_locks(scope_key TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('sales','freight')),month TEXT NOT NULL,shop_id TEXT,channel TEXT NOT NULL DEFAULT '',version TEXT NOT NULL,revision TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('normal','zero')),snapshot TEXT NOT NULL,locked_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS reconciliation_history(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,kind TEXT NOT NULL,month TEXT NOT NULL,shop_id TEXT,channel TEXT NOT NULL,version TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS reconciliation_history_no_update BEFORE UPDATE ON reconciliation_history BEGIN SELECT RAISE(ABORT,'HISTORY_IMMUTABLE'); END;
 CREATE TRIGGER IF NOT EXISTS reconciliation_history_no_delete BEFORE DELETE ON reconciliation_history BEGIN SELECT RAISE(ABORT,'HISTORY_IMMUTABLE'); END;
 CREATE TRIGGER IF NOT EXISTS reconciliation_lock_no_update BEFORE UPDATE ON reconciliation_locks BEGIN SELECT RAISE(ABORT,'LOCK_IMMUTABLE'); END;`);
 const sales=(p,a,b=a)=>`EXISTS(SELECT 1 FROM reconciliation_locks k WHERE k.kind='sales' AND k.shop_id=${p}.shop_id AND k.month BETWEEN ${a} AND ${b})`;
 const freight=p=>`EXISTS(SELECT 1 FROM reconciliation_locks k WHERE k.kind='freight' AND k.shop_id IS ${p}.shop_id AND k.channel=${p}.channel AND k.month=${p}.month)`;
 const ledger=p=>sales(p,`substr(${p}.date,1,7)`);
 const operation=p=>sales(p,`substr(${p}.start,1,7)`,`substr(${p}.end,1,7)`);
 const imported=p=>`EXISTS(SELECT 1 FROM ledger l WHERE l.batch_id=${p}.id AND (${ledger('l')})) OR EXISTS(SELECT 1 FROM operations o WHERE o.batch_id=${p}.id AND (${operation('o')})) OR (${p}.status='committed' AND ${sales(p,`coalesce(substr(json_extract(${p}.context_json,'$.scope.start'),1,7),json_extract(${p}.context_json,'$.month'))`,`coalesce(substr(json_extract(${p}.context_json,'$.scope.end'),1,7),json_extract(${p}.context_json,'$.month'))`)})`;
 const predicates={ledger,operations:operation,coverage:p=>sales(p,`${p}.month`),platform_references:p=>`EXISTS(SELECT 1 FROM month_locks WHERE month=${p}.month) OR ${sales(p,`${p}.month`)}`,
 freight_records:freight,freight_attachments:p=>`EXISTS(SELECT 1 FROM freight_records f WHERE f.id=${p}.record_id AND (${freight('f')}))`,
 matches:p=>`EXISTS(SELECT 1 FROM ledger l WHERE l.id IN (${p}.left_id,${p}.right_id) AND (${ledger('l')}))`,
 rates:p=>`EXISTS(SELECT 1 FROM reconciliation_locks k WHERE k.kind='sales' AND k.month=substr(${p}.date,1,7))`,
 imports:imported,
 batch_attributions:p=>`EXISTS(SELECT 1 FROM imports b WHERE b.id=${p}.import_id AND (${imported('b')}))`,
 shops:p=>`EXISTS(SELECT 1 FROM reconciliation_locks k WHERE k.shop_id=${p}.id) OR EXISTS(SELECT 1 FROM month_locks)`};
 for(const [table,predicate] of Object.entries(predicates))for(const op of ['INSERT','UPDATE','DELETE']){
  if(table==='shops'&&op==='INSERT')continue;
  const condition=op==='INSERT'?predicate('NEW'):op==='DELETE'?predicate('OLD'):`(${predicate('OLD')}) OR (${predicate('NEW')})`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS scoped_lock_${table}_${op.toLowerCase()} BEFORE ${op} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'MONTH_LOCKED'); END;`);
 }
 // The historical whole-month lock protects batch metadata, not only its child rows.
 for(const op of ['UPDATE','DELETE']){
  const p='OLD';db.exec(`CREATE TRIGGER IF NOT EXISTS whole_lock_imports_${op.toLowerCase()} BEFORE ${op} ON imports WHEN EXISTS(SELECT 1 FROM ledger l JOIN month_locks m ON m.month=substr(l.date,1,7) WHERE l.batch_id=${p}.id) OR EXISTS(SELECT 1 FROM operations o JOIN month_locks m ON m.month BETWEEN substr(o.start,1,7) AND substr(o.end,1,7) WHERE o.batch_id=${p}.id) OR (${p}.status='committed' AND EXISTS(SELECT 1 FROM month_locks m WHERE m.month BETWEEN coalesce(substr(json_extract(${p}.context_json,'$.scope.start'),1,7),json_extract(${p}.context_json,'$.month')) AND coalesce(substr(json_extract(${p}.context_json,'$.scope.end'),1,7),json_extract(${p}.context_json,'$.month')))) BEGIN SELECT RAISE(ABORT,'MONTH_LOCKED'); END;`);
 }
}

function normalize(s,input){
 const m=month(input.month),kind=input.kind,shop_id=input.shop_id||null,channel=kind==='freight'?input.channel:'';
 if(!['sales','freight'].includes(kind))throw fail('请选择销售或运费对账');
 if(shop_id&&!s.get("SELECT 1 FROM shops WHERE id=? AND platform<>'待归属'",shop_id))throw fail('店铺不存在');
 if(kind==='sales'&&!shop_id)throw fail('销售对账必须选择店铺');
 if(kind==='freight'&&(!['warehouse','merchant','sf'].includes(channel)||(channel==='warehouse'&&shop_id)||(channel==='merchant'&&!shop_id)))throw fail('运费渠道与店铺范围无效');
 return {month:m,kind,shop_id,channel,scope_key:JSON.stringify([kind,m,shop_id,channel])};
}
function publicLock(row){if(!row)return null;const {snapshot,...rest}=row;return {...rest,actor_id:JSON.parse(snapshot).actorId||'local'};}
function adminStatus(s){return s.monthAdmin?.status()||{configured:false};}
export function scopedLocks(s,input){
 const m=month(input.month);if(!['sales','freight'].includes(input.kind))throw fail('对账类型无效');
 const sfIds=new Set(s.all("SELECT DISTINCT shop_id FROM freight_records WHERE channel='sf' AND month=? UNION SELECT shop_id FROM reconciliation_locks WHERE kind='freight' AND channel='sf' AND month=?",m,m).map(x=>x.shop_id).filter(Boolean));
 const scopes=input.kind==='sales'?s.shops().map(x=>({shop_id:x.id,channel:''})):[{shop_id:null,channel:'warehouse'},{shop_id:null,channel:'sf'},...s.shops().map(x=>({shop_id:x.id,channel:'merchant'})),...[...sfIds].map(shop_id=>({shop_id,channel:'sf'}))];
 return {month:m,kind:input.kind,scopes,locks:s.all('SELECT * FROM reconciliation_locks WHERE month=? AND kind=? ORDER BY scope_key',m,input.kind).map(publicLock),wholeMonthLocked:!!s.get('SELECT 1 FROM month_locks WHERE month=?',m),admin:adminStatus(s)};
}
export function scopedPreview(s,input){
 const scope=normalize(s,input),{month:m,kind,shop_id,channel}=scope,[start,end]=bounds(m);
 const existing=s.get('SELECT * FROM reconciliation_locks WHERE scope_key=?',scope.scope_key);
 if(existing){const {salesData,actorId,...saved}=JSON.parse(existing.snapshot);return {...saved,locked:true,lock:publicLock(existing),wholeMonthLocked:!!s.get('SELECT 1 FROM month_locks WHERE month=?',m),admin:adminStatus(s)};}
 let rows,coverage=[],positiveFacts,totals;
 if(kind==='sales'){
  const ledger=s.all('SELECT * FROM ledger WHERE shop_id=? AND date BETWEEN ? AND ? ORDER BY id',shop_id,start,end),operations=s.all('SELECT * FROM operations WHERE shop_id=? AND start<=? AND end>=? ORDER BY id',shop_id,end,start);
  coverage=s.all('SELECT * FROM coverage WHERE shop_id=? AND month=? ORDER BY dataset',shop_id,m);
  const matches=s.all('SELECT * FROM matches WHERE left_id IN (SELECT id FROM ledger WHERE shop_id=? AND date BETWEEN ? AND ?) OR right_id IN (SELECT id FROM ledger WHERE shop_id=? AND date BETWEEN ? AND ?) ORDER BY id',shop_id,start,end,shop_id,start,end);
  const references=s.all('SELECT * FROM platform_references WHERE shop_id=? AND month=? ORDER BY id',shop_id,m);
  const imports=s.all('SELECT * FROM imports WHERE id IN (SELECT batch_id FROM ledger WHERE shop_id=? AND date BETWEEN ? AND ? UNION SELECT batch_id FROM operations WHERE shop_id=? AND start<=? AND end>=?) ORDER BY id',shop_id,start,end,shop_id,end,start);
  const attributions=s.all('SELECT * FROM batch_attributions WHERE import_id IN (SELECT id FROM imports WHERE shop_id=?) ORDER BY import_id',shop_id);
  rows={ledger,operations,matches,references,imports,attributions,rates:s.all('SELECT * FROM rates WHERE date BETWEEN ? AND ? ORDER BY date,currency',start,end)};
  positiveFacts=ledger.filter(x=>['sale','receipt','settlement','platform_flow'].includes(x.kind)&&x.amount>0).length+operations.filter(x=>x.sales>0).length;
  const active=s.all('SELECT * FROM active_ledger WHERE shop_id=? AND date BETWEEN ? AND ?',shop_id,start,end);
  const shop=s.get('SELECT * FROM shops WHERE id=?',shop_id);
  const official=active.filter(x=>x.source===(shop.platform==='拼多多'?'拼多多货款账务明细':shop.platform==='淘宝'?'淘宝官方交易货款账单（账期口径）':''));
  const manualKinds=active.some(x=>x.kind==='receipt')?['receipt','refund','expense']:['sale','refund','expense'];
  const movements=official.length?official:shop.manual?active.filter(x=>manualKinds.includes(x.kind)).map(x=>({...x,amount:['refund','expense'].includes(x.kind)?-x.amount:x.amount})):active.filter(x=>['settlement','platform_flow','withdrawal','transfer'].includes(x.kind));
  totals={sales:active.filter(x=>x.kind==='sale').reduce((v,x)=>v+x.amount,0),refunds:active.filter(x=>x.kind==='refund').reduce((v,x)=>v+x.amount,0),income:movements.filter(x=>x.amount>0).reduce((v,x)=>v+x.amount,0),expense:movements.filter(x=>x.amount<0).reduce((v,x)=>v+x.amount,0),net:movements.reduce((v,x)=>v+x.amount,0)};
 }else{
  const records=s.all('SELECT * FROM freight_records WHERE month=? AND channel=? AND shop_id IS ? ORDER BY id',m,channel,shop_id);
  const attachments=s.all('SELECT a.* FROM freight_attachments a JOIN freight_records f ON f.id=a.record_id WHERE f.month=? AND f.channel=? AND f.shop_id IS ? ORDER BY a.id',m,channel,shop_id);
  rows={records,attachments};positiveFacts=records.filter(x=>x.status==='active'&&['shipping','packing','materials','storage','other'].some(k=>x[k]>0)).length;
  const active=records.filter(x=>x.status==='active'),sum=k=>active.reduce((v,x)=>v+x[k],0);
  totals={total:sum('total'),shipping:sum('shipping'),extras:active.reduce((v,x)=>v+x.total-x.shipping,0),packing:sum('packing'),materials:sum('materials'),storage:sum('storage'),other:sum('other')};
 }
 const missing=kind==='sales'?['operations',...(!s.get('SELECT manual FROM shops WHERE id=?',shop_id)?.manual?['settlement']:[]),'receipt','expense'].filter(dataset=>!coverage.some(x=>x.dataset===dataset&&x.status==='full')):[];
 if(kind==='sales'&&rows.attributions.some(x=>x.status==='unassigned'))missing.push('unassigned');
 const data={...scope,rows,coverage,missing,positiveFacts,totals};
 const counts=Object.fromEntries(Object.entries(rows).map(([key,value])=>[key,value.length]));
 let dependencies=null;
 if(kind==='sales'){
  const live=monthData(s,m,{live:true}),ledger=live.ledger.filter(x=>x.shop_id===shop_id),ids=new Set(ledger.map(x=>x.id));
  dependencies={shop:s.get('SELECT * FROM shops WHERE id=?',shop_id),ledger,matches:live.matches.filter(x=>ids.has(x.left_id)||ids.has(x.right_id)),rates:live.rates};
 }
 const lock=s.get('SELECT * FROM reconciliation_locks WHERE scope_key=?',scope.scope_key);
 return {...data,counts,hasData:kind==='sales'?!!(counts.ledger||counts.operations||counts.imports||coverage.length):!!counts.records,revision:hash({data,dependencies}),zeroAllowed:positiveFacts===0,locked:!!lock,lock:publicLock(lock),wholeMonthLocked:!!s.get('SELECT 1 FROM month_locks WHERE month=?',m),admin:adminStatus(s)};
}
export async function requireMonthPassword(s,password){if(!s.monthAdmin?.configured())throw fail('请先设置统一管理密码',409,'MONTH_ADMIN_UNCONFIGURED');const version=s.monthAdmin.status().passwordVersion;if(!await s.monthAdmin.verify(password))throw fail('管理密码不正确',403,'MONTH_ADMIN_PASSWORD_INVALID');if(s.monthAdmin.status().passwordVersion!==version)throw fail('管理密码已变化，请重新验证',409,'ADMIN_PASSWORD_CHANGED');return version;}
export async function lockScope(s,input,{actorId='local'}={}){
 if(!s.monthAdmin?.configured())throw fail('请先设置统一管理密码',409,'MONTH_ADMIN_UNCONFIGURED');
 const scope=normalize(s,input);if(scope.month>=beijing().month)throw fail('只能锁定已经结束的月份');
 if(input.confirmed!==true||!['normal','zero'].includes(input.mode))throw fail('请明确确认锁定模式');
 return s.transaction(()=>{const p=scopedPreview(s,scope);if(p.locked||p.wholeMonthLocked)throw fail('月份已锁定',423,'MONTH_LOCKED');if(p.revision!==input.revision)throw fail('预览后数据已变化，请重新预览',409,'REVISION_CHANGED');if(input.mode==='zero'&&!p.zeroAllowed)throw fail('已有正金额业务事实，不能零确认',409,'POSITIVE_FACTS');
  let salesData;
  if(scope.kind==='sales'){
   const data=monthData(s,scope.month,{live:true}),ledger=data.ledger.filter(x=>x.shop_id===scope.shop_id),ids=new Set(ledger.map(x=>x.id));
   salesData={...data,scopedSnapshots:[],shops:data.shops.filter(x=>x.id===scope.shop_id),ledger,operations:data.operations.filter(x=>x.shop_id===scope.shop_id),coverage:data.coverage.filter(x=>x.shop_id===scope.shop_id),matches:data.matches.filter(x=>ids.has(x.left_id)||ids.has(x.right_id)),freight:[],freight_attachments:[]};
  }
  const lock={...scope,version:id(),revision:p.revision,mode:input.mode,snapshot:JSON.stringify({...p,actorId,...(salesData?{salesData}:{})}),locked_at:now()};
  s.run('INSERT INTO reconciliation_locks VALUES(?,?,?,?,?,?,?,?,?,?)',lock.scope_key,lock.kind,lock.month,lock.shop_id,lock.channel,lock.version,lock.revision,lock.mode,lock.snapshot,lock.locked_at);
  s.run('INSERT INTO reconciliation_history VALUES(?,?,?,?,?,?,?,?,?,?,?)',id(),scope.scope_key,scope.kind,scope.month,scope.shop_id,scope.channel,lock.version,'lock',input.mode==='zero'?'明确零确认':'用户确认锁定',lock.snapshot,lock.locked_at);s.audit('reconciliation.lock',scope.scope_key,{actorId,version:lock.version,mode:lock.mode,revision:lock.revision});return {ok:true,lock:publicLock(lock)};
 });
}
export async function unlockScope(s,input,{actorId='local'}={}){
 const scope=normalize(s,input),reason=required(input.reason,'解锁原因',500),passwordVersion=await requireMonthPassword(s,input.password);
 if(s.monthAdmin.status().passwordVersion!==passwordVersion)throw fail('管理密码已变化，请重新验证',409,'ADMIN_PASSWORD_CHANGED');
 return s.transaction(()=>{if(s.get('SELECT 1 FROM month_locks WHERE month=?',scope.month))throw fail('整月锁定仍生效，请先解锁整月',423,'MONTH_LOCKED');const old=s.get('SELECT * FROM reconciliation_locks WHERE scope_key=?',scope.scope_key);if(!old)throw fail('范围尚未锁定',409);if(old.version!==input.version)throw fail('锁定版本已变化，请刷新',409,'REVISION_CHANGED');s.run('INSERT INTO reconciliation_history VALUES(?,?,?,?,?,?,?,?,?,?,?)',id(),scope.scope_key,scope.kind,scope.month,scope.shop_id,scope.channel,old.version,'unlock',reason,JSON.stringify({prior:JSON.parse(old.snapshot),unlockActorId:actorId}),now());s.run('DELETE FROM reconciliation_locks WHERE scope_key=?',scope.scope_key);s.audit('reconciliation.unlock',scope.scope_key,{actorId,reason,version:old.version});return {ok:true};});
}
