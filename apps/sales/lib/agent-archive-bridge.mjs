import {createHash} from 'node:crypto';
import {stageTaskAttachment} from './agent-host-files.mjs';
import {prepareArchivedFreight} from './agent-cainiao-artifacts.mjs';
import {hash,fail,month as checkMonth} from './util.mjs';

export function normalizedOverviewManifest(value){
 if(value?.ready!==true||value.basis!=='业务时间'||!Array.isArray(value.files)||!value.files.length)throw fail('总览归档尚未取得完整范围和核验依据',409,'OVERVIEW_ARCHIVE_NOT_READY');
 const manifest={version:1,jobId:value.jobId,month:checkMonth(value.month),account:value.account,basis:value.basis,from:value.from,cutoff:value.cutoff,files:value.files.filter(file=>file.postingRelevant!==false).map(file=>({fileId:file.fileId,report:file.role||file.report,filename:file.filename,sha256:file.sha256,bytes:file.bytes,from:file.from,cutoff:file.cutoff,expected:{count:file.expected?.count??null,amountCents:file.expected?.amountCents??null},verification:{verified:file.verification?.verified===true}})).sort((a,b)=>(a.report+a.filename+a.sha256).localeCompare(b.report+b.filename+b.sha256))};
 if(!manifest.jobId||!manifest.account||!manifest.from||!manifest.cutoff||manifest.files.some(file=>!file.fileId||!['transactions','fees','warehouse'].includes(file.report)||!file.filename||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||!file.verification.verified||file.from!==manifest.from||file.cutoff!==manifest.cutoff))throw fail('总览归档清单缺少可信原件、范围或摘要',409,'OVERVIEW_MANIFEST_INVALID');
 for(const report of ['transactions','fees'])if(!manifest.files.some(file=>file.report===report&&Number.isSafeInteger(file.expected.count)&&Number.isSafeInteger(file.expected.amountCents)))throw fail('总览归档缺少交易或费用的实际核验依据',409,'OVERVIEW_MANIFEST_INVALID');
 return manifest;
}
export const overviewManifestDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function stageOverviewArtifacts({input,ctx,request}){
 if(!ctx?.actor?.modules?.includes('sales')||!ctx.actor.modules.includes('overview'))throw fail('复用总览原件需要当前人员具有总览及销售权限',403,'CROSS_MODULE_PERMISSION_REQUIRED');
 if(typeof ctx.resolveTaskArtifact!=='function')throw fail('主机尚未接通本任务可信产物解析',503,'TASK_ARTIFACT_RESOLVER_REQUIRED');
 const raw=await request('overview','/api/integration/v1/agent/query?'+new URLSearchParams({capabilityId:'overview.cainiao-handoff',input:JSON.stringify({jobId:input.sourceJobId,month:input.month}),taskId:ctx.taskId}),{method:'GET',ctx,signal:ctx.signal});
 if(raw.ready!==true)return {blocked:{summary:'总览原件仍有未解决缺口，未开始销售采集或入账',scope:{module:'sales',month:input.month},blocks:raw.blocks||[],evidence:raw.evidence||[],changes:[],issues:raw.issues?.length?raw.issues:[{code:'OVERVIEW_ARCHIVE_NOT_READY',blocking:true,message:'请先完成原归档任务的范围与文件核验',module:'overview',jobId:input.sourceJobId}]}};
 const manifest=normalizedOverviewManifest(raw);if(manifest.jobId!==input.sourceJobId||manifest.month!==input.month)throw fail('总览返回的归档范围与当前选择不一致',409,'OVERVIEW_SCOPE_CHANGED');
 const ids=[...new Set(input.artifactIds||[])];if(ids.length!==manifest.files.length)throw fail('请选择该月份清单中参与入账的交易和费用完整原件，不要混入补充仓储文件或遗漏分卷',409,'OVERVIEW_ARTIFACTS_INCOMPLETE');
 const staged=[],matched=new Set();
 for(const artifactId of ids){
  ctx.signal?.throwIfAborted();const artifact=await ctx.resolveTaskArtifact(artifactId);
  if(artifact?.taskId!==ctx.taskId||(artifact.actorId&&artifact.actorId!==ctx.actor.id)||(artifact.ownerId&&artifact.ownerId!==ctx.actor.id)||artifact.sourceModule!=='overview'||artifact.sourceCapabilityId!=='overview.cainiao-file')throw fail('只接受本任务中由总览云仓原件能力生成并带可信来源的产物',403,'ARTIFACT_SOURCE_REQUIRED');
  const matches=manifest.files.filter(file=>file.sha256===artifact.sha256&&file.filename===artifact.name&&file.bytes===artifact.size);
  if(matches.length!==1||matched.has(matches[0].fileId))throw fail('中央产物与总览归档清单不唯一或不一致，请明确选择原件',409,'ARTIFACT_MANIFEST_MISMATCH');
  const source=matches[0];matched.add(source.fileId);
  const file=await stageTaskAttachment({module:'sales',attachmentId:artifactId,ctx:{...ctx,resolveAttachment:async id=>{if(id!==artifactId)throw fail('产物不属于本次传输',403);return artifact;}},request});
  if(file.sha256!==source.sha256||file.bytes!==source.bytes||file.id===source.fileId)throw fail('销售原件重新暂存校验未通过',409,'ARTIFACT_STAGE_MISMATCH');
  staged.push({id:file.id,artifactId,filename:file.filename,sha256:file.sha256,sourceModule:'overview',sourceCapabilityId:'overview.cainiao-file',report:source.report});
 }
 return {manifest,manifestDigest:overviewManifestDigest(manifest),files:staged};
}

