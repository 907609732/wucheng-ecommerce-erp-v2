import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {sanitizeDiagnosticText} from './shared/diagnostics.mjs';

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function safeError(error) {
  return sanitizeDiagnosticText(error?.message || error || '未知错误');
}

export function createInventoryMcpServer({ version, getStatus, getLogs, getDiagnostics, searchDebugLogs, getCapabilities, exportDebugBundle, listExtensions, callExtension, runSync, refreshLogin, onClose }) {
  const server = new McpServer(
    { name: "wucheng-ecommerce-erp-v2", version },
    { instructions: "先调用 inventory_runtime_capabilities 发现运行模式和扩展，再用 inventory_debug_diagnose / inventory_debug_search_logs 定位故障。不得绕过同步确认、库存校验或扩展信任边界。" }
  );

  server.registerTool("inventory_status", {
    description: "读取云仓库存同步状态、配置完整性和自动任务状态，不返回密码或密钥。",
    inputSchema: z.object({})
  }, async () => result(await getStatus()));

  server.registerTool("inventory_recent_logs", {
    description: "读取云仓库存同步最近的运行日志。",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(30).describe("返回最近多少行，范围 1 到 100")
    })
  }, async ({ limit }) => result({ lines: await getLogs(limit) }));

  server.registerTool("inventory_debug_diagnose", {
    description: "执行只读 AI 诊断：检查运行环境、配置完整性、登录态文件结构、任务锁、核心脚本、最近库存校验与错误日志。不会联网、不会执行同步、不会返回密钥。",
    inputSchema: z.object({})
  }, async () => {
    try {
      return result(await getDiagnostics());
    } catch (error) {
      return result({ error: safeError(error) }, true);
    }
  });

  server.registerTool("inventory_debug_search_logs", {
    description: "按级别和普通文本搜索本机最近日志，用于定位登录、校验、同步或钉钉发送故障；返回内容会脱敏。",
    inputSchema: z.object({
      level: z.enum(["any", "error", "warning", "info"]).default("any").describe("日志级别"),
      query: z.string().max(100).default("").describe("可选的普通文本关键词，不支持正则表达式"),
      limit: z.number().int().min(1).max(100).default(50).describe("最多返回行数")
    })
  }, async ({ level, query, limit }) => {
    try {
      return result({ lines: await searchDebugLogs({ level, query, limit }) });
    } catch (error) {
      return result({ error: safeError(error) }, true);
    }
  });

  server.registerTool("inventory_runtime_capabilities", {
    description: "发现当前运行形态、版本、构建提交、CLI 命令、MCP 工具、Debug Bundle 格式以及已安装扩展。",
    inputSchema: z.object({})
  }, async () => result(await getCapabilities()));

  server.registerTool("inventory_debug_export_bundle", {
    description: "生成并返回一个脱敏 Debug Bundle，同时保存到本机工作目录，供 AI 定位版本、复现问题和修复源码。不会执行同步或联网。",
    inputSchema: z.object({})
  }, async () => {
    try {
      return result(await exportDebugBundle());
    } catch (error) {
      return result({ error: safeError(error) }, true);
    }
  });

  server.registerTool("inventory_extension_list", {
    description: "列出工作目录中发现的扩展、信任状态、版本和已声明 action，不加载未信任代码。",
    inputSchema: z.object({})
  }, async () => result(await listExtensions()));

  server.registerTool("inventory_extension_call", {
    description: "调用一个已由用户显式信任的扩展 action。写入型 action 必须额外传 confirmSideEffect=true。",
    inputSchema: z.object({
      extensionId: z.string().min(2).max(64),
      action: z.string().min(2).max(64),
      params: z.record(z.string(), z.json()).default({}),
      confirmSideEffect: z.boolean().default(false)
    })
  }, async ({ extensionId, action, params, confirmSideEffect }) => {
    try {
      return result(await callExtension({ extensionId, action, params, confirmSideEffect }));
    } catch (error) {
      return result({ error: safeError(error) }, true);
    }
  });

  server.registerTool("inventory_sync_once", {
    description: "抓取一次菜鸟云仓实时库存，完成数据校验和本地导入，并向已配置的钉钉目标发送一条报告。",
    inputSchema: z.object({
      confirmSend: z.boolean().describe("必须明确为 true，表示用户确认本次会访问菜鸟并发送一条钉钉报告")
    })
  }, async ({ confirmSend }) => {
    if (!confirmSend) return result({ error: "需要 confirmSend=true 才能执行同步和钉钉发送" }, true);
    try {
      const task = await runSync();
      return result({ ...task, logs: (Array.isArray(task.logs)?task.logs:[]).slice(-100) }, task.success === false || task.ok === false);
    } catch (error) {
      return result({ error: safeError(error) }, true);
    }
  });

  server.registerTool("cainiao_refresh_login", {
    description: "打开菜鸟登录窗口并等待登录态保存；如出现验证码或滑块，需要用户本人处理。",
    inputSchema: z.object({
      confirmOpenBrowser: z.boolean().describe("必须明确为 true，表示用户确认打开菜鸟登录窗口")
    })
  }, async ({ confirmOpenBrowser }) => {
    if (!confirmOpenBrowser) return result({ error: "需要 confirmOpenBrowser=true 才能打开登录窗口" }, true);
    try {
      const task = await refreshLogin();
      return result({ ...task, logs: (Array.isArray(task.logs)?task.logs:[]).slice(-100) }, task.success === false || task.ok === false);
    } catch (error) {
      return result({ error: safeError(error) }, true);
    }
  });

  if (typeof onClose === "function") server.server.onclose = onClose;
  return server;
}

