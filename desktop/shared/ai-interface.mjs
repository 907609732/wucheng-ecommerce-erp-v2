export const AI_TOOLS = Object.freeze([
  "inventory_status",
  "inventory_recent_logs",
  "inventory_debug_diagnose",
  "inventory_debug_search_logs",
  "inventory_runtime_capabilities",
  "inventory_debug_export_bundle",
  "inventory_extension_list",
  "inventory_extension_call",
  "inventory_sync_once",
  "cainiao_refresh_login"
]);

export const WORKBENCH_TOOLS = Object.freeze([
  'workbench_status', 'workbench_capabilities', 'workbench_modules',
  'workbench_query', 'workbench_tasks', 'workbench_prepare'
]);

const workbenchActions = new Set(['status','capabilities','modules','query','tasks','prepare']);
const moduleIds = new Set(['warehouse','purchase','sales','overview','exporter']);
function cliObject(values) {
  const encoded=values.find(value=>value.startsWith('--params-base64='))?.slice(16);
  const plain=values.find(value=>value.startsWith('--params-json='))?.slice(14);
  if(encoded!==undefined&&plain!==undefined)throw Error('请只使用一种 JSON 参数格式');
  const text=encoded!==undefined?Buffer.from(encoded,'base64url').toString('utf8'):plain;
  if(text===undefined)return {};
  if(Buffer.byteLength(text,'utf8')>65536)throw Error('工作台参数过大');
  let object;try{object=JSON.parse(text);}catch{throw Error('工作台参数不是有效的 JSON');}
  if(!object||typeof object!=='object'||Array.isArray(object))throw Error('工作台参数必须是 JSON 对象');
  return object;
}

export function parseCliRequest(args = []) {
  const values = args.map((value) => String(value));
  const command = String(values[0] || "help").toLowerCase();
  if (["help", "--help", "-h"].includes(command)) return { command: "help" };
  if(command==='workbench'){
    const action=String(values[1]||'help').toLowerCase();
    if(!workbenchActions.has(action))throw Error('工作台命令支持 status、capabilities、modules、query、tasks、prepare');
    const module=values.find(value=>value.startsWith('--module='))?.slice(9);
    if(module!==undefined&&!moduleIds.has(module))throw Error('未知工作台模块');
    if(['query','tasks','prepare'].includes(action)&&!module)throw Error('请提供 --module=<模块标识>');
    return {command,action,...(module?{module}:{}),params:cliObject(values),confirmSideEffect:values.includes('--confirm-side-effect')};
  }
  if (command === "status") return { command };
  if (command === "capabilities") return { command };
  if (command === "doctor") return { command };
  if (command === "debug-bundle") return { command };
  if (command === "extensions") return { command };
  if (command === "logs") {
    const rawLimit = values.find((item) => item.startsWith("--limit="))?.split("=", 2)[1];
    return { command, limit: Math.min(100, Math.max(1, Number(rawLimit) || 30)) };
  }
  if (command === "debug-logs") {
    const rawLimit = values.find((item) => item.startsWith("--limit="))?.split("=", 2)[1];
    const rawLevel = values.find((item) => item.startsWith("--level="))?.split("=", 2)[1]?.toLowerCase();
    const level = ["any", "error", "warning", "info"].includes(rawLevel) ? rawLevel : "any";
    const query = values.find((item) => item.startsWith("--query="))?.slice("--query=".length, 100 + "--query=".length) || "";
    return { command, limit: Math.min(100, Math.max(1, Number(rawLimit) || 50)), level, query };
  }
  if (command === "extension-trust") {
    const id = values.find((item) => item.startsWith("--id="))?.slice("--id=".length) || "";
    if (!id) throw new Error("请提供 --id=<extension-id>");
    if (!values.includes("--confirm-trust-code")) throw new Error("信任本地扩展代码必须添加 --confirm-trust-code");
    return { command, id: id.toLowerCase(), confirmed: true };
  }
  if (command === "extension-call") {
    const id = values.find((item) => item.startsWith("--id="))?.slice("--id=".length) || "";
    const action = values.find((item) => item.startsWith("--action="))?.slice("--action=".length) || "";
    const encoded = values.find((item) => item.startsWith("--params-base64="))?.slice("--params-base64=".length) || "";
    if (!id || !action) throw new Error("请提供扩展 --id 和 --action");
    if (encoded.length > 87_384) throw new Error("扩展参数过大");
    let params = {};
    if (encoded) {
      try {
        params = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      } catch {
        throw new Error("扩展参数不是有效的 base64url JSON");
      }
    }
    return { command, id: id.toLowerCase(), action, params, confirmSideEffect: values.includes("--confirm-side-effect") };
  }
  if (command === "sync") {
    if (!values.includes("--confirm-send")) {
      throw new Error("同步会发送钉钉报告；请在用户明确确认后添加 --confirm-send");
    }
    return { command, confirmed: true };
  }
  if (command === "send-latest-valid") {
    if (!values.includes("--confirm-send")) {
      throw new Error("发送最近有效库存快照会向钉钉群发送报告；请在用户明确确认后添加 --confirm-send");
    }
    return { command, confirmed: true };
  }
  if (command === "login") {
    if (!values.includes("--confirm-open-browser")) {
      throw new Error("登录会打开菜鸟浏览器窗口；请确认后添加 --confirm-open-browser");
    }
    return { command, confirmed: true };
  }
  throw new Error(`未知 CLI 命令：${command}`);
}
