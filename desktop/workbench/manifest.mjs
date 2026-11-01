import fs from 'node:fs';
import path from 'node:path';
import {warehouseAdapter,exporterAdapter} from './descriptors.mjs';

const validKinds=new Set(['read','write','confirmation','download','upload','ui']);
const safeMethods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const builtin={warehouse:warehouseAdapter,exporter:exporterAdapter};
const failure=message=>Object.assign(Error(message),{statusCode:503,code:'MODULE_PROTOCOL_UNAVAILABLE',workbenchPublic:true});
// A module manifest cannot grant system-administration privileges through the business proxy.
const hostOnly=/^\/api\/integration\/v1\/(?:open|stop|maintenance|capabilities)(?:\/|$)|^\/api\/(?:settings|filesystem|data-dir|sql|database|admin|backups?|restore|upgrades?|updates?)(?:\/|$)|\/workbench\/migration(?:\/|$)|\/(?:modules?|runtime)\/(?:install|uninstall|update|stop|configure|restore)(?:\/|$)/i;
export function safeRequestPath(raw) {
  if(typeof raw!=='string'||raw.length>8192||!raw.startsWith('/')||raw.includes('\\')||raw.includes('\0'))return false;
  let decoded=raw.split('?')[0];
  for(let i=0;i<3;i++){if(/%2f|%5c|%00/i.test(decoded))return false;try{const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}catch{return false;}}
  return !decoded.split('/').some(s=>s==='.'||s==='..'||s.startsWith('.'))&&!decoded.includes('//');
}
export function compileOperation(operation,id,basePath='') {
  const method=String(operation.method||'').toUpperCase(),template=operation.path;
  if(operation.module&&operation.module!==id||!safeMethods.has(method)||!validKinds.has(operation.kind)||typeof template!=='string'||!safeRequestPath(template)||template.includes('?')||operation.kind==='ui'&&!['GET','HEAD'].includes(method))throw failure('模块操作清单无效');
  const upstreamPath=template.startsWith('/api/')?template:(basePath||'')+template;
  const names=[];
  const regexp=new RegExp('^'+upstreamPath.split('/').map(s=>{if(s==='*'){names.push('*');return '([^?]+)';}if(/^:[A-Za-z][\w]*$/.test(s)){names.push(s.slice(1));return '([^/]+)';}return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}).join('/')+'/?$');
  return {...operation,module:id,method,path:upstreamPath,shortPath:template,remote:operation.remote===true&&!hostOnly.test(upstreamPath),operationId:operation.operationId||id+'.'+method+'.'+upstreamPath,regexp,names};
}
export function normalizeManifest(id,source) {
  if(Array.isArray(source))source={operations:source};
  if(!source||!Array.isArray(source.operations)||source.operations.length>3000)throw failure('模块未提供受控业务操作清单');
  for(const prefix of [source.basePath,source.ui?.indexPath,source.ui?.prefix])if(prefix&&(!safeRequestPath(prefix)||prefix.includes('?')||prefix.includes(':')||prefix.includes('*')))throw failure('模块接口前缀无效');
  return {id,basePath:source.basePath||'',ui:source.ui||{indexPath:'/',prefix:''},hostOnly:source.hostOnly||[],operations:source.operations.map(o=>compileOperation(o,id,source.basePath||''))};
}
export async function loadOperationManifest(id,{config,capabilities,getManifest,integrationKey}={}) {
  const declared=capabilities?.workbench||capabilities?.state?.workbench||capabilities?.capabilities?.workbench;
  if(declared?.protocolVersion!==1)throw failure('模块尚未升级为工作台接口 v1');
  let source=await getManifest?.(id,{config,capabilities});
  if(!source)source=capabilities?.workbench||capabilities?.state?.workbench||capabilities?.capabilities?.workbench;
  if(!source?.operations&&config?.root){
    const file=path.join(config.root,'workbench-manifest.json');
    if(fs.existsSync(file)){const stat=fs.statSync(file);if(!stat.isFile()||stat.size>2*1024*1024)throw failure('模块清单文件无效');source=JSON.parse(fs.readFileSync(file,'utf8'));}
  }
  if(!source?.operations&&builtin[id])source=builtin[id];
  if(!source?.operations&&capabilities?.url){
    const response=await fetch(capabilities.url+'/api/integration/v1/workbench/operations',{headers:{Authorization:'Bearer '+integrationKey},redirect:'error',signal:AbortSignal.timeout(3000)});
    if(response.ok){const text=await response.text();if(text.length>2*1024*1024)throw failure('模块清单过大');source=JSON.parse(text);}
  }
  const normalized=normalizeManifest(id,source);
  // Builtin descriptors define safe aliases but do not prove the installed backend supports actor isolation.
  return normalized;
}
export function publicManifest(manifest){return {module:manifest.id,operations:manifest.operations.map(o=>({module:o.module,method:o.method,path:o.path,shortPath:o.shortPath,kind:o.kind,remote:o.remote,uiOnly:o.uiOnly===true,canRunTasks:o.canRunTasks===true,operationId:o.operationId})),hostOnly:manifest.hostOnly};}
export function matchOperation(manifest,method,requestPath) {
  const pathname=requestPath.split('?')[0];
  // A literal route must win over a :parameter route just like the source router.
  const candidates=manifest.operations.filter(o=>o.method===method&&(o.path===pathname||o.shortPath===pathname));
  const list=candidates.length?candidates:manifest.operations.filter(o=>o.method===method);
  for(const o of list){let target=pathname;if(!target.startsWith('/api/')&&manifest.basePath)target=manifest.basePath+target;const match=o.regexp.exec(target);if(match)return {operation:o,upstreamPath:target+requestPath.slice(pathname.length)};}
  return null;
}
