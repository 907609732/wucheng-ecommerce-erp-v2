# 五成 ERP 0.14.4 浏览器服务版

本包适用于 Windows x64，包含采购、销售、经营总览及其运行依赖。需要系统 Node.js 24 或更新版本。无需 Electron 或安装器；普通成员通过已授权的 Tailscale 连接访问。NAS 可另安装飞牛统一登录入口，参阅 deploy/fnos/README.md。

本包不包含公司账本、附件、登录授权、主机配置、系统 Node 或 WinSW。历史买家订单导出工具独立维护，不包含在本包。不要在开发源码目录覆盖正式程序。

已部署用户：解压到新的独立版本目录，先核对 SHA256SUMS.txt 与 web-release.json；按照 OPERATIONS.md 使用 web:update、已有正式配置和备份完成切换。更新失败回退程序版本，不自动恢复旧业务数据。

首次部署：先配置已有账本路径、独立 stateDir、实际 Tailscale HTTPS 地址及 releaseRoot；再按 OPERATIONS.md 配置官方 WinSW。正式启动必须显式指定配置：`node server/cli.mjs start --config 配置文件完整路径`。不提供自动新建正式账本或自动登录。

Windows 服务以 LocalSystem 运行时，服务维护命令需在管理员 PowerShell 执行；日常浏览器使用无需管理员权限。

构建与合成账本验收在 GitHub Actions 完成。真实双机操作、主机重启及真实平台采集须在部署环境单独验收。三个业务模块继承依赖存在 npm audit 告警，尚未做破坏性大版本升级。
