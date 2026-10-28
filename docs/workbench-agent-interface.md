# 电商工作台智能体接口 v1

统一入口是安装后的 `云仓库存同步.exe`（保留安装身份与旧命令兼容）。工作台自身、CLI 和 MCP 复用同一业务适配层。服务器/客户端继续按原 Tailscale 成员身份、模块权限、迁移状态和账本身份校验；单机调用使用持有本机服务授权文件的当前 Windows 用户身份 `local:<用户名>`，不伪装为 Tailscale 用户。

## CLI

```powershell
$app = "$env:LOCALAPPDATA\Programs\wucheng-ecommerce-erp-v2\云仓库存同步.exe"
& $app --cli workbench capabilities
& $app --cli workbench status
& $app --cli workbench modules
& $app --cli workbench tasks --module=warehouse
$params = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"kind":"orders","query":{"month":"2026-10"}}')).TrimEnd('=').Replace('+','-').Replace('/','_')
& $app --cli workbench query --module=purchase "--params-base64=$params"
```

`workbench query` 参数支持 `kind`、记录 `id`、查询条件 `query`，或业务清单已登记的 `/api/...` 只读 `path`。模块标识为 warehouse、purchase、sales、overview、exporter。`workbench tasks` 只查询 warehouse 当前任务或 exporter 历史任务；导出台可传 `{"id":"任务ID"}`。

整理草稿使用 `workbench prepare --module=purchase|sales|overview --params-base64=... --confirm-side-effect`。参数沿用原 `kind:transfer|edit`、`source`、`decisions`、`revision`、`edit` 业务契约。确认参数只授权整理草稿，不能提交、确认、撤销正式账目。数据金额、锁定月份、修订版本和必填项仍由所属业务服务核对。

JSON 参数限制 64 KiB。`--params-json` 支持直接传对象，但 PowerShell 等环境容易改变引号，脚本优先使用 base64url。CLI 始终输出 JSON，失败沿用稳定错误码与非零退出码。未接入的能力明确报错，不隐式安装或创建空账本。

## MCP

在智能体客户端配置 stdio：

```json
{
  "command": "C:\\Users\\你的用户名\\AppData\\Local\\Programs\\wucheng-ecommerce-erp-v2\\云仓库存同步.exe",
  "args": ["--mcp-stdio"]
}
```

新增工具：`workbench_status`、`workbench_capabilities`、`workbench_modules`、`workbench_query`、`workbench_tasks`、`workbench_prepare`。先调用 capabilities，再按返回能力查询。query/tasks/prepare 使用 `module` 和 `params` 对象；prepare 还要求本次 `confirmSideEffect:true`。

MCP 会话只启动一个常驻 Node 模式协议代理，使用官方 SDK；所有请求经继承的私有 IPC 通道回到同一个工作台进程和同一连接适配器处理。不会因每次工具调用重新启动 Electron CLI，也不另开网络端口。旧云仓实际采集/登录命令仍可按原协议调用所属云仓进程。关闭 MCP 会话同时结束其代理，不停止独立业务后台。

旧 `inventory_*`、`cainiao_refresh_login`、`--cli status|capabilities|extension-call` 入口保留。查询不执行采集；登录和真实发送沿用原本次确认边界。历史订单正式导入必须由同一用户在页面完成两次核对，CLI/MCP 不提供绕过参数。接口不提供任意命令、SQL、磁盘路径或凭据读取。

## 验收

- `tests/workbench-dispatcher.test.mjs`：参数边界、旧命令兼容、草稿确认、路径白名单、实际本机 HTTP actor 签名与确认接口拒绝。
- `tests/workbench-mcp-persistent-native.mjs`：真实 Electron 和官方 MCP 客户端连续调用，核对调度 PID 与代理 PID稳定，旧工具兼容、缺少草稿确认被拒绝。业务响应全为隔离合成数据，不访问真实账号、账本或登录状态。
- `tests/service-manager-startup.test.mjs`：生命周期去重后源码及复制到独立 workspace 的扩展依赖完整，原启动锁、忙碌检查和数据目录保护继续生效。
