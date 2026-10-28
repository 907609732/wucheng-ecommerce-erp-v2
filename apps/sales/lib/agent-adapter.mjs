import {salesCapabilityDefinitions} from './agent-schemas.mjs';
export const salesAgentCapabilities=salesCapabilityDefinitions.map(({name,...definition})=>({id:'sales.'+name,...definition}));
export function createSalesAgentAdapter({transport}){
 const request=typeof transport==='function'?transport:transport?.request?.bind(transport);if(!request)throw TypeError('Sales Agent requires trusted module transport');
 const call=(route,body,ctx,method='POST')=>request('sales','/api/integration/v1/agent/'+route,{method,body,ctx,signal:ctx?.signal,approval:ctx?.approval,idempotencyKey:ctx?.idempotencyKey});
 return {id:'sales',capabilities:salesAgentCapabilities,binding:ctx=>typeof transport.binding==='function'?transport.binding('sales',ctx):call('binding',undefined,ctx,'GET'),query:(capabilityId,input,ctx)=>call('query?'+new URLSearchParams({capabilityId,input:JSON.stringify(input||{}),taskId:ctx?.taskId||''}),undefined,ctx,'GET'),prepare:(capabilityId,input,ctx)=>call('prepare',{capabilityId,input,taskId:ctx?.taskId},ctx),commit:(prepared,ctx)=>call('commit',{prepared},ctx),receipt:(key,ctx)=>call('receipts/'+encodeURIComponent(key),undefined,ctx,'GET')};
}
