# Agent Beta 发布与验收门禁

Beta 仅可使用独立 Windows 安装身份 `com.wucheng.ecommerce.erp.v2.agentbeta`，根目录 `%LOCALAPPDATA%/WuchengAgentBeta`，profile、data、registry 和托管 programs 均在该目录内；网关回环 27330，模块使用 27331–27379 且不能重复，采购手机端必须显式登记 27380，缺失或使用正式端口均拒绝。更新禁用。所有模块必须显式注册、managed、allowInitialize=false，不得回退正式路径或使用正式登录分区。主机可以用 validateRegistry 检查配置骨架；实际启动业务前必须调用 validateBetaReady，确保各模块主账本、程序和独立 Node 已就绪。程序的 root、exe、nodePath、认证目录及所有声明端口必须位于 Beta 范围内。

`node scripts/agent-beta-coverage.mjs inventory` 读取本工作树模块 manifest 和内置描述符，不访问正式数据。当前清单是操作基线，不等于可执行能力；UI 路由单独标注，实际服务器动态路由、CLI、MCP 和任务映射须重新对照。每条操作默认 pending，真实任务工具、人审边界、回执、回读、数据隔离及实际运行证据均缺失；未开通平台只有经证据确认后才可标记 pending_expected。

`node scripts/agent-beta-coverage.mjs check` 缺少或过期时失败。`build/agent-beta-builder.cjs` 另外始终阻止打包，直到主机组完成并验证独立身份、安装、profile、端口、服务与更新通道；本文件不能作为可发行配置。覆盖清单生成是破坏性重置证据操作，已有人工证据时不得重复生成，须增量合并。

迁移预演工具 `scripts/agent-beta-migration.mjs rehearse` 仅使用当前工作台位置记录所绑定的 registry，缺少记录时拒绝回退。它逐库使用 SQLite backup、核对所有表的行数及摘要和外键检查，并校验附件哈希；支持在线 WAL 数据库，通过 SQLite backup 获取逐库一致快照；记录来源主库与 WAL 等文件在备份前后的尽力读取摘要和各库时间。目录链接或主账本缺失时拒绝；附件清单或摘要变化会产生需要复核的差异报告。不会复制 Cookie、DPAPI 凭据或私网身份。已有只读预演保存为独立副本；在线 SQLite 读取可能参与共享内存锁协调，但不执行业务写入；跨数据库一致性和维护窗口需主机组另行保障。

预演副本在独立 rehearsals 目录，不会启用或注册为 Beta 账本，原始记录中的操作性绝对路径尚未改写；不得直接用副本启动业务。声明式公共权限配置在存在时已复制并校验结构与摘要；未知外部权限路径、业务金额汇总、跨库关系和月锁语义仍需核验。跨库没有原子事务，报告明确不允许正式切换。`rollback <精确预演目录>` 仅对完整、未修改且没有额外文件的副本执行删除；未完成的中断副本须人工审查，不能自动清理。

显式受控准备入口：node scripts/agent-beta-migration.mjs prepare-test-data <精确预演目录>。该命令只接受当前已绑定 registry 的完整预演，对快照与权限哈希、外键和文件范围重新核验；目标 Beta data 已存在时拒绝覆盖。候选副本按 desktop/agent-host/data-rewrite-rules.json 的白名单映射已识别原件路径、移除已识别登录及会话字段，并记录字段位置及前后摘要；原始预演不变。映射目标必须存在且原件摘要一致；未知外部绝对路径、未识别凭据、缺失原件或规则不匹配时拒绝切换。准备先写隔离临时目录和日志，完成后对整个 data 目录执行同卷重命名；已有 data 一律拒绝覆盖。显式 rollback-test-data <准备回执ID> 只允许摘要完全一致且服务未运行的副本，整体移回隔离准备目录，保留权限文件。中断后可能保留维护锁或日志，必须人工核对；来源身份只保留摘要。此入口尚未在真实副本执行。

主机接线要求：服务启动全过程必须使用 desktop/agent-host/data-maintenance.mjs 的 withBetaServiceStartFence(paths, operation)，与数据准备、回滚、组件激活共享同一互斥文件；只在启动前检查锁存在会有竞态。失败发生在开始切换之后时锁会保留，需按日志人工核对，不得自动删除。

字段级转换在独立候选 SQLite 中事务执行，完成后比较数据库结构、各表记录数及已识别整数金额；不打印凭据原值。规则当前只覆盖源码中已确认的字段，其他路径或敏感字段仍需模块负责人确认后显式增加规则，不能放宽为通配重写。
