import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import {createHash} from 'node:crypto';
import {cleanEngineEnvironment,MCP_ENTRY,openTaskBridge,spawnEngine,stopEngine,privateProfileEnvironment,taskPrompt,exactEngineVersion} from './engine-common.mjs';
import {agentError} from './approval.mjs';

const bootstrap=fileURLToPath(new URL('./hermes-bootstrap.py',import.meta.url));
const compatibility=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./hermes-compatibility.json',import.meta.url)),'utf8').replace(/^\uFEFF/,''));
export function verifyHermesCompatibility(root){try{return !!root&&Object.entries(compatibility.files).every(([name,digest])=>createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')===digest);}catch{return false;}}
export function createHermesEngine({python,root,nodeExecutable=process.execPath,bootstrapPath=bootstrap,mcpEntryPath=MCP_ENTRY,expectedVersion='0.21.0',diagnostic}={}){
  const bootstrapValid=()=>{try{return createHash('sha256').update(fs.readFileSync(bootstrapPath)).digest('hex')===createHash('sha256').update(fs.readFileSync(bootstrap)).digest('hex');}catch{return false;}};
  return {id:'hermes',async check(){let version;try{version=fs.readFileSync(path.join(root,'pyproject.toml'),'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];}catch{}const compatible=verifyHermesCompatibility(root);return {available:!!python&&fs.existsSync(python)&&version===expectedVersion&&compatible&&bootstrapValid()&&fs.existsSync(mcpEntryPath),version,expectedVersion,compatible,sourceCommit:compatibility.sourceCommit,protocol:'acp-v1',isolation:'erp-mcp-only'};},
    async run({task,session,credentials,workingDirectory,profileDirectory,signal,invoke,emit=()=>{},onUsage=()=>{},checkpoint=()=>{},onSession=()=>{}}){
      if(!python||!root)throw agentError('HERMES_UNAVAILABLE','公司主机未配置 Hermes 运行环境',503);
      if(!bootstrapValid())throw agentError('HERMES_BOOTSTRAP_INVALID','Hermes 桥接组件缺失或版本不匹配',503);
      if(!fs.existsSync(mcpEntryPath))throw agentError('ERP_MCP_UNAVAILABLE','ERP 业务工具组件缺失',503);
      if(!verifyHermesCompatibility(root))throw agentError('HERMES_SOURCE_UNSUPPORTED','Hermes 源码已变化，需要重新验证兼容性和工具隔离',409);
      const acp=await import('@agentclientprotocol/sdk'),home=path.join(profileDirectory,task.id);fs.mkdirSync(home,{recursive:true,mode:0o700});
      fs.writeFileSync(path.join(home,'config.yaml'),JSON.stringify({model:{default:credentials.model,provider:'custom'},mcp_servers:{},auxiliary:{title_generation:{enabled:false}},tools:{tool_search:{enabled:'off'}},memory:{memory_enabled:false,user_profile_enabled:false}},null,2),{mode:0o600});
      const bridge=await openTaskBridge(invoke),env=cleanEngineEnvironment({...privateProfileEnvironment(home),HERMES_HOME:home,ERP_HERMES_ROOT:root,ERP_COMPANY_API_KEY:credentials.apiKey,ERP_COMPANY_MODEL:credentials.model,ERP_COMPANY_BASE_URL:credentials.baseUrl,HERMES_ACP_SKIP_CONFIGURED_MCP:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'});
      const child=spawnEngine(python,[bootstrapPath],{cwd:workingDirectory,env});
      if(diagnostic)child.stderr.on('data',chunk=>diagnostic(String(chunk)));
      let text='',usage,sessionId=session?.sessionId;
      const client=acp.client({name:'wucheng-erp',version:'1.0.0'})
        .onRequest(acp.methods.client.session.requestPermission,()=>({outcome:{outcome:'cancelled'}}))
        .onNotification(acp.methods.client.session.update,ctx=>{const update=ctx.params.update;if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text'){text+=update.content.text;emit('engine.message',{text:update.content.text});}if(update.sessionUpdate==='usage_update'){usage=update;onUsage(usage);}});
      const connection=await client.connect(acp.ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout),{maxMessageBytes:8*1024*1024}));
      child.once('exit',()=>connection.close(agentError('HERMES_EXITED','Hermes 执行进程已退出',503)));
      const cancel=()=>sessionId?connection.agent.notify(acp.methods.agent.session.cancel,{sessionId}):Promise.resolve();const abort=()=>{cancel().catch(()=>{}).finally(()=>{connection.close();stopEngine(child);});};signal?.addEventListener('abort',abort,{once:true});onSession({cancel});
      try{
        const init=await connection.agent.request(acp.methods.agent.initialize,{protocolVersion:acp.PROTOCOL_VERSION,clientInfo:{name:'wucheng-erp',version:'1.0.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
        if(!exactEngineVersion(init.agentInfo?.version,expectedVersion))throw agentError('HERMES_VERSION_UNSUPPORTED','Hermes 版本与已验证适配器不一致',409);
        const mcpServers=[{name:'wucheng_erp',command:nodeExecutable,args:[mcpEntryPath],env:[{name:'ERP_AGENT_BRIDGE_URL',value:bridge.url},{name:'ERP_AGENT_BRIDGE_TOKEN',value:bridge.token},{name:'ELECTRON_RUN_AS_NODE',value:'1'}]}];
        if(sessionId)await connection.agent.request(acp.methods.agent.session.load,{sessionId,cwd:workingDirectory,mcpServers});
        else{const created=await connection.agent.request(acp.methods.agent.session.new,{cwd:workingDirectory,mcpServers});sessionId=created.sessionId;}
        checkpoint({sessionId});if(signal?.aborted)throw agentError('TASK_CANCELLED','任务已停止',409);
        const result=await connection.agent.request(acp.methods.agent.session.prompt,{sessionId,prompt:[{type:'text',text:taskPrompt(task)}]},{signal});
        return {text,usage:result.usage||usage};
      }finally{signal?.removeEventListener('abort',abort);connection.close();await stopEngine(child);await bridge.close();}
    }
  };
}
