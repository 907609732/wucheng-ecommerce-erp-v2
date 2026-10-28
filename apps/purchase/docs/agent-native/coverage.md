# 采购 Agent 全能力清单

工厂：`lib/agent-adapter.mjs:createPurchaseAgentAdapter({transport})`；采用冻结的 `transport(moduleId,route,{method,body,ctx,signal,approval,idempotencyKey})`。接口 `/api/integration/v1/agent/*`。

业务映射 `lib/agent-operations.mjs`，文件/OCR `lib/agent-files.mjs`，服务端同源AJV参数校验 `lib/agent-schemas.mjs`。原界面及其业务路由全部保留，实际接口允许清单在 `workbench-manifest.json`。

| 能力ID | 真实业务 | 调用 | 授权 | 必需参数 |
|---|---|---|---|---|
| orders | 采购订单与详情 | query | 自动准备/只读 |  |
| dashboard | 采购支出统计 | query | 自动准备/只读 | year |
| sources | 导入来源与原件 | query | 自动准备/只读 |  |
| audit | 订单审计与补充来源 | query | 自动准备/只读 |  |
| suppliers | 供应商与历史 | query | 自动准备/只读 |  |
| addresses | 收货地址 | query | 自动准备/只读 |  |
| tasks | 月度任务与分派 | query | 自动准备/只读 | month |
| months | 月度确认与历史 | query | 自动准备/只读 | month |
| attachments | 订单附件与图片 | query | 自动准备/只读 | id |
| export | 采购报表导出 | query | 自动准备/只读 |  |
| ocr.text | 识别采购文字 | query | 自动准备/只读 | text |
| ocr.status | 识别进度与结果 | query | 自动准备/只读 | jobId |
| import.preview | 读取表格导入核对结果 | query | 自动准备/只读 | previewId |
| files.get | 读取已上传原件的文件ID、摘要及下载链接 | query | 自动准备/只读 | fileId |
| files.upload | 上传采购原件并取得受控文件ID | prepare | 自动准备/只读 | filename, dataBase64 |
| files.upload.part | 分片上传大原件并按摘要校验后取得文件ID | prepare | 自动准备/只读 | filename, totalBytes, offset, dataBase64, sha256 |
| attachment.stage | 将原件暂存为订单附件 | prepare | 自动准备/只读 | fileId |
| import.analyze | 识别Excel或CSV字段并生成导入核对表 | prepare | 自动准备/只读 | fileId, platform |
| import.remap | 调整原件工作表与字段映射并重新核对 | prepare | 自动准备/只读 | previewId |
| ocr.start | 使用本地真实OCR识别图片或PDF原件 | prepare | 自动准备/只读 | fileIds |
| ocr.commit | 核对识别结果后保存采购单及所有原件 | prepare | 中央审批 | jobId, order |
| transfers | 查询导出台传入的历史订单核对批次 | query | 自动准备/只读 |  |
| transfer.verify | 复核历史订单导入批次与当前订单差异 | query | 自动准备/只读 | id |
| transfer.save | 补齐采集账号退款依据及冲突字段取值 | prepare | 自动准备/只读 | id, revision, decisions |
| transfer.commit | 中央审批后正式导入采集订单 | prepare | 中央审批 | id, revision |
| transfer.rollback | 中央审批后撤销整批采集订单导入 | prepare | 中央审批 | id, reason |
| order.create | 录入采购订单 | prepare | 中央审批 | platform, orderNo, date, supplier, amountCents, items |
| order.update | 修改采购与退款 | prepare | 中央审批 | platform, orderNo, date, supplier, amountCents, items, id, updatedAt |
| orders.attributes | 批量采购属性 | prepare | 中央审批 | orders, patch |
| orders.classification | 批量分类与分摊 | prepare | 中央审批 | orders, category |
| supplier.save | 维护供应商 | prepare | 中央审批 | name |
| address.save | 维护地址 | prepare | 中央审批 | name |
| address.remove | 删除地址 | prepare | 中央审批 | id, updatedAt |
| task.action | 分派执行提交验收任务 | prepare | 中央审批 | month, taskId, action, revision |
| task.mark | 记录月度核对结果 | prepare | 中央审批 | month, taskId, status, operator, revision |
| month.confirm | 确认并锁定月份 | prepare | 中央审批 | month, platform, revision |
| month.cancel | 取消月份锁定 | prepare | 中央审批 | month, platform, version |
| audit.rollback | 回滚采购修改 | prepare | 中央审批 | auditId, scope, versions |
| import.commit | 核对后导入表格 | prepare | 中央审批 | previewId, indices |
| image.prepare | 提取订单来源图片 | prepare | 自动准备/只读 | id |
| image.cache | 缓存原始图片 | prepare | 自动准备/只读 | id, imageId |
| attachment.remove | 删除暂存附件 | prepare | 中央审批 | id |

金额为人民币整数分，查询筛选minAmount/maxAmount沿用原界面单位元并有明确参数说明。付款日期为空回退下单日期，月度确认按北京时间次月15日开放。prepare私有数据留服务端，返回preparedId及材料摘要；中央签名证明绑定人员、任务、结果版本、账本UUID/revision、差异和幂等键。

表格保留原文件、字段映射、逐行异常、未导入报告；OCR使用真实本地worker，任务与原件/附件持久化，重启中断明确标记。正式导入复用原去重、锁月和事务；采集转采购复用原备份、来源对照、写后逐单核验及恢复，绝不伪造旧UI会话。未知结果不能返回成功回执，只按真实已核验业务回读恢复。

人员主数据、密码、备份恢复、升级与服务管理仍归主页/主机，不开放模型任意主机文件路径或个人AI配置。真实平台登录、验证码和真实公司API验证由主集成验收，模块测试全部使用隔离合成账本。

验证：`node --test --test-concurrency=2 tests/*.test.mjs`；新业务链路测试 `agent-http.test.mjs`、`agent-files.test.mjs`、`agent-transfer.test.mjs`、`agent-service.test.mjs`、`agent-schemas.test.mjs`。审批helper来自冻结runtime源码，SHA256 `1ca342e316eccb12b9fa69827dcac70cdd94023198fc2f16c475c3a43d6a588f`；独立模块不引用仓库外desktop路径。最终统计以本次完整测试日志为准。

原件上传单次8MiB；大文件使用files.upload.part，每片8MiB、完整文件50MiB，表格分析25MiB、OCR总200MiB。所有分片与完成文件均检查所属人员、字节偏移和SHA256。

最终冻结源码 `500b2b4dcdfb1ceec03172f19ba34e1e1b63e887`：采购完整回归192/192，导出台147/147，采购语法检查通过。覆盖真实HTTP→文件→OCR/表格→审批→数据库→原件/附件/来源回读及恢复。详见 validation.json。
