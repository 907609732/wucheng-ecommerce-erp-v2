# 工作台网关

当前规则：已认证公司成员同权。角色分配、模块授权和任务权限配置已移除；旧 `--policy` 配置会明确拒绝，不再创建 `access-policy.json`。统一入口见[功能架构](../../docs/architecture.md)、[开发流程](../../docs/development.md)和[运维规则](../../docs/operations.md)。

网关只监听本机，通过 Tailscale Serve 提供 HTTPS。登录记录、会话 Cookie、CSRF、请求签名、原件归属、人工复核和防重复写入继续生效。`identity.json` 是稳定主机与账本集合标识，不能通过重建它绕过身份核对；历史策略副本仅作追溯，不参与授权。

`server.mjs --configure true --origin https://设备名.私网名.ts.net:8443 --store-dir 独立网关目录` 保存连接设置。预览版服务端使用固定隔离身份及端口，不能指向正式账本。

- `GET /api/workbench/v1/health` 核对主机及账本集合身份。
- `GET /api/workbench/v1/session` 经真实登录建立会话。
- `GET /api/workbench/v1/modules` 返回全部已登记模块的真实状态；缺失或启动失败不能显示可用。
- `GET /api/workbench/v1/modules/:id/connection` 启动或复用模块，核对运行协议与账本身份。
- `GET /api/workbench/v1/capabilities` 返回当前模块操作清单。
- `/api/workbench/v1/modules/:id/*` 和 `/apps/:id/api/*` 只转发清单允许的业务请求。
- 操作回执只反映实际结果；中断、未知或失败不得视为完成。

外部 MCP/CLI 保留。内置模型执行器、跨模块来源跳转和云仓签到/考勤已移除。日常修改从源码启动并运行相关验收，不需要构建安装包。
