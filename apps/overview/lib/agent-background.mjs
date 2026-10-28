import {setTimeout as delay} from 'node:timers/promises';

const running=new Set(['pending','running','processing','queued','waiting','querying','submitting','downloading']);
export function backgroundResult({module,job,queryCapability,summary}){
 const id=job?.id||job?.jobId,status=job?.status||job?.state||'unknown';
 const sources=new Set((job?.files||[]).map(file=>file.fileId||file.id));
 const complete=status==='completed'&&Array.isArray(job?.items)&&job.items.length>0&&job.items.every(item=>item.status==='empty'||(item.status==='unavailable'&&item.type==='warehouse')||(item.status==='completed'&&item.verification?.verified===true&&Array.isArray(item.fileIds)&&item.fileIds.length>0&&item.fileIds.every(id=>sources.has(id))));
 const message=status==='completed'&&!complete?'下载状态缺少可校验原件或完整核对结果，请按原任务编号核对':job?.message||(complete?'官方原件处理完成，尚未入账':'后台任务尚未完成，请按原任务编号继续查询');
 return {summary:summary||(complete?'官方原件下载与核对完成，尚未入账':'官方原件任务尚未完成'),scope:{module},blocks:[{type:'job',jobId:id||null,status,message,queryCapability,items:job?.items||[],files:job?.files||[]}],evidence:id?[{jobId:id,status,queryCapability}]:[],changes:[],issues:complete?[]:[{code:running.has(status)?'BACKGROUND_PROCESSING':'BACKGROUND_NEEDS_ACTION',blocking:true,message,jobId:id||null,status,queryCapability}]};
}

// A bounded wait never converts a submitted or paused job into a completed task.
export async function settleBackgroundJob({module,jobId,queryCapability,query,ctx,waitMs=45000,pollMs=3000}){
 if(!jobId)return {summary:'未取得持久任务编号，请先查询已有下载任务，勿重复启动',scope:{module},blocks:[],evidence:[],changes:[],issues:[{code:'BACKGROUND_JOB_UNKNOWN',blocking:true,message:'下载提交结果未知；先查询已有任务，禁止自动重新启动',queryCapability:module+'.cainiao-jobs'}]};
 const deadline=Date.now()+waitMs;
 while(true){
  ctx?.signal?.throwIfAborted();
  let job;try{job=await query(jobId);}catch(error){if(ctx?.signal?.aborted)throw error;return {summary:'后台任务状态暂时无法回读',scope:{module},blocks:[{type:'job',jobId,status:'unknown',queryCapability}],evidence:[{jobId,queryCapability}],changes:[],issues:[{code:'BACKGROUND_QUERY_FAILED',blocking:true,message:'保留原任务编号，恢复连接后继续查询；不重复启动',jobId,queryCapability}]};}
  const output=backgroundResult({module,job,queryCapability});
  ctx?.emit?.('job.updated',output.blocks[0]);
  if(!running.has(job?.status||job?.state)||Date.now()>=deadline)return output;
  await delay(Math.min(pollMs,Math.max(1,deadline-Date.now())),undefined,{signal:ctx?.signal});
 }
}

export function existingDownload(jobs,input){
 if(!Array.isArray(jobs))return null;
 // An unfinished task is resumed or inspected by its persisted ID, never silently replaced.
 return jobs.find(job=>{if(job.account!==input.account||!Array.isArray(job.months)||job.months[0]!==input.from||job.months.at(-1)!==(input.to||input.from))return false;if(job.status!=='completed')return true;return input.force!==true&&(!input.cutoff||job.cutoffs?.[input.to||input.from]===input.cutoff)&&Object.entries(input.cutoffs||{}).every(([month,cutoff])=>job.cutoffs?.[month]===cutoff);});
}

export function backgroundJobId(output){
 if(output?.jobId||output?.id)return output.jobId||output.id;
 for(const block of output?.blocks||[]){if(block.jobId)return block.jobId;for(const row of block.rows||[])if(row?.id||row?.jobId)return row.jobId||row.id;}
 return null;
}
