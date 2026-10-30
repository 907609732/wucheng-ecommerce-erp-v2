# 公共备份与独立恢复副本接线

集中冻结后的定向修复已验证：agent-backup-recovery、agent-beta-backups、agent-host-backups 三个测试文件共 9 项通过；覆盖合成账本与真实 SQLite/WAL 及主机 HTTP 绑定，不代表正式账本切换验收。日志在 .codex-artifacts/acceptance-20261029/backup-recovery-fixed.tap。

- 用户决定删除权限管理，全部已登录员工可访问全部业务。公共备份、列表、核验和恢复只依赖可信 `resolveActor` 对真实登录 ID 的新鲜核验；不再读取旧 role、modules、canRunTasks、enabled 标记作为授权规则，未知登录仍拒绝。
- 公共备份现在复制任务上传附件和登记产物，核对原路径范围与 SHA。公共任务快照会剥离已知引擎会话及凭据字段；原数据库和原件不修改。
- 私有 hook 为 `backups.list`、`backups.verify`、`backups.restore.prepare`、`backups.restore.commit`、`backups.restore.receipt`。公开业务能力由运行时统一核验登录和具体结果复核；hook 不接受文件系统路径。新备份不读取或复制旧 access-policy，清单明确 `inactive-not-included` / `accessPolicyApplied:false`；没有该文件不阻断备份或恢复。旧备份内的历史 policy 只在核对 SHA 后复制到 `shared/history/access-policy.json`，记录 `historicalOnly:true` / `applied:false`，不会恢复生效。
- 独立恢复准备绑定备份 UUID、清单 SHA 与服务端生成的恢复 UUID。提交必须有本次任务复核上下文和幂等标识。只向 `%LOCALAPPDATA%/WuchengAgentBeta/recoveries` 写新副本；不会替换当前模块数据、权限或任务中心。
- 恢复核对所有备份文件摘要、数据库表摘要/完整性/外键和目录清单；额外文件、软链接、跨公司备份、陈旧清单都会拒绝。副本中的任务附件与产物私有路径改到新副本；旧任务暂停，旧复核与 prepared 作废，旧计划禁用。未知提交仍保持未知。
- 恢复产物清单与完成回执在目录原子更名前写入；幂等 claim 绑定真实执行人、任务和该清单 SHA。已登录员工可以在同一任务核对回执，回执始终保留原执行人，不能用相同幂等标识冒换执行人或跨任务复用。缺少完成回执时返回 unknown，不自动重做恢复。
- 领域 SQLite 副本复用 `data-rewrite.mjs` 的审查规则：仅重映射已知原件字段且原件存在、摘要一致时才生成恢复目录引用，剥离已知凭据/会话，未知绝对外部路径或凭据拒绝。改写后重核表结构、记录数与已识别金额汇总；恢复清单保存每个文件原始/当前 SHA 和逐字段变更摘要，不保存秘密原值。原备份清单与原件 SHA 不改。
- 集中验收发现 WAL 快照的只读查询也可能生成 SHM。现对自有备份/恢复候选库在清单摘要前 checkpoint 并封为 DELETE 模式；既有备份的数据库核验只读临时副本，不在原备份创建日志文件。额外文件门禁继续严格拒绝，不忽略 WAL/SHM。任务脱敏查询显式别名 `rowid AS backup_rowid`，兼容事件表的 INTEGER PRIMARY KEY。

`activated:false` 明确表示恢复副本尚未接入运行服务。实际替换当前 Beta 账本或正式账本仍须维护窗口、备份、身份/路径重绑定与独立切换验收；本实现不把生成副本当作正式恢复或正式迁移完成。跨数据库快照不是同一时点原子快照。
