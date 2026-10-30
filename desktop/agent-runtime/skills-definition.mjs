import {fromJsonSchema} from '@modelcontextprotocol/server';
import {agentError,agentDigest} from './approval.mjs';

export const SKILL_MODULES=Object.freeze(['warehouse','purchase','sales','overview','exporter','system']);
export const skillObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const definitionKeys=new Set(['schemaVersion','kind','name','description','modules','platforms','instructions','inputSchema','toolBindings','outputRequirements']);
const schemaKeys=new Set(['type','title','description','properties','required','additionalProperties','items','enum','const','default','minLength','maxLength','format','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minItems','maxItems','uniqueItems']);
const schemaTypes=new Set(['object','array','string','number','integer','boolean','null']);
const forbiddenKeys=new Set(['__proto__','prototype','constructor']);
const invalid=message=>agentError('SKILL_DEFINITION_INVALID',message||'技能定义格式无效',400);
export function assertSkillKeys(value,allowed,message){if(!skillObject(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw invalid(message||'技能字段包含不支持的内容');}
export function skillJson(value,maxBytes,code='SKILL_DEFINITION_INVALID'){
  let nodes=0;
  function visit(item,depth){
    if(++nodes>30000||depth>24)throw agentError(code,'内容过深或包含过多字段',400);
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
    if(Array.isArray(item)){for(const child of item)visit(child,depth+1);return;}
    if(!skillObject(item))throw agentError(code,'内容必须是标准 JSON 数据',400);
    for(const [key,child]of Object.entries(item)){if(forbiddenKeys.has(key))throw agentError(code,'内容包含不支持的字段名称',400);visit(child,depth+1);}
  }
  visit(value,0);const text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)throw agentError(code,'内容超过允许大小',413);return JSON.parse(text);
}
const text=(value,max,required,label)=>{if(typeof value!=='string'||value.length>max||required&&!value.trim())throw invalid(label+'无效');return value;};
function validateSchema(schema){
  let nodes=0;
  function visit(node,depth){
    if(!skillObject(node)||++nodes>500||depth>8||Object.keys(node).some(key=>!schemaKeys.has(key)))throw invalid('输入参数仅支持对象、数组和基本类型的 JSON Schema；v1 不支持自定义 pattern、$ref 或扩展代码');
    if(!schemaTypes.has(node.type))throw invalid('每个参数需声明一个受支持的 type');
    for(const key of ['title','description'])if(node[key]!==undefined)text(node[key],1000,false,'参数说明');
    if(node.properties!==undefined){if(node.type!=='object'||!skillObject(node.properties)||Object.keys(node.properties).length>100)throw invalid('对象参数 properties 无效');for(const [key,child]of Object.entries(node.properties)){if(!key||key.length>100||forbiddenKeys.has(key))throw invalid('参数名称无效');visit(child,depth+1);}}
    if(node.required!==undefined&&(!Array.isArray(node.required)||node.required.length>100||new Set(node.required).size!==node.required.length||node.required.some(key=>typeof key!=='string'||!Object.hasOwn(node.properties||{},key))))throw invalid('required 必须引用实际参数且不可重复');
    if(node.additionalProperties!==undefined&&(node.type!=='object'||typeof node.additionalProperties!=='boolean'))throw invalid('additionalProperties 仅支持布尔值');
    if(node.items!==undefined){if(node.type!=='array')throw invalid('仅数组可以声明 items');visit(node.items,depth+1);}else if(node.type==='array')throw invalid('数组参数需声明 items');
    if(node.enum!==undefined&&(!Array.isArray(node.enum)||!node.enum.length||node.enum.length>100))throw invalid('enum 需为 1–100 项数组');
    for(const key of ['minLength','maxLength','minItems','maxItems'])if(node[key]!==undefined&&(!Number.isSafeInteger(node[key])||node[key]<0||node[key]>1000000))throw invalid('参数长度边界无效');
    for(const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf'])if(node[key]!==undefined&&(typeof node[key]!=='number'||!Number.isFinite(node[key])||key==='multipleOf'&&node[key]<=0))throw invalid('参数数值边界无效');
    if(node.uniqueItems!==undefined&&typeof node.uniqueItems!=='boolean')throw invalid('uniqueItems 需为布尔值');
    if(node.format!==undefined&&!['date','date-time','time','email','uri','uuid'].includes(node.format))throw invalid('参数 format 暂不支持');
  }
  if(schema?.type!=='object')throw invalid('技能输入的根类型必须是 object');visit(schema,0);
  try{return fromJsonSchema(schema);}catch{throw invalid('输入参数 Schema 无法由当前组件解析');}
}
export async function validateSkillDefinition(input,{getCapability}={}){
  const source=skillJson(input,128*1024);if(!skillObject(source)||Object.keys(source).some(key=>!definitionKeys.has(key))||source.schemaVersion!==1||!['skill','prompt'].includes(source.kind))throw invalid();
  const name=text(source.name,100,true,'名称').trim(),description=text(source.description??'',1000,false,'用途'),instructions=text(source.instructions,20000,true,'提示词'),outputRequirements=text(source.outputRequirements??'',4000,false,'输出要求');
  if(!Array.isArray(source.modules)||!source.modules.length||source.modules.length>6||source.modules.some(module=>!SKILL_MODULES.includes(module)))throw invalid('请选择实际业务模块');
  if(!Array.isArray(source.platforms??[])||(source.platforms||[]).length>30||(source.platforms||[]).some(platform=>typeof platform!=='string'||!platform.trim()||platform.length>100))throw invalid('平台名称无效');
  if(!Array.isArray(source.toolBindings)||(source.toolBindings||[]).length>100)throw invalid('能力绑定最多 100 项');
  const modules=[...new Set(source.modules)],toolBindings=[],seen=new Set();
  for(const binding of source.toolBindings){
    assertSkillKeys(binding,['module','capabilityId'],'能力绑定只接受 module 和 capabilityId');
    if(!modules.includes(binding.module)||typeof binding.capabilityId!=='string'||!binding.capabilityId||binding.capabilityId.length>200)throw invalid('能力绑定不属于技能模块或编号无效');
    const cap=getCapability?.(binding.module,binding.capabilityId);if(!cap)throw agentError('SKILL_BINDING_UNAVAILABLE','绑定的业务能力未登记：'+binding.module+'/'+binding.capabilityId,409);
    const key=JSON.stringify([binding.module,binding.capabilityId]);if(!seen.has(key)){seen.add(key);toolBindings.push({...binding});}
  }
  if(source.kind==='skill'&&!toolBindings.length)throw invalid('Skill 至少绑定一项已登记业务能力；纯提示词请使用 prompt');
  const inputSchema=source.inputSchema;if(!skillObject(inputSchema))throw invalid('请输入对象型 inputSchema');const validator=validateSchema(inputSchema);
  try{await validator['~standard'].validate({});}catch{throw invalid('输入参数 Schema 无法由当前组件校验');}
  return {schemaVersion:1,kind:source.kind,name,description,modules,platforms:[...new Set(source.platforms||[])],instructions,inputSchema,toolBindings,outputRequirements};
}
export async function validateSkillInputs(schema,input={}){
  const value=skillJson(input,1024*1024,'SKILL_INPUT_INVALID');if(!skillObject(value))throw agentError('SKILL_INPUT_INVALID','技能参数必须是对象',400);
  let result;try{result=await fromJsonSchema(schema)['~standard'].validate(value);}catch{throw agentError('SKILL_INPUT_INVALID','技能输入参数无法校验',400);}
  if(result.issues)throw agentError('SKILL_INPUT_INVALID','技能输入不符合所选版本的 inputSchema，请核对必填项和数据类型',400);return value;
}
export function skillBindingSnapshot(definition,getCapability,{scopeModules=definition.modules}={}){
  if(!Array.isArray(scopeModules)||definition.modules.some(module=>!scopeModules.includes(module)))throw agentError('SKILL_BINDING_UNAVAILABLE','技能涉及的业务模块不在本次任务范围',409);
  return definition.toolBindings.map(binding=>{const cap=getCapability(binding.module,binding.capabilityId);if(!cap||cap.available===false||!['query','prepare'].includes(cap.kind)||!cap.inputSchema)throw agentError('SKILL_BINDING_UNAVAILABLE','绑定能力待开通、已移除或参数说明缺失：'+binding.module+'/'+binding.capabilityId,409);return {...binding,kind:cap.kind,inputSchemaSha256:agentDigest(cap.inputSchema)};});
}
