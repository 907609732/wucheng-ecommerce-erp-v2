import {hash,now,fail,required} from './util.mjs';

export function createSalesDomainPeople(store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS sales_domain_people(id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sales_actor_people(actor_id TEXT PRIMARY KEY,domain_person_id TEXT UNIQUE NOT NULL REFERENCES sales_domain_people(id),confirmed_by TEXT NOT NULL,reason TEXT NOT NULL,confirmed_at TEXT NOT NULL);`);
 const historical=()=>store.all('SELECT DISTINCT submitted_by AS id FROM sales_staff_handoffs WHERE submitted_by IS NOT NULL AND submitted_by<>\'\' ORDER BY submitted_by').map(row=>({id:row.id,name:'历史提交人（姓名未登记）',source:'sales_staff_handoffs',historical:true}));
 const candidates=()=>{const rows=new Map(store.all('SELECT id,name,source FROM sales_domain_people ORDER BY id').map(row=>[row.id,row]));for(const row of historical())if(!rows.has(row.id))rows.set(row.id,row);return [...rows.values()];};
 const revision=()=>hash({people:candidates(),mappings:store.all('SELECT * FROM sales_actor_people ORDER BY actor_id')});
 function inspect(actor){
  if(!actor?.id)throw fail('缺少真实登录人员',403);
  const mapping=store.get('SELECT m.*,p.name FROM sales_actor_people m JOIN sales_domain_people p ON p.id=m.domain_person_id WHERE actor_id=?',actor.id);
  const claimed=new Set(store.all('SELECT domain_person_id FROM sales_actor_people WHERE actor_id<>?',actor.id).map(row=>row.domain_person_id));
  const rows=candidates().filter(row=>!claimed.has(row.id)).map(row=>({...row,requiresExplicitSelection:true}));
  const names=new Map();for(const row of rows)names.set(row.name,(names.get(row.name)||0)+1);
  return {actorId:actor.id,login:actor.login||actor.id,effectiveBusinessRole:actor.role==='admin'?'boss':'employee',mapping:mapping||null,revision:revision(),newPersonId:'person:'+hash(actor.id).slice(0,32),candidates:rows.map(row=>({...row,ambiguousName:names.get(row.name)>1})),requiresSelection:!mapping,
   summary:mapping?'当前登录人员已有销售领域映射':'请本人选择历史人员ID或明确新建领域人员；不能按姓名猜测',
   blocks:[{type:'table',id:'sales-person-candidates',title:'可明确选择的销售领域人员',rowKey:'id',rows}],
   issues:mapping?[]:[{code:'DOMAIN_PERSON_SELECTION_REQUIRED',blocking:true,message:'历史记录只保存提交人标识，姓名或老板/员工角色不能替代本人身份确认',actorId:actor.id,selectionCapability:'sales.personnel-link'}]};
 }
 function validate(actor,input){
  const state=inspect(actor);if(input.revision!==state.revision)throw fail('人员映射已变化，请重新读取后选择',409,'DOMAIN_PERSON_CHANGED');
  const selected=required(input.domainPersonId,'领域人员ID',200),name=required(input.displayName,'显示姓名',80);required(input.reason,'本人确认依据',500);
  if(selected!==state.newPersonId&&!state.candidates.some(row=>row.id===selected))throw fail('选中的领域人员不存在或已经属于其他登录人员',409,'DOMAIN_PERSON_UNAVAILABLE');
  const old=store.get('SELECT name FROM sales_domain_people WHERE id=?',selected);if(old&&old.name!==name)throw fail('已登记姓名不能在人员绑定中静默改写',409,'DOMAIN_PERSON_NAME_CHANGED');
  return {actorId:actor.id,domainPersonId:selected,displayName:name,source:selected===state.newPersonId?'explicit-global-person':'explicit-historical-choice',confirmedBy:actor.id,reason:input.reason};
 }
 function link(actor,input){const selected=validate(actor,input);return store.transaction(()=>{
  store.run('INSERT OR IGNORE INTO sales_domain_people VALUES(?,?,?,?)',selected.domainPersonId,selected.displayName,selected.source,now());
  store.run('INSERT INTO sales_actor_people VALUES(?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET domain_person_id=excluded.domain_person_id,confirmed_by=excluded.confirmed_by,reason=excluded.reason,confirmed_at=excluded.confirmed_at',actor.id,selected.domainPersonId,actor.id,input.reason,now());
  store.audit('personnel.link',actor.id,selected);return selected;
 });}
 function requireMapping(actor){const state=inspect(actor);if(!state.mapping)throw fail('请先由本人确认销售领域人员映射',409,'DOMAIN_PERSON_SELECTION_REQUIRED');return state.mapping;}
 return {inspect,validate,link,requireMapping};
}
