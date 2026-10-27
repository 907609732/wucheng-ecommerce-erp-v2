import { spawn } from "node:child_process";
import { serveInventoryMcp,serveWorkbenchMcp } from "./mcp-server.mjs";
import {randomUUID} from 'node:crypto';

const appExe = process.env.CAINIAO_ASSISTANT_EXE || process.execPath;
const appPath = process.env.CAINIAO_ASSISTANT_APP_PATH || "";
const userDataDir = process.env.CAINIAO_ASSISTANT_USER_DATA || "";
const version = process.env.CAINIAO_ASSISTANT_VERSION || "0.0.0";

function cleanChildEnvironment() {
  const env = { ...process.env };
  env.WORKBENCH_CLIENT_CHANNEL='mcp';
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
        if (payload.code === 'MODULE_NOT_INSTALLED') { reject(new Error(payload.error)); return; }
        if (code !== 0 && payload.ok !== false) payload.ok = false;
        resolve(payload);
      } catch {
        reject(new Error(`CLI 返回了无效 JSON（退出码 ${code ?? "未知"}）：${stderr.trim().slice(-1000)}`));
      }
    });
  });
}

if(process.env.WORKBENCH_MCP_BROKER==='1'){
  if(typeof process.send!=='function')throw Error('工作台 MCP 需要可信的父进程 IPC 通道');
  const pending=new Map();
  process.on('message',message=>{
    if(message?.type!=='workbench:response')return;
    const request=pending.get(message.id);if(!request)return;
    pending.delete(message.id);clearTimeout(request.timer);
    if(message.ok)request.resolve(message.value);
    else request.reject(Object.assign(Error(message.error?.message||'工作台操作失败'),{code:message.error?.code}));
  });
  process.on('disconnect',()=>process.exit(0));
  const dispatch=request=>new Promise((resolve,reject)=>{
    if(!process.connected)return reject(Error('工作台 MCP 调度通道已关闭'));
    const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('工作台调用未及时返回，请查询任务结果后再试'),{code:'WORKBENCH_OUTCOME_UNKNOWN'}));},180000);
    pending.set(id,{resolve,reject,timer});
    process.send({type:'workbench:request',id,request},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
  });
  serveWorkbenchMcp({version,dispatch,onClose:()=>process.exit(0)});
}else serveInventoryMcp({
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
