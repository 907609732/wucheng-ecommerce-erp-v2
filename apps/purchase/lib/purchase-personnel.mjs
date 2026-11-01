import {randomBytes,randomUUID,createHash} from 'node:crypto';

const COOKIE='purchase_personnel';
const OWNER='local-owner';
const fail=(message,code,status=403)=>Object.assign(Error(message),{code,status});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cookie=q=>String(q.headers?.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
const brief=row=>row?{id:row.id,name:row.name,role:row.role,active:!!row.active}:null;
const full=row=>({...brief(row),workbenchActorId:row.workbench_actor_id||'',owner:row.id===OWNER,updatedAt:row.updated_at,revision:hash([row.id,row.name,row.role,row.active,row.workbench_actor_id,row.updated_at])});

// Local role selection is a work mode, matching the existing sales desk. Remote
// authority always comes from the gateway's verified actor, never the role form.
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
   role=actor.role==='admin'?'boss':['editor','viewer'].includes(actor.role)?'employee':null;
   selected=!!role&&(!staff||!!staff.active);
   readOnly=actor.role==='viewer'||!role||!!staff&&!staff.active||Array.isArray(actor.modules)&&!actor.modules.includes('purchase');
   if(readOnly&&actor.role!=='viewer')selected=false;
  }else{
   const entry=sessions.get(cookie(req));
   if(entry&&entry.expiresAt>Date.now()){
    staff=get(entry.staffId)||null;
    if(staff?.active&&staff.role===entry.role){role=entry.role;selected=true;}
   }
  }
  const writable=selected&&!readOnly;
  return {selected,role:selected?role:null,source,readOnly,staff:brief(staff),canAssign:writable&&role==='boss',canManagePersonnel:writable&&role==='boss',canSubmit:writable&&!!staff?.active,canReview:writable&&role==='boss'};
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
 return {current,select,list,save};
}
