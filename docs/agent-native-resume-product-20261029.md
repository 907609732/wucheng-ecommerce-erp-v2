# 2026-10-29 策划续接契约

本文件是恢复开发时的源码核对与 UX/UI 交接，不是验收报告。核对起点为集成提交 `01b40a9`，继续沿用“完成实现后集中测试”。原目标、五个领域账本、现有金额与审计规则不重做。本轮未运行测试、未操作正式账本。

## 结果更正与版本

必须支持用户核对并更正准备结果，但不能把通用表格变成绕过领域服务的数据库编辑器。

| 结果类型 | 可更正内容 | 必须保留只读的内容 |
| --- | --- | --- |
| 采购表格/OCR 导入草稿 | 字段映射、订单候选的业务字段、真实冲突决定，均以对应能力 Schema 为准 | 原件字节、来源行/页、SHA、识别原文、既有审计 |
| 采购订单/供应商/地址准备结果 | 已有 create/update/save 能力允许的字段 | ID、updatedAt、账本修订、已锁月、权限和回执 |
| 销售导入/归属/手工流水草稿 | 原件映射、真实店铺、日期、允许的金额/币种/分类、依据和说明 | 官方流水原文、原件覆盖范围、派生净额/利润、业务签名 |
| 运费准备结果 | 有原件依据的费用分类、赔付抵扣说明、归属和同源更新选择 | 官方原件、锁月、既有版本/附件历史；不得用编辑伪造缺失账单 |
| 经营总览费用/付款登记草稿 | 已有领域写能力允许的费用、付款登记及分类参数 | 采购/销售来源值、派生合计、来源摘要、银行实际付款动作 |
| 纯查询、历史版本、已提交结果、备份和审计 | 通过目标提出新任务或更正请求 | 直接修改查询值、历史版本或已经确认的回执 |

更正项必须带 `resultId + resultVersion + blockId + rowKey + field + before + after`。行使用稳定键，不能使用排序后可变化的行号。适配器只为允许更正的草稿字段声明元数据，未声明默认只读。金额沿用领域整数分或十进制元字符串，不使用前端浮点换算作为入账输入。

“保存更正”只提交更正要求，先显示“更正已提交，正在重新核对”。服务端核对人员、任务、当前结果版本与旧值，重新走原 prepare/校验/计算，保存新结果版本，作废原审批。用户必须对新版本重新确认。发生并发变化时显示最新版本差异，不能悄悄覆盖。若暂通过 `tasks.input` 承接结构化更正，也必须持久化版本绑定并重新 prepare；仅修改 DOM 或复用旧 commitData 不算完成。

界面把草稿单元格的更正模式、保存/放弃更正控制放在结果表局部，不恢复首页的一串业务步骤按钮。

## 原件预览

预览只接受同一任务已登记的中央 `artifactId`，经当前人员授权、文件大小、摘要和真实 MIME 校验后读取。不能把模块 fileId、URL、主机路径变成预览地址。允许内嵌 PNG/JPEG/WebP 和 PDF；SVG、HTML、脚本及其他文件只提供受控下载。

预览区必须显示文件原名、类型/大小、SHA、来源/归属范围；图片提供缩放，PDF 提供页码/分页、缩放与下载。预览失败保留下载与错误说明，不把失败显示为空白凭证。离开结果页时释放临时 URL。正式版与 Beta 的文件边界继续由主机控制。需凭据或外部登录的页面由原接管机制处理。

## 结构化图表

统一 `chart` 结果块提供稳定 `id/title`、图形类型（首批 line/bar）、横轴维度、序列名称及值、单位/币种、来源证据引用、期间/时区及完整性。与本次 UX 交接统一采用 `dimension/series/rows`，以便同一数据直接生成可访问明细表；不得让模型直接提供任意 ECharts option/JavaScript/HTML。

```json
{
  "type": "chart", "id": "monthly-expense", "title": "月度费用",
  "chartType": "bar", "dimension": {"key": "month", "label": "月份"},
  "series": [{"key": "expense", "label": "费用", "unit": "fen", "currency": "CNY"}],
  "rows": [{"month": "2026-08", "expense": 12000}, {"month": "2026-09", "expense": null}],
  "sourceRefs": ["evidence-1"], "scope": {"timezone": "Asia/Shanghai"},
  "completeness": {"state": "partial", "message": "9月费用尚未取得"}
}
```

渲染器从声明式数据构造受控图表；悬浮显示原始精度、单位及期间，始终有等价明细表。`null` 留空并标缺失，不能补 0；多币种分别展示，不相加；不将资金参考差额标为利润。不完整数据显示“部分数据”。宽屏结果区展开，390px 时图表和数据表保持可访问，不挤压目标输入框。已有仓库依赖 ECharts，可复用而不引入另一套图表库。

## 菜鸟运费唯一执行路径

“导入云仓/菜鸟运费”以销售台作为正式运费记录的唯一领域 owner，优先复用 `sales.cainiao-download-* → sales.cainiao-preview → sales.cainiao-posting`。先查任务/原件与范围，存在同源可复用结果时不另起下载。

从经营总览已有归档继续时：总览受控下载 → 中央登记 artifact → 同任务受控附件/交接引用 → 销售暂存并校验 SHA/原件与账期 → 销售原件分析/准备 → 统一结果复核 → 销售入账/回读 → 总览读取销售来源。跨模块引用应保存来源模块、原件摘要、原 jobId/账期/截止日与交接关系。禁止把 `overview.fileId` 当作 `sales.fileId`；禁止重新造 Excel；禁止同一原件同时写总览独立运费账与销售账形成双计。

