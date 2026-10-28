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
