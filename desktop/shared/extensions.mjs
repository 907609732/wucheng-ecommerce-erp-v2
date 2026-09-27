import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_API_VERSION } from "./runtime-contract.mjs";

const ID_PATTERN = /^[a-z][a-z0-9.-]{1,63}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function normalizeTrustedExtensionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim().toLowerCase()).filter((item) => ID_PATTERN.test(item)))].sort();
}

export function validateExtensionManifest(value, directory) {
  const errors = [];
  const id = String(value?.id || "").trim().toLowerCase();
  const name = String(value?.name || id).trim();
  const version = String(value?.version || "").trim();
  const apiVersion = String(value?.apiVersion || "").trim();
  const entryName = String(value?.entry || "extension.mjs").trim();
  if (!ID_PATTERN.test(id)) errors.push("扩展 id 必须是小写字母开头的安全标识");
  if (!name) errors.push("扩展名称不能为空");
  if (!version) errors.push("扩展版本不能为空");
  if (apiVersion !== EXTENSION_API_VERSION) errors.push(`扩展 API 版本必须是 ${EXTENSION_API_VERSION}`);
  let entry = path.resolve(directory, entryName);
  if (!within(path.resolve(directory), entry)) errors.push("扩展入口必须位于扩展目录内");
  if (!fs.existsSync(entry)) {
    errors.push("扩展入口文件不存在");
  } else {
    try {
      const realDirectory = fs.realpathSync(directory);
      entry = fs.realpathSync(entry);
      if (!within(realDirectory, entry)) errors.push("扩展入口不能通过符号链接跳出扩展目录");
    } catch (error) {
      errors.push(`无法解析扩展入口：${error.message}`);
    }
  }
  const actions = Array.isArray(value?.actions) ? value.actions.map((action) => ({
    name: String(action?.name || "").trim(),
    description: String(action?.description || "").trim(),
    sideEffect: action?.sideEffect === "write" ? "write" : "read"
  })) : [];
  if (!actions.length) errors.push("扩展至少需要一个 action");
  if (actions.some((action) => !ACTION_PATTERN.test(action.name))) errors.push("扩展 action 名称不合法");
  if (new Set(actions.map((action) => action.name)).size !== actions.length) errors.push("扩展 action 名称重复");
  return { valid: errors.length === 0, errors, manifest: { id, name, version, apiVersion, entry, actions } };
}

export function discoverExtensions(extensionRoot, trustedIds = []) {
  const trusted = new Set(normalizeTrustedExtensionIds(trustedIds));
  if (!fs.existsSync(extensionRoot)) return [];
  const results = [];
  for (const item of fs.readdirSync(extensionRoot, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const directory = path.join(extensionRoot, item.name);
    const manifestPath = path.join(directory, "extension.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const checked = validateExtensionManifest(parsed, directory);
      results.push({
        ...checked.manifest,
        directory,
        manifestPath,
        trusted: trusted.has(checked.manifest.id),
        valid: checked.valid,
        errors: checked.errors
      });
    } catch (error) {
      results.push({
        id: item.name,
        name: item.name,
        version: "",
        apiVersion: "",
        entry: "",
        actions: [],
        directory,
        manifestPath,
        trusted: false,
        valid: false,
        errors: [String(error?.message || error)]
      });
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

export async function invokeTrustedExtension(extension, actionName, params, context = {}) {
  if (!extension?.valid) throw new Error("扩展清单无效");
  if (!extension.trusted) throw new Error("扩展尚未被用户信任");
  const action = extension.actions.find((item) => item.name === actionName);
  if (!action) throw new Error("扩展 action 不存在");
  if (action.sideEffect === "write" && context.confirmSideEffect !== true) {
    throw new Error("该扩展操作会写入或发送数据，必须 confirmSideEffect=true");
  }
  const module = await import(`${pathToFileURL(extension.entry).href}?v=${encodeURIComponent(extension.version)}`);
  const handler = module.actions?.[actionName];
  if (typeof handler !== "function") throw new Error("扩展入口未导出对应 action 函数");
  const result = await handler(params && typeof params === "object" ? params : {}, {
    apiVersion: EXTENSION_API_VERSION,
    appVersion: context.appVersion,
    workspace: context.workspace,
    sideEffect: action.sideEffect
  });
  return { extension: extension.id, action: actionName, sideEffect: action.sideEffect, result };
}
