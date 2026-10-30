# 销售／总览续接代码清单

本轮先完成代码，测试、真实浏览器、真实平台、实际安装包与正式迁移均留待总控冻结后集中执行。历史证据表只描述当时版本，不作为本轮通过证据。

## 目标到能力与结果

| 用户目标 | 实际能力和结果 | 明确边界 |
|---|---|---|
| 按店铺逐项处理本月资料 | `sales.shops`、`sales.task-center`、资料覆盖与版本、`sales.staff-handoff` | 交接前确认本人领域身份；不代表资金已核对或自动锁月 |
| 核对历史人员归属 | `sales.personnel-state` → 本人明确选择候选 ID／newPersonId → 中央复核 `sales.personnel-link` | 重名或旧匿名记录不推断姓名，不改历史 submitted_by；不授予账号权限 |
| 导入淘宝、拼多多或其他已支持原件 | `sales.files.stage` → `file-inspect`／格式校验 → 对应 import → 人审与回执 | 原件 ID 同人员同任务，50MiB 传输；运费附件仍保留每个25MiB、总50MiB业务限制 |
| 结算与实际到账核对 | 两平台 statement／funds／movement、`reconciliation`、match、月锁 | 原币、定点金额、旧版本及重复约束不变；不真实转账 |
| 新采集云仓运费 | 销售现有 cainiao-download → 持久 job 查询 → cainiao-preview → cainiao-posting 人审 | 默认销售流程，不额外启动总览采集；后台未完成、登录或范围缺失不能显示完成 |
| 明确复用总览归档运费 | `overview.cainiao-handoff` → 必需交易／费用原件 `overview.cainiao-file` 登记本任务中央 artifact → `sales.cainiao-archive-stage` → `cainiao-archive-preview` → `cainiao-archive-posting` | 无新采集；不把总览 fileId 当销售 fileId；缺真实来源 stamp、范围、页金额行数核验均阻断 |
| 登记／更正单店费用、手工销售或运费 | ledger／freight create/update 的元金额草稿 → 用户更正 → 新 prepare／审批 | 明细预演仍为整数分只读；更正不能直接落账或复用旧审批 |
| 看经营／运费趋势 | 销售 report／freight-report 与总览 dashboard 的声明式 chart + 明细 + evidence | 缺数为 null，运费完整度只表示已登记；参考差额不标利润 |
| 公司费用、工资、付款登记 | 总览 bill/payment、来源分类、覆盖、快照与报告 | 收款人姓名是业务标签，不自动变为登录账号；不发起银行转账 |
| 保留原件并备份恢复 | 一致性备份包括正式原件、已完成销售采集归档、中央重新暂存源文件与不可变交接 sidecar；恢复为独立副本 | 不覆盖正式库；不包含浏览器授权或私钥；尚待统一恢复验收 |
| 商家寄件／顺丰自动采集 | 继续明确 `available:false`／待开通 | 手工运费渠道可登记不等于自动采集已开通 |

## 可信交接接口

模型输入仅 `{sourceJobId,month,artifactIds}`。适配器从总览现有任务获取已校验清单，用 `await ctx.resolveTaskArtifact(id)` 获取同任务、当前人员拥有且由运行时标记 `sourceModule:'overview'`、`sourceCapabilityId:'overview.cainiao-file'` 的私有文件描述；旧无来源产物拒绝。文件名、大小、SHA 必须唯一对应清单中参与入账的原件。仅复用已有 `stageTaskAttachment` 分片协议，代码读取字节，销售重新生成本模块原件 ID。

内部 adopt 不公开给模型；持久 `agent_cainiao_handoffs` 绑定人员、任务、源任务、清单摘要、中央 artifact ID 与销售 file ID。scope.expected 为总览真实查询依据，不由模型填写。分类重新读取销售原件，校验字段、业务日期、币种、金额精度、费用类别与净额；人审提交前重新核对总览清单摘要、销售文件 SHA、记录版本和月锁。来源变化必须重新交接／准备。

同源同分类同截止日拒绝重复记账；未结月只在旧不可变来源链及原附件 SHA 可回读时更新原记录，保留 ID、递增版本及旧附件。与原销售自有采集记录发生重叠但无法证实来源时阻断，不猜测覆盖或双计。

后台证据使用同一 module+jobId、明确 complete 与真实原件 SHA。图表 sourceRefs 对应本结果 evidence 的稳定 id。准备草稿的 resultEditFields、editableFields、稳定 block.id／rowKey 只用于用户提出新更正要求，真正写入仍须新结果复核。

## 本轮未完成的验收边界

- 新增人员映射、跨域交接、备份保留、图表及可修改草稿的测试文件已写，尚未集中运行。
- 中央真实 UI 的人员选择／更正、新结果审批、图表来源验证、中央产物下载与恢复需总控联调。
- 真实菜鸟登录、页面变化、当月范围及官方文件仍须实际账号验收。
- 预览包、正式数据最终迁移与切换均未执行；本轮没有触碰正式业务数据。
