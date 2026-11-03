import {randomUUID} from 'node:crypto';
import {integrationHash as hash,integrationError as fail} from './local-integration.mjs';

// Shared by the three independently owned ledgers. Only the owning adapter writes.
export function registerReviewedEdits(integration,{db,transaction,backup,types}){
  db.exec(`CREATE TABLE IF NOT EXISTS integration_edit_drafts(
    id TEXT PRIMARY KEY,type TEXT NOT NULL,target TEXT NOT NULL,before_json TEXT NOT NULL,
    proposed_json TEXT NOT NULL,reason TEXT NOT NULL,revision TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',result_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_edit_events(
    id INTEGER PRIMARY KEY,draft_id TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  let busy=false;
  const event=(id,action,payload)=>db.prepare('INSERT INTO integration_edit_events(draft_id,action,payload,created_at) VALUES(?,?,?,?)').run(id,action,JSON.stringify(payload),new Date().toISOString());
  const get=id=>{
    const r=db.prepare('SELECT * FROM integration_edit_drafts WHERE id=?').get(id);if(!r)throw fail('修改草稿不存在',404);
    return {id:r.id,type:r.type,target:r.target,before:JSON.parse(r.before_json),proposed:JSON.parse(r.proposed_json),reason:r.reason,revision:r.revision,state:r.state,result:r.result_json?JSON.parse(r.result_json):null,createdAt:r.created_at};
  };
  const create=input=>{
    const adapter=types[input?.type];if(!adapter)throw fail('不支持的修改类型');
    if(typeof input.target!=='string'||!input.patch||Array.isArray(input.patch)||typeof input.patch!=='object')throw fail('缺少修改对象或字段');
    if(Object.keys(input.patch).some(k=>!adapter.fields.includes(k)))throw fail('包含不支持的修改字段');
    const reason=String(input.reason||'').trim();if(!reason||reason.length>500)throw fail('请填写本次修改原因（最多 500 字）');
    const before=adapter.read(input.target);if(!before)throw fail('目标记录不存在',404);
    const proposed=adapter.propose(before,input.patch,reason);
    const id=randomUUID(),revision=hash({type:input.type,target:input.target,before,proposed,reason});
    db.prepare('INSERT INTO integration_edit_drafts(id,type,target,before_json,proposed_json,reason,revision,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,input.type,input.target,JSON.stringify(before),JSON.stringify(proposed),reason,revision,new Date().toISOString());
    event(id,'prepared',{revision});return {...get(id),reviewUrl:'/integration-edits.html?draft='+id};
  };
  const commitReviewed=async(id,revision,{session,actor,approvalId})=>{
    let d=get(id);if(d.state==='committed')return d.result;
    if(busy)throw fail('正在保存另一项修改，请稍后重试',409);
    busy=true;
    try{
      const adapter=types[d.type];
      const check=()=>{d=get(id);if(d.state!=='draft'||d.revision!==revision||hash(adapter.read(d.target))!==hash(d.before))throw fail('记录或草稿已变化，请重新生成修改草稿',409,'EDIT_CHANGED');};
      check();await backup();check();
      return transaction(()=>{
        check();adapter.write(d.target,d.before,d.proposed,d.reason);
        const actual=adapter.read(d.target),expected=adapter.comparable(d.proposed);
        if(hash(adapter.comparable(actual))!==hash(expected))throw fail('写入后校验不一致，本次修改已撤销',409,'EDIT_MISMATCH');
        const result={id,verified:true,record:JSON.parse(JSON.stringify(actual))};
        db.prepare("UPDATE integration_edit_drafts SET state='committed',result_json=? WHERE id=?").run(JSON.stringify(result),id);
        event(id,'confirmed-and-committed',{revision,session:session||null,approvalId:approvalId||null,actor:actor||null,reason:d.reason,before:d.before,after:actual});return result;
      });
    }catch(e){event(id,'rejected',{message:e.message});throw e;}finally{busy=false;}
  };
  const commit=(id,revision,session,actor)=>{if(!session)throw fail('请在页面查看差异并确认',403);return commitReviewed(id,revision,{session,actor});};
  const previewAgent=(id,revision)=>{const d=get(id);if(d.state!=='draft'||d.revision!==revision||hash(types[d.type].read(d.target))!==hash(d.before))throw fail('记录或草稿已变化，请重新核对',409,'EDIT_CHANGED');return d;};
  const commitAgent=(id,revision,ctx)=>{const proof=ctx?.verifiedApproval;if(!proof||!ctx.actor?.modules?.includes('purchase')||proof.actorId!==ctx.actor?.id||proof.module!=='purchase'||proof.capabilityId!=='edit.commit'||proof.taskId!==ctx.taskId)throw fail('缺少本次修改的中央复核授权',403,'AGENT_APPROVAL_REQUIRED');return commitReviewed(id,revision,{actor:ctx.actor,approvalId:proof.approvalId});};
  const list=()=>db.prepare('SELECT id,type,target,reason,state,revision,created_at FROM integration_edit_drafts ORDER BY created_at DESC').all();
  const {router:r,requireReview:ui}=integration;
  r.get('/edits',(q,s)=>s.json({drafts:db.prepare(`SELECT id,type,target,reason,state,created_at FROM integration_edit_drafts ${q.query.state==='draft'?"WHERE state='draft'":''} ORDER BY created_at DESC LIMIT 100`).all()}));
  r.post('/edits',(q,s)=>s.json(create(q.body)));
  r.get('/edits/:id',(q,s)=>s.json(get(q.params.id)));
  r.post('/edits/:id/commit',ui,async(q,s)=>s.json(await commit(q.params.id,q.body.revision,q.integration.session,q.integration.actor)));
  return {get,create,commit,list,previewAgent,commitAgent,busy:()=>busy};
}
