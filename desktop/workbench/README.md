# 工作台网关 v1

网关仅监听 `127.0.0.1:17330`，交给 Tailscale Serve 的 HTTPS `8443` 转发；采购手机入口 `443` 不受此服务管理。服务不会自行配置 Tailscale、增加成员、安装模块或修改业务账本。

## 本机设置

`server.mjs --configure true --origin https://设备名.私网名.ts.net:8443 --policy 策略文件 --store-dir 独立网关目录` 仅保存本机设置。配置文件和成员文件由主机管理员维护。无成员、禁用成员及无对应模块权限一律拒绝。

```json
{
  "schemaVersion": 1,
  "users": {
    "person@example.com": {
      "role": "editor",
      "modules": ["warehouse", "purchase", "sales", "overview", "exporter"],
      "canRunTasks": false,
      "enabled": true
    }
  }
}
```

`identity.json` 是此主机和账本集合的稳定标识。`gateway.sqlite` 仅保存网关会话、操作回执与审计；不能把它当业务账本迁移。不得重新生成身份文件来绕过客户端的账本身份核对。

`gateway-ownership.sqlite` 使用 SQLite 的独占进程锁，阻止两个网关同时处理相同目录；进程退出后由操作系统释放。另一个仍在运行的网关存在时，不能清理其上传暂存或将其写入任务标为中断。

## API

- `GET /api/workbench/v1/health`：协议及主机/账本集合身份，用于本机监听器核对。
- `GET /api/workbench/v1/session`：经 Serve 验证的人员建立会话，返回 `actor`、`sessionId`、`csrfToken`、身份及可用模块。Cookie 为 Secure、HttpOnly、SameSite=Strict。
- `GET /api/workbench/v1/modules`：仅返回已授权模块的版本、状态和数据修订号，不返回磁盘路径、PID 或密钥。
- `GET /api/workbench/v1/modules/:id/connection`：启动或复用已安装的授权模块，核对实际运行协议及账本身份，返回安全的连接元数据。不能借此安装模块。
- `GET /api/workbench/v1/capabilities`：已授权模块的操作覆盖清单。
- `/api/workbench/v1/modules/:id/*`：清单允许的业务 API；`/apps/:id/`：模块页面；`/apps/:id/api/*`：界面业务请求，保留模块范围的核对会话 Cookie。
- `GET /api/workbench/v1/operations/:idempotencyKey?module=:id`：查询当前人员的操作回执，`unknown/pending` 明确需要核对，不冒充已完成。

每个修改请求都必须包含准确的 `Origin`、会话对应的 `X-Workbench-CSRF` 和 `Idempotency-Key`。CLI/MCP 的调用通道固定为 `cli/mcp`，不暴露切换参数；界面确认操作只接受 `ui` 会话，业务服务继续验证人员、会话、版本与两次核对记录。HTTP 通道标识不是人类点击的密码学证明。

会话首次连接每个模块时记录该正式账本的 UUID；此记录持久保存。之后每次连接、页面资源或业务调用都重新检查，发现账本更换返回 `409 DATASET_CHANGED`，不自动重置，也不向新账本转发。账本身份尚未就绪返回 `503 MODULE_DATA_NOT_READY`。公司级账本集合身份和各模块账本身份分别保存，新增一个模块不会更换公司级身份。

相同操作标识和内容重试返回原回执；内容变化返回冲突。发送后连接中断或进程退出时标记 `unknown`，阻止盲目重放；应查询业务批次/导入结果并核对。不能为了清除未知状态而删除网关操作记录。

二进制/多段上传按流写入私有临时文件并校验大小上限，完成后删除；文件下载按流转发。文件接口必须由模块登记并使用文件标识，不转发任意 SQL、数据库路径或目录参数。

## 内部服务协议

`ServiceManager` 负责服务身份、原数据路径、版本及已有进程核对。网关只启动已安装模块，不通过远程请求安装、升级、停止服务或恢复备份。未升级到 `workbench.protocolVersion:1` 的服务不能代理。

模块提供来自实际路由注册的 `workbench.operations`，或者本机 `workbench-manifest.json` / `GET /api/integration/v1/workbench/operations`。每项为 `{module,method,path,kind,remote,uiOnly?,operationId}`；缺项拒绝。页面资源也须逐项列出，不能建立无限静态通配代理。云仓和导出台使用各自已登记的内部前缀并兼容短业务路径。

网关至模块仍使用模块自己的 `.integration-key` Bearer；独立的 `.workbench-key` 仅用于 `actor.mjs` 规定的 HMAC 身份，两个密钥均不发给客户端。签名绑定人员、权限、调用通道、会话、请求标识、模块、方法和包含查询串的精确上游路径，有效期 30 秒。浏览器的代理身份、Tailscale/Cloudflare 身份、Authorization 及转发来源不透传，全部由网关重新生成可信头。

工厂 `await createWorkbenchGateway(options)` 返回 `{app,start,stop,serverId,dataSetId,...context}`。`registerRoutes(app,context)` 接入迁移等工作台功能；context 包含 `requireSession`、`requireAdmin`、`resolveActor`、`writeAudit`、`operationStore`、`storeDir` 和身份信息。新增修改路由必须使用相应认证钩子并实现自己的幂等与事务核对。

实现复用官方 [Fastify](https://fastify.dev/docs/latest/Reference/Server/)、[@fastify/reply-from](https://github.com/fastify/fastify-reply-from) 和 [@fastify/cookie](https://github.com/fastify/fastify-cookie)。Serve 的身份头及回环监听边界参照 [Tailscale 官方文档](https://tailscale.com/docs/features/tailscale-serve#identity-headers)。主机本地其他程序属于受信任管理边界；不能把网关改为监听局域网或公网地址。

## 验证

`node --test tests/workbench-gateway*.mjs` 使用独立临时目录和模拟后端，覆盖权限、CSRF、身份签名、前缀、确认通道、Cookie、上传下载、重复写入、审计和中断恢复。此测试不代表已通过真实 Tailscale 网络、真实平台采集、现有账本合并或另一台设备验收。
