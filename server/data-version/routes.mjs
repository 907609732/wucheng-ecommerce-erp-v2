const base='/api/workbench/v1/data-versions';
const fail=(statusCode,message)=>Object.assign(Error(message),{statusCode,workbenchPublic:true});
function filters(query={}) {
  const out={};
  for(const key of ['module','actor','status','from','to'])if(query[key]!==undefined){
    if(typeof query[key]!=='string'||query[key].length>200)throw fail(400,'版本查询条件无效');
    out[key]=query[key];
  }
  if(out.module&&!['purchase','sales','overview'].includes(out.module))throw fail(400,'版本模块无效');
  if(out.status&&!['pending','uploading','failed','submitted'].includes(out.status))throw fail(400,'版本状态无效');
  for(const key of ['from','to'])if(out[key]){
    const value=out[key],n=Date.parse(value);
    if(!Number.isFinite(n)||!(/^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.test(value))||new Date(n).toISOString().slice(0,10)!==value.slice(0,10))throw fail(400,'版本日期无效');
  }
  if(out.from&&out.to&&out.from>out.to)throw fail(400,'版本日期范围无效');
  for(const [key,fallback,max]of [['limit',50,100],['offset',0,100000]]){
    const n=query[key]===undefined?fallback:Number(query[key]);
    if(!Number.isInteger(n)||n<(key==='limit'?1:0)||n>max)throw fail(400,'版本分页条件无效');
    out[key]=n;
  }
  return out;
}
function publicEvent(event){
  if(!event)return null;
  const out={};
  for(const key of ['id','module','createdAt','action','summary','counts','status','changeset','submittedAt','error','attempts','nextRetryAt'])if(event[key]!==undefined)out[key]=event[key];
  out.actor={id:event.actor?.id||'',label:event.actor?.label||'系统任务'};
  out.attachments=(event.attachments||[]).map(item=>({name:item.name||String(item.path||'').split(/[\\/]/).pop(),sha256:item.sha256,bytes:item.bytes}));
  return out;
}
export function registerDataVersionRoutes(app,context,worker){
  const protect={preHandler:context.requireSession};
  app.addHook('onSend',async(q,r,payload)=>{if(q.url.split('?')[0].startsWith(base))r.header('cache-control','no-store');return payload;});
  app.get(base,protect,async q=>{const result=await worker.list(filters(q.query));return {items:result.items.map(publicEvent),total:result.total};});
  app.get(base+'/summary',protect,async()=>worker.summary());
  app.get(base+'/:id',protect,async q=>{
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(q.params.id))throw fail(400,'版本标识无效');
    const event=await worker.detail(q.params.id);
    if(!event)throw fail(404,'未找到数据版本');
    return publicEvent(event);
  });
  app.post(base+'/:id/retry',protect,async q=>{
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(q.params.id))throw fail(400,'版本标识无效');
    if(!await worker.detail(q.params.id))throw fail(404,'未找到数据版本');
    const result=await worker.retry(q.params.id);
    context.writeAudit({actorId:q.workbenchActor.id,operation:'data-version.retry',outcome:'queued',details:{eventId:q.params.id}});
    return result;
  });
}
