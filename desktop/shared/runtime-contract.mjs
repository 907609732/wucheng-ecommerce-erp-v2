import { AI_TOOLS } from "./ai-interface.mjs";

export const RUNTIME_API_VERSION = "1.0.0";
export const EXTENSION_API_VERSION = "1";

export function createRuntimeCapabilities({ version, packaged, executable, workspace, sourceRoot = "", buildInfo = {}, extensions = [], displayName = "云仓库存同步" }) {
  return {
    schemaVersion: RUNTIME_API_VERSION,
    application: {
      name: "wucheng-ecommerce-erp-v2",
      displayName,
      version,
      packaged: Boolean(packaged),
      executable,
      source: {
        repository: "https://github.com/907609732/wucheng-ecommerce-erp-v2",
        root: String(sourceRoot || ""),
        editable: !packaged && Boolean(sourceRoot)
      },
      build: {
        commit: String(buildInfo.commit || "development"),
        builtAt: String(buildInfo.builtAt || ""),
        channel: String(buildInfo.channel || (packaged ? "release" : "development"))
      }
    },
    modes: [
      { id: "source", entry: "npm.cmd run desktop", purpose: "开发、调试与修复源码" },
      { id: "cli", entry: "云仓库存同步.exe --cli <command>", purpose: "脚本和 CI 的稳定 JSON 接口" },
      { id: "mcp-stdio", entry: "云仓库存同步.exe --mcp-stdio", purpose: "AI 客户端标准调用" },
      { id: "portable", entry: "CloudWarehouseInventorySync-Portable-<version>-x64.exe", purpose: "无需安装的便携运行" },
      { id: "installed", entry: `${displayName}.exe`, purpose: "带设置界面和在线升级的桌面运行" }
    ],
    cliCommands: ["status", "capabilities", "doctor", "logs", "debug-logs", "debug-bundle", "extensions", "extension-trust", "extension-call", "sync", "send-latest-valid", "login"],
    mcpTools: [...AI_TOOLS],
    debug: {
      bundleFormat: "cainiao-debug-bundle/v1",
      secretsRedacted: true,
      arbitraryFileRead: false,
      arbitraryCommandExecution: false
    },
    extensions: {
      apiVersion: EXTENSION_API_VERSION,
      directory: `${workspace}\\extensions`,
      trustRequired: true,
      writeConfirmationRequired: true,
      installed: extensions
    }
  };
}
