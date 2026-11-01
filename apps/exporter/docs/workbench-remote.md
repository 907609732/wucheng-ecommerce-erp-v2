# 历史订单导出台：工作台远程接入

保留原 Electron 独立入口、`买家订单导出台` 用户目录、`persist:orderdesk-<platform>` 登录分区和全部原业务功能。新增的客户端页面不接收 Cookie、DPAPI、登录分区或服务器绝对文件路径。

## 路由与身份

页面入口为 `/apps/exporter/`；客户端业务 API 为 `/api/workbench/v1/modules/exporter/`。网关将白名单操作转发至本机 `/api/integration/v1/workbench/`，同时验证原本机 Bearer 和每模块 `.workbench-key` 的请求签名。签名绑定操作人、模块、路径、方法、会话、渠道、请求 ID 及短时有效期。客户端不能自行提交 Tailscale 身份头。

| 原能力 | 远程接口 | 约束 |
|---|---|---|
| 平台、任务和状态 | `GET state`、`tasks/:id` | 移除本机路径、Cookie 名、游标、详情导出凭据 |
| 订单与原始结果 | `GET tasks/:id/orders`、`snapshot` | 保留字符串订单号、整数分及缺项状态 |
| 开始／暂停／继续／重试／结束／详情提取 | `POST tasks`、`tasks/:id/<动作>` | 管理员或明确获授权的编辑成员；全部在服务器执行 |
| 登录／验证码／主机查看订单 | `POST host-action` | 返回 `waiting-host-action`，只打开主服务器页面 |
| 执行日志 | `GET logs/:platform` | 复用现有安全日志内容 |
| Excel／CSV 导出 | `POST tasks/:id/export`、`GET files/:id` | 受控文件 ID，流式下载，限制所属操作人 |
| 导入采购 | `POST tasks/:id/transfer` | 需要采购模块权限，委派真实操作人；返回 batchId 和采购核对路由 |
| 清理任务缓存 | `POST platforms/:platform/clear` | 管理员页面明确确认、检查修订和忙碌状态 |
| 请求结果 | `GET requests/:id` | 只读取本人请求，断线重试不会再次执行原操作 |

输出目录选择、打开本机文件夹、日志设置、系统代理、证书安装、更新安装及登录分区仍由主服务器原独立界面管理。安装、更新和停止进程不能通过业务网关调用。

## 迁移

内部协调器使用 `/api/integration/v1/workbench/migration/` 的 export、files、preview、maintenance、backup、commit 和 verify 接口；这些接口不列入普通业务白名单。所有请求必须同时具备本机 Bearer、管理员 UI 委派身份；提交还必须处于持久维护窗口，并验证根协调器在两次核对后签发的短期 HMAC 凭据。

维护请求必须携带 `migrationId`。维护标记保存初始操作人和所属批次；其他批次不能抢占、解除或使用该窗口提交。管理员可在新会话中恢复同一批次，初始操作人保留为来源证据。提交计划中的 `migrationId` 也包含在签名摘要内，原件准备结束后再次检查窗口和凭据。客户端旧账本封存使用 `local-migration:<clientId>` 与 `source-archive-<clientId>`，重试保持该归属，封存后禁止本地业务写入。

原件先进入 `<dataDir>/workbench-migration-staging/<stagingId>`，校验摘要、大小后进入正式原件目录。迁入的任务使用新 ID，保存来源映射和审计，以历史证据形式保留；不能直接恢复旧机器的采集进程。写入后逐项校验，失败整批回滚。在线 SQLite 备份必须停止所属服务后才能恢复，禁止覆盖正在打开的数据库。

## 已验证范围

`npm.cmd run test` 覆盖隔离数据、权限、请求重试、账号敏感字段脱敏、长订单号文件导出、迁移修订检查、两次确认凭据与事务回滚。`node tests/workbench-remote-ui-smoke.mjs` 使用本机 Chrome 和合成 HTTP 服务检查页面、人工处理提示及断线后复用同一幂等标识。

这些测试不代表真实平台采集无漏单；真实账号、验证码、跨电脑 Tailscale、安装器及最终迁移均需单独记录验收。
