# 浏览器全面迁移状态 · 2026-11-03

## 已完成

- ERP 源码已移除 Electron 外壳、安装器、组件下载、内嵌云仓、历史订单导出及对应测试和打包产物；保留采购、销售、经营总览。
- 灵兔 AI 电商平台买家订单导出已有独立工作区。本轮临时创建的 order-exporter-standalone 副本已送入 Windows 回收站，不保留重复副本；用户已有工作区、安装和业务数据未删除。
- 服务管理与网关迁入 server，纯 Node 运行；共享协议与加载资源迁至 shared。
- 根开发环境已移除 449 个旧依赖；保留系统 Node、浏览器、Tailscale、其他软件及其运行环境。
- 宿主 47 项、采购 193 项、销售 207 项、经营总览 72 项测试通过，共 519 项。环境检查、共享审批协议检查通过。独立代码审查未发现 Critical/Important 回归。
- 独立候选 E:/WuchengERP/releases/browser-only-20261103 在合成账本上启动三个真实服务、加载页面及查询通过，web-release.json accepted=true。候选没有 Electron 或安装器。此结果不代表正式切换。

## 数据保护和恢复位置

正式数据未迁移或覆盖。清理前一致性备份：E:/WuchengERP/migration-backups/formal-before-browser-only-20261103（526 文件，SQLite 与摘要校验）。

剩余私有构建配置和可能独立的发票源码先保存至 E:/WuchengERP/migration-backups/legacy-workspace-private-20261103，设置了受限 ACL；不把私有配置作为普通源码提交。历史桌面源码可从 Git 追溯。开发数据 .codex-artifacts/web-dev/data、正式账本、附件、登录资料和 SCM 元数据保留。

## 正式入口切换

Tailscale 已恢复在线。用户完成管理员安装后，WinSW WuchengERPWeb 已运行并配置为自动延迟启动。原 ERP HTTPS 的 8443 入口已切到浏览器网关，443 配置保留；三模块直接读取原正式账本，网关 serverId/dataSetId 与审计保留。真实 HTTPS 会话、三个页面及 bootstrap 均返回 200，缺少身份访问返回 401。浏览器采购看板已显示正式记录。旧 ERP 已退出，旧开机启动项关闭；桌面已提供浏览器入口。

## 尚未完成

- 旧安装版保留用于人工回退。禁止新旧程序同时写同一账本。
- 真实双机 Tailscale、Windows 开机恢复、真实平台采集及完整人工导入导出尚未验收。
- 三个业务模块继承的运行依赖仍有 npm audit 报告（各有 2 个 high）；本次没有做可能破坏业务的强制大版本升级。根宿主依赖审计为零。

候选测试使用合成数据，不能与此前桌面正式账本数据的性能数值直接比较。完整基线和此前副本演练记录见 browser-validation-2026-11-03.md（其桌面过渡描述属于前一阶段）。后续正式配置与更新方法见 browser-service.md。
