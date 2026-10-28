# Agent 原生重构契约 v1

状态：2026-10-28 用户已授权实施。测试版须等全部现有模块通过后交付。

## 隔离与交付

基线：`codex/pre-agent-baseline-20261028`；集成：`codex/agent-native-rebuild`。各组独立工作树与子分支；不得修改原始 main 工作目录、正式账本、个人 AI 配置。基线只含源码、可公开资源、依赖锁及合成测试，不含正式数据、附件、账户发现结果、登录态或密钥。

测试版必须独立身份、配置、端口、更新通道及账本副本，持续显示“测试账本”。正式切换另待用户验收。迁移只从当前 registry 指向的正式账本读取，不自动收集旧独立数据库。

## 模块适配器

每模块导出 `create…AgentAdapter(deps)`，不自行接大模型或制作聊天 UI。

```js
{
  id,
  capabilities: [{id, title, kind: 'query' /* 或 prepare */, description, inputSchema, requiresReview}],
  binding(ctx), // => {dataSetId, revision} 从真实业务服务读取
  query(capabilityId, input, ctx),
  prepare(capabilityId, input, ctx), // => {summary,scope,blocks,evidence,changes,issues,commitData}
  commit(prepared, ctx), // => {receipt,blocks?}
  receipt(idempotencyKey, ctx)
}
```

`ctx={actor,taskId,signal,emit,approval?,idempotencyKey}` 仅由可信主机提供。模型输入不得提供身份、审批凭据或 `confirmed`。`commitData` 仅保存在服务端，不发送模型或 UI。准备、审批与提交均重新核对数据集和修订；未知结果先核查回执。原有金额、去重、月锁、人员范围和审计规则继续生效。每项 capability 必须对应真实现有能力与验收证据，未开通平台明确标记。

正式业务 HTTP 接口通过 `desktop/agent-runtime/approval.mjs` 的签名证明升级。证明绑定人员、任务、结果版本、数据集、修订、差异摘要、幂等键和有效期。模块用自己的 `.workbench-key` 验证，并与真实签名 actor 对照。不得伪造旧 UI channel、review cookie 或将模型传入的 `confirmed=true` 当作人审。

## 运行时与界面

运行时入口：`createAgentRuntime({storeDir,adapters,engines,resolveActor,secretStore,environment})`；调用 `request(op,payload,{actor,trustedUi})`。真实身份由主机/gateway 解析，不能由 renderer 提供。MCP 永远没有 `trustedUi`。

接口包括 status、tasks.list/create/get/input/control、review.approve/reject、schedules CRUD、settings.get/save、permissions.get/save、attachments。细节由运行时契约文件与测试固定，前端集中在 agent-api 映射。

状态包含 actor、environment、engines、capabilities。任务详情包含 events、result（id/version/summary/scope/blocks/evidence/changes/issues/receipt）、review（id/resultVersion/revision/canApprove）。秘密仅写入安全存储，读取只返回是否配置；不回显 API key。持久化任务状态与业务回执决定是否完成，不采信模型文字“完成”。

Codex 使用官方 App Server，Hermes 使用官方 ACP SDK。公司专属配置与个人 AI 配置分离。ERP 控制业务能力、权限、预算、证据、复核与恢复。定时任务携带创建者、时区、漏跑及重叠策略，需审批时进入待处理队列。

## 责任目录

| 组 | 范围 |
|---|---|
| 总控 | 公共契约、能力覆盖整合、main/preload/gateway 接线、集成审查 |
| 运行时 | desktop/agent-runtime、tests/agent-runtime* |
| UX/UI | desktop/launcher/agent-*、tests/agent-workspace* |
| 云仓 | core 云仓领域、desktop/workbench/warehouse-agent*、对应测试 |
| 采购及导出 | apps/purchase、apps/exporter、对应适配器和测试 |
| 销售及总览 | apps/sales、apps/overview、对应适配器和测试 |
| 测试打包迁移 | 独立 Beta 配置、迁移副本工具、跨模块验收、能力缺口与打包门禁 |

所有 Loading 复用现有 shared/loading-screen 进度条。业务结果保留表格、原件、差异及下载；用户无需跳回旧页逐步操作。正式入账、对外发送、权限变更等由真实授权人员在具体结果页确认。
