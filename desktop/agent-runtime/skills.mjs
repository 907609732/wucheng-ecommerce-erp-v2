import {randomUUID} from 'node:crypto';
import {agentError,agentDigest,canonicalJson} from './approval.mjs';
import {assertSkillKeys,skillObject,skillJson,validateSkillDefinition,validateSkillInputs,skillBindingSnapshot} from './skills-definition.mjs';

const idValue=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const revisionNumber=value=>Number.isSafeInteger(value)&&value>0;
const note=value=>{if(value===undefined)return '';if(typeof value!=='string'||value.length>1000)throw agentError('SKILL_DEFINITION_INVALID','版本变更说明最多 1000 字',400);return value;};
const revisionId=(id,number)=>id+':'+number;
const metadata=revision=>({number:revision.number,sha256:revision.sha256,changeNote:revision.changeNote,createdAt:revision.createdAt,createdBy:revision.createdBy});
const publicRevision=revision=>({...metadata(revision),definition:structuredClone(revision.definition)});

export function createAgentSkills({store,getCapability,now=Date.now}){
  function skill(id){if(!idValue(id))throw agentError('SKILL_NOT_FOUND','技能不存在',404);const value=store.get('skill',id);if(!value)throw agentError('SKILL_NOT_FOUND','技能不存在',404);return value;}
  function revision(id,number){if(!revisionNumber(number))throw agentError('SKILL_REVISION_NOT_FOUND','技能内容版本不存在',404);const value=store.get('skill_revision',revisionId(id,number));if(!value||value.skillId!==id||value.number!==number)throw agentError('SKILL_REVISION_NOT_FOUND','技能内容版本不存在',404);if(!skillObject(value.definition)||agentDigest(value.definition)!==value.sha256)throw agentError('SKILL_REVISION_CHANGED','技能内容摘要不匹配，请核对版本记录',409);return value;}
  function actualRun(id,number){
    const task=store.list('task').filter(task=>task.skillSnapshot?.id===id&&task.skillSnapshot?.revision===number&&task.executionStartedAt).sort((a,b)=>b.executionStartedAt-a.executionStartedAt)[0];if(!task)return null;
    const result=task.resultId?store.get('result',task.resultId):null,hasResult=result?.taskId===task.id;
    const state=hasResult&&task.status==='completed'&&!result.issues?.some(issue=>issue.blocking)?'completed':hasResult&&task.status==='waiting_review'&&task.review?'waiting_review':'incomplete';
    return {state,label:state==='completed'?'实际任务完成':state==='waiting_review'?'实际任务待复核':'上次未完成',taskId:task.id,revision:number,sha256:task.skillSnapshot.sha256,engine:task.executionEngine||task.engine,model:task.executionModel||null,at:task.updatedAt||task.executionStartedAt,status:task.status,...(hasResult?{resultId:result.id,resultVersion:result.version,...(result.receipt?{receiptState:result.receipt.state}:{})}:{})};
  }
  function summary(value,number=value.enabled?value.activeRevision:value.latestRevision){const latest=revision(value.id,value.latestRevision);return {id:value.id,kind:latest.definition.kind,name:latest.definition.name,description:latest.definition.description,modules:[...latest.definition.modules],platforms:[...latest.definition.platforms],version:value.version,latestRevision:value.latestRevision,activeRevision:value.activeRevision??null,enabled:value.enabled===true,origin:value.origin,updatedAt:value.updatedAt,updatedBy:value.updatedBy,actualRun:actualRun(value.id,number)};}
  function audit(value,action,actor,details={}){store.insert('skill_audit',{id:randomUUID(),ownerId:actor.id,skillId:value.id,action,actorId:actor.id,at:now(),...details});}
  function assertMutable(value){if(value.origin==='builtin')throw agentError('SKILL_READ_ONLY','内置技能定义只读，请复制后定制',403);}
  function assertVersion(value,version){if(!revisionNumber(version)||value.version!==version)throw agentError('AGENT_REVISION_CHANGED','技能已由他人修改，请重新加载后保存',409);}
  async function save(input,actor,{disable=false}={}){
    assertSkillKeys(input,['id','version','definition','changeNote']);const definition=await validateSkillDefinition(input.definition,{getCapability}),changeNote=note(input.changeNote);
    const saved=store.transaction(()=>{
      const old=input.id===undefined?null:skill(input.id);if(old){assertMutable(old);assertVersion(old,input.version);}else if(input.version!==undefined)throw agentError('AGENT_REVISION_CHANGED','新建技能不能携带旧并发版本',409);
      // Recheck the live registry after asynchronous schema validation.
      for(const binding of definition.toolBindings)if(!getCapability(binding.module,binding.capabilityId))throw agentError('SKILL_BINDING_UNAVAILABLE','绑定的业务能力已移除',409);
      const id=old?.id||randomUUID(),number=(old?.latestRevision||0)+1,createdAt=now(),savedRevision=store.insert('skill_revision',{id:revisionId(id,number),ownerId:actor.id,skillId:id,number,sha256:agentDigest(definition),definition,changeNote,createdAt,createdBy:actor.id});
      const values={kind:definition.kind,name:definition.name,latestRevision:number,updatedAt:createdAt,updatedBy:actor.id,...(disable?{enabled:false}:{})};
      const savedSkill=old?store.update('skill',id,values,{expectedVersion:input.version}):store.insert('skill',{id,ownerId:actor.id,origin:'custom',enabled:false,activeRevision:null,createdAt,createdBy:actor.id,...values});
      audit(savedSkill,old?'revision.created':'skill.created',actor,{revision:number,sha256:savedRevision.sha256});return {savedSkill,savedRevision};
    });return {skill:summary(saved.savedSkill),revision:publicRevision(saved.savedRevision)};
  }
  function assertSnapshot(snapshot,scopeModules){
    if(!skillObject(snapshot)||!idValue(snapshot.id)||!revisionNumber(snapshot.revision)||!skillObject(snapshot.definition)||!Array.isArray(snapshot.toolBindings)||agentDigest(snapshot.definition)!==snapshot.sha256)throw agentError('SKILL_REVISION_CHANGED','任务冻结的技能内容无法核验，请保留任务并重新创建',409);
    const source=revision(snapshot.id,snapshot.revision);if(source.sha256!==snapshot.sha256||canonicalJson(source.definition)!==canonicalJson(snapshot.definition))throw agentError('SKILL_REVISION_CHANGED','任务冻结版本与不可变内容记录不一致',409);
    const current=skillBindingSnapshot(snapshot.definition,getCapability,{scopeModules});if(canonicalJson(current)!==canonicalJson(snapshot.toolBindings))throw agentError('SKILL_BINDING_UNAVAILABLE','任务绑定的能力或输入 Schema 已变化；不能静默更新，请使用新任务核对',409);
    return snapshot;
  }
  function assertPrepared(prepared,input){
    if(!prepared?.skillSnapshot){if(input.skill!==undefined&&input.skill!==null)throw agentError('SKILL_REVISION_CHANGED','技能版本尚未完成冻结',409);return;}
    const snapshot=prepared.skillSnapshot,value=skill(snapshot.id);if(value.enabled!==true)throw agentError('SKILL_DISABLED','技能已停用；现有任务不受影响，新任务不能使用',409);
    if(input.skill?.id!==snapshot.id||input.skill?.revision!==snapshot.revision||value.activeRevision!==snapshot.revision)throw agentError('SKILL_REVISION_CHANGED','启用版本已变化，请重新选择；系统不会自动升级任务',409);
    if(canonicalJson(input.skillInputs??{})!==canonicalJson(prepared.skillInputs))throw agentError('SKILL_INPUT_INVALID','任务参数在冻结后发生变化，请重新提交',409);
    assertSnapshot(snapshot,input.scope?.modules||snapshot.definition.modules);
  }
  async function prepareTask(input){
    if(Object.hasOwn(input,'skillSnapshot'))throw agentError('SKILL_DEFINITION_INVALID','任务技能快照由服务端生成，不能由客户端提交',400);
    if(input.skill===undefined||input.skill===null){if(input.skillInputs!==undefined&&(!skillObject(input.skillInputs)||Object.keys(input.skillInputs).length))throw agentError('SKILL_INPUT_INVALID','未选择技能时不能附加技能参数',400);return {};}
    assertSkillKeys(input.skill,['id','revision'],'技能引用只接受 id 和 revision');const value=skill(input.skill.id);if(value.enabled!==true)throw agentError('SKILL_DISABLED','所选技能已停用',409);
    if(input.skill.revision!==value.activeRevision)throw agentError('SKILL_REVISION_CHANGED','启用版本已变化，请重新选择；不会自动改用新版本',409);
    const source=revision(value.id,input.skill.revision),definition=structuredClone(source.definition),toolBindings=skillBindingSnapshot(definition,getCapability,{scopeModules:input.scope?.modules||definition.modules}),skillInputs=await validateSkillInputs(definition.inputSchema,input.skillInputs??{});
    const prepared={skillSnapshot:{id:value.id,revision:source.number,sha256:source.sha256,definition,toolBindings},skillInputs};assertPrepared(prepared,input);return prepared;
  }
  async function portable(document){
    const value=skillJson(document,256*1024);assertSkillKeys(value,['format','formatVersion','definition','changeNote'],'导入文件含有未知字段或实跑/身份数据');if(value.format!=='wucheng.erp.skill'||value.formatVersion!==1)throw agentError('SKILL_DEFINITION_INVALID','不支持的技能文件格式',400);
    const definition=await validateSkillDefinition(value.definition,{getCapability}),changeNote=note(value.changeNote),normalized={format:'wucheng.erp.skill',formatVersion:1,definition,...(changeNote?{changeNote}:{})};
    return {document:normalized,definition,changeNote,sha256:agentDigest(normalized)};
  }
  async function request(operation,input,actor,{trustedUi=false}={}){
    if(!actor?.id||actor.enabled===false)throw agentError('IDENTITY_REQUIRED','请先登录公司工作台',401);
    if((['skills.save','skills.setEnabled'].includes(operation)||operation==='skills.import'&&input.dryRun!==true)&&!trustedUi)throw agentError('HUMAN_SETTINGS_REQUIRED','请在技能与提示词页面由实际人员操作',403);
    if(operation==='skills.list'){
      assertSkillKeys(input,['kind','query','includeDisabled']);if(input.kind!==undefined&&!['skill','prompt'].includes(input.kind)||input.query!==undefined&&(typeof input.query!=='string'||input.query.length>200)||input.includeDisabled!==undefined&&typeof input.includeDisabled!=='boolean')throw agentError('SKILL_DEFINITION_INVALID','技能筛选参数无效',400);
      const query=(input.query||'').trim().toLocaleLowerCase();return {skills:store.list('skill').filter(value=>(input.includeDisabled===true||value.enabled===true)&&(!input.kind||value.kind===input.kind)).map(value=>summary(value)).filter(value=>!query||(value.name+' '+value.description).toLocaleLowerCase().includes(query))};
    }
    if(operation==='skills.get'){assertSkillKeys(input,['id','revision']);const value=skill(input.id),selected=revision(value.id,input.revision??value.latestRevision);return {skill:summary(value,selected.number),revision:publicRevision(selected),revisions:store.list('skill_revision').filter(item=>item.skillId===value.id).sort((a,b)=>b.number-a.number).map(metadata)};}
    if(operation==='skills.save')return save(input,actor);
    if(operation==='skills.setEnabled'){
      assertSkillKeys(input,['id','version','enabled','revision']);if(typeof input.enabled!=='boolean')throw agentError('SKILL_DEFINITION_INVALID','启停状态必须明确',400);
      const value=store.transaction(()=>{const old=skill(input.id);assertVersion(old,input.version);if(input.enabled){if(!revisionNumber(input.revision))throw agentError('SKILL_REVISION_NOT_FOUND','请选择需要启用的具体内容版本',404);const source=revision(old.id,input.revision);skillBindingSnapshot(source.definition,getCapability);}
        const saved=store.update('skill',old.id,{enabled:input.enabled,...(input.enabled?{activeRevision:input.revision}:{}),updatedBy:actor.id,updatedAt:now()},{expectedVersion:input.version});audit(saved,input.enabled?'skill.enabled':'skill.disabled',actor,{revision:saved.activeRevision});return saved;});return {skill:summary(value)};
    }
    if(operation==='skills.export'){assertSkillKeys(input,['id','revision']);const value=skill(input.id),source=revision(value.id,input.revision??value.latestRevision),document={format:'wucheng.erp.skill',formatVersion:1,definition:structuredClone(source.definition),...(source.changeNote?{changeNote:source.changeNote}:{})};return {fileName:(source.definition.name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/,'')||'skill')+'-v'+source.number+'.json',mimeType:'application/json',document,sha256:agentDigest(document)};}
    if(operation==='skills.import'){
      assertSkillKeys(input,['document','dryRun','expectedSha256','targetId','version']);if(typeof input.dryRun!=='boolean'||input.targetId===undefined&&input.version!==undefined)throw agentError('SKILL_DEFINITION_INVALID','导入必须明确预览或确认；并发版本仅可与 targetId 一起提供',400);const preview=await portable(input.document);
      if(input.dryRun)return {import:{definition:preview.definition,sha256:preview.sha256,warnings:preview.definition.toolBindings.some(binding=>getCapability(binding.module,binding.capabilityId)?.available===false)?['包含待开通能力，可保存但不能启用。']:[],canImport:true}};
      if(typeof input.expectedSha256!=='string'||input.expectedSha256!==preview.sha256)throw agentError('SKILL_IMPORT_CHANGED','导入内容已变化，请重新预览并确认摘要',409);
      return save({...(input.targetId!==undefined?{id:input.targetId,version:input.version}:{}),definition:preview.definition,changeNote:preview.changeNote},actor,{disable:true});
    }
    throw agentError('OPERATION_UNAVAILABLE','此技能操作尚未接入',404);
  }
  return {request,prepareTask,assertPrepared,assertSnapshot};
}
