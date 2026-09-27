# 五成电子商务集团 ERP V2 AI 接口

桌面版从 v0.3.0 起提供 CLI 和 MCP，v0.3.1 增加受控 AI Debug，v0.4.0 将其升级为可发现、可扩展的 AI Runtime。同一核心支持源码、便携 EXE、安装版、CLI 和 MCP，并复用 Windows DPAPI 保存的账号与机器人配置。库存日报采用本机直发：本机完成采集、校验和导入后，直接调用钉钉企业应用机器人，不依赖云端 ERP、SSH 或 WSL。

## CLI

PowerShell 示例：

```powershell
$app = "$env:LOCALAPPDATA\Programs\wucheng-ecommerce-erp-v2\五成电子商务集团 ERP V2.exe"
& $app --cli status
& $app --cli capabilities
& $app --cli logs --limit=30
& $app --cli doctor
& $app --cli debug-logs --level=error --query=登录 --limit=50
& $app --cli debug-bundle
& $app --cli extensions
& $app --cli sync --confirm-send
& $app --cli login --confirm-open-browser
```

- `status`：只读，返回版本、空闲/忙碌、账号/机器人是否配置、计划任务和路径。
- `capabilities`：返回运行形态、构建提交、CLI/MCP 能力和扩展 API 契约。
- `logs`：只读，最多返回最近 100 行日志。
- `doctor`：只读检查运行环境、配置完整性、登录态文件结构、任务锁、核心脚本、最近库存校验和错误日志。
- `debug-logs`：按 `any/error/warning/info` 和普通文本关键词检索最近日志，最多 100 行，返回前自动脱敏。
- `debug-bundle`：生成并返回 `cainiao-debug-bundle/v1`，同时保存一份脱敏 JSON 到本机工作目录。
- `extensions`：只读取扩展清单，不加载未信任代码。扩展开发见 [extensions.md](extensions.md)。
- `sync --confirm-send`：执行一次完整的本地库存同步并由本机企业应用机器人发送一条钉钉报告；缺少确认参数时拒绝执行。
- `login --confirm-open-browser`：打开菜鸟登录窗口；验证码或滑块必须由用户本人处理。

所有 CLI 输出均为 JSON，可供 PowerShell、批处理、CI 或其他程序解析。

## MCP（stdio）

MCP 客户端使用以下本地进程配置：

```json
{
  "command": "C:\\Users\\当前用户\\AppData\\Local\\Programs\\wucheng-ecommerce-erp-v2\\五成电子商务集团 ERP V2.exe",
  "args": ["--mcp-stdio"]
}
```

MCP 使用本地 `stdio`，不监听 HTTP 端口，也不向局域网开放服务。可用工具：

| 工具 | 作用 | 写入/发送门禁 |
| --- | --- | --- |
| `inventory_status` | 查询配置和运行状态 | 只读 |
| `inventory_recent_logs` | 查询最近日志 | 只读 |
| `inventory_debug_diagnose` | 生成结构化环境与故障诊断 | 只读、不联网、密钥脱敏 |
| `inventory_debug_search_logs` | 按级别和关键词搜索脱敏日志 | 只读，不支持任意文件路径或正则表达式 |
| `inventory_runtime_capabilities` | 发现运行形态、构建版本和扩展 | 只读 |
| `inventory_debug_export_bundle` | 生成供 AI 修复问题的脱敏诊断包 | 只写入专用 Debug Bundle 目录 |
| `inventory_extension_list` | 列出扩展及信任状态 | 只读，不加载扩展代码 |
| `inventory_extension_call` | 调用已信任扩展 action | 未信任扩展拒绝；写入 action 需二次确认 |
| `inventory_sync_once` | 抓取、校验、导入库存并发送钉钉报告 | 必须传 `confirmSend: true` |
| `cainiao_refresh_login` | 打开登录窗口刷新登录态 | 必须传 `confirmOpenBrowser: true` |

GUI、CLI 和 MCP 共用 `workspace/state/desktop-task.lock`，同一时刻只允许一个登录或同步任务。异常退出形成的死进程锁会被归档到日志目录，不会覆盖活跃任务。

AI Debug 不提供 Shell、SQL、任意路径文件读取或密钥读取。`doctor` 只报告布尔配置状态、文件结构/时间、进程锁状态、最近一次库存校验摘要和脱敏后的错误行。登录态 JSON 结构有效不代表线上会话仍有效，真正同步遇到登录跳转、验证码或滑块时仍会停止并交由用户处理。

## 开发与验证

源码模式：

```powershell
npm.cmd run ai:status
npm.cmd run ai:doctor
npm.cmd run ai:mcp
npm.cmd run ai:inspect
npm.cmd run ai:inspect:tools
```

MCP 服务基于官方 `@modelcontextprotocol/server` v2，调试器使用固定版本的官方 `@modelcontextprotocol/inspector`。stdout 专用于协议数据，诊断信息只写入 stderr 或桌面日志。
