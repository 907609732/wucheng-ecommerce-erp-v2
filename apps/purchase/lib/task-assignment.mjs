import {createHash} from 'node:crypto';
import {purchaseMonth} from './month-locks.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,code,status=403)=>Object.assign(Error(message),{code,status});
const scopeHash=orders=>hash(orders.map(o=>[o.id,o.updatedAt]).sort((a,b)=>a[0].localeCompare(b[0])));
const clean=value=>typeof value==='string'?value.trim():'';
const dateValid=value=>/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

export function openTaskAssignment(store,taskCenter,personnel){
 const {db}=store;
 db.exec(`CREATE TABLE IF NOT EXISTS purchase_task_assignments(month TEXT NOT NULL,task_id TEXT NOT NULL,assignee_id TEXT NOT NULL,due_on TEXT NOT NULL,instructions TEXT NOT NULL,state TEXT NOT NULL,assigned_by TEXT NOT NULL,submitted_by TEXT,submitted_at TEXT,submission_note TEXT NOT NULL DEFAULT '',submission_result TEXT NOT NULL DEFAULT 'done',reviewed_by TEXT,reviewed_at TEXT,review_note TEXT NOT NULL DEFAULT '',scope_revision TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(month,task_id));
 CREATE TABLE IF NOT EXISTS purchase_task_assignment_events(id INTEGER PRIMARY KEY AUTOINCREMENT,month TEXT NOT NULL,task_id TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
 const allStaff=()=>db.prepare('SELECT * FROM purchase_staff ORDER BY id').all();
 const scope=(month,task)=>store.list().filter(o=>purchaseMonth(o)===month&&(!task.platform||o.platform===task.platform));
 const assignmentRows=month=>db.prepare('SELECT * FROM purchase_task_assignments WHERE month=? ORDER BY task_id').all(month);
 const actorId=(req,identity)=>req.workbenchActor?.id||identity.staff?.id||'';
 function overview(req,month,{all=false}={}){
  const base=taskCenter.overview(month),identity=personnel.current(req),staff=allStaff(),rows=assignmentRows(month);
  const tasks=base.tasks.map(task=>{
   const row=rows.find(r=>r.task_id===task.id),assignee=row&&staff.find(s=>s.id===row.assignee_id),validAssignee=req.workbenchActor?!!assignee:!!assignee?.active;
   const changed=row&&['submitted','accepted'].includes(row.state)&&row.scope_revision!==scopeHash(scope(month,task));
   const state=changed?'stale':row?.state;
   const assignment=row?{assigneeId:row.assignee_id,assigneeName:assignee?.name||'已移除人员',assigneeActive:validAssignee,dueOn:row.due_on,instructions:row.instructions,state,submittedAt:row.submitted_at,submittedBy:row.submitted_by,submissionNote:row.submission_note,result:row.submission_result,reviewNote:row.review_note,reviewedAt:row.reviewed_at,reviewedBy:row.reviewed_by,updatedAt:row.updated_at,revision:hash([row.version,row.updated_at,row.scope_revision,state,assignee?.active,assignee?.name])}:null;
   const writable=identity.selected&&!identity.readOnly&&task.status!=='locked'&&task.kind!=='confirm',own=writable&&validAssignee&&(!!req.workbenchActor||identity.staff?.id===row?.assignee_id);
   return {...task,completed:task.status==='locked'||state==='accepted',assignment,permissions:{canAssign:writable&&identity.canAssign,canStart:own&&['assigned','returned','stale'].includes(state),canSubmit:own&&identity.canSubmit&&['in_progress','returned','stale'].includes(state),canReview:writable&&identity.canReview&&validAssignee&&state==='submitted'}};
  });
  const eventVersion=db.prepare('SELECT MAX(id) AS version FROM purchase_task_assignment_events WHERE month=?').get(month).version||0;
  const revision=hash({base:base.revision,eventVersion,assignments:rows,staff:staff.map(s=>[s.id,s.name,s.role,s.active,s.workbench_actor_id,s.updated_at])});
  const visible=!req.workbenchActor&&!all&&identity.role==='employee'&&!identity.readOnly?tasks.filter(t=>identity.staff&&t.assignment?.assigneeId===identity.staff.id):tasks;
  const work=visible.filter(t=>t.kind!=='confirm'&&t.status!=='locked'),count=state=>work.filter(t=>t.assignment?.state===state).length,visibleOrders=new Set();
  for(const task of visible)for(const order of scope(month,task))visibleOrders.add(order.id);
  const completed=visible.filter(t=>t.completed).length;
  const summary={...base.summary,total:visible.length,completed,pending:visible.length-completed,stale:visible.filter(t=>t.assignment?.state==='stale'||t.status==='stale').length,orderCount:visibleOrders.size,lockedPlatforms:new Set(visible.filter(t=>t.status==='locked'&&t.platform).map(t=>t.platform)).size};
  return {...base,revision,summary,personnel:identity,staff:personnel.list(req),tasks:visible,workflowSummary:{unassigned:work.filter(t=>!t.assignment).length,assigned:count('assigned'),inProgress:count('in_progress'),submitted:count('submitted'),accepted:count('accepted'),returned:count('returned'),stale:count('stale'),mine:work.filter(t=>identity.staff&&t.assignment?.assigneeId===identity.staff.id).length,pendingReview:count('submitted')}};
 }
 function act(req,input={}){
  const identity=personnel.current(req);
  if(!identity.selected)throw fail('请先选择有效的采购工作身份','PERSONNEL_REQUIRED');
  if(identity.readOnly)throw fail('当前账号仅有只读权限','PERSONNEL_READ_ONLY');
  const {month,taskId,action,revision}=input;
  if(!['assign','start','submit','accept','return'].includes(action))throw fail('任务操作无效','ASSIGNMENT_ACTION_INVALID',400);
  const note=clean(input.note),instructions=clean(input.instructions),dueOn=clean(input.dueOn);
  if(note.length>2000||instructions.length>2000)throw fail('任务说明与备注最多2000字','ASSIGNMENT_TEXT_TOO_LONG',400);
  if(dueOn&&!dateValid(dueOn))throw fail('请选择有效的截止日期','ASSIGNMENT_DUE_INVALID',400);
  return store.transaction(()=>{
   const current=overview(req,month,{all:true}),task=current.tasks.find(t=>t.id===taskId);
   if(!task)throw fail('采购任务不存在','ASSIGNMENT_TASK_INVALID',404);
   if(typeof revision!=='string'||revision!==current.revision)throw fail('任务、人员或采购数据已变化，请刷新后再操作','ASSIGNMENT_REVISION_CHANGED',409);
   if(task.status==='locked')throw fail('本月此任务范围已锁定，请先到月度确认取消确认','ASSIGNMENT_MONTH_LOCKED',423);
   if(task.kind==='confirm')throw fail('月度确认由老板按现有确认流程操作，不能作为员工任务分派','ASSIGNMENT_CONFIRM_PROTECTED');
   const before=db.prepare('SELECT * FROM purchase_task_assignments WHERE month=? AND task_id=?').get(month,taskId)||null;
   const now=new Date(Math.max(Date.now(),before?Date.parse(before.updated_at)+1:0)).toISOString(),who=actorId(req,identity),currentScope=scopeHash(scope(month,task));
   let after;
   if(action==='assign'){
    if(!task.permissions.canAssign)throw fail('请先登录再分派采购任务','ASSIGNMENT_BOSS_REQUIRED');
    const target=db.prepare('SELECT * FROM purchase_staff WHERE id=?').get(clean(input.assigneeId));
    if(!target||!req.workbenchActor&&(!target.active||target.role!=='employee'&&target.id!==identity.staff?.id))throw fail('请选择启用的员工，或分派给老板本人','ASSIGNMENT_STAFF_INVALID',400);
    after={month,task_id:taskId,assignee_id:target.id,due_on:dueOn,instructions,state:'assigned',assigned_by:who,submitted_by:null,submitted_at:null,submission_note:'',submission_result:'done',reviewed_by:null,reviewed_at:null,review_note:'',scope_revision:currentScope,updated_at:now,version:(before?.version||0)+1};
   }else{
    if(!before)throw fail('此任务尚未分派','ASSIGNMENT_REQUIRED',409);
    const target=db.prepare('SELECT * FROM purchase_staff WHERE id=?').get(before.assignee_id);
    if(!target||!req.workbenchActor&&!target.active)throw fail('负责人员已停用，请由老板重新分派','ASSIGNMENT_STAFF_INACTIVE');
    after={...before,updated_at:now,version:before.version+1};
    if(action==='start'){
     if(!task.permissions.canStart)throw fail('请确认任务处于可开始状态','ASSIGNMENT_NOT_OWNER');
     Object.assign(after,{state:'in_progress',submitted_by:null,submitted_at:null,submission_note:'',reviewed_by:null,reviewed_at:null,scope_revision:currentScope});
    }else if(action==='submit'){
     if(!task.permissions.canSubmit)throw fail('请确认任务处于可提交状态','ASSIGNMENT_NOT_OWNER');
     if(input.ack!==true||!note)throw fail('请核对任务范围并填写提交说明','ASSIGNMENT_SUBMISSION_REQUIRED',400);
     const result=input.result||'done';
     if(!['done','no_activity'].includes(result)||result==='no_activity'&&(task.kind!=='collect'||task.evidence.count!==0))throw fail('仅无订单的平台任务可以提交无采购结果','ASSIGNMENT_RESULT_INVALID',400);
     Object.assign(after,{state:'submitted',submitted_by:who,submitted_at:now,submission_note:note,submission_result:result,reviewed_by:null,reviewed_at:null,review_note:'',scope_revision:currentScope});
    }else{
     if(!identity.canReview)throw fail('请先登录再验收或退回任务','ASSIGNMENT_BOSS_REQUIRED');
     if(task.assignment.state!=='submitted'||before.scope_revision!==currentScope)throw fail('提交资料已变化或尚未提交，请员工重新提交','ASSIGNMENT_SUBMISSION_STALE',409);
     if(action==='return'){
      if(!note)throw fail('请填写退回补充的原因','ASSIGNMENT_RETURN_REASON_REQUIRED',400);
      Object.assign(after,{state:'returned',reviewed_by:who,reviewed_at:now,review_note:note});
     }else{
      // Accept the precise submitted scope; nested store transactions remain atomic.
      const base=taskCenter.overview(month);
      taskCenter.update({month,taskId,status:before.submission_result,operator:(identity.staff?.name||req.workbenchActor?.login||'老板').slice(0,100),note:`经办：${target.name}；提交：${before.submission_note}${note?'；验收：'+note:''}`.slice(0,2000),ack:true,revision:base.revision});
      Object.assign(after,{state:'accepted',reviewed_by:who,reviewed_at:now,review_note:note,scope_revision:currentScope});
     }
    }
   }
   const fields=['month','task_id','assignee_id','due_on','instructions','state','assigned_by','submitted_by','submitted_at','submission_note','submission_result','reviewed_by','reviewed_at','review_note','scope_revision','updated_at','version'];
   db.prepare(`INSERT INTO purchase_task_assignments(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')}) ON CONFLICT(month,task_id) DO UPDATE SET ${fields.slice(2).map(field=>field+'=excluded.'+field).join(',')}`).run(...fields.map(field=>after[field]));
   db.prepare('INSERT INTO purchase_task_assignment_events(month,task_id,action,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)').run(month,taskId,action,who,before?JSON.stringify(before):null,JSON.stringify(after),now);
   return overview(req,month);
  });
 }
 return {overview,act};
}
