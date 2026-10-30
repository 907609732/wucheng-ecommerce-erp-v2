import {randomBytes,randomUUID,createHash} from 'node:crypto';

const COOKIE='purchase_personnel';
const OWNER='local-owner';
const fail=(message,code,status=403)=>Object.assign(Error(message),{code,status});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cookie=q=>String(q.headers?.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
const brief=row=>row?{id:row.id,name:row.name,role:row.role,active:!!row.active}:null;
const full=row=>({...brief(row),workbenchActorId:row.workbench_actor_id||'',owner:row.id===OWNER,updatedAt:row.updated_at,revision:hash([row.id,row.name,row.role,row.active,row.workbench_actor_id,row.updated_at])});

// Local legacy work modes remain for standalone compatibility. All verified
// gateway members have equal business access; historical roles are metadata.
export function openPurchasePersonnel(store,{sessionTtlMs=12*60*60*1000}={}){
 const {db}=store,sessions=new Map();
 db.exec(`CREATE TABLE IF NOT EXISTS purchase_staff(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('boss','employee')),active INTEGER NOT NULL CHECK(active IN (0,1)),workbench_actor_id TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS purchase_staff_events(id INTEGER PRIMARY KEY AUTOINCREMENT,staff_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const now=new Date().toISOString();
 db.prepare('INSERT OR IGNORE INTO purchase_staff VALUES(?,?,?,?,?,?,?)').run(OWNER,'本机老板','boss',1,null,now,now);
 const get=id=>db.prepare('SELECT * FROM purchase_staff WHERE id=?').get(id);
 function current(req={}){
  const actor=req.workbenchActor;
  let role=null,staff=null,selected=false,readOnly=false,source=actor?'workbench':'local';
  if(actor){
   staff=db.prepare('SELECT * FROM purchase_staff WHERE workbench_actor_id=?').get(actor.id)||null;
   // Gateway signature establishes the real login. Legacy roles/active flags
   // describe historical records and no longer grant or revoke business access.
   role='boss';selected=!!actor.id;readOnly=false;
  }else{
   const entry=sessions.get(cookie(req));
   if(entry&&entry.expiresAt>Date.now()){
    staff=get(entry.staffId)||null;
    if(staff?.active&&staff.role===entry.role){role=entry.role;selected=true;}
   }
  }
  const writable=selected&&!readOnly;
  return {selected,role:selected?role:null,source,readOnly,actor:actor?{id:actor.id,login:actor.login||actor.id,label:actor.label||actor.login||actor.id}:null,staff:brief(staff),canAssign:writable&&role==='boss',canManagePersonnel:writable&&role==='boss',canSubmit:writable&&(!!actor||!!staff?.active),canReview:writable&&role==='boss'};
 }
 function select(req,res,input={}){
  const role=input.role;
  if(!['boss','employee'].includes(role))throw fail('请选择老板或员工身份','PERSONNEL_ROLE_INVALID',400);
  if(req.workbenchActor){
   const identity=current(req);
   if(!identity.selected||identity.readOnly||identity.role!==role||input.staffId&&identity.staff?.id!==input.staffId)throw fail('不能更改已登录工作台成员的身份','PERSONNEL_ROLE_DENIED');
   return identity;
  }
  const staff=role==='boss'?get(OWNER):get(input.staffId);
  if(!staff||!staff.active||staff.role!==role)throw fail('请选择有效的员工，停用人员不能进入','PERSONNEL_STAFF_INVALID');
  for(const [key,value] of sessions)if(value.expiresAt<=Date.now())sessions.delete(key);
  if(sessions.size>=1000)throw fail('人员会话过多，请稍后重试','PERSONNEL_SESSION_LIMIT',429);
  const old=cookie(req);if(old)sessions.delete(old);
  const value=randomBytes(32).toString('base64url');
  sessions.set(value,{role,staffId:staff.id,expiresAt:Date.now()+sessionTtlMs});
  res.setHeader('Set-Cookie',`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs/1000)}`);
  req.headers??={};req.headers.cookie=String(req.headers.cookie||'').split(';').filter(part=>!part.trim().startsWith(COOKIE+'=')).concat(`${COOKIE}=${value}`).join('; ');
  return current(req);
 }
 function list(req){
  if(current(req).canManagePersonnel)return db.prepare('SELECT * FROM purchase_staff ORDER BY role,name,id').all().map(full);
  return db.prepare('SELECT * FROM purchase_staff WHERE active=1 ORDER BY role,name,id').all().map(brief);
 }
 function save(req,input={}){
  const identity=current(req);if(!identity.canManagePersonnel)throw fail('只有老板可以管理采购人员','PERSONNEL_BOSS_REQUIRED');
  const name=typeof input.name==='string'?input.name.trim():'',role=input.role,active=input.active??true,actorId=typeof input.workbenchActorId==='string'?input.workbenchActorId.trim():'';
  if(!name||name.length>100||!['boss','employee'].includes(role)||typeof active!=='boolean')throw fail('请填写有效姓名、身份和启用状态','PERSONNEL_INVALID',400);
  if(actorId&&(actorId.length>300||!/^tailscale:[^\s,]+$/.test(actorId)))throw fail('工作台身份应填写有效的 tailscale:登录账号','PERSONNEL_ACTOR_INVALID',400);
  return store.transaction(()=>{
   const before=input.id?get(input.id):null;
   if(input.id&&!before)throw fail('人员记录不存在','PERSONNEL_NOT_FOUND',404);
   if(before?.id===OWNER)throw fail('本机老板为系统身份，不能修改或停用','PERSONNEL_OWNER_IMMUTABLE');
   if(before&&input.revision!==full(before).revision)throw fail('人员资料已变化，请刷新后重试','PERSONNEL_REVISION_CHANGED',409);
   if(before?.id===identity.staff?.id&&!active)throw fail('不能停用当前操作人','PERSONNEL_SELF_DISABLE');
   if(actorId&&db.prepare('SELECT id FROM purchase_staff WHERE workbench_actor_id=? AND id<>?').get(actorId,before?.id||''))throw fail('该工作台账号已绑定其他人员','PERSONNEL_ACTOR_CONFLICT',409);
   const id=before?.id||randomUUID(),updatedAt=new Date(Math.max(Date.now(),before?Date.parse(before.updated_at)+1:0)).toISOString();
   db.prepare('INSERT INTO purchase_staff VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,active=excluded.active,workbench_actor_id=excluded.workbench_actor_id,updated_at=excluded.updated_at').run(id,name,role,Number(active),actorId||null,before?.created_at||updatedAt,updatedAt);
   const saved=full(get(id));
   db.prepare('INSERT INTO purchase_staff_events(staff_id,actor_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(id,req.workbenchActor?.id||identity.staff.id,before?'update':'create',before?JSON.stringify(full(before)):null,JSON.stringify(saved),updatedAt);
   return saved;
  });
 }
 function mapping(req){
  const a=req.workbenchActor;if(!a?.id||!a.modules?.includes('purchase'))throw fail('需要可信工作台身份','PERSONNEL_ACTOR_REQUIRED');
  const identity=current(req),rows=db.prepare('SELECT * FROM purchase_staff ORDER BY name,id').all().map(full);
  return {identity,actorId:a.id,mapped:!!identity.staff,staff:rows,selectionRequired:!identity.staff,notice:'人员主数据在主页管理。此处只连接历史采购人员与真实工作台ID；禁止按姓名自动绑定。重名须请用户明确选择staffId及主页人员ID。'};
 }
 function previewBinding(req,input){
  const a=req.workbenchActor;if(!a?.id||!a.modules?.includes('purchase'))throw fail('历史人员归属须真实登录后复核','PERSONNEL_ACTOR_REQUIRED');
  const before=get(input.staffId);if(!before)throw fail('请选择存在的历史采购人员','PERSONNEL_STAFF_INVALID',400);
  if(full(before).revision!==input.revision)throw fail('人员映射已变化，请重新查询','PERSONNEL_REVISION_CHANGED',409);
  if(typeof input.actorId!=='string'||!(/^(?:tailscale:[^\s,]+|windows:S-1-5-(?:\d+-)*\d+)$/.test(input.actorId)))throw fail('须选择主页目录返回的真实人员ID，不可填写姓名','PERSONNEL_ACTOR_INVALID',400);
  const conflict=db.prepare('SELECT id FROM purchase_staff WHERE workbench_actor_id=? AND id<>?').get(input.actorId,before.id);
  if(conflict)throw fail('该账号已绑定其他历史采购人员，不能合并或猜测归属','PERSONNEL_ACTOR_CONFLICT',409);
  return {before:full(before),after:{...full(before),workbenchActorId:input.actorId},reason:input.reason};
 }
 function bind(req,input){return store.transaction(()=>{
  const detail=previewBinding(req,input),before=get(input.staffId),now=new Date(Math.max(Date.now(),Date.parse(before.updated_at)+1)).toISOString();
  db.prepare('UPDATE purchase_staff SET workbench_actor_id=?,updated_at=? WHERE id=?').run(input.actorId,now,before.id);
  const after=full(get(before.id));db.prepare('INSERT INTO purchase_staff_events(staff_id,actor_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(before.id,req.workbenchActor.id,'bind-workbench',JSON.stringify(detail.before),JSON.stringify({...after,reason:input.reason}),now);
  return {staff:after,historicalAssignmentsPreserved:true};
 });}
 return {current,select,list,save,mapping,previewBinding,bind};
}