销售当前专用入账能力只接受自己的 jobId；总览原件交接还需要一个接受已校验原件集合/来源描述的销售准备入口或可信导入桥。这是实际缺口，不能仅改变提示词就标完成。若原件不足以复用销售的同源校验，应返回明确缺口，并保留原件，不自动重新采集或猜覆盖范围。

## 待开通平台

商家寄件、顺丰自动采集继续 `available:false` / “待开通”。可以展示平台名称、说明与未来技能占位；不出现可成功执行的“开始导入”。既有手工原件处理/历史记录不等于该平台已支持后台自动采集。菜鸟使用已有 skill 与真实采集能力。运费快捷入口保持一个“导入运费”，选择平台后显示可用技能或待开通状态。

## 语义能力覆盖矩阵

以下是一组用户目的与真实能力对应关系，**不是 571 个旧 manifest 路径的功能数，也不是全部通过证明**。静态资源、页面路由和内部传输不计为独立业务能力。最终仍须对每条旧真实业务动作在 coverage 门禁中做 route/UI/CLI/MCP 对照，不能批量改 verified。

| 用户目的 | 当前能力/承接 | 真正剩余缺口或验收边界 |
| --- | --- | --- |
| 查询库存、销量、日结和来源 | warehouse inventory/sales/daily/sources | 真实平台范围、中央结果与完整性验收 |
| 采集并更新库存/月销量 | warehouse inventory.collect/import、sales.collect/import/backfill | 下载/校验/人审/入库全链与中断恢复 |
| 发送日结/月报、提醒员工 | warehouse inventory.send/sales.send、employees.remind | 真实供应商受理回执与未知结果恢复 |
| 本人签到、完成当日工作 | warehouse attendance.check-in/complete | 普通员工真实身份例外路径验收 |
| 维护云仓员工、备份、旧定时计划 | warehouse employees.configure/backup/schedules.legacy | 全局人员映射、迁入来源、30秒受控更新 |
| 查询平台订单/快照/日志 | exporter state/task/orders/snapshot/logs | 各平台真实分页/退款/详情完整性 |
| 启停恢复采集、补详情 | exporter start/pause/resume/retry/finish/enrichDetails | 登录/验证码接管与真实平台恢复 |
| 导出订单并转采购 | exporter export/transfer、purchase transfers/transfer.* | 不可把 transfer 当完成入账，真实原件交接验收 |
| 查看采购、来源、供应商和地址 | purchase orders/dashboard/sources/audit/suppliers/addresses/attachments | 文件预览、实际角色隔离 |
| 表格采购导入和字段映射 | purchase files.stage/import.analyze/remap/commit | 草稿更正 UI、新版本与统一复核 |
| OCR 录入采购 | purchase ocr.start/status/commit | 真正取消底层 worker、真实 OCR 与更正链 |
| 采购修改退款分类、供应商地址 | purchase order.create/update、orders.attributes/classification、supplier.save/address.* | 领域人员归属映射和完整目标验收 |
| 采购月度任务/月结/回滚 | purchase task.action/mark、month.confirm/cancel、audit.rollback | 月度验收与系统任务分派分别验证 |
| 查询销售运营、流水与资金核对 | sales report/reconciliation/ledger、taobao/pdd funds/statement/movements | 金额口径、完整分页、真实原件与权限 |
| 导入官方账单、字段映射、确认归属 | sales files.stage/file-inspect、taobao-import/pdd-import/import、batch-attribution | 真实文件、冲突、锁月、重复与原位更正 |
| 手工渠道、应收收款、匹配与费用 | sales manual-summary、ledger-create/update/delete、match-create/delete | 原币和权限、历史订单关联、正式回执 |
| 运费汇总、原件、导出 | sales freight-report/records/record/attachment/export | 真实文件与共享结果预览 |
| 自动采集并登记菜鸟运费 | sales cainiao-* | 总览归档原件交接桥、真实平台与截止范围 |
| 商家寄件/顺丰自动采集 | sales.skill 返回不支持 | 本轮继续待开通，不计已实现 |
| 月报、交接、锁月、参考汇率 | sales job-create、staff-handoff、month-lock/unlock、rates-refresh | 真实资料缺口、员工/老板隔离和来源变更 |
| 经营总览分析和追溯来源 | overview report/dashboard/details/sources/audit/coverage | 结构化图表、跨来源修订与差额口径 |
| 工资/其他费用/付款登记 | overview bill-create/update/void、payment-create/void | 真实财务复核；不新增银行转账 |
| 月报快照、模板、导出、备份 | overview snapshot-create/template/export/backup/restore-copy | 真实产物与恢复副本验收 |
| 找员工、分派 Agent 任务 | system people.assignable/tasks.assign | 主机可信目录接线、重名问答、领域人员映射 |
| 公司模型、引擎、人员权限、私网 | settings/permissions/connection + 主机 | 公司真实 API 尚未输入，员工设备未验收 |
| 附件、结果、审批、历史和恢复 | attachments/artifacts/tasks/review | 草稿编辑版本、预览/图表、异步 job 阻塞消解 |
| 新定时任务及旧计划接管 | schedules + importSchedules | 旧创建者未知来源字段、30秒更新、漏跑重叠 |
| 完整备份、测试账本与独立包体 | host backups + agent-beta 工具 | 副本激活、完整程序资源、Setup 生命周期、版本定位 |

界面资源、收起平台页/日志开关、系统目录选择、代理证书、软件更新及服务管理有各自维护边界；它们可以被明确保留为本机维护入口或交付工具，不能伪称 Agent 已执行业务。历史旧独立库不在本轮合并范围。

UX 后续应根据以上契约给出更正/失效、预览失败、图表缺数和待开通平台的状态与键盘流程；UI 在这次交接后实现。总控协调主机、运行时和领域组的服务端约束，最后冻结源码集中验收。
