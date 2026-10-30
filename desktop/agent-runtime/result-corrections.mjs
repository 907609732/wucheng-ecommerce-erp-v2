import {agentError,canonicalJson} from './approval.mjs';

const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const scalar=value=>value===null||typeof value==='boolean'||typeof value==='string'&&value.length<=4000||typeof value==='number'&&Number.isFinite(value);
const safeKey=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!['__proto__','constructor','prototype'].includes(value);

/** Corrections are new human requirements, never mutations of saved rows or commitData. */
export function prepareResultCorrections({payload,task,result,adapterMap,actor,now=Date.now}){
  const request=payload.corrections;
  if(!plain(request)||!Array.isArray(request.edits)||request.edits.length<1||request.edits.length>100)throw agentError('CORRECTIONS_INVALID','请选择 1–100 个草稿字段进行更正');
  if(!['admin','editor'].includes(actor.role)||actor.canRunTasks!==true)throw agentError('TASK_PERMISSION_REQUIRED','当前人员无权更正业务草稿',403);
  if(!result||result.id!==request.resultId||result.version!==request.resultVersion||task.resultId!==result.id)throw agentError('RESULT_STALE','结果版本已变化，请刷新后重新核对更正',409);
  if(!['waiting_review','waiting_input','paused','failed'].includes(task.status)||result.receipt||(task.completedStages||[]).length)throw agentError('RESULT_NOT_EDITABLE','此结果已有提交或不属于可更正草稿，请另建更正任务',409);
  const seen=new Set(),edits=[];
  for(const edit of request.edits){
    if(!plain(edit)||!safeKey(edit.blockId)||!safeKey(edit.field)||!scalar(edit.rowKey)||edit.rowKey===null||!Object.hasOwn(edit,'before')||!Object.hasOwn(edit,'after')||!scalar(edit.before)||!scalar(edit.after))throw agentError('CORRECTIONS_INVALID','更正字段、稳定行标识或数值无效');
    const matching=(result.blocks||[]).filter(block=>block.id===edit.blockId),block=matching[0];
    const cap=adapterMap.get(block?.sourceModule)?.capabilities?.find(item=>item.id===block.sourceCapabilityId);
    if(matching.length!==1||block.type!=='table'||!safeKey(block.rowKey)||!Array.isArray(block.editableFields)||!block.editableFields.includes(edit.field)||!Array.isArray(cap?.resultEditFields)||!cap.resultEditFields.includes(edit.field)||!actor.modules.includes(block.sourceModule)||!(result.prepared||[]).some(step=>step.module===block.sourceModule&&step.capabilityId===block.sourceCapabilityId))throw agentError('RESULT_FIELD_READ_ONLY','此表格字段未声明为可更正草稿',403);
    const rows=(Array.isArray(block.rows)?block.rows:[]).filter(row=>plain(row)&&Object.hasOwn(row,block.rowKey)&&canonicalJson(row[block.rowKey])===canonicalJson(edit.rowKey));
    if(rows.length!==1||!Object.hasOwn(rows[0],edit.field)||canonicalJson(rows[0][edit.field])!==canonicalJson(edit.before))throw agentError('RESULT_ROW_CHANGED','原字段或行标识已变化，请刷新后重新更正',409);
    const key=canonicalJson([edit.blockId,edit.rowKey,edit.field]);
    if(seen.has(key))throw agentError('CORRECTIONS_DUPLICATE','同一字段不能重复更正');seen.add(key);
    if(canonicalJson(edit.before)===canonicalJson(edit.after))continue;
    edits.push({...structuredClone(edit),module:block.sourceModule,capabilityId:block.sourceCapabilityId});
  }
  if(!edits.length)throw agentError('CORRECTIONS_EMPTY','没有需要保存的更正');
  const corrections={schemaVersion:1,resultId:result.id,resultVersion:result.version,taskId:task.id,actorId:actor.id,createdAt:now(),edits};
  const text=[String(payload.text||'').trim(),'用户对以下草稿字段提出更正。请按对应能力重新准备、校验和计算，生成新版本供用户复核；不能将更正视为入账授权，不能复用旧审批。',JSON.stringify(corrections)].filter(Boolean).join('\n');
  if(text.length>20000)throw agentError('CORRECTIONS_TOO_LARGE','本次更正过多，请分次提交');
  return {text,corrections};
}