export function serveInventoryMcp(options) {
  const handle = serveStdio(() => createInventoryMcpServer(options));
  console.error(`云仓库存同步 MCP ${options.version} 已通过 stdio 启动`);
  return handle;
}

// The launcher retains this server and dispatcher in its headless process.
// No request-level Electron CLI process or new listening port is created.
export function createWorkbenchMcpServer({version,dispatch,onClose}){
  if(typeof dispatch!=='function')throw TypeError('A persistent workbench dispatcher is required');
  const run=async request=>{
    const response=await dispatch(request);
    if(response?.ok===false)throw Object.assign(Error(response.error||'工作台操作失败'),{code:response.code});
    return response;
  };
  const server=createInventoryMcpServer({version,onClose,
    getStatus:async()=>(await run({command:'status'})).status,
    getLogs:async limit=>(await run({command:'logs',limit})).lines||[],
    getDiagnostics:async()=>(await run({command:'doctor'})).diagnostics,
    searchDebugLogs:async options=>(await run({command:'debug-logs',...options})).lines||[],
    getCapabilities:async()=>(await run({command:'workbench',action:'capabilities'})).capabilities,
    exportDebugBundle:async()=>{const r=await run({command:'debug-bundle'});return {path:r.path,sha256:r.sha256,size:r.size,bundle:r.bundle};},
    listExtensions:async()=>{const r=await run({command:'extensions'});return {directory:r.directory,extensions:r.extensions||[]};},
    callExtension:async({extensionId,action,params,confirmSideEffect})=>(await run({command:'extension-call',id:extensionId,action,params,confirmSideEffect})).response,
    runSync:()=>run({command:'sync',confirmed:true}),refreshLogin:()=>run({command:'login',confirmed:true})
  });
  const invoke=action=>async args=>{
    try{
      const response=await dispatch({command:'workbench',action,...args});
      return result(response?.ok===false?{...response,error:safeError(response.error)}:response,response?.ok===false);
    }catch(error){return result({ok:false,code:error.code||'WORKBENCH_REQUEST_FAILED',error:safeError(error)},true);}
  };
  const read={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  const module=z.enum(['warehouse','purchase','sales','overview','exporter']);
  const object=z.record(z.string(),z.json()).default({});
  server.registerTool('workbench_status',{description:'读取电商工作台的统一连接及业务状态，不写账。',inputSchema:z.object({}),annotations:read},invoke('status'));
  server.registerTool('workbench_capabilities',{description:'发现工作台版本、模块及 MCP/CLI 能力。正式入账需要两次界面确认。',inputSchema:z.object({}),annotations:read},invoke('capabilities'));
  server.registerTool('workbench_modules',{description:'查询五个内置业务模块的版本和运行状态，不自动安装或更新。',inputSchema:z.object({}),annotations:read},invoke('modules'));
  server.registerTool('workbench_query',{description:'通过所属模块受控接口只读查询；支持 kind、id、query 或已登记 API path，不允许任意文件、SQL 或命令。',inputSchema:z.object({module,params:object}),annotations:read},invoke('query'));
  server.registerTool('workbench_tasks',{description:'只读查询云仓当前采集任务或历史订单采集任务；不会启动采集。params.id 可指定导出台任务。',inputSchema:z.object({module:z.enum(['warehouse','exporter']),params:object}),annotations:read},invoke('tasks'));
  server.registerTool('workbench_prepare',{description:'按用户本次确认整理采购导入或业务编辑草稿，不正式写账；不能替代两次界面确认。',inputSchema:z.object({module:z.enum(['purchase','sales','overview']),params:object,confirmSideEffect:z.boolean().default(false)}),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},invoke('prepare'));
  return server;
}

export function serveWorkbenchMcp(options){
  const handle=serveStdio(()=>createWorkbenchMcpServer(options));
  console.error(`五成电子商务工作台 MCP ${options.version} 已通过 stdio 启动（常驻调度）`);
  return handle;
}
