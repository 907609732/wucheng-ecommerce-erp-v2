/** Root mounts these on the module integration server only after verifying the
 * existing signed workbench actor, session permissions, body limits and maintenance.
 * No body-supplied actor or approval is accepted by this dispatcher.
 */
export const WAREHOUSE_AGENT_ROUTES=['binding','query','prepare','commit','receipt'].map(action=>({method:['binding','query','receipt'].includes(action)?'GET':'POST',path:'/api/integration/v1/agent/'+action,action,requiresApproval:action==='commit'}));
export function createWarehouseAgentRequestHandler(adapter){
  return async function dispatch(action,body={},ctx){
    if(!ctx?.actor?.id)throw Object.assign(Error('缺少模块已验证身份'),{code:'WAREHOUSE_ACTOR_REQUIRED',statusCode:401});
    switch(action){
      case 'binding':return adapter.binding(ctx);
      case 'query':return adapter.query(body.capabilityId,body.input||{},ctx);
      case 'prepare':return adapter.prepare(body.capabilityId,body.input||{},ctx);
      case 'commit':return adapter.commit(body.prepared,ctx);
      case 'receipt':return adapter.receipt(body.idempotencyKey,ctx);
      default:throw Object.assign(Error('未知云仓Agent接口'),{code:'WAREHOUSE_ROUTE_NOT_FOUND',statusCode:404});
    }
  };
}
