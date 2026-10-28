import {salesCapabilityDefinitions} from './agent-schemas.mjs';
import {stageTaskAttachment,materializeArtifacts,publicFileSchema} from './agent-host-files.mjs';
import Ajv from 'ajv';
export const salesModuleCapabilities=salesCapabilityDefinitions.map(({name,...definition})=>({id:'sales.'+name,...definition}));
export const salesAgentCapabilities=[...salesModuleCapabilities.filter(c=>c.id!=='sales.file-stage').map(c=>({...c,inputSchema:publicFileSchema(c.inputSchema)})),{id:'sales.files.stage',title:'接收任务附件',description:'将本次任务已上传附件安全暂存到销售模块，按SHA-256校验、分片续传；只传附件ID，不填路径或原件字节。',kind:'prepare',requiresReview:false,inputSchema:{type:'object',properties:{attachmentId:{type:'string',minLength:1,maxLength:200,description:'本次任务真实上传的附件ID'}},required:['attachmentId'],additionalProperties:false}}];
export function createSalesAgentAdapter({transport}){
 const request=typeof transport==='function'?transport:transport?.request?.bind(transport);if(!request)throw TypeError('Sales Agent requires trusted module transport');
 const call=(route,body,ctx,method='POST')=>request('sales','/api/integration/v1/agent/'+route,{method,body,ctx,signal:ctx?.signal,approval:ctx?.approval,idempotencyKey:ctx?.idempotencyKey});
 const ajv=new Ajv({strict:false,allErrors:true}),validators=new Map(salesAgentCapabilities.map(c=>[c.id,{kind:c.kind,validate:ajv.compile(c.inputSchema)}]));
 const validate=(id,input,kind)=>{const entry=validators.get(id);if(!entry||entry.kind!==kind||!entry.validate(input||{}))throw Object.assign(Error('销售能力或业务参数无效；原件请先使用files.stage接收任务附件'),{code:'AGENT_INPUT_SCHEMA',status:400});};
 const output=(value,ctx)=>materializeArtifacts({module:'sales',value,ctx,transport});
 return {id:'sales',capabilities:salesAgentCapabilities,binding:ctx=>typeof transport.binding==='function'?transport.binding('sales',ctx):call('binding',undefined,ctx,'GET'),query:async(capabilityId,input,ctx)=>{validate(capabilityId,input,'query');return output(await call('query?'+new URLSearchParams({capabilityId,input:JSON.stringify(input||{}),taskId:ctx?.taskId||''}),undefined,ctx,'GET'),ctx);},
  prepare:async(capabilityId,input,ctx)=>{validate(capabilityId,input,'prepare');if(capabilityId==='sales.files.stage'){const file=await stageTaskAttachment({module:'sales',attachmentId:input?.attachmentId,ctx,request});const {url,...source}=file;return {summary:'任务附件已接收，尚未入账',scope:{module:'sales'},blocks:[{type:'table',title:'同任务原件标识',rows:[source]}],evidence:[{fileId:file.id,filename:file.filename,sha256:file.sha256}],changes:[],issues:[]};}return output(await call('prepare',{capabilityId,input,taskId:ctx?.taskId},ctx),ctx);},
  commit:async(prepared,ctx)=>output(await call('commit',{prepared},ctx),ctx),receipt:async(key,ctx)=>output(await call('receipts/'+encodeURIComponent(key),undefined,ctx,'GET'),ctx)};
}
