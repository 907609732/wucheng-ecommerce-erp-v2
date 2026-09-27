import { spawn } from "node:child_process";
import { serveInventoryMcp } from "./mcp-server.mjs";

const appExe = process.env.CAINIAO_ASSISTANT_EXE || process.execPath;
const appPath = process.env.CAINIAO_ASSISTANT_APP_PATH || "";
const userDataDir = process.env.CAINIAO_ASSISTANT_USER_DATA || "";
const version = process.env.CAINIAO_ASSISTANT_VERSION || "0.0.0";

function cleanChildEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CAINIAO_ASSISTANT_EXE;
  delete env.CAINIAO_ASSISTANT_APP_PATH;
  delete env.CAINIAO_ASSISTANT_USER_DATA;
  delete env.CAINIAO_ASSISTANT_VERSION;
  return env;
}

function invokeCli(args) {
  return new Promise((resolve, reject) => {
    const executableArgs = [
      ...(appPath ? [appPath] : []),
      "--cli",
      ...args,
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : [])
    ];
    const child = spawn(appExe, executableArgs, {
      env: cleanChildEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const payload = JSON.parse(stdout.trim());
        if (code !== 0 && payload.ok !== false) payload.ok = false;
        resolve(payload);
      } catch {
        reject(new Error(`CLI 返回了无效 JSON（退出码 ${code ?? "未知"}）：${stderr.trim().slice(-1000)}`));
      }
    });
  });
}

serveInventoryMcp({
  version,
  getStatus: async () => (await invokeCli(["status"])).status,
  getLogs: async (limit) => (await invokeCli(["logs", `--limit=${limit}`])).lines || [],
  getDiagnostics: async () => (await invokeCli(["doctor"])).diagnostics,
  searchDebugLogs: async ({ level, query, limit }) => (await invokeCli([
    "debug-logs",
    `--level=${level}`,
    `--query=${query}`,
    `--limit=${limit}`
  ])).lines || [],
  getCapabilities: async () => (await invokeCli(["capabilities"])).capabilities,
  exportDebugBundle: async () => {
    const response = await invokeCli(["debug-bundle"]);
    return { path: response.path, sha256: response.sha256, size: response.size, bundle: response.bundle };
  },
  listExtensions: async () => {
    const response = await invokeCli(["extensions"]);
    return { directory: response.directory, extensions: response.extensions || [] };
  },
  callExtension: async ({ extensionId, action, params, confirmSideEffect }) => {
    const encoded = Buffer.from(JSON.stringify(params || {}), "utf8").toString("base64url");
    const response = await invokeCli([
      "extension-call",
      `--id=${extensionId}`,
      `--action=${action}`,
      `--params-base64=${encoded}`,
      ...(confirmSideEffect ? ["--confirm-side-effect"] : [])
    ]);
    if (response.ok === false) throw new Error(response.error || "扩展调用失败");
    return response.response;
  },
  runSync: () => invokeCli(["sync", "--confirm-send"]),
  refreshLogin: () => invokeCli(["login", "--confirm-open-browser"]),
  onClose: () => process.exit(0)
});
