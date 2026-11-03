# 浏览器服务架构

浏览器 → Tailscale Serve HTTPS → 本机统一网关 → 三个 Node 模块服务 → SQLite。

`server/config.mjs` 明确采购、销售、经营总览三个模块；`server/service-manager.mjs` 通过系统 Node 启动模块，不依赖桌面外壳、组件下载或内嵌运行时。模块端口只监听本机。网关保留成员会话、签名身份、CSRF、重复提交回执、上传限制和审计。

页面入口为 `/apps/purchase/`、`/apps/sales/`、`/apps/overview/`。模块按需启动；运行锁、启动归属和健康身份检查防止重复启动、误接其他账本或错误版本。宿主退出会等待活动任务并关闭托管服务。

开发数据、正式数据和程序版本分离。正式模式必须明确已有账本路径，拒绝缺失账本及默认回退。业务规则继续由三个模块实现，不更换 SQLite。需要浏览器登录的采集通过用户会话助手运行。

共享审批协议位于 `shared/protocol/approval.mjs`，加载资源位于 `shared/ui/`。同步命令为 `npm.cmd run sync:approval`（检查）及 `npm.cmd run sync:loading`（同步）。

云仓和历史买家订单导出已移出 ERP，使用现有独立软件；ERP 不负责启动或更新它们。旧数据与授权仍保留，不能把删除源码视为删除账本许可。

配置、更新与恢复见 [浏览器运维说明](browser-service.md)。
