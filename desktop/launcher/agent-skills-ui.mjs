const node=(tag,text='',className='')=>Object.assign(document.createElement(tag),{textContent:String(text??''),className});
const list=value=>Array.isArray(value)?value:[];
const labels={overview:'经营',purchase:'采购',sales:'销售',warehouse:'云仓',exporter:'订单导出',system:'公共事务'};
const json=value=>JSON.stringify(value,null,2);
const emptySchema=()=>({type:'object',properties:{},additionalProperties:false});
function button(text,action,className=''){const item=node('button',text,className);item.type='button';item.addEventListener('click',()=>void action());return item;}
function field(text,input){const wrap=node('label',text);wrap.append(input);return wrap;}
function control(tag,value='',attributes={}){return Object.assign(node(tag),{value,...attributes});}
function option(text,value){return Object.assign(node('option',text),{value});}
function when(value){const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{hour12:false});}

/** Inputs are read from actual version schemas; complex values remain explicit JSON. */
function schemaFields(target,schema={}){
  target.replaceChildren();const fields=[];
  for(const [key,definition]of Object.entries(schema.properties||{})){
    const required=list(schema.required).includes(key),type=definition.type,label=definition.title||key;
    let input,read;
    if(Array.isArray(definition.enum)){
      input=node('select');input.append(option(required?'请选择':'不填写',''));definition.enum.forEach((value,index)=>input.append(option(String(value),String(index))));
      read=()=>input.value===''?undefined:definition.enum[Number(input.value)];
    }else if(type==='boolean'){
      input=node('select');input.append(option(required?'请选择':'不填写',''),option('是','true'),option('否','false'));read=()=>input.value===''?undefined:input.value==='true';
    }else if(type==='number'||type==='integer'){
      input=control('input','',{type:'number',step:type==='integer'?'1':'any'});if(definition.minimum!==undefined)input.min=definition.minimum;if(definition.maximum!==undefined)input.max=definition.maximum;
      read=()=>input.value===''?undefined:Number(input.value);
    }else if(type==='array'||type==='object'){
      input=control('textarea','',{rows:3,placeholder:type==='array'?'输入 JSON 数组，例如 ["编号"]':'输入 JSON 对象，例如 {"编号":"值"}'});
      read=()=>input.value.trim()?JSON.parse(input.value):undefined;
    }else{
      input=control('input','',{type:'text'});if(definition.maxLength)input.maxLength=definition.maxLength;read=()=>input.value===''?undefined:input.value;
    }
    input.required=required;
    if(definition.default!==undefined){if(Array.isArray(definition.enum))input.value=String(definition.enum.indexOf(definition.default));else input.value=typeof definition.default==='object'?json(definition.default):String(definition.default);}
    const wrap=field(label+(required?'（必填）':''),input);if(definition.description)wrap.append(node('small',definition.description));target.append(wrap);fields.push({key,read});
  }
  if(!fields.length)target.append(node('p','此版本不需要额外输入。','fine-print'));
  return ()=>Object.fromEntries(fields.map(({key,read})=>[key,read()]).filter(([,value])=>value!==undefined));
}