export function createArchiveHandoffs(store){
 store.db.exec('CREATE TABLE IF NOT EXISTS agent_cainiao_handoffs(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,task_id TEXT NOT NULL,payload TEXT NOT NULL)');
 const get=(id,ctx)=>{const row=store.get('SELECT payload FROM agent_cainiao_handoffs WHERE id=? AND actor_id=? AND task_id=?',id,ctx.actor.id,ctx.taskId);if(!row)throw fail('交接原件不属于当前人员和任务',404,'ARCHIVE_HANDOFF_NOT_FOUND');return JSON.parse(row.payload);};
 async function preview(payload,ctx){
  const manifest=payload.manifest,files=payload.files.map(file=>{const resolved=ctx.resolveFile(file.id);if(resolved.sha256!==file.sha256||resolved.filename!==file.filename)throw fail('销售暂存原件已变化',409,'ARCHIVE_SOURCE_CHANGED');return {...file,buffer:Buffer.from(resolved.dataBase64,'base64')};});
  const expected={};for(const report of ['transactions','fees','warehouse']){const sources=manifest.files.filter(file=>file.report===report);if(sources.length){const values=[...new Map(sources.map(file=>[JSON.stringify(file.expected),file.expected])).values()];if(values.length!==1)throw fail('同一导出角色的分卷核验依据不明确，不能猜测相加',409,'ARCHIVE_PART_EVIDENCE_AMBIGUOUS');expected[report]={...values[0],period:manifest.month,from:manifest.from,to:manifest.cutoff};}}
  return prepareArchivedFreight({store,month:manifest.month,files,scope:{account:manifest.account,from:manifest.from,to:manifest.cutoff,expected,files:manifest.files}});
 }
 async function adopt(input,ctx){
  if(!ctx.actor.modules?.includes('overview'))throw fail('缺少总览来源权限',403);
  const manifest=normalizedOverviewManifest({...input.manifest,ready:true});if(overviewManifestDigest(manifest)!==input.manifestDigest)throw fail('总览来源摘要不一致',409,'ARCHIVE_MANIFEST_CHANGED');
  const payload={manifest,manifestDigest:input.manifestDigest,files:input.files};
  for(const file of payload.files){const source=manifest.files.filter(row=>row.filename===file.filename&&row.sha256===file.sha256&&row.report===file.report);if(source.length!==1||file.sourceModule!=='overview'||file.sourceCapabilityId!=='overview.cainiao-file'||file.id===source[0].fileId)throw fail('交接原件来源不一致',409,'ARCHIVE_MANIFEST_CHANGED');}
  if(new Set(payload.files.map(file=>file.id)).size!==manifest.files.length||payload.files.length!==manifest.files.length)throw fail('原件交接不完整',409);
  const draft=await preview(payload,ctx),id=hash({actorId:ctx.actor.id,taskId:ctx.taskId,...payload});
  store.run('INSERT OR IGNORE INTO agent_cainiao_handoffs VALUES(?,?,?,?)',id,ctx.actor.id,ctx.taskId,JSON.stringify(payload));
  return {handoffId:id,...draft};
 }
 return {get,adopt,preview:async(id,ctx)=>({handoffId:id,...await preview(get(id,ctx),ctx)})};
}
