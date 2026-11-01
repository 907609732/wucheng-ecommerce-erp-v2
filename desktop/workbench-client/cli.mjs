export async function runRemoteCommand(request,transport){
  const manager=await import('./transport.mjs').then(m=>new m.RemoteServiceManager(transport));
  if(request.command==='status'||request.command==='doctor'){const status={connection:await transport.connect(),modules:await manager.status()};return {ok:true,...(request.command==='doctor'?{diagnostics:status}:{status})};}
  if(request.command==='capabilities')return {ok:true,capabilities:await transport.request('/capabilities')};
  if(request.command==='extensions')return {ok:true,extensions:[{id:'lingtu.desks',actions:['status','query','prepare'],remote:true}]};
  if(request.command==='extension-call'){
    if(request.id!=='lingtu.desks')throw Error('客户端未接入此扩展');
    if(['start','stop'].includes(request.action))throw Error('服务启动和停止仅在主机操作');
    if(request.action==='prepare'&&!request.confirmSideEffect)throw Error('整理草稿需要本次明确确认');
    const {createActions}=await import('../extensions/lingtu-desks/extension.mjs');
    const actions=createActions(manager);
    if(!['status','query','prepare'].includes(request.action))throw Error('不支持的远程扩展操作');
    return {ok:true,response:await actions[request.action](request.params)};
  }
  const routes={logs:['GET','/logs?limit='+encodeURIComponent(request.limit||30)],sync:['POST','/jobs'],login:['POST','/host-action'],'send-latest-valid':['POST','/send-latest-valid']};
  const route=routes[request.command];if(!route)throw Error('此诊断或本机管理命令只能在主服务器运行');
  return transport.call('warehouse','/api/integration/v1/workbench'+route[1],{method:route[0],...(route[0]==='POST'?{body:{confirm:true,confirmSend:request.command==='send-latest-valid',type:request.command==='sync'?'sync':request.command==='login'?'login':undefined}}:{})});
}
