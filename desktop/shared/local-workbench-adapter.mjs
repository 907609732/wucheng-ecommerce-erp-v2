import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {signWorkbenchActor,WORKBENCH_MODULES} from '../workbench/actor.mjs';
import {loadOperationManifest,matchOperation,safeRequestPath} from '../workbench/manifest.mjs';

const fail=(message,code='LOCAL_WORKBENCH_REQUEST_DENIED')=>Object.assign(Error(message),{code});
const draftRoute=/^\/api\/integration\/v1\/(?:edits|transfers)(?:\/[A-Za-z0-9_-]{1,200})?$/;
const unsafeQuery=/^(?:path|filePath|directory|root|database|db|sql|query_sql)$/i;
function readKey(dataDir,name){
  const file=path.join(dataDir,name),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw fail('本机服务授权文件无效','LOCAL_WORKBENCH_KEY_INVALID');
  const key=fs.readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(key))throw fail('本机服务授权文件无效','LOCAL_WORKBENCH_KEY_INVALID');
  return key;
}

// Local key ownership grants the current Windows user local administrator
// business rights. This identity never impersonates a Tailnet member.
export function createLocalWorkbenchManager(services,{channel='cli',username=os.userInfo().username,fetchImpl=fetch}={}){
  if(!['cli','mcp'].includes(channel)||typeof username!=='string'||!username||username.length>200||/[\r\n\0]/.test(username))throw fail('本机智能体身份无效');
  const sessionId=randomUUID(),login='local:'+username;
  async function call(id,route,{method='GET',body}={}){
    if(!WORKBENCH_MODULES.includes(id)||!safeRequestPath(route)||/[\r\n#]/.test(route))throw fail('接口路径无效');
    const query=new URL(route,'http://127.0.0.1').searchParams;
    if([...query.keys()].some(key=>unsafeQuery.test(key)))throw fail('文件访问必须使用已登记文件标识');
    if(!['GET','HEAD','POST','PUT'].includes(method))throw fail('本机智能体只允许读取或整理草稿');
    const mutating=!['GET','HEAD'].includes(method),config=services.config(id);
    if(config.maintenance)throw fail('模块正在安装或迁移检查','MODULE_MAINTENANCE');
    const cap=await services.ensure(id);
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(cap?.url||''))throw fail('本机模块尚未就绪','MODULE_NOT_RUNNING');
    const integrationKey=readKey(config.dataDir,config.keyFile||'.integration-key'),actorKey=readKey(config.dataDir,'.workbench-key');
    const manifest=await loadOperationManifest(id,{config,capabilities:cap,integrationKey});
    const matched=matchOperation(manifest,method,route);
    if(!matched||!matched.operation.remote||matched.operation.kind==='ui')throw fail('此接口未登记为可调用业务功能','OPERATION_UNLISTED');
    const {operation,upstreamPath:target}=matched;
    if(operation.uiOnly||operation.kind==='confirmation'||/\/(?:confirm|commit|rollback)(?:[/?-]|$)/i.test(target))throw fail('正式确认必须在界面完成，CLI/MCP 只能整理草稿','UI_CONFIRMATION_REQUIRED');
    if(mutating&&(!draftRoute.test(target.split('?')[0])||operation.kind!=='write'))throw fail('本机智能体只能整理导入或编辑草稿','UI_CONFIRMATION_REQUIRED');
    if(!mutating&&!['read','download'].includes(operation.kind))throw fail('此接口不允许只读调用');
    if(body!==undefined&&Buffer.byteLength(JSON.stringify(body),'utf8')>65536)throw fail('草稿参数过大');
    const now=Date.now(),requestId=randomUUID();
    const actor={v:1,id:login,login,role:'admin',modules:[...WORKBENCH_MODULES],canRunTasks:false,channel,sessionId,requestId,issuedAt:now,expiresAt:now+30000,module:id,method,path:target};
    const response=await fetchImpl(cap.url+target,{method,redirect:'error',headers:{Authorization:'Bearer '+integrationKey,...signWorkbenchActor(actor,actorKey),'X-Workbench-Channel':channel,...(mutating?{'Content-Type':'application/json','Idempotency-Key':requestId}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    if(!String(response.headers.get('content-type')||'').includes('application/json'))throw fail('接口未返回受控 JSON 数据','MODULE_RESPONSE_INVALID');
    const text=await response.text();if(Buffer.byteLength(text,'utf8')>16*1024*1024)throw fail('查询结果过大，请缩小范围','MODULE_RESPONSE_TOO_LARGE');
    const result=JSON.parse(text);
    if(!response.ok)throw fail(result.message||result.error||'模块业务请求失败',result.code||'MODULE_REQUEST_FAILED');
    return result;
  }
  return {status:options=>services.status(options),ensure:id=>services.ensure(id),stop:id=>services.stop(id),config:id=>services.config(id),
    request:(id,route,options)=>call(id,'/api/integration/v1'+route,options),business:(id,route)=>call(id,route)};
}
