# Agent Beta 发布与验收门禁

Beta 仅可使用独立 Windows 安装身份 `com.wucheng.ecommerce.erp.v2.agentbeta`，根目录 `%LOCALAPPDATA%/WuchengAgentBeta`，profile、data、registry 均在该目录内；网关回环 27330，模块使用 27331–27379 且不能重复。更新禁用。所有模块必须显式注册、managed、allowInitialize=false，不得回退正式路径或使用正式登录分区。

`node scripts/agent-beta-coverage.mjs inventory` 读取本工作树模块 manifest 和内置描述符，不访问正式数据。当前清单是操作基线，不等于可执行能力；UI 路由单独标注，实际服务器动态路由、CLI、MCP 和任务映射须重新对照。每条操作默认 pending，真实任务工具、人审边界、回执、回读、数据隔离及实际运行证据均缺失；未开通平台只有经证据确认后才可标记 pending_expected。

`node scripts/agent-beta-coverage.mjs check` 缺少或过期时失败。`build/agent-beta-builder.cjs` 另外始终阻止打包，直到主机组完成并验证独立身份、安装、profile、端口、服务与更新通道；本文件不能作为可发行配置。覆盖清单生成是破坏性重置证据操作，已有人工证据时不得重复生成，须增量合并。

迁移预演尚未实现；必须只从当前正式 registry 指向的源只读备份 SQLite，复制业务附件并核对摘要、权限、审计、月锁与关联。源持续写入时，单库备份不构成跨库一致性保证；没有可靠跨库一致性证据必须阻断切换。禁止复制 Cookie、DPAPI 凭据与私网身份。未进行真实数据迁移、安装或发布。
