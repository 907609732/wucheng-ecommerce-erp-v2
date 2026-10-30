# 归档交接、费用图表与新草稿编辑

本次仅补经营总览代码；按本轮要求，未运行测试、语法执行、浏览器或真实数据检查。新增回归用例位于 `tests/agent-handoff-analysis.test.mjs`，待集成阶段执行。

## 只读归档清单

公开查询 `overview.cainiao-handoff` 接受 `{jobId,month}` 或 `{id,month}`，两种编号不能同时传入。查询从现有 CainiaoDownloads 的持久 job/items/files 读取，不启动下载，不创建销售记录。

输出字段：

- `version:1,module:'overview',jobId,month,account,accountKey,basis:'业务时间'`。
- `ready,complete,from,cutoff,issues`：只有已确认交易/费用原件、账户、范围和页面核对金额一致时才可交接。未知范围保留 null；旧任务不按月份猜整月，原当前月任务不得将未来截止日当作证据。
- `files[]`：`fileId,role,postingRelevant,filename,sha256,bytes,account,from,cutoff,rangeVerified,rangeEvidence,expected:{count,amountCents},verification,sourceRef`。角色为 transactions/fees/warehouse，仓储货品信息只是补充，不重复作为费用合计。
- `binding:{dataSetId,revision}`：由经营总览真实 routes 绑定逻辑提供，含本地及采购、销售来源修订。
- `sourceRefs[]` 是 evidence 稳定 ID；`evidence/handoffEvidence[]` 提供对应源引用。适配器会恢复服务封装中同名 evidence 的展示字段。

每个 `sourceRef` 含稳定 `id`、`module:'overview'`、`capabilityId:'overview.cainiao-file'`、`input:{id:fileId}`、`sha256`、`filename`。其 `metadata` 包含 `purpose:'cainiao-freight-handoff',jobId,month,role,account,from,cutoff`，供主机将用途带入中央 artifact。调用者通过既有 cainiao-file 下载和中央任务产物解析能力核对实际哈希、文件名，再重新 stage 到销售模块；这里不产生销售 ID，也不替代销售台自己的默认采集流程。明确复用本模块归档时仍须具备两个模块的人员权限。

阻断条件包括：所选月不在任务、缺交易/费用、原件或页面依据缺失、未核实状态、多份报表关系不明、账户/月份/角色错误、路径或字节摘要改变、重新解析不一致、范围缺失/冲突，以及交易与费用核对金额不同。原件查询会重新 inspectBill/reconcile，不仅信任历史成功标志。

## 真实费用趋势

`overview.dashboard` 的适配器结果追加两个 chart blocks：已录支出趋势、已录收支参考差额（非利润）。包含 `type,id,chartType,dimension,series,unit:'分',currency:'CNY',rows,sourceRefs,completeness,scope`。sourceRefs 对应 chartEvidence 中真实 dashboard 修订与来源版本的稳定 evidence ID。

退款、平台费用、采购实付、运费实付、人力实付和其他实付沿用真实账本趋势。缺失数值保留 null；参考差额只有当收入及全部支出序列均有数值时才计算，不将部分金额或未知项当零，不称为利润。来源不可用时保留空数据状态。

## 新单据草稿编辑

仅 `overview.bill-create`、`overview.payment-create` 声明 `resultEditFields`，字段使用实际行字段名。新准备草稿 block 有固定 `id`、`rowKey:'key'`、稳定 `rows[].key:'draft'` 和 `editableFields`，后者是对应能力白名单的子集。历史统计、账单更新、作废和原件解析结果没有可编辑白名单。

编辑只用于修改当前任务输入并重新 prepare；领域校验、版本/来源绑定和中央审批仍然必须重新经过，不直接写入账本。
