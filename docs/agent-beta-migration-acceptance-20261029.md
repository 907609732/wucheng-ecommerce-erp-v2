# Beta 真实测试副本准备验收（2026-10-29）

本次只修集中验收发现的副本准备阻断，并执行受影响的定向复测；没有正式迁移、主干合并、安装或发布。

## 修复及边界

- 旧预演只读核对发现五组未登记的 WAL/SHM（WAL 为零字节，SHM 各 32768 字节）。未删除、改写旧预演，也未放宽额外文件门禁。
- 在线备份生成的新 SQLite 副本先转为 DELETE journal 模式再登记摘要。Fingerprint 在打开 SQLite 前检查封口及 sidecar，防止仅以 readOnly 打开 WAL 模式文件时生成新文件。
- 按实际 schema 补采购缓存图片、云仓 `workspace/downloads` 裸文件名引用；原件必须唯一匹配快照附件并通过 SHA-256。
- 只在采购原始钉钉 JSON 的固定字段允许固定图片 URI，在销售历史 JSON 的固定字段允许与同对象附件 ID 完全匹配的本地下载 URI；未知外部路径、未知凭据及未知凭据设置仍拒绝。
- 手机会话凭据及月度管理员密码配置在测试副本清除，手机会话失效；历史行、附件归属引用、月锁及业务数据保留。
- 总览唯一已不存在的 `.cainiao-staging/<UUID>.part` 是临时下载指针，按精确 JSON 路径清除并记录前后哈希；平台任务、提交时间、明细状态及核验历史保留。若暂存文件仍存在，准备会中止要求核对；未删除明细原件来通过检查。
- 旧 access-policy 只保留来源证据，未用于授权；正式实例身份未激活。当前所有真实登录员工可用全部业务的规则不变。

## 本地验收结果

- 新预演：`%LOCALAPPDATA%\WuchengAgentBeta\rehearsals\rehearsal-a44a84cc-6d43-466d-b500-ef56f6c4ff19`。
- 来源是当前已核验注册表；只用 SQLite 在线 backup 读取正式账本，未执行正式业务 DML 或更改正式配置。
- 新预演共 586 个登记文件：6 个 SQLite、579 个附件及 1 个历史策略文件；复制差异为零。
- 实际一次准备成功，目标固定为 `%LOCALAPPDATA%\WuchengAgentBeta\data`，未覆盖已有 Beta 数据。
- 回执：`%LOCALAPPDATA%\WuchengAgentBeta\preparations\prepare-ab0ad79d-8d2a-46e9-b796-a3348db6ac51\receipt.json`，状态 `complete`。
- 准备后再次核对全部 586 个来源文件和 585 个 Beta 业务文件摘要，579 个附件保持原哈希；6 库共 108 张表、15450 行，schema、user_version、行数及可识别的整数金额汇总全部保持。
- 共 33 条改写审计，只含字段位置、行哈希及前后值哈希，不含原始凭据值。旧预演全部 451 个登记文件摘要仍匹配。
- 迁移定向测试 13/13；改写定向测试 9/9，补充现存暂存原件门禁后仅复测该受影响用例 1/1；`git diff --check` 通过。未重复运行全套测试。

运行记录汇总保存在忽略目录 `.codex-artifacts/acceptance-20261029/migration-{rehearsal,preparation,final-verification}-summary.json`。正式来源、私有原件、数据库及完整回执未加入 Git。

这是独立测试副本准备通过。多个数据库不是同一时点的原子快照，`readyForFormalCutover=false`。Beta 实际启动、真实登录及业务端到端验收仍属于后续集中验收；本记录不表示正式切换完成。