export function createSkillsWorkspace({target,api,getCapabilities=()=>[],ready=()=>false,showError=()=>{},notice=()=>{},loading=()=>{},openTask=()=>{},beforeModal=async()=>{}}){
  let records=[],selected=null,dirty=false,busy=false,selectionEpoch=0,readRunInputs=()=>({}),runVersion=null;
  const choosers=new Set(),bindings=new Map();
  const header=node('div','','section-heading'),heading=node('div');heading.append(node('h1','技能与提示词'),node('p','保存工作方法，按固定版本交给 AI 执行。'));
  const headerActions=node('div','','actions');headerActions.append(button('新建 Skill',()=>newDefinition('skill')),button('新建提示词',()=>newDefinition('prompt')),button('导入 JSON',()=>importFile.click()),button('刷新',()=>refresh()));header.append(heading,headerActions);
  const importFile=Object.assign(node('input'),{type:'file',accept:'.json,application/json',hidden:true});
  const filters=node('div','','skills-filters'),query=control('input','',{type:'search',placeholder:'搜索名称或用途','aria-label':'搜索技能与提示词'}),kind=node('select');kind.setAttribute('aria-label','类型');kind.append(option('全部类型',''),option('Skill','skill'),option('提示词','prompt'));filters.append(query,kind);
  query.setAttribute('aria-label','搜索技能与提示词');
  const layout=node('div','','skills-layout'),items=node('div','','skills-list'),editor=node('section','','skills-editor settings-card');layout.append(items,editor);target.append(header,filters,layout,importFile);
  const form=node('form'),editorHeading=node('div','','section-heading'),title=node('h2','选择或新建一项'),versionNote=node('p','','fine-print'),lastRun=node('p','','fine-print');editorHeading.append(title);editor.append(editorHeading,versionNote,lastRun);
  const name=control('input','',{maxLength:100,required:true}),description=control('textarea','',{rows:2,maxLength:1000}),platforms=control('input','',{placeholder:'可选，用逗号分隔'}),instructions=control('textarea','',{rows:10,maxLength:20000,required:true}),output=control('textarea','',{rows:3,maxLength:4000}),changeNote=control('input','',{maxLength:1000,placeholder:'说明本次调整'});
  const modules=node('fieldset','','skill-modules'),moduleChecks=new Map();modules.append(node('legend','涉及业务'));
  for(const [id,label]of Object.entries(labels)){const input=control('input','',{type:'checkbox'});input.value=id;moduleChecks.set(id,input);const wrap=field(label,input);wrap.className='check';modules.append(wrap);input.addEventListener('change',()=>renderBindings());}
  const bindingSection=node('details','','skill-advanced'),bindingSearch=control('input','',{type:'search',placeholder:'查找需要调用的业务能力'}),bindingList=node('div','','skill-binding-list');bindingSection.append(node('summary','工具能力绑定'),bindingSearch,bindingList);
  const advanced=node('details','','skill-advanced'),inputSchema=control('textarea',json(emptySchema()),{rows:7,spellcheck:false});advanced.append(node('summary','高级：所需输入的 JSON Schema'),field('参数约定',inputSchema),node('p','可保留默认空对象。此处只定义任务输入，不配置命令或任意 MCP 地址。','fine-print'));
  const actions=node('div','','actions'),save=button('保存新版本',()=>saveDefinition(),'primary'),copy=button('复制并定制',()=>copyDefinition()),enable=button('启用此版本',()=>setEnabled(true)),disable=button('停用',()=>setEnabled(false)),exportButton=button('导出此版本',()=>exportDefinition()),runButton=button('使用启用版本运行',()=>showRun());actions.append(save,copy,enable,disable,exportButton,runButton);
  const revisionSelect=node('select');revisionSelect.setAttribute('aria-label','查看内容版本');const history=field('版本历史',revisionSelect);
  form.append(field('名称',name),field('用途说明',description),modules,field('平台',platforms),bindingSection,field('步骤与提示词',instructions),field('输出要求',output),advanced,field('变更说明',changeNote),actions,history);editor.append(form);
  const runForm=node('form','','skill-run-form'),runHeading=node('h3','开始任务'),runDescription=node('p','','fine-print'),runGoal=control('textarea','',{rows:3,maxLength:12000,required:true}),runInputs=node('div','','skill-input-fields'),start=Object.assign(node('button','开始任务','primary'),{type:'submit'});runForm.hidden=true;runForm.append(runHeading,runDescription,field('本次工作目标',runGoal),runInputs,start,button('取消',()=>{runForm.hidden=true;}));editor.append(runForm);
  form.hidden=true;

  async function guarded(fn){if(busy)return;busy=true;for(const item of target.querySelectorAll('button'))item.disabled=true;try{return await fn();}catch(error){showError(error);return undefined;}finally{busy=false;for(const item of target.querySelectorAll('button'))item.disabled=false;syncEditor();renderList();}}
  function hasChanges(){return dirty;}
  function leave(){if(!dirty)return true;if(!window.confirm('技能内容尚未保存。放弃本次编辑并离开？'))return false;dirty=false;return true;}
  function selectedModules(){return [...moduleChecks].filter(([,input])=>input.checked).map(([id])=>id);}
  function renderBindings(){
    const wanted=selectedModules(),chosen=new Set([...bindings].filter(([key,input])=>input.checked&&wanted.includes(key.split('\0')[0])).map(([key])=>key)),term=bindingSearch.value.trim().toLocaleLowerCase();
    const catalog=list(getCapabilities()).filter(cap=>wanted.includes(cap.module));bindings.clear();bindingList.replaceChildren();
    for(const cap of catalog){const key=cap.module+'\0'+cap.id,input=control('input','',{type:'checkbox',checked:chosen.has(key),disabled:cap.available===false});input.dataset.module=cap.module;input.dataset.capability=cap.id;bindings.set(key,input);
      const label=field((labels[cap.module]||cap.module)+' · '+(cap.title||cap.id)+(cap.available===false?'（待开通）':''),input);label.className='check';label.hidden=!!term&&!`${cap.id} ${cap.title||''}`.toLocaleLowerCase().includes(term);bindingList.append(label);}
    for(const key of chosen)if(!bindings.has(key)){const [module,capabilityId]=key.split('\0'),input=control('input','',{type:'checkbox',checked:true});input.dataset.module=module;input.dataset.capability=capabilityId;bindings.set(key,input);const label=field((labels[module]||module)+' · '+capabilityId+'（当前不可用）',input);label.className='check';bindingList.append(label);}
    if(!catalog.length&&!chosen.size)bindingList.append(node('p','先选择涉及业务，再选择实际登记的能力。','fine-print'));
  }
  function fill(definition){
    name.value=definition.name||'';description.value=definition.description||'';platforms.value=list(definition.platforms).join('，');instructions.value=definition.instructions||'';output.value=definition.outputRequirements||'';inputSchema.value=json(definition.inputSchema||emptySchema());changeNote.value='';
    for(const [id,input]of moduleChecks)input.checked=list(definition.modules).includes(id);bindings.clear();for(const item of list(definition.toolBindings))bindings.set(item.module+'\0'+item.capabilityId,{checked:true});renderBindings();dirty=false;runForm.hidden=true;form.hidden=false;syncEditor();
  }
  function syncEditor(){
    const builtIn=selected?.skill?.origin==='builtin'||selected?.skill?.origin==='built-in',exists=!!selected?.skill?.id;
    for(const input of form.querySelectorAll('input,textarea'))input.disabled=busy||builtIn;
    for(const [key,input]of bindings){const cap=list(getCapabilities()).find(item=>item.module===input.dataset.module&&item.id===input.dataset.capability);input.disabled=busy||builtIn||cap?.available===false;}
    save.disabled=busy||builtIn||!ready();save.hidden=builtIn;copy.disabled=busy;copy.hidden=!exists;enable.disabled=busy||!exists||dirty||!ready();disable.disabled=busy||!exists||selected?.skill?.enabled===false||!ready();exportButton.disabled=busy||!exists;runButton.disabled=busy||!exists||selected?.skill?.enabled!==true||dirty||!ready();revisionSelect.disabled=busy||!exists;
    title.textContent=selected?.skill?.id?(selected.revision.definition.name||selected.skill.name):'新建'+(selected?.kind==='prompt'?'提示词':' Skill');
    versionNote.textContent=exists?`内容 v${selected.revision.number} · ${selected.skill.enabled?'启用版本 v'+selected.skill.activeRevision:'已停用'} · ${builtIn?'内置定义，可复制定制':'自定义'}${dirty?' · 未保存':''}`:dirty?'尚未保存到公司技能库。':'填写后保存为第一个版本；新建默认停用。';
    lastRun.replaceChildren();if(exists){const actual=selected.skill.actualRun;lastRun.append(node('span',actual?`${actual.label} · ${actual.engine||''} · ${actual.model||''} · ${when(actual.at)} · v${actual.revision}`:'未运行；保存和结构校验不会标记实际执行成功。'));if(actual?.taskId)lastRun.append(button('查看实际任务',()=>openTask(actual.taskId),'text-button'));}
    if(!exists)revisionSelect.replaceChildren(option('保存后显示版本',''));
  }
  function renderList(){
    const term=query.value.trim().toLocaleLowerCase(),rows=records.filter(item=>(!kind.value||item.kind===kind.value)&&(!term||`${item.name||''} ${item.description||''}`.toLocaleLowerCase().includes(term)));
    items.replaceChildren(...rows.map(item=>{const row=button('',()=>select(item.id),'skill-list-item');row.append(node('strong',item.name||'未命名'),node('small',`${item.kind==='prompt'?'提示词':'Skill'} · ${item.enabled?'启用 v'+item.activeRevision:'已停用'} · 最新 v${item.latestRevision}`),node('small',item.actualRun?.label||'未运行'));row.setAttribute('aria-current',item.id===selected?.skill?.id?'true':'false');row.disabled=busy;return row;}));
    if(!rows.length)items.append(node('p',records.length?'没有符合条件的项目。':'还没有技能或提示词。可新建，或导入便携 JSON。','empty'));
  }
  async function refresh(){const response=await api.request('skills.list',{includeDisabled:true});records=list(response.skills);renderList();await refreshChoosers();}
  async function select(id,revision){if(!leave())return;const epoch=++selectionEpoch;loading(editorHeading,'正在读取技能');try{const response=await api.request('skills.get',{id,...(revision?{revision}: {})});if(epoch!==selectionEpoch)return;selected=response;editorHeading.replaceChildren(title);fill(response.revision.definition);revisionSelect.replaceChildren(...list(response.revisions).map(item=>option(`v${item.number} · ${when(item.createdAt)}${item.changeNote?' · '+item.changeNote:''}`,String(item.number))));revisionSelect.value=String(response.revision.number);renderList();}catch(error){editorHeading.replaceChildren(title);showError(error);}}
  function newDefinition(type){if(!leave())return;selectionEpoch++;selected={kind:type};fill({schemaVersion:1,kind:type,modules:[],platforms:[],inputSchema:emptySchema(),toolBindings:[]});renderList();name.focus();}
  function definition(){return {schemaVersion:1,kind:selected?.revision?.definition?.kind||selected?.kind||'skill',name:name.value.trim(),description:description.value.trim(),modules:selectedModules(),platforms:platforms.value.split(/[,，]/).map(value=>value.trim()).filter(Boolean),instructions:instructions.value.trim(),inputSchema:JSON.parse(inputSchema.value),toolBindings:[...bindings.values()].filter(input=>input.checked).map(input=>({module:input.dataset.module,capabilityId:input.dataset.capability})),outputRequirements:output.value.trim()};}
  async function saveDefinition(){if(!form.reportValidity())return;await guarded(async()=>{const value=definition();if(!value.modules.length)throw Error('请选择涉及的业务模块');const response=await api.request('skills.save',{...(selected?.skill?.id?{id:selected.skill.id,version:selected.skill.version}:{}),definition:value,changeNote:changeNote.value.trim()});dirty=false;notice('内容版本已保存。启用此版本后用于新任务。');await refresh();await select(response.skill.id,response.revision.number);});}
  function copyDefinition(){if(!leave())return;const value=selected.revision.definition;selected={kind:value.kind};fill({...value,name:(value.name+'（副本）').slice(0,100)});dirty=true;syncEditor();renderList();}
  async function setEnabled(enabled){await guarded(async()=>{await api.request('skills.setEnabled',{id:selected.skill.id,version:selected.skill.version,enabled,...(enabled?{revision:selected.revision.number}:{})});notice(enabled?'此版本已启用，仅影响后续新任务。':'已停用，已有任务和版本继续保留。');const id=selected.skill.id,revision=selected.revision.number;await refresh();await select(id,revision);});}
  async function exportDefinition(){await guarded(async()=>{const response=await api.request('skills.export',{id:selected.skill.id,revision:selected.revision.number});if(!response.document||!response.fileName)throw Error('服务未返回完整导出内容');const url=URL.createObjectURL(new Blob([json(response.document)],{type:response.mimeType||'application/json'})),link=node('a');link.href=url;link.download=response.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1500);});}
  async function importDefinition(file){if(!file)return;await guarded(async()=>{if(file.size>256*1024)throw Error('技能文件不能超过 256 KiB');const documentValue=JSON.parse(await file.text()),preview=await api.request('skills.import',{document:documentValue,dryRun:true});if(!preview.import?.canImport||!preview.import.sha256)throw Error('此文件暂不能导入');await beforeModal();
    const dialog=node('dialog','','skill-import-dialog'),details=preview.import,body=node('pre',json(details.definition)),actions=node('div','','actions');dialog.append(node('h2','确认导入技能'),node('p','导入为新项目，不会按同名覆盖现有版本。'),node('p','内容摘要：'+details.sha256,'fine-print'),body);for(const warning of list(details.warnings))dialog.append(node('p',typeof warning==='string'?warning:json(warning),'attention'));
    actions.append(button('确认导入',async()=>{await guarded(async()=>{const response=await api.request('skills.import',{document:documentValue,dryRun:false,expectedSha256:details.sha256});dialog.close();await refresh();dirty=false;await select(response.skill.id,response.revision.number);notice('已导入，默认停用。核对后可启用指定版本。');});},'primary'),button('取消',()=>dialog.close()));dialog.append(actions);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  });importFile.value='';}
  async function showRun(){await guarded(async()=>{const current=await api.request('skills.get',{id:selected.skill.id,revision:selected.skill.activeRevision});if(!current.skill.enabled)throw Error('此项目已停用');runVersion=current;runForm.hidden=false;runGoal.value=current.revision.definition.description||current.revision.definition.name;runDescription.textContent=`固定使用 ${current.skill.name} v${current.revision.number} · ${list(current.revision.definition.modules).map(id=>labels[id]||id).join('、')}`;readRunInputs=schemaFields(runInputs,current.revision.definition.inputSchema);runGoal.focus();});}
  async function refreshChoosers(){
    for(const chooser of choosers){
      const previous=chooser.select.value,record=records.find(item=>item.id===previous),changed=!!previous&&(!record?.enabled||!record.activeRevision||chooser.definition&&chooser.definition.revision.number!==record.activeRevision);
      chooser.select.replaceChildren(option('自由目标，不使用固定 Skill',''));for(const item of records.filter(item=>item.enabled&&item.activeRevision))chooser.select.append(option(`${item.name} · v${item.activeRevision}`,item.id));
      if(changed){const invalid=option('原选择已变化，请重新选择','__stale__:'+previous);invalid.disabled=true;chooser.select.append(invalid);chooser.select.value=invalid.value;chooser.definition=null;chooser.epoch++;chooser.metadata.textContent='原 Skill 已停用或启用版本发生变化。请明确重新选择；不会自动切为自由目标或新版本。';}
      else chooser.select.value=previous;
    }
  }
  function attachChooser(container){
    const select=node('select'),fields=node('div','','skill-input-fields'),metadata=node('p','','fine-print'),choice={select,fields,metadata,definition:null,epoch:0,read:()=>({})};select.append(option('自由目标，不使用固定 Skill',''));container.append(field('Skill / 提示词（可选）',select),metadata,fields);choosers.add(choice);
    select.addEventListener('change',()=>{choice.definition=null;choice.fields.replaceChildren();choice.metadata.textContent='';const id=select.value,epoch=++choice.epoch;if(!id)return;const record=records.find(item=>item.id===id);if(!record?.activeRevision)return;
      void api.request('skills.get',{id,revision:record.activeRevision}).then(response=>{if(epoch!==choice.epoch)return;choice.definition=response;choice.metadata.textContent=`固定版本 v${response.revision.number} · ${list(response.revision.definition.modules).map(id=>labels[id]||id).join('、')}`;choice.read=schemaFields(fields,response.revision.definition.inputSchema);}).catch(showError);
    });
    return ()=>{if(!select.value)return {};if(!choice.definition)throw Error('所选 Skill 尚未读取完成，请重新选择');return {skill:{id:choice.definition.skill.id,revision:choice.definition.revision.number},skillInputs:choice.read(),scope:{modules:list(choice.definition.revision.definition.modules)}};};
  }
  const markDirty=event=>{if(event.target===bindingSearch||event.target===revisionSelect)return;dirty=true;syncEditor();};form.addEventListener('input',markDirty);form.addEventListener('change',markDirty);form.addEventListener('submit',event=>{event.preventDefault();void saveDefinition();});bindingSearch.addEventListener('input',renderBindings);
  query.addEventListener('input',renderList);kind.addEventListener('change',renderList);revisionSelect.addEventListener('change',()=>void select(selected.skill.id,Number(revisionSelect.value)));importFile.addEventListener('change',()=>void importDefinition(importFile.files[0]));
  runForm.addEventListener('submit',event=>{event.preventDefault();void guarded(async()=>{const response=await api.request('tasks.create',{goal:runGoal.value.trim(),skill:{id:runVersion.skill.id,revision:runVersion.revision.number},skillInputs:readRunInputs(),scope:{modules:list(runVersion.revision.definition.modules)}});if(!response.task?.id)throw Error('主机没有返回真实任务编号，请查看任务历史后重试');await openTask(response.task.id);});});
  return {show:()=>refresh().catch(showError),refresh,attachChooser,hasChanges,leave};
}
