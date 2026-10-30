# 导出台 Agent 能力覆盖

工厂：`src/main/agent-adapter.mjs#createExporterAgentAdapter({transport})`。
transport(moduleId,route,{method,body,ctx,signal,approval,idempotencyKey})；模块ID exporter。

|界面/原接口|Agent capability|规则及证据|验证|
|---|---|---|---|
|平台/任务总览 workbench/state|state|真实账本UUID/revision，脱敏任务|workbench.test.ts|
|任务详情/orders/snapshot|task/orders/snapshot|原始任务ID及实际订单，不返回cookie/cursor|workbench.test.ts、order-transfer.test.ts|
|执行日志|logs|原executionLogs处理器|workbench.test.ts|
|日期/计划采集|start|平台、日期校验；现有Store及collector执行|extraction-plan.test.ts、workbench.test.ts|
|暂停/恢复/重试/结束|pause/resume/retry/finish|调用现有执行器，结束仍为partial，不能宣称完整|execution-log.test.ts、workbench.test.ts|
|详情补充|enrichDetails|调用原平台详情规则，已有结果保留|platform-detail.test.ts|
|登录/订单网页|host-action|打开真实主机页，返回waiting-host-action；登录验证码人工|platform-login.test.ts|
|CSV/XLSX/图片导出|export|原exportFile，隔离结果目录和用户所有权下载ID|exporter.test.ts、workbench.test.ts|
|发送采购核对|transfer|现有transfer处理器，不能直接完成采购入账|workbench.test.ts、order-transfer.test.ts|
|清理记录|clear|中央管理员签名审批、busy拒绝；保留已导出文件|workbench.test.ts|
|代理采集启停|proxyStart/proxyStop|管理员中央审批；原proxy处理器|原proxy相关用例；真实平台需人工验收|
|收起平台页/日志开关|hidePage/setLogging/setExecutionLogVisible|中央审批后原处理器|类型检查|

宿主本地专属操作继续保留原入口：选目录、打开输出/日志/导出文件、打开系统代理设置/证书、更新安装、官网仓库。不能把这些路径/系统授权动作交给模型自动执行。OCR属于采购台而非导出台。

审批：prepare服务端保存并返回commitData引用；commit对照服务端结果、真实签名actor及中央proof校验task/result/version/dataset/revision/digest。receipt先预留processing，未知结果禁止重复调用；完成后持久化结果。失败或进程崩溃后的processing需人工核实，不宣称已恢复自动执行。

目前合成隔离账本测试不代表外部平台登录/反爬/验证码验收。未进行正式数据操作或平台真实采集。

## 自动阶段协议

start/pause/resume/retry/finish/enrichDetails/host-action/export/hidePage 登记为 prepare、requiresReview=false。模块真实执行现有处理器后返回 summary/blocks/evidence/requiresReview:false，不返回 changes 或 commitData。运行时必须为调用持久化 ctx.idempotencyKey；模块缺键拒绝，重复键回读原结果，内容不同拒绝。响应丢失且结果未知仅返回顶层 processing/ok:false，不能视作完成。transfer/clear/代理与设置变更仍须中央人审。host-action 仅打开人工操作页面，不能代替登录验证码授权。

## 输入及结果契约

`agent-adapter.mjs` 导出每项封闭 JSON Schema 与中文能力语义；模块服务端使用同源校验。平台枚举、日期与起止关系、原提取计划校验、任务/订单/文件ID、导出格式、开关、分页均拒绝额外字段和错误类型。orders/logs 支持 offset/limit（默认100，最多500），返回 total/nextOffset；orders 明示 moneyUnit=fen 与 dateBasis=order-created-at。file 查询使用导出结果中的 fileId，仅本人或管理员可读取元信息；本机路径、cookie、游标及凭据不返回 Agent。


## 2026-10-29增量（待统一验收）

下载请求统一使用主机默认64MiB预算，修复旧512MiB请求在小文件上同样遭ARTIFACT_LIMIT_INVALID的问题。导出/file元信息返回真实bytes；超限明确提示按平台/日期拆分或关闭图片，保留领域原件，不放宽主机预算。job状态区块、issue、evidence统一module=exporter与真实jobId，完成证据仍需status completed＋listOutcome complete＋计划完整。新增用例未执行，不复用旧测试结论。完整旧入口对应见采购docs/agent-native/CAPABILITY-MATRIX-20261029.md。


最新访问决策：所有已签名认证员工同等读写全部业务，Agent/workbench的viewer、admin和canRunTasks不再用于访问授权；导出原文件可供其他真实登录成员读取，中央任务artifact仍受任务原件绑定。旧签名格式、实际actor审计、UI确认通道、人审proof、版本及幂等保留。未新增权限管理接口。新增访问语义用例尚未运行。
