# 独立环境包

本仓库通过 GitHub Actions 的 **Same source environment packages** 工作流，为同一源码提交构建 Windows x64 ZIP、Debian 12 / glibc 2.36 及以上的 Linux x64 tar.gz，以及飞牛 x86 Native FPK。ARM、其他 Linux 发行版和其他 libc 当前不在支持范围。

## 下载与保留

推送到 `main` 或 `codex/fnos-native` 中匹配环境构建的源码会触发统一工作流，也可手动运行。只有 Windows、Linux、飞牛三个包及其隔离验收全部通过后，工作流才生成 `DELIVERY.json`。包、SHA256、验收记录和飞牛对应源码 companion 作为同一次 GitHub Actions run 的 artifacts 保存 14 天；它们不是公共 Release，不会自动部署、发布到应用商店或改动 NAS。

`DELIVERY.json` 记录每个目标的源码版本、commit、run ID、通用业务源码摘要、实际包 SHA256 和验收状态。下载后应使用同一 run 的清单、验收文件及飞牛源码 companion；不要跨 run 拼接不同产物。正式 ERP 服务、账本和入口不由此工作流变更。

## 平台范围与运行环境

- **Windows x64**：内置 Node.js 24.22.2；首次运行需要提供真实 HTTPS origin、独立数据目录和现有 Tailscale 身份。Windows 以当前用户启动。可选 WinSW 服务安装是单独的运维步骤，不会由包自动注册。
- **Linux x64**：面向 Debian 12、glibc 2.36 或更新版本，内置 Node.js、生产依赖和私有 Chromium/Xvfb 图形运行时；服务模板以非 root 用户运行。组网工具不随包安装或改写。首次运行需要明确 HTTPS origin、独立数据目录和现有 Tailscale 身份。
- **飞牛 x86**：保留 fnOS 原生 FPK 生命周期、权限边界、诊断包和 clean-runtime 验收。应用继续使用 fnOS 登录身份。

通用环境包将程序/运行时与持久数据分开。Windows/Linux 首次 `configure` 必须显式提供 origin 和独立 data 路径，并使用现有初始化流程；不能使用开发身份、默认管理员密码或把测试路径指向正式账本。已有配置不会自动重配，升级也不会自动迁移数据。迁移前须停止写入，并使用已验证的备份/恢复方案；本仓库当前没有自动迁移流程。fnOS 保留既有配置兼容行为。

三端继续使用现有业务与账本格式，不复制业务实现。Windows 保留现有浏览器扩展采集方式；Linux 使用私有浏览器闭包；各平台依赖文件可能不同，因此源码摘要相同不代表包字节相同。产物保留运行时许可证、来源说明和平台所需源码材料。

## 配置入口

解压后先阅读包内 `README.md` 或 `deploy/README.md`，再执行平台对应的显式 `configure`、`start`、`status`、`stop` 操作。`configure` 需要用户提供真实 HTTPS 地址、该环境专属的数据路径及现有身份配置；不要复制其他环境的会话、浏览器 profile、密钥或配置文件。已有数据不得通过选择相同路径来“初始化”；需要接入已有数据时，先安排停写备份和经过验证的迁移。

Linux 的 systemd 模板须由管理员按包内说明安装，并配置独立服务用户和目录权限。Windows 如需开机服务，应按说明显式安装 WinSW；默认使用当前用户运行。包不会安装 Tailscale 或更改网络路由。

## 交付验证

统一门禁要求每个目标恰有一份元数据、receipt 和真实验收 JSON；元数据中的 version、commit、run ID 与三端相同，源码摘要一致。门禁会重新计算每个 ZIP、tar.gz 或 FPK 的 SHA256，并确认验收记录声明成功、清理完成且身份与 metadata 相符。缺包、重复目标、跨 run 元数据、验收失败、证据缺失或哈希不符都会阻止交付清单生成。

此流程只验证隔离构建和合成数据，不证明用户 NAS 上已安装，也不执行正式数据迁移、公开发布或正式部署。旧的 Browser release workflow 保留原手动入口名称，并转调统一环境工作流生成三平台交付。

## 飞牛并行试装

NAS 上现有 `wuchengerp` 应用仍在服务时，不能直接用同名主包升级来测试。可选的完整试装包使用独立应用 `wuchengerptrial`、`/app/wuchengerptrial` 中转入口及 `@wuchengerptrial-data` 数据根；浏览器也使用独立端口和 display，Xvfb 按试装 target 另行编译。它复用同次业务 release，并有独立的包哈希和运行证据，不是第四种正式平台交付目标。

试装只新建合成账本或沿用自身数据，不读取正式迁移源；完成局域网、中转身份、启停和隔离性验收后，才进入正式停写备份与迁移。试装包的 CI 检查不替代 NAS 实机验收，主包和正式账本在试装期间保持原部署。
