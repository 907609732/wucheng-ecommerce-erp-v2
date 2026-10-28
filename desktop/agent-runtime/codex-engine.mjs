import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StdioRpc} from './json-rpc.mjs';
import {cleanEngineEnvironment,ERP_TOOLS,MCP_ENTRY,openTaskBridge,spawnEngine,privateProfileEnvironment,taskPrompt,exactEngineVersion,engineVersion} from './engine-common.mjs';
import {agentError} from './approval.mjs';
import {openCompanyModelProxy} from './model-proxy.mjs';

export const CODEX_DISABLED_FEATURES=Object.freeze(['shell_tool','unified_exec','shell_snapshot','apps','plugins','remote_plugin','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','view_image','image_generation','code_mode','code_mode_host','multi_agent','multi_agent_v2','memories','hooks','skill_search','skill_mcp_dependency_install','in_app_browser','in_app_local_automation','workspace_dependencies','tool_suggest','enable_request_compression','goals','request_permissions_tool','current_time_reminder','token_budget','deferred_executor']);
const quote=JSON.stringify;
const catalog=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./codex-model-catalog.json',import.meta.url)),'utf8').replace(/^\uFEFF/,''));
export const CODEX_SUPPORTED_MODELS=Object.freeze(catalog.models.map(item=>item.slug));
export function restrictedModelCatalog(model){
  const selected=catalog.models.find(item=>item.slug===model);
  if(!selected)throw agentError('CODEX_MODEL_UNSUPPORTED','该模型尚未列入已验证的 Codex 协议目录，请管理员选择兼容模型',409);
  return {models:[{...selected,apply_patch_tool_type:null,shell_type:'disabled',experimental_supported_tools:[],use_responses_lite:false,prefer_websockets:false,node_repl_disabled:true,include_skills_usage_instructions:false,include_apps_usage_instructions:false,include_plugin_usage_instructions:false}]};
}
export function codexProfile({model,baseUrl,bridge,nodeExecutable,catalogPath,mcpEntry=MCP_ENTRY}){
  return `model = ${quote(model)}\nmodel_provider = "erp_company"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nproject_doc_max_bytes = 0\nmodel_catalog_json = ${quote(catalogPath)}\n[model_providers.erp_company]\nname = "Company API"\nbase_url = ${quote(baseUrl)}\nenv_key = "ERP_COMPANY_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\n[tools.update_plan]\nenabled = false\n[tools.experimental_request_user_input]\nenabled = false\n[features]\n${CODEX_DISABLED_FEATURES.map(k=>k+' = false').join('\n')}\n[mcp_servers.wucheng_erp]\ncommand = ${quote(nodeExecutable)}\nargs = [${quote(mcpEntry)}]\nrequired = true\nomit_tools_from = ["deferred"]\nenabled_tools = ${JSON.stringify(ERP_TOOLS)}\n[mcp_servers.wucheng_erp.env]\nERP_AGENT_BRIDGE_URL = ${quote(bridge.url)}\nERP_AGENT_BRIDGE_TOKEN = ${quote(bridge.token)}\nELECTRON_RUN_AS_NODE = "1"\n`+ERP_TOOLS.map(name=>`[mcp_servers.wucheng_erp.tools.${name}]\napproval_mode = "approve"\n`).join('\n');
}
export function createCodexEngine({command,argsPrefix=[],nodeExecutable=process.execPath,mcpEntryPath=MCP_ENTRY,expectedVersion='0.150.1'}={}){
  return {id:'codex',supportedModels:CODEX_SUPPORTED_MODELS,
    async check(){const version=command&&fs.existsSync(command)?await engineVersion(command,[...argsPrefix,'--version']):null;return {available:version===expectedVersion&&fs.existsSync(mcpEntryPath),version,expectedVersion,supportedModels:CODEX_SUPPORTED_MODELS,protocol:'app-server',isolation:'erp-mcp-only'};},
    async run({task,session,credentials,workingDirectory,profileDirectory,signal,invoke,emit=()=>{},onUsage=()=>{},checkpoint=()=>{},onSession=()=>{}}){
      if(!command||!fs.existsSync(command))throw agentError('CODEX_UNAVAILABLE','公司主机未找到 Codex 引擎',503);
      if(!fs.existsSync(mcpEntryPath))throw agentError('ERP_MCP_UNAVAILABLE','ERP 业务工具组件缺失',503);
      const home=path.join(profileDirectory,task.id);fs.mkdirSync(home,{recursive:true,mode:0o700});
      const catalogPath=path.join(home,'models.json');fs.writeFileSync(catalogPath,JSON.stringify(restrictedModelCatalog(credentials.model)),{mode:0o600});
      const bridge=await openTaskBridge(invoke),modelProxy=await openCompanyModelProxy({...credentials,signal,onUsage});fs.writeFileSync(path.join(home,'config.toml'),codexProfile({model:credentials.model,baseUrl:modelProxy.baseUrl,bridge,nodeExecutable,catalogPath,mcpEntry:mcpEntryPath}),{mode:0o600});
      const env=cleanEngineEnvironment({...privateProfileEnvironment(home),CODEX_HOME:home,ERP_COMPANY_API_KEY:modelProxy.token,ELECTRON_RUN_AS_NODE:'1'});
      const child=spawnEngine(command,[...argsPrefix,'app-server','--listen','stdio://'],{cwd:workingDirectory,env}),rpc=new StdioRpc(child);
      let threadId=session?.threadId,turnId,text='',usage,finish,rejectTurn,closed=false,usageTotalTokens=session?.usageTotalTokens;
      const usageBaseline=session?.threadId?session.usageTotalTokens:0;
      const saveCheckpoint=()=>checkpoint({threadId,turnId,usageTotalTokens});
      const completed=new Promise((resolve,reject)=>{finish=resolve;rejectTurn=reject;});completed.catch(()=>{});
      rpc.on('request',message=>{
        // ERP MCP handles collection. Native execution, file and arbitrary permission requests are always denied.
        if(message.method==='item/commandExecution/requestApproval'||message.method==='item/fileChange/requestApproval')rpc.send({id:message.id,result:{decision:'decline'}});
        else if(message.method==='item/permissions/requestApproval')rpc.send({id:message.id,result:{permissions:{},scope:'turn'}});
        else rpc.send({id:message.id,error:{code:-32601,message:'ERP only permits its scoped MCP tools'}});
      });
      rpc.on('notification',message=>{
        const p=message.params||{};
        if(p.threadId&&threadId&&p.threadId!==threadId)return;
        if(message.method==='item/agentMessage/delta'){text+=p.delta||'';emit('engine.message',{text:p.delta||''});}
        if(message.method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.text){if(!text.includes(p.item.text))text+=p.item.text;}
        if(message.method==='thread/tokenUsage/updated'){const total=p.tokenUsage?.total?.totalTokens;if(Number.isSafeInteger(total)){usageTotalTokens=total;usage=Number.isSafeInteger(usageBaseline)&&total>=usageBaseline?{totalTokens:total-usageBaseline}:undefined;saveCheckpoint();if(usage)onUsage(usage);}}
        if(message.method==='turn/completed'){if(p.turn?.status==='failed')rejectTurn(agentError('CODEX_TURN_FAILED',p.turn.error?.message||'Codex 未能完成本次执行',502));else finish({text,usage});}
      });
      rpc.on('closed',error=>{if(!closed)rejectTurn(error);});
      const cancel=async()=>{if(turnId&&threadId)await rpc.request('turn/interrupt',{threadId,turnId},5000).catch(()=>{});};
      const onAbort=()=>cancel().finally(()=>{rejectTurn(agentError('TASK_CANCELLED','任务已停止',409));rpc.close();});signal?.addEventListener('abort',onAbort,{once:true});onSession({cancel});
      try{
        const init=await rpc.request('initialize',{clientInfo:{name:'wucheng_erp',version:'1.0.0',title:'五成 ERP'},capabilities:{experimentalApi:true}});
        if(!exactEngineVersion(init.userAgent,expectedVersion))throw agentError('CODEX_VERSION_UNSUPPORTED','Codex 版本与已验证协议不一致，请管理员检查兼容版本',409);
        rpc.notify('initialized');
        const params={cwd:workingDirectory,model:credentials.model,modelProvider:'erp_company',approvalPolicy:'never',sandbox:'read-only',baseInstructions:taskPrompt(task)};
        const started=await rpc.request(threadId?'thread/resume':'thread/start',{...params,...(threadId?{threadId,excludeTurns:true}:{})},60000);threadId=started.thread.id;saveCheckpoint();
        if(signal?.aborted)throw agentError('TASK_CANCELLED','任务已停止',409);
        const turn=await rpc.request('turn/start',{threadId,input:[{type:'text',text:taskPrompt(task)}],approvalPolicy:'never',sandboxPolicy:{type:'readOnly'}},60000);turnId=turn.turn.id;saveCheckpoint();
        const result=await completed;return {...result,usage:modelProxy.usage()};
      }finally{closed=true;signal?.removeEventListener('abort',onAbort);await rpc.close();await bridge.close();await modelProxy.close();}
    }
  };
}
