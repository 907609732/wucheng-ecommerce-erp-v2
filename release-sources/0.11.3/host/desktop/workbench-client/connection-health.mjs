import {serverAddress} from './connection.mjs';

const HEALTH='/api/workbench/v1/health';
export async function serverConnectionHealth({state,identity,fetchImpl=fetch}){
  async function probe(url){
    const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(2500),headers:{Accept:'application/json'}});
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('网关未返回有效状态');
    const body=await response.json();
    if(body.ok!==true||body.service!=='wucheng-workbench'||body.protocolVersion!==1)throw Error('网关身份或版本不符');
    if(!identity?.serverId||!identity?.dataSetId||body.serverId!==identity.serverId||body.dataSetId!==identity.dataSetId)throw Object.assign(Error('网关账本身份不符'),{code:'DATASET_CHANGED'});
  }
  try{await probe('http://127.0.0.1:17330'+HEALTH);}
  catch(error){return {state:'error',label:error.code==='DATASET_CHANGED'?'主服务器身份不符':'主服务器未就绪',detail:error.code==='DATASET_CHANGED'?'本机网关与原账本身份不一致，请核对主机配置。':'本机网关未通过检查，请检查主服务器后台。'};}
  try{await probe(serverAddress(state.serverUrl)+HEALTH);}
  catch(error){
    const code=String(error.cause?.code||error.code||'');
    const reason=/CERT|TLS|SSL/.test(code)?'证书验证失败':/ENOTFOUND|EAI_AGAIN/.test(code)?'域名解析失败':error.code==='DATASET_CHANGED'?'入口账本身份不符':'连接失败或超时';
    return {state:'warning',label:'私网入口异常',detail:'本机网关正常；私网 HTTPS '+reason+'，请检查 Tailscale 连接与入口配置。'};
  }
  return {state:'ready',label:'主服务器已就绪',detail:'本机网关及私网 HTTPS 检查通过。'};
}

export function clientConnectionFailure(error){
  const code=error?.code||'';
  if(['DATASET_CHANGED','CONNECTION_CHANGED','SERVER_IDENTITY_MISSING','VERSION_INCOMPATIBLE'].includes(code))return {state:'identity-error',label:'连接身份需核对',detail:'服务器、账本身份或接口版本发生变化，请重新核对连接。'};
  if(['IDENTITY_REQUIRED','PERMISSION_DENIED','MEMBER_DENIED','MEMBER_UNKNOWN','MEMBER_DISABLED'].includes(code)||[401,403].includes(error?.status))return {state:'unauthorized',label:'身份或权限失效',detail:'请核对登录身份及主机成员授权。'};
  return {state:'offline',label:'主服务器连接中断',detail:'当前无法完成身份验证后的请求；请检查网络和主机状态。'};
}
