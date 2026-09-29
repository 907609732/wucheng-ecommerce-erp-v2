# AI Runtime 扩展开发

当前运行时 API 版本为 `1.0.0`，扩展 API 版本为 `1`。扩展适用于企业内部的诊断适配器、数据源、报告格式或其他明确业务动作。

## 运行形态

同一套核心支持源码、JSON CLI、本地 stdio MCP、便携 EXE 和安装版。AI 应先调用 `inventory_runtime_capabilities` 或 `--cli capabilities`，再根据返回的版本、构建提交和扩展清单工作。

官方 MCP Inspector 已固定为开发依赖：

```powershell
npm.cmd run ai:inspect
npm.cmd run ai:inspect:tools
```

## 扩展结构

每个扩展放在诊断结果所示的 `workspace\extensions\<目录>` 中：

```text
sample-extension/
  extension.json
  extension.mjs
```

`extension.json`：

```json
{
  "id": "sample.extension",
  "name": "示例扩展",
  "version": "1.0.0",
  "apiVersion": "1",
  "entry": "extension.mjs",
  "actions": [
    { "name": "diagnose", "description": "只读诊断", "sideEffect": "read" },
    { "name": "repair", "description": "执行受控修复", "sideEffect": "write" }
  ]
}
```

`extension.mjs` 导出与清单同名的 action：

```js
export const actions = {
  async diagnose(params, context) {
    return { ok: true, appVersion: context.appVersion, received: params };
  },
  async repair(params, context) {
    return { ok: true, changed: [] };
  }
};
```

## 信任和调用

发现扩展不会加载代码。首次运行前必须由用户显式信任：

```powershell
& $app --cli extensions
& $app --cli extension-trust --id=sample.extension --confirm-trust-code
```

MCP 通过 `inventory_extension_call` 调用。`sideEffect: write` 的 action 还必须传 `confirmSideEffect: true`；只读 action 不需要。扩展入口的真实路径必须留在自身目录，符号链接不能跳出目录。

扩展代码一旦被信任，就拥有当前 Windows 用户权限。不要信任来源不明的扩展，不要在扩展清单、参数或返回值中写入密码、Token、Webhook 或私钥。

## Debug Bundle

`inventory_debug_export_bundle` 或 `--cli debug-bundle` 会生成 `cainiao-debug-bundle/v1` 文件，包含版本、Git 提交、运行形态、配置布尔状态、锁、校验摘要和脱敏日志。AI 修复问题时应把 Bundle 中的提交号与仓库提交对齐，不应把“修复代码”误当成“业务同步已成功”。
