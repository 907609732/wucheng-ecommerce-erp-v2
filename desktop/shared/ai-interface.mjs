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

export function parseCliRequest(args = []) {
  const values = args.map((value) => String(value));
  const command = String(values[0] || "help").toLowerCase();
  if (["help", "--help", "-h"].includes(command)) return { command: "help" };
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
  if (command === "login") {
    if (!values.includes("--confirm-open-browser")) {
      throw new Error("登录会打开菜鸟浏览器窗口；请确认后添加 --confirm-open-browser");
    }
    return { command, confirmed: true };
  }
  throw new Error(`未知 CLI 命令：${command}`);
}
