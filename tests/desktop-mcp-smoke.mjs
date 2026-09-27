import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const projectRoot = path.resolve(".");
const expectedVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;
const electronPath = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const packagedApp = process.env.MCP_APP_EXE || "";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cainiao-mcp-smoke-"));
const extensionDir = path.join(userDataDir, "workspace", "extensions", "smoke-extension");
fs.mkdirSync(extensionDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ trustedExtensionIds: ["smoke.extension"] }));
fs.writeFileSync(path.join(extensionDir, "extension.json"), JSON.stringify({
  id: "smoke.extension",
  name: "Smoke Extension",
  version: "1.0.0",
  apiVersion: "1",
  entry: "extension.mjs",
  actions: [
    { name: "diagnose", description: "read", sideEffect: "read" },
    { name: "guarded_write", description: "write", sideEffect: "write" }
  ]
}));
fs.writeFileSync(path.join(extensionDir, "extension.mjs"), `export const actions = {
  diagnose: async (params, context) => ({ ok: true, value: params.value, apiVersion: context.apiVersion }),
  guarded_write: async () => ({ shouldNotRun: true })
};\n`);
const transport = new StdioClientTransport({
  command: packagedApp || electronPath,
  args: [...(packagedApp ? [] : [projectRoot]), "--mcp-stdio", `--user-data-dir=${userDataDir}`],
  cwd: projectRoot,
  stderr: "pipe"
});
const client = new Client({ name: "cainiao-mcp-smoke", version: "1.0.0" });
let stderrText = "";
transport.stderr?.on("data", (chunk) => { stderrText += String(chunk); });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  for (const required of ["cainiao_refresh_login", "inventory_debug_diagnose", "inventory_debug_export_bundle", "inventory_debug_search_logs", "inventory_extension_call", "inventory_extension_list", "inventory_recent_logs", "inventory_runtime_capabilities", "inventory_status", "inventory_sync_once"]) {
    if (!names.includes(required)) throw new Error(`缺少 MCP 工具：${required}`);
  }
  const response = await client.callTool({ name: "inventory_status", arguments: {} });
  const text = response.content?.find((item) => item.type === "text")?.text || "";
  const status = JSON.parse(text);
  if (status.version !== expectedVersion || status.state !== "idle" || status.configured?.account !== false || status.configured?.robot !== false) {
    throw new Error(`MCP 状态异常：${text}`);
  }
  const diagnosisResponse = await client.callTool({ name: "inventory_debug_diagnose", arguments: {} });
  const diagnosisText = diagnosisResponse.content?.find((item) => item.type === "text")?.text || "";
  const diagnosis = JSON.parse(diagnosisText);
  if (diagnosis.version !== expectedVersion || diagnosis.safety?.readOnly !== true || diagnosis.safety?.secretsRedacted !== true) {
    throw new Error(`MCP AI 诊断异常：${diagnosisText}`);
  }
  const debugLogs = await client.callTool({ name: "inventory_debug_search_logs", arguments: { level: "error", query: "登录", limit: 10 } });
  if (debugLogs.isError) throw new Error("MCP 脱敏日志搜索失败");
  const capabilitiesResponse = await client.callTool({ name: "inventory_runtime_capabilities", arguments: {} });
  const capabilities = JSON.parse(capabilitiesResponse.content?.find((item) => item.type === "text")?.text || "{}");
  if (capabilities.schemaVersion !== "1.0.0" || !capabilities.modes?.some((mode) => mode.id === "portable")) {
    throw new Error("MCP 运行时能力发现失败");
  }
  const extensionResponse = await client.callTool({ name: "inventory_extension_list", arguments: {} });
  if (extensionResponse.isError) throw new Error("MCP 扩展发现失败");
  const extensionList = JSON.parse(extensionResponse.content?.find((item) => item.type === "text")?.text || "{}");
  if (extensionList.extensions?.[0]?.id !== "smoke.extension" || extensionList.extensions?.[0]?.trusted !== true) {
    throw new Error("MCP 扩展信任状态异常");
  }
  const extensionCall = await client.callTool({
    name: "inventory_extension_call",
    arguments: { extensionId: "smoke.extension", action: "diagnose", params: { value: 4 }, confirmSideEffect: false }
  });
  const extensionResult = JSON.parse(extensionCall.content?.find((item) => item.type === "text")?.text || "{}");
  if (extensionCall.isError || extensionResult.result?.value !== 4 || extensionResult.result?.apiVersion !== "1") {
    throw new Error("MCP 只读扩展调用失败");
  }
  const blockedExtension = await client.callTool({
    name: "inventory_extension_call",
    arguments: { extensionId: "smoke.extension", action: "guarded_write", params: {}, confirmSideEffect: false }
  });
  if (!blockedExtension.isError || !blockedExtension.content?.some((item) => item.type === "text" && item.text.includes("confirmSideEffect=true"))) {
    throw new Error("MCP 扩展写入确认门禁未生效");
  }
  const bundleResponse = await client.callTool({ name: "inventory_debug_export_bundle", arguments: {} });
  const bundle = JSON.parse(bundleResponse.content?.find((item) => item.type === "text")?.text || "{}");
  if (bundle.bundle?.format !== "cainiao-debug-bundle/v1" || !bundle.sha256 || !fs.existsSync(bundle.path)) {
    throw new Error("MCP Debug Bundle 导出失败");
  }
  const blocked = await client.callTool({ name: "inventory_sync_once", arguments: { confirmSend: false } });
  if (!blocked.isError || !blocked.content?.some((item) => item.type === "text" && item.text.includes("confirmSend=true"))) {
    throw new Error("MCP 同步确认门禁未生效");
  }
  console.log(`DESKTOP_MCP_SMOKE_OK ${names.join(",")}`);
} catch (error) {
  throw new Error(`${error.message}\nMCP stderr:\n${stderrText.slice(-4000)}`);
} finally {
  await client.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
