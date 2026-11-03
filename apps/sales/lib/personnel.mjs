import {randomBytes,timingSafeEqual} from 'node:crypto';
import {bounds,month,hash,fail,now} from './util.mjs';
import {monthData,summarizeMonth} from './report.mjs';
import {closePreview} from './close.mjs';
import {sourceStatus} from './jobs.mjs';
import {pddCoverage,pddStatementYear,unassignedBatches} from './pdd-services.mjs';
import {taobaoStatement,TAOBAO_SOURCE} from './taobao.mjs';

const COOKIE='sales_personnel';
const safe=new Set(['GET','HEAD','OPTIONS']);
const official=new Set(['淘宝','拼多多']);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const cookieValue=q=>String(q.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
const protectedPath=/^\/api\/(?:report(?:-history)?(?:\/|$)|reconciliation(?:\/|$)|matches(?:\/|$)|close(?:\/|$)|jobs(?:\/|$)|export(?:\/|$)|audit(?:\/|$)|backups(?:\/|$)|(?:pdd|taobao)\/(?:funds|statement|movements|movements-export|references)(?:\/|$)|integration\/v1\/(?:report|ledger|review-session|edits|open|stop|maintenance|workbench\/migration)(?:\/|$))/i;
const confirmationPath=/^\/api\/integration\/v1\/(?:edits|transfers)\/[^/]+\/(?:commit|confirm|review)(?:\/|$)/i;

export function createPersonnel(s,{sessionTtlMs=12*60*60*1000}={}){
 const sessions=new Map();let integrationKey;
 s.db.exec(`CREATE TABLE IF NOT EXISTS sales_staff_handoffs(
   month TEXT PRIMARY KEY,submitted_by TEXT NOT NULL,submitted_at TEXT NOT NULL,staff_revision TEXT NOT NULL);`);
 const owner=q=>!!integrationKey&&!q.workbenchActor&&same(q.headers.authorization,'Bearer '+integrationKey);
 function current(q){
  if(q.workbenchActor?.id)return {required:false,protocolVersion:1,role:'member',selected:true,readOnly:false,canPrepare:true,canSubmit:true,canReconcile:true,canReviewReport:true,canCloseMonth:true,canExportReport:true,automation:q.workbenchActor.channel!=='ui',actor:{id:q.workbenchActor.id}};
  if(owner(q)||q.workbenchActor?.channel!=='ui'&&q.workbenchActor?.role==='admin')return {required:true,protocolVersion:1,role:'boss',selected:true,readOnly:false,canPrepare:true,canSubmit:false,canReconcile:true,canReviewReport:true,canCloseMonth:true,canExportReport:true,automation:true};
  const entry=sessions.get(cookieValue(q));
  const actor=q.workbenchActor;
  const bound=entry&&entry.expiresAt>Date.now()&&(actor?entry.actorId===actor.id&&entry.actorSession===actor.sessionId:!entry.actorId);
  const role=bound&&!(entry.role==='boss'&&actor&&actor.role!=='admin')?entry.role:actor&&actor.channel!=='ui'?'employee':null;
  const readOnly=actor?.role==='viewer',selected=!!role;
  return {required:true,protocolVersion:1,role,selected,readOnly,canPrepare:selected&&!readOnly,canSubmit:role==='employee'&&!readOnly,
   canReconcile:role==='boss'&&!readOnly,canReviewReport:role==='boss'&&!readOnly,canCloseMonth:role==='boss'&&!readOnly,canExportReport:role==='boss'&&!readOnly,
   ...(actor?{actor:{id:actor.id,role:actor.role}}:{})};
 }
 function select(q,r,role){
  if(q.workbenchActor?.id)return current(q);
  if(!['boss','employee'].includes(role))throw fail('请选择老板或员工身份',400,'PERSONNEL_ROLE_INVALID');
  const actor=q.workbenchActor;
  if(actor&&(actor.channel!=='ui'||actor.role==='viewer'||role==='boss'&&actor.role!=='admin'))throw fail('当前账号不能选择老板身份或修改人员会话',403,'PERSONNEL_ROLE_DENIED');
  for(const [key,value]of sessions)if(value.expiresAt<=Date.now())sessions.delete(key);
  if(sessions.size>=1000)throw fail('人员会话过多，请稍后重试',429,'PERSONNEL_SESSION_LIMIT');
  const previous=cookieValue(q);if(previous)sessions.delete(previous);
  const value=randomBytes(32).toString('base64url');
  sessions.set(value,{role,actorId:actor?.id||null,actorSession:actor?.sessionId||null,localId:'local:'+role+':'+randomBytes(12).toString('hex'),expiresAt:Date.now()+sessionTtlMs});
  r.setHeader('Set-Cookie',`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs/1000)}`);
  q.headers.cookie=String(q.headers.cookie||'').split(';').filter(part=>!part.trim().startsWith(COOKIE+'=')).concat(`${COOKIE}=${value}`).join('; ');
  return current(q);
 }
 function authorize(q,r,next,context={}){
  integrationKey=context.integrationKey||integrationKey;
  try{
   const requestPath=q.path.toLowerCase();
   if(!requestPath.startsWith('/api/'))return next();
   r.set('Cache-Control','no-store');
   q.personnel=current(q);
   if(['/api/health','/api/bootstrap','/api/personnel/session','/api/integration/v1/capabilities'].includes(requestPath.replace(/\/$/,'')))return next();
   if(owner(q))return next();
   if(!q.personnel.selected)throw fail('请先选择老板或员工身份',403,'PERSONNEL_REQUIRED');
   if(!safe.has(q.method)&&q.personnel.readOnly)throw fail('当前账号仅有只读权限',403,'PERSONNEL_READ_ONLY');
   if((protectedPath.test(q.path)||confirmationPath.test(q.path))&&!q.personnel.canReconcile)throw fail('此项工作由老板核对，请等待老板处理',403,'BOSS_REQUIRED');
   next();
  }catch(error){next(error);}
 }
 function coverage(q,input){
  if(['settlement','receipt'].includes(input.dataset)&&!current(q).canReconcile)throw fail('资金核对状态只能由老板修改',403,'BOSS_REQUIRED');
 }
 const staffLedgerRow=(row,manualIds)=>row.kind==='expense'||manualIds.has(row.shop_id)&&['sale','refund','receipt'].includes(row.kind);
 const manualIds=()=>new Set(s.shops().filter(shop=>shop.manual).map(shop=>shop.id));
 function ledgerRows(q,rows){const ids=manualIds();return current(q).canReconcile?rows:rows.filter(row=>staffLedgerRow(row,ids));}
 function ledgerWrite(q,input,recordId){
  if(current(q).canReconcile)return;
  const record=recordId?s.get('SELECT * FROM ledger WHERE id=?',recordId):input;
  if(record&&!staffLedgerRow(record,manualIds()))throw fail('线上资金记录由老板核对，员工请使用账单导入或登记费用',403,'BOSS_REQUIRED');
 }
 function sources(q,m){
  const rows=sourceStatus(s,month(m));
  return current(q).canReconcile?rows:rows.map(row=>({...row,datasets:row.datasets.map(item=>['operations','expense'].includes(item.dataset)?item:{dataset:item.dataset,status:item.status,evidence:'由老板核对'})}));
 }
 function evidence(shop,m){
  if(shop.platform==='拼多多')return pddCoverage(s,shop.id,m);
  const sources=s.all("SELECT id,filename,context_json FROM imports WHERE shop_id=? AND dataset='ledger' AND status='committed' ORDER BY id",shop.id).map(row=>({...row,context:JSON.parse(row.context_json)})).filter(row=>row.context.source===TAOBAO_SOURCE&&row.context.month===m).map(row=>({id:row.id,filename:row.filename,scope:row.context.scope}));
  return {status:sources.length?'partial':'missing',sources,intervals:[],gaps:[]};
 }
 function staffSnapshot(m){
  month(m);const [start,end]=bounds(m),data=monthData(s,m);
  const shops=(data.shops||s.shops()).filter(shop=>shop.platform!=='待归属');
  const statements=shops.filter(shop=>official.has(shop.platform)).map(shop=>({shop_id:shop.id,shop:shop.name,platform:shop.platform,year:m.slice(0,4),months:[{month:m,income:null,expense:null,net:null,count:null,coverage:evidence(shop,m),comparison:'no_reference'}]}));
  const pending=unassignedBatches(s).filter(item=>item.scope?.start?.slice(0,7)<=m&&item.scope?.end?.slice(0,7)>=m);
  const imports=s.all('SELECT id,shop_id,dataset,sha256,status,context_json FROM imports ORDER BY id').filter(row=>{
   const context=JSON.parse(row.context_json);return context.month===m||(context.months||[]).includes(m)||context.scope?.start?.slice(0,7)<=m&&context.scope?.end?.slice(0,7)>=m;
  }).map(row=>({...row,attribution:s.get('SELECT status,reason FROM batch_attributions WHERE import_id=?',row.id)||null}));
  const coverage=(data.coverage||[]).filter(row=>['operations','expense'].includes(row.dataset)).sort((a,b)=>(a.shop_id+'|'+a.dataset).localeCompare(b.shop_id+'|'+b.dataset));
  const fingerprint={month:m,shops,operations:(data.operations||[]).filter(row=>row.start<=end&&row.end>=start).sort((a,b)=>a.id.localeCompare(b.id)),ledger:(data.ledger||[]).filter(row=>row.date>=start&&row.date<=end).sort((a,b)=>a.id.localeCompare(b.id)),freight:(data.freight||[]).slice().sort((a,b)=>a.id.localeCompare(b.id)),attachments:(data.freight_attachments||[]).slice().sort((a,b)=>a.id.localeCompare(b.id)),coverage,imports,officialEvidence:statements,pending:pending.map(row=>({id:row.id,status:row.status,scope:row.scope}))};
  const employeeReady=shops.length>0&&pending.length===0&&statements.every(row=>row.months[0].coverage.sources.length>0)&&shops.every(shop=>['operations','expense'].every(dataset=>coverage.some(row=>row.shop_id===shop.id&&row.dataset===dataset&&row.status==='full')));
  return {data,shops,statements,pending,staffRevision:hash(fingerprint),employeeReady};
 }
 function submission(m,revision){
  const row=s.get('SELECT * FROM sales_staff_handoffs WHERE month=?',m);
  return row?{state:row.staff_revision===revision?'submitted':'changed',submittedAt:row.submitted_at,submittedBy:row.submitted_by}:{state:'draft',submittedAt:null,submittedBy:null};
 }
 function taskCenter(q,m){
  const personnel=current(q);if(!personnel.selected)throw fail('请先选择人员身份',403,'PERSONNEL_REQUIRED');
  const snapshot=staffSnapshot(m),{data,shops,statements,pending,staffRevision,employeeReady}=snapshot;
  const boss=personnel.canReviewReport;
  const sources=sourceStatus(s,m).filter(row=>shops.some(shop=>shop.id===row.id)).map(row=>({...row,datasets:row.datasets.map(item=>{const saved=(data.coverage||[]).find(value=>value.shop_id===row.id&&value.dataset===item.dataset);return {dataset:item.dataset,status:saved?.status||'missing',evidence:boss||['operations','expense'].includes(item.dataset)?saved?.evidence||'尚未取得':'由老板核对'};})}));
  const closeInfo=boss?closePreview(s,m):{month:m,locked:!!data.locked,coverage:(data.coverage||[]).map(({shop_id,month,dataset,status})=>({shop_id,month,dataset,status})),freight:{count:(data.freight||[]).filter(row=>row.status==='active').length}};
  const jobs=boss?s.all('SELECT * FROM jobs WHERE period=? ORDER BY created_at DESC',m).map(row=>({...row,report_status:s.get('SELECT status FROM report_history WHERE filename=?',(()=>{try{return JSON.parse(row.detail).file||'';}catch{return '';}})())?.status||'current'})):[];
  return {month:m,personnel,closeInfo,sources,pending:boss?pending:pending.map(({id,filename,created_at,status,reason,scope,summary})=>({id,filename,created_at,status,reason,scope,summary:{count:summary?.count??null}})),jobs,
   statements:boss?shops.filter(shop=>official.has(shop.platform)).map(shop=>({...((shop.platform==='淘宝'?taobaoStatement:pddStatementYear)(s,m.slice(0,4),shop.id)),platform:shop.platform})):statements,
   staffRevision,employeeReady,submission:submission(m,staffRevision)};
 }
 function handoff(q,input){
  const personnel=current(q);if(!personnel.canSubmit||(!q.workbenchActor?.id&&personnel.role!=='employee'))throw fail('请使用当前人员身份提交准备资料',403,'PERSONNEL_REQUIRED');
  const m=month(input.month);
  return s.transaction(()=>{
   if(s.get('SELECT 1 FROM month_locks WHERE month=?',m))throw fail('本月已锁定，不能重新提交资料',423,'MONTH_LOCKED');
   const snapshot=staffSnapshot(m);
   if(input.revision!==snapshot.staffRevision)throw fail('资料已变化，请刷新任务后重新提交',409,'STAFF_REVISION_CHANGED');
   if(!snapshot.employeeReady)throw fail('请先取得本月官方账单、处理归属并确认经营和费用资料',409,'STAFF_NOT_READY');
   const submittedBy=q.workbenchActor?.id||sessions.get(cookieValue(q))?.localId;
   const submittedAt=now();
   s.run('INSERT INTO sales_staff_handoffs VALUES(?,?,?,?) ON CONFLICT(month) DO UPDATE SET submitted_by=excluded.submitted_by,submitted_at=excluded.submitted_at,staff_revision=excluded.staff_revision',m,submittedBy,submittedAt,snapshot.staffRevision);
   s.audit('staff.handoff',m,{submittedBy,revision:snapshot.staffRevision});
   return {submission:submission(m,snapshot.staffRevision),staffRevision:snapshot.staffRevision,employeeReady:true};
  });
 }
 function manualSummary(m,shop='all'){
  const data=monthData(s,month(m)),ids=new Set((data.shops||s.shops()).filter(row=>row.manual).map(row=>row.id));
  return {reconciliation:summarizeMonth(data).reconciliation.filter(row=>ids.has(row.shop_id)&&(shop==='all'||row.shop_id===shop))};
 }
 return {current,select,authorize,coverage,taskCenter,handoff,manualSummary,ledgerRows,ledgerWrite,sources};
}
