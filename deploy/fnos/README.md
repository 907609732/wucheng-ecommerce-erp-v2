# 五成 ERP 完整原生 FPK 0.15.0

构建目标是 Debian 12 / glibc 2.36 / x86_64 的飞牛 Native 应用。包内包含 Node 24.22.2、Linux 生产依赖、采购/销售/经营总览、Debian Chromium、Xvfb、x11vnc、XKB、中文字体及 noVNC 1.6.0；部署不使用 Docker。官方 fnpack 1.2.3 生成 FPK。实机安装、正式迁移与公网入口需要单独验收，CI 成功不代表这些已经完成。

## 构建与交付

Windows 的 `build.ps1` 明确拒绝生成旧薄包。推送分支后手动运行 GitHub Actions **fnOS native FPK**。工作流使用临时 Debian 12 构建容器；仅为测试 Chromium namespace sandbox 允许 CI 容器特权，FPK 不授予 package 用户能力，也不依赖 Docker。

构建后还在全新的 Debian 12 slim 运行容器重复主包 smoke 和诊断安装钩子，只准备系统 Python、CA 和 util-linux，断言没有宿主 X11/GTK/NSS/字体/XKB。可读取的受控进程 `/proc/maps` 只允许已验包内运行时/原生 npm 依赖和明确的宿主 glibc/loader；sandbox 拒绝读取的进程单独记录。该验证避免构建机图形依赖掩盖私有闭包遗漏，仍不替代 NAS 实机验收。

产物包括 `wuchengerp.fpk`、独立测试包 `wuchengerpdiag.fpk`、`SHA256SUMS.txt`、逐文件 payload 校验清单、`THIRD-PARTY.json`、对应源码 companion、编译参数及合成验收 JSON/截图。下载后先用 SHA256 验证；源码伴随包必须和对应 FPK 一并保存，未来再分发时一并提供。GitHub workflow artifacts 默认保留 14 天，不是长期公开源码下载服务。

可在专用临时 Debian 12 amd64 构建机执行：

```sh
# 仅构建机：先准备官方系统 python3、curl、CA、git；绝不能在正式 NAS 执行。
sudo bash deploy/fnos/build-native.sh /tmp/new-native-output
```

输出目录必须不存在且位于源码目录外。脚本通过签名 apt 索引准备固定版本软件包、从带 Debian 补丁的 xorg-server 源码构建 Xvfb，并使用标准 lddtree 收集私有共享库。保留 NAS 的 glibc 2.36/loader；不在 NAS 安装浏览器依赖、不更改全局 LD_LIBRARY_PATH。锁定版本不可下载时构建失败，不能悄悄换浏览器。来源与许可证见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 安装前提与正式切换

- 系统必须为实测兼容的 x86_64 / glibc 2.36，并支持非 root Chromium namespace sandbox；禁止添加 `--no-sandbox` 绕过。系统需有 `runuser`、标准 POSIX/Linux 工具和可信 `/usr/bin/python3`。安装钩子使用系统 Python 进行保留目录的安全属主恢复；包内 Python 或 python312 应用不能替代这个可信路径。缺少时安装明确失败，管理员应通过另行审核的官方系统安装方案准备 Python，然后重试；FPK 不自动修改 NAS apt 环境。
- 新建安装显式选择 fresh，填写真实 NAS HTTPS 主地址、允许 UID 和附加 Origin；不带开发用户、真实地址或默认密码。账本保存在安装卷物理目录的 `@wuchengerp-data/erp`，不在可替换 target 内，卸载保留。
- 现有实例迁移先停写、完整备份并恢复验证，再选择 migrate 和已经校验的停写副本。禁止旧容器和原生服务同时写入。保留原身份、锁、密码、历史和 UVCS 队列；不支持的原件绝对路径必须阻止切换。
- 当前实例已启用 UVCS 时，必须验证原生 cm 可执行及原 HOME/认证/队列，不能关闭托管以通过迁移。UVCS 不随 FPK 再分发；向导可明确选择由 root-owned appcenter 钩子安装固定官方 11.0.16.10616-1 amd64 deb，核对大小/SHA256/包字段后安装，禁止升级/移除无关软件。不设置认证，不携带私有凭据。
- 生命周期只在短暂准备阶段使用 root，Node/collector/两套浏览器全部使用专用 package 用户。长服务由已有 supervisor 管理，启停核对 generation、真实命令和账本身份；失败明确暴露。

完成隔离诊断后，正式切换仍须依次验证账本摘要、两种入口的相同 serverId/dataSetId、权限/匿名拒绝、真实浏览器登录、UVCS、停止原 ERP 容器后的原生重启，以及 NAS 重启。保留旧 Docker 停机配置和原备份用于回退，不修改其他业务。

## 独立诊断包

`wuchengerpdiag` 只用于合成数据：独立包 UID、私有 `@wuchengerpdiag-data`、独立 Chromium profiles、29430–29434/29222–29223/29322–29323 回环端口和 display 222/223。它有单独编译固定 helper 路径的 Xvfb，不依赖正式 target，不加载正式 native_env，不读取正式配置、账本、UVCS 或 Tailscale。无远程入口、身份代理或长期报告服务。

官方安装 callback 降权后同步执行一次 smoke，240 秒后 TERM、再留 45 秒清理，返回后再用真实 nativeLifecycle stop 核对。成功后应用保持 stopped，证据位于 `@wuchengerpdiag-data/run-*/evidence/`。fnOS 对安装 hook 的实际时限尚未实机验证；若平台更早结束安装，应当作为诊断失败检查保留证据，不能据此宣称主包失败或擅自后台重试。命令行可用该包 `cmd/acceptance` 明确重试。

验收包含真实 SQLite、nativeLifecycle/collector、MCP 导航/快照/输入/下载、HTTPS/NSS、namespace/seccomp sandbox、上游 noVNC 到 x11vnc 的真实 RFB 画面和键鼠、中文显示截图、持久合成浏览器 session 和重启停止。中文输入法、真实平台登录和正式 fnOS 授权 GUI 仍需实机人工验收；诊断成功不替代正式主包固定路径与身份验收。
