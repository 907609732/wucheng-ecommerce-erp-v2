import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readCainiaoInventory,inventorySnapshotFingerprint} from '../../desktop/shared/inventory-store.mjs';

export const CHANNELS = ['email', 'dingtalk', 'sms', 'phone'];
export function businessDate(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function expectedInventoryDate(now=new Date()) {
  const day=new Date(businessDate(now)+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-1);return day.toISOString().slice(0,10);
}
const problem = (message, status=400) => Object.assign(Error(message), {status});
const admin = actor => {if(!actor?.id)throw problem('缺少已验证的工作台身份',401);};
const safeError = () => '服务请求失败，请检查渠道配置或服务商记录';
const weekday = day => new Date(day+'T00:00:00Z').getUTCDay() || 7;
const normalizeLogin = value => String(value||'').trim().toLowerCase();
const json = value => JSON.stringify(value);

// This store lives in the existing warehouse ledger. It is opened only by the
// owning host, never by a remote client or a new independently-created ledger.
export function createWarehouseDaily({databasePath, now=()=>new Date(), senders={}, getChannels=async()=>({})}) {
  if(!fs.existsSync(databasePath))throw problem('原云仓账本不存在，无法初始化工作记录',503);
  const db=new DatabaseSync(databasePath,{timeout:5000});
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS warehouse_sync_runs(id TEXT PRIMARY KEY,business_date TEXT NOT NULL,started_at TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS warehouse_daily_config(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS warehouse_attendance(login TEXT NOT NULL,business_date TEXT NOT NULL,check_in_at TEXT NOT NULL,completed_at TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',PRIMARY KEY(login,business_date));
    CREATE TABLE IF NOT EXISTS warehouse_reminders(id TEXT PRIMARY KEY,login TEXT NOT NULL,business_date TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(login,business_date,channel));
    CREATE TABLE IF NOT EXISTS warehouse_daily_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);`);
  const time=()=>now().toISOString();
  const config=()=>JSON.parse(db.prepare('SELECT payload FROM warehouse_daily_config WHERE id=1').get()?.payload||'{"employees":[],"autoRemind":false}');
  const audit=(actor,action,payload)=>db.prepare('INSERT INTO warehouse_daily_audit VALUES(?,?,?,?,?)').run(randomUUID(),String(actor?.id||'system'),action,time(),json(payload));
  function beginRun({id=randomUUID(),expectedSourceDate=expectedInventoryDate(now()),kind='sync'}={}) {
    const startedAt=time(),day=businessDate(now());
    db.prepare('INSERT INTO warehouse_sync_runs VALUES(?,?,?,?)').run(id,day,startedAt,json({id,runId:id,businessDate:day,expectedSourceDate,kind,startedAt,collectionStatus:'pending',validationStatus:'pending',deliveryStatus:'pending'}));
    return id;
  }
  function updateRun(id,patch) {
    const row=db.prepare('SELECT payload FROM warehouse_sync_runs WHERE id=?').get(id);
    if(!row)throw problem('同步批次不存在',404);
    const previous=JSON.parse(row.payload);
    const next={...previous,...patch,id,runId:id,businessDate:previous.businessDate,startedAt:previous.startedAt};
    if(patch.importedAt)next.snapshotHash=inventorySnapshotFingerprint(readCainiaoInventory(databasePath));
    db.prepare('UPDATE warehouse_sync_runs SET payload=? WHERE id=?').run(json(next),id);
  }
  function syncStatus() {
    const day=businessDate(now()), rows=db.prepare('SELECT payload FROM warehouse_sync_runs WHERE business_date=? ORDER BY started_at DESC,rowid DESC').all(day).map(r=>JSON.parse(r.payload));
    let inventory;
    try{inventory=readCainiaoInventory(databasePath);}catch{inventory={available:false};}
    const expected=expectedInventoryDate(now());
    const verified=r=>r.kind==='sync'&&r.sourceDate>=expected&&r.sourceDate<=day&&r.expectedSourceDate>=expected&&r.expectedSourceDate<=day&&r.sourceDate>=r.expectedSourceDate&&r.collectionStatus==='success'&&r.validationStatus==='success'&&r.deliveryStatus==='accepted'&&r.collectedAt&&r.validatedAt&&r.importedAt&&r.sentAt&&r.fileHash&&r.validationId&&inventory.available&&inventory.validation?.matchesSnapshot&&inventory.sourceDate===r.sourceDate&&inventory.skuCount===r.rowCount&&Math.abs(inventory.totalQuantity-r.totalQuantity)<0.001&&inventory.validation.id===r.validationId;
    const successful=rows.find(r=>verified(r)&&r.snapshotHash&&r.snapshotHash===inventorySnapshotFingerprint(inventory)),latest=rows[0];
    return {...(successful||latest||{collectionStatus:'pending',validationStatus:'pending',deliveryStatus:'pending'}),complete:Boolean(successful),runId:(successful||latest)?.id||'',expectedSourceDate:expected,lastAttempt:latest||null};
  }
  function employeesFor(actor) {
    const day=businessDate(now()),c=config();
    const rows=c.employees.map(e=>{
      const record=db.prepare('SELECT * FROM warehouse_attendance WHERE login=? AND business_date=?').get(e.login,day);
      const due=e.enabled&&e.workdays.includes(weekday(day));
      const deadlineAt=`${day}T${e.deadline}:00+08:00`,overdue=now().getTime()>new Date(deadlineAt).getTime();
      return {...e,checkInAt:record?.check_in_at||'',completedAt:record?.completed_at||'',completedRunId:record?.run_id||'',status:!due?'off':record?.completed_at?'completed':overdue?'overdue':'pending',late:Boolean(record?.completed_at&&new Date(record.completed_at)>new Date(deadlineAt))};
    });
    return rows;
  }
  async function status(actor) {
    if(!actor?.id)throw problem('缺少已验证的工作台身份',401);
    const employees=employeesFor(actor),all=true,due=employees.filter(e=>e.status!=='off');
    const reminders=db.prepare('SELECT * FROM warehouse_reminders WHERE business_date=? ORDER BY created_at DESC').all(businessDate(now())).filter(r=>all||r.login===normalizeLogin(actor.login)).map(r=>({...JSON.parse(r.payload),login:r.login,channel:r.channel,status:r.status,createdAt:r.created_at}));
    return {businessDate:businessDate(now()),timeZone:'Asia/Shanghai',expectedSourceDate:expectedInventoryDate(now()),sync:syncStatus(),actor:{id:actor.id,login:actor.login,role:actor.role,local:Boolean(actor.local)},me:actor.local?null:employees.find(e=>e.login===normalizeLogin(actor.login))||null,employees,team:{expected:due.length,checkedIn:due.filter(e=>e.checkInAt).length,completed:due.filter(e=>e.completedAt).length,pending:due.filter(e=>!e.completedAt).length},config:all?config():{employees:[],autoRemind:false},channels:await getChannels(),reminders};
  }
  function configure(actor,input) {
    admin(actor);
    if(!Array.isArray(input.employees)||input.employees.length>300)throw problem('员工列表无效（最多300人）');
    const seen=new Set();
    const employees=input.employees.map(raw=>{
      const login=normalizeLogin(raw.login),name=String(raw.name||'').trim();
      if(!login||login.length>254||/[\s,\r\n]/.test(login)||seen.has(login)||!name||name.length>80)throw problem('员工登录标识或姓名无效/重复');
      seen.add(login);
      const deadline=raw.deadline||'18:00',workdays=raw.workdays||[1,2,3,4,5],channels=raw.channels||[];
      if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(deadline)||!Array.isArray(workdays)||workdays.some(d=>!Number.isInteger(d)||d<1||d>7)||!Array.isArray(channels)||channels.some(c=>!CHANNELS.includes(c)))throw problem('截止时间、工作日或提醒渠道无效');
      const email=String(raw.email||'').trim(),mobile=String(raw.mobile||'').trim(),dingtalkUserId=String(raw.dingtalkUserId||'').trim(),task=String(raw.task||'核对库存并处理预警').trim();
      if(email&&(!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)||email.length>254))throw problem('邮箱格式无效');
      if(mobile&&!/^\+?\d{7,18}$/.test(mobile))throw problem('手机号格式无效');
      if(dingtalkUserId.length>128||/[\r\n]/.test(dingtalkUserId)||task.length>500)throw problem('员工任务或钉钉标识过长');
      return {login,name,email,mobile,dingtalkUserId,task,deadline,workdays:[...new Set(workdays)],channels:[...new Set(channels)],enabled:raw.enabled!==false};
    });
    const value={employees,autoRemind:input.autoRemind===true};
    db.prepare('INSERT INTO warehouse_daily_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(json(value));audit(actor,'config',{employees:employees.map(e=>e.login),autoRemind:value.autoRemind});return value;
  }
  function action(actor,input,{approvalVerified=false}={}) {
    if(!actor?.id||actor.local||!actor.id.startsWith('tailscale:')||(actor.channel!=='ui'&&!approvalVerified))throw problem('请员工使用自己的 Tailscale 工作台账号在界面签到',403);
    const login=normalizeLogin(actor.login),employee=config().employees.find(e=>e.login===login&&e.enabled);
    if(!employee)throw problem('当前账号未加入云仓员工名单',403);
    if(input.login&&normalizeLogin(input.login)!==login)throw problem('不能替其他员工签到',403);
    const day=businessDate(now());if(!employee.workdays.includes(weekday(day)))throw problem('今天不是该员工的工作日');
    const old=db.prepare('SELECT * FROM warehouse_attendance WHERE login=? AND business_date=?').get(login,day);
    if(input.action==='check-in') {
      db.prepare('INSERT OR IGNORE INTO warehouse_attendance(login,business_date,check_in_at) VALUES(?,?,?)').run(login,day,time());
    }else if(input.action==='complete') {
      if(!old)throw problem('请先签到');
      if(!old.completed_at){
        const sync=syncStatus();if(!sync.complete||input.runId!==sync.runId||(input.confirmed!==true&&!approvalVerified))throw problem('今日最新数据尚未完成采集、校验和发群，或批次已变化，请刷新后确认',409);
        const note=String(input.note||'').slice(0,500);
        db.prepare('UPDATE warehouse_attendance SET completed_at=?,run_id=?,note=? WHERE login=? AND business_date=? AND completed_at=\'\'').run(time(),sync.runId,note,login,day);
      }
    }else throw problem('不支持的签到操作');
    audit(actor,input.action,{login,day});return {ok:true};
  }
  async function remind(actor,input,automatic=false,{approvalVerified=false}={}) {
    admin(actor);
    if(!automatic&&input.confirmed!==true&&!approvalVerified)throw problem('请确认提醒对象和渠道');
    if(!automatic&&actor.channel!=='ui'&&!approvalVerified)throw problem('催办须从管理界面发起',403);
    if(!Array.isArray(input.logins)||!input.logins.length||input.logins.length>300||!Array.isArray(input.channels)||!input.channels.length||input.channels.some(c=>!CHANNELS.includes(c)))throw problem('提醒对象或渠道无效');
    const day=businessDate(now()),channels=await getChannels(),results=[];
    for(const login of new Set(input.logins.map(normalizeLogin))){
      const employee=employeesFor(actor).find(e=>e.login===login);
      if(!employee||employee.status==='off'||employee.completedAt)continue;
      for(const channel of new Set(input.channels)){
        const currentEmployee=employeesFor(actor).find(e=>e.login===login);
        if(businessDate(now())!==day||!currentEmployee||currentEmployee.status==='off'||currentEmployee.completedAt)break;
        if(!currentEmployee.channels.includes(channel))continue;
        if(!employee.channels.includes(channel)){results.push({login,channel,status:'unconfigured',message:'员工未启用此渠道'});continue;}
        const old=db.prepare('SELECT * FROM warehouse_reminders WHERE login=? AND business_date=? AND channel=?').get(login,day,channel);
        if(old){results.push({...JSON.parse(old.payload),login,channel,status:old.status,deduplicated:true});continue;}
        const id=randomUUID(),message=`${employee.name}，请完成 ${day} 的云仓任务：${employee.task}。截止 ${employee.deadline}（北京时间）。请用本人工作台账号签到并确认任务。`,payload={name:employee.name,message,receiptId:''};
        // Reserve before any network call. A crash or timeout remains unknown
        // and is never automatically replayed into a second SMS or phone call.
        db.prepare('INSERT INTO warehouse_reminders VALUES(?,?,?,?,?,?,?)').run(id,login,day,channel,'unknown',time(),json(payload));
        let outcome;
        const target=channel==='email'?employee.email:channel==='dingtalk'?employee.dingtalkUserId:employee.mobile;
        if(!channels[channel]?.ready||!target||!senders[channel])outcome={status:'unconfigured',message:channels[channel]?.reason||'缺少接收人或渠道配置'};
        else try{const receipt=await senders[channel]({employee,message,businessDate:day});const receiptId=String(receipt?.receiptId||'').trim();outcome=receiptId?{status:'accepted',receiptId}:{status:'unknown',message:'服务商未返回可核对的受理记录'};}
        catch(error){outcome={status:error?.definiteFailure?'failed':'unknown',message:safeError()};}
        const result={...payload,...outcome};db.prepare('UPDATE warehouse_reminders SET status=?,payload=? WHERE id=?').run(result.status,json(result),id);audit(actor,'remind',{login,day,channel,status:result.status});results.push({...result,login,channel});
      }
    }
    return {ok:true,results};
  }
  async function tick(){
    if(!config().autoRemind)return {skipped:true};
    const actor={id:'system',role:'admin',channel:'ui'},employees=employeesFor(actor).filter(e=>e.status==='overdue'&&!e.completedAt&&e.channels.length);
    const results=[];for(const employee of employees)results.push(await remind(actor,{logins:[employee.login],channels:employee.channels},true));return {results};
  }
  return {beginRun,updateRun,status,configure,action,remind,tick,close:()=>db.close()};
}
