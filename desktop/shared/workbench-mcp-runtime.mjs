import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sanitizeDiagnosticText} from './diagnostics.mjs';

// Electron's Windows GUI process does not reliably expose console stdin.
// One Node-mode broker owns stdio for the session; every tool is dispatched
// in this same launcher process over its private inherited IPC channel.
export function startWorkbenchMcpRuntime({version,dispatch,onClose=()=>{},execPath=process.execPath,entry=fileURLToPath(new URL('../mcp-stdio-entry.mjs',import.meta.url))}){
  if(typeof dispatch!=='function')throw TypeError('A persistent workbench dispatcher is required');
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',WORKBENCH_MCP_BROKER:'1',CAINIAO_ASSISTANT_VERSION:version};
  const child=spawn(execPath,[entry],{env,windowsHide:true,stdio:['inherit','inherit','inherit','ipc']});
  const active=new Set();let closed=false;
  const finish=code=>{if(!closed){closed=true;onClose(code??0);}};
  child.once('error',()=>finish(1));child.once('exit',finish);
  child.on('message',async message=>{
    if(closed||message?.type!=='workbench:request'||typeof message.id!=='string'||message.id.length>80||active.has(message.id))return;
    const send=value=>{if(child.connected)child.send({type:'workbench:response',id:message.id,...value},()=>{});};
    if(active.size>=32){send({ok:false,error:{code:'MCP_BUSY',message:'当前智能体请求过多，请稍后重试'}});return;}
    active.add(message.id);
    try{send({ok:true,value:await dispatch(message.request)});}
    catch(error){send({ok:false,error:{code:error.code||'WORKBENCH_REQUEST_FAILED',message:sanitizeDiagnosticText(error.message||'工作台操作失败')}});}
    finally{active.delete(message.id);}
  });
  return {child,close(){if(child.connected)child.disconnect();},get activeRequests(){return active.size;}};
}
