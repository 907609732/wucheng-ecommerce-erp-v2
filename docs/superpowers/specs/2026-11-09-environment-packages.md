# 同源三平台环境包

用户已确认：同一套代码同时打包 Windows、Linux、飞牛，由子智能体开发、主智能体监督验收，正式 ERP 不停服、不切换。本轮开发子智能体只用 gpt-6-luna / low，不用 Astra。

## 架构

业务源码和 SQLite 格式继续共用 server、shared、ui、apps 三模块。复用 server/release.mjs 的独立生产依赖构建和隔离验收。平台仅负责运行时、启动、服务安装及目录策略，不复制业务实现。

产物为 Windows x64 ZIP、Debian 12 / glibc>=2.36 x64 Linux tar.gz、飞牛 x86 Native FPK。全部自带锁定的 Node 24.22.2 和目标系统生产依赖；不要求系统安装 Node，不依赖 Docker 运行。构建机可以用现有隔离 Debian 容器。ARM 和其他 libc 不在本次范围。

Windows 保留现有用户浏览器扩展采集，不另造浏览器登录。Linux 包复用私有 Chromium/Xvfb/noVNC 闭包，使用 /opt/wuchengerp 作为安装前缀并编译匹配的 XKB helper 路径；程序和账本分开。飞牛保持官方 target/VAR 生命周期。Windows/Linux 使用现有 Tailscale 身份入口，飞牛使用 fnOS 登录；组网工具不随包安装或改配置。

通用环境命令支持显式 configure/start/serve/status/stop。Windows/Linux fresh 必须明确提供真实 HTTPS origin 和独立 data 路径，使用现有初始化能力；已有配置不自动重配，迁移仍要求已验证的停写源。不能生成默认管理员密码、开发身份或静默关闭 UVCS。fnOS 默认配置行为保持兼容。

Windows 首选当前用户启动，提供可选 WinSW 集成说明，不静默安装 LocalSystem 服务。Linux 提供 systemd 模板和明确的安装/配置指令；长期进程非 root。飞牛保留原生钩子。

## 发布契约

一次 GitHub workflow/run checkout 同一 commit，产生三平台产物；不同平台 node_modules 可以不同。统一 environment-build.json 至少包含 schemaVersion、target、version、commit、runId、nodeVersion、commonSourceSHA256。

commonSourceSHA256 对 web-release.json 的业务源文件集合计算，排除生成的根 package-lock.json，对文本 CRLF 规范为 LF，二进制保持原字节；不把 OS 原生依赖声称为跨平台同字节。每个平台仍独立验证完整产物 SHA256、源文件、Node 和运行验收。

最终汇总拒绝缺目标、重复目标、不同 commit/version/runId/源码摘要、失败验收及摘要不符。只有三包都通过才生成交付清单。保留现有 FPK 诊断和完整 corresponding-source companion，不自动发布公共 Release、推送应用商店或部署。

## 运行与数据边界

所有新测试用隔离数据、临时端口和新目录，完成后确认进程退出。所有源码修改均在当前 linked worktree，保留已完成的 fnOS 权限修复。禁止读写正式账本做测试，禁止更改现有 NAS 容器、入口、Tailscale、DNS 或应用安装。

包内不得带入正式 SQLite、HOME、凭据、会话、用户配置或浏览器 profile。保留运行时与依赖许可证、来源及已有对应源码；Linux 特有 Xvfb 构建参数随产物保留。

## 验收

三包元数据必须相等且逐包哈希可核对；Windows 使用包内 node.exe，Linux 使用包内 Node/图形闭包并以非 root 验证，FPK 保留现有合成双启动/清理与 clean runtime 检查。构建通过不等于已在正式 NAS 安装，本轮不进行正式迁移。

参考：[GitHub job matrix](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)、[Node 官方发行](https://nodejs.org/dist/v24.22.2/)、[WinSW](https://github.com/winsw/winsw)、[systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)。
