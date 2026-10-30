# 云仓 Agent 能力覆盖与待验收清单（2026-10-29）

| 原业务入口 | Agent 能力/归属 | 当前边界 |
| --- | --- | --- |
| 库存查询、预警 | inventory | 读取原库存快照 |
| 月销量查询、同步、补齐 | sales / sales.collect / sales.backfill / sales.import | 采集原件与正式导入分离 |
| 库存采集、导入、发送 | inventory.collect / inventory.import / inventory.send | 导入与发送须中央复核 |
| 最近有效库存发送 | inventory.send-latest-valid | 显式历史来源，不计今日新同步 |
| 采集状态、停止、重试 | collection.jobs / collection.cancel / collection.retry | 持久 jobId；未知先回查 |
| 登录刷新 | login.refresh | 验证码等本人在主机处理 |
| 今日闭环、签到、任务完成 | daily / attendance.check-in / attendance.complete | 签到绑定本人，不能代签 |
| 员工工作安排、催办 | employees.configure / remind | 编辑白名单草稿；发送须复核 |
| 诊断、日志、脱敏包 | diagnostics / logs / debug.bundle | 复用原主机函数，不接受任意路径 |
| 设置查询、秘密录入 | configuration / 主机设置 | AI 仅读取非秘密设置及就绪标记 |
| 原件、备份 | sources / backup / 中央原件下载 | 任务原件归属与摘要校验保留 |
| 原每日、月度、催办计划 | schedules.legacy / 统一调度 | 只读迁移来源；未创建真实任务 |
| 品牌、关于、更新、打开目录、远程连接 | 主机工作台 | 不计作云仓业务能力；须主机集成 |

全员访问：所有通过真实身份验证的员工均可使用业务能力、查看业务数据；不使用角色、模块列表或 canRunTasks 再授权。真实登录签名仍由主机校验。重试保留原执行人，原件下载保留任务归属，签到保留本人绑定；中央复核、版本、月份锁、幂等键均保留。

待验收：上述全部新增实现尚未执行测试；恢复/取消竞态与登录态、真实原件、中央文件流、草稿重准备、调度接管和实际回执均需总控统一验收。本次未打包、安装、发送或修改正式账本。员工本人目前仍要求 Tailscale 身份；Windows 真实个人签到需主机提供可区分共享本机管理身份的个人标记后再扩展。
