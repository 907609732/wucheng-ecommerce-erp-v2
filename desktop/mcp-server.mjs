import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function safeError(error) {
  return String(error?.message || error || "未知错误")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED]");
}

export function createInventoryMcpServer({ version, getStatus, getLogs, getDiagnostics, searchDebugLogs, getCapabilities, exportDebugBundle, listExtensions, callExtension, runSync, refreshLogin, onClose }) {
  const server = new McpServer(
    { name: "wucheng-ecommerce-erp-v2", version },
    { instructions: "先调用 inventory_runtime_capabilities 发现运行模式和扩展，再用 inventory_debug_diagnose / inventory_debug_search_logs 定位故障。不得绕过同步确认、库存校验或扩展信任边界。" }
  );

  server.registerTool("inventory_status", {
    description: "读取五成电子商务集团 ERP V2 状态、配置完整性和自动任务状态，不返回密码或密钥。",
    inputSchema: z.object({})
  }, async () => result(await getStatus()));

  server.registerTool("inventory_recent_logs", {
    description: "读取五成电子商务集团 ERP V2 最近的运行日志。",
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
      return result({ ...task, logs: task.logs.slice(-100) }, !task.success);
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
      return result({ ...task, logs: task.logs.slice(-100) }, !task.success);
    } catch (error) {
      return result({ error: safeError(error) }, true);
    }
  });

  if (typeof onClose === "function") server.server.onclose = onClose;
  return server;
}

export function serveInventoryMcp(options) {
  const handle = serveStdio(() => createInventoryMcpServer(options));
  console.error(`五成电子商务集团 ERP V2 MCP ${options.version} 已通过 stdio 启动`);
  return handle;
}
