# 能力与验证证据

下表使用短名，正式能力 ID 均加 `overview.`。所有 34 项的 JSON Schema 均由 `tests/agent-schema.test.mjs` 编译并检查；HTTP 服务对查询和准备阶段执行 AJV 校验。

| 能力 | 真实实现及验证 |
| --- | --- |
| report、dashboard、details | report/dashboard/selectRows 读取真实采购、销售及费用记录；agent-actions、core、dashboard 测试核对月份、年度、金额、下钻和分页 |
| bills、bill、payments、audit | 原账本领域读取与分页筛选；agent-actions 测试真实更正、付款、撤销、作废后历史保留 |
| sources | sourceRecords + overrides；agent-actions 测试源哈希、分类及覆盖变化；source-paths 测试来源变更 |
| snapshot | 读取真实 snapshots payload；agent-actions 测试创建后读回修订 |
| original | 来源 original 领域接口或 imports 保留原件；agent-actions 测试原始 CSV 字节完全一致；core/API 测试原件保留 |
| template、export、freight-export | 现有 ExcelJS 模板/报表/运费导出函数；agent-actions 检查实际 XLSX，core/dashboard/freight 测试导出金额和字段 |
| import-preview | readTable + previewTable；agent-actions、agent-http 测试 CSV 原件、映射、冲突、重复、文件 ID 任务归属 |
| backup-file | 受限文件名读取已生成 ZIP；agent-actions 测试实际备份和越界拒绝 |
| cainiao-status、cainiao-jobs、cainiao-job、cainiao-file | 真实 CainiaoDownloads 与 cainiao_files 归档；cainiao、cainiao-browser 测试任务、重启、归档、CRC、SHA256、账号/月边界；Agent HTTP 测试真实持久任务状态 |
| bill-create、bill-update、bill-void | 原 store 领域函数 + 准备回滚 + 提交后读回；agent-actions 测试金额、版本、付后限制；agent-http 测试中央证明、角色和回执 |
| payment-create、payment-void | 原付款流水领域函数；agent-actions/core 测试金额、付款历史、退款顺序、撤销审计；不转移实际资金 |
| source-classify | 来源哈希、CNY 分类、采购退款实际日期；agent-actions/core 测试更正与过期源拒绝 |
| import | 保留原件、真实创建/维护账单、读回行数和摘要；agent-http 测试 file-stage→预览→中央复核→987 分实账→持久回执 |
| coverage、snapshot-create | 月报修订与领域验证后写入；agent-actions/core/dashboard 测试过期修订、零数据条件、快照读回 |
| restore-copy | restoreBackup 校验清单、CRC、SHA256、SQLite 完整性和引用原件，只创建独立副本；agent-actions/core/cainiao 测试真实恢复和损坏拒绝 |
| file-stage | 无需复核，真实原件入任务库，绑定人员+任务并校验摘要；agent-http 测试跨任务拒绝 |
| backup | 无需复核，真实 ZIP 和带摘要下载产物；agent-http 测试下载字节 SHA256、老板降权和跨人员下载拒绝 |
| cainiao-start、cainiao-stop、cainiao-resume | 无需财务复核，执行原下载管理器；agent-http 测试已登录账号、真实任务/空报表完成、停止、断线继续拒绝，费用账本不变 |

安全与并发证据：`agent-http` 包含无签名人员、伪造/错人证明、篡改差异、源变化、员工权限、相同幂等重试、重启回执、持有 Agent 事务时旧接口被拒绝。`agent-transaction` 使用真实 SQLite 事务、预先持有的原生 statement、已运行后台任务、并行请求、嵌套写入、回滚、BEGIN 被另连接锁住以及 detached 异步任务，验证 owner 隔离和后续独立请求可正常持久化。

## 菜鸟至销售运费的边界

当前经营总览能作为真实下载与归档入口；它不是只返回 skill 文本。现有 inspectBill/reconcile 已核对页面行数、金额、费用项覆盖及业务月份，但只保存表级合计和费用项名称，尚未形成销售台五分类金额草稿。

归档至销售台仍需主机协调以下真实步骤：从已校验 ZIP 提取官方 CSV/XLSX；按明确费用白名单汇总 shipping/packing/materials/storage/other（保留赔付负数）；核对币种、月份及交易/明细总额；将原件重新 stage 到销售模块；读取销售运费现有月记录、锁和版本；生成 freight-create/update 草稿并中央复核后入账。经营总览的文件 ID 不能直接当作销售模块文件 ID，销售附件领域也不接受原始 ZIP。未知费用和差异必须阻断。此交接尚未在经营总览中自动实现；本组没有改动销售模块。

正式平台、真实浏览器账号、主机跨模块文件桥接、打包安装与部署不属于这些隔离测试的通过范围。
