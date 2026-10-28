export const exporterQueries=['state','task','orders','snapshot','logs'];
export const exporterActions=['start','pause','resume','retry','finish','enrichDetails','host-action','export','transfer','clear','proxyStart','proxyStop','hidePage','setLogging','setExecutionLogVisible'];
const schema=id=>({type:'object',properties:{taskId:{type:'string'},platform:{type:'string'},from:{type:'string'},to:{type:'string'},plan:{type:'object'},format:{enum:['csv','xlsx']},images:{type:'boolean'},orderId:{type:'string'},enabled:{type:'boolean'}},additionalProperties:false,required:id==='start'?['platform','from','to']:['clear','host-action','proxyStart','logs'].includes(id)?['platform']:['setLogging','setExecutionLogVisible'].includes(id)?['enabled']:['task','orders','snapshot','pause','resume','retry','finish','enrichDetails','export','transfer'].includes(id)?['taskId']:[]});
export function createExporterAgentAdapter({transport}){
 const request=(op,body,ctx)=>(typeof transport==='function'?transport:transport.request)('exporter','/api/integration/v1/agent/'+op,{method:op==='state'?'GET':'POST',body:body?{...body,taskId:ctx?.taskId,idempotencyKey:ctx?.idempotencyKey}:undefined,ctx,signal:ctx?.signal,approval:ctx?.approval,idempotencyKey:ctx?.idempotencyKey});
 return {id:'exporter',capabilities:[...exporterQueries.map(id=>({id,title:id,kind:'query',description:'读取导出台实际业务 '+id,inputSchema:schema(id),requiresReview:false})),...exporterActions.map(id=>({id,title:id,kind:'prepare',description:'准备导出台业务 '+id,inputSchema:schema(id),requiresReview:true}))],
 async binding(ctx){const s=await request('state',undefined,ctx);if(!s.dataSetId||s.revision===undefined)throw Error('导出台账本身份不可用');return {dataSetId:s.dataSetId,revision:s.revision};},
 query:(capabilityId,input,ctx)=>request('query',{capabilityId,input},ctx),
 prepare:(capabilityId,input,ctx)=>request('prepare',{capabilityId,input},ctx),
 commit:(prepared,ctx)=>request('commit',{prepared},ctx),
 receipt:(idempotencyKey,ctx)=>request('receipt',{idempotencyKey},ctx)};
}
