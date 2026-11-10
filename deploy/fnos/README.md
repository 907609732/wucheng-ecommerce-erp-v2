# 五成 ERP 完整原生 FPK 0.15.0

构建目标是 Debian 12 / glibc 2.36 / x86_64 的飞牛 Native 应用。包内包含 Node 24.22.2、Linux 生产依赖、采购/销售/经营总览、Debian Chromium、Xvfb、x11vnc、XKB、中文字体及 noVNC 1.6.0；部署不使用 Docker。官方 fnpack 1.2.3 生成 FPK。实机安装、正式迁移与公网入口需要单独验收，CI 成功不代表这些已经完成。

## 访问入口

公网主入口使用飞牛应用入口，经飞牛中转与反向代理访问，并保留飞牛登录身份校验。ERP 安装包不包含 Tailscale，也不要求安装 Tailscale 才能使用。

需要备用组网时，优先复用飞牛主机已有的 Tailscale 服务和现有转发配置，不创建第二套组网容器。已有实例迁移保留原备用入口；新建实例默认只启用飞牛入口。不得将内部模块端口直接暴露到公网。

## 构建与交付

Windows 的 `build.ps1` 明确拒绝生成旧薄包。推送 `codex/fnos-native` 相关源码会自动运行 GitHub Actions **fnOS native FPK**，迭代检查 native/collector/release/privacy；手动入口可选择 full 全量检查。工作流使用临时 Debian 12 构建容器；仅为测试 Chromium namespace sandbox 允许 CI 容器特权，FPK 不授予 package 用户能力，也不依赖 Docker。

Ubuntu 24.04 runner 还需按 [Chromium 官方说明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) 临时放开其 AppArmor 对未配置 Chromium 的 userns 限制，工作流结束恢复原值。此设置只用于一次性 CI 主机，不在 FPK 或 NAS 安装钩子中执行；NAS 必须在原有策略下单独通过非 root sandbox 诊断，不能用关闭 Chromium sandbox 绕过。

构建后先核对实际 FPK 解包与源载荷的全部普通文件集合/SHA256及符号链接目标集合；官方 fnpack 对齐后的 manifest 单独检查全部源字段语义不变及 app.tgz 校验值。随后在全新的 Debian 12 slim 运行容器，直接运行解包后的主包 smoke 和诊断安装钩子，只准备系统 Python、CA 和 util-linux，断言没有宿主 X11/GTK/NSS/字体/XKB。可读取的受控进程 `/proc/maps` 只允许已验包内运行时/原生 npm 依赖和明确的宿主 glibc/loader；sandbox 拒绝读取的进程单独记录。该验证避免构建机图形依赖掩盖私有闭包遗漏，仍不替代 NAS 实机验收。

产物包括 `wuchengerp.fpk`、独立测试包 `wuchengerpdiag.fpk`、`SHA256SUMS.txt`、逐文件 payload 校验清单、`THIRD-PARTY.json`、对应源码 companion、编译参数及合成验收 JSON/截图。下载后先用 SHA256 验证；源码伴随包必须和对应 FPK 一并保存，未来再分发时一并提供。GitHub workflow artifacts 默认保留 14 天，不是长期公开源码下载服务。

在 `codex/fnos-native` 的环境发布工作流中，可选构建 `wuchengerptrial.fpk` 隔离试装包。它使用独立 appID、账本目录、Xvfb 构建前缀和浏览器端口，向导仅允许创建合成账本或沿用本试装数据；安装及升级钩子拒绝迁移。trial 有单独的 `fnos-trial-<sha>-<run>` artifact 和 `trial-source-companion.txt`；源码包本身随同次 `fnos-corresponding-source-<sha>-<run>` artifact 提供。分发时需同时保存这两个 artifact，并按引用文件校验源码包 SHA256。默认构建关闭此试装入口，常规三端交付不变。

可在专用临时 Debian 12 amd64 构建机执行：

```sh
# 仅构建机：先准备官方系统 python3、curl、CA、git；绝不能在正式 NAS 执行。
sudo bash deploy/fnos/build-native.sh /tmp/new-native-output
```

输出目录必须不存在且位于源码目录外。脚本通过签名 apt 索引准备固定版本软件包、从带 Debian 补丁的 xorg-server 源码构建 Xvfb，并使用标准 lddtree 收集私有共享库。保留 NAS 的 glibc 2.36/loader；不在 NAS 安装浏览器依赖、不更改全局 LD_LIBRARY_PATH。锁定版本不可下载时构建失败，不能悄悄换浏览器。来源与许可证见 [THIRD-PARTY.md](THIRD-PARTY.md)。

Chromium 的可选动态加载也必须闭包：包内保留官方 SwiftShader ICD/loader，GIO/dconf、外置 `mymachines`/`mdns` NSS 插件和 VA 库及其 lddtree 依赖。进程环境限定私有 GIO、Vulkan ICD/layer、VA 路径，sysroot 优先于 Chromium 目录，避免 ANGLE 抢占 Mesa EGL；继续使用宿主 glibc，不允许宿主外置 NSS 或 GPU 库通过审计。NSS 插件可能查询宿主 systemd-machined/Avahi 服务，打包库并不安装或保证这些可选服务。构建 smoke 在真实带这些宿主库与 Mesa Vulkan 驱动的环境运行，并用标准 getent 实际加载两个私有 NSS 插件检查完整加载链；主包、诊断包及干净运行容器都注入宿主插件路径，仍须通过原有运行库审计。

Chromium 156 的 GPU pre-sandbox hook 会直接预加载硬件 Vulkan 库，绕过 ICD 环境配置；因此也收集官方 `mesa-vulkan-drivers` 的全部共享库及闭包，并检查真实 Chromium maps 中 Intel/Radeon 来自私有包。保留原 SwiftShader ICD，不启用 Mesa 的宿主 ICD/layer JSON。该上游 hook 还尝试 `libGLX_nvidia.so.0` 和 `libvulkan_freedreno.so`：Debian bookworm amd64 的 Mesa 包不提供这两项，本包也不分发 NVIDIA 专有驱动；若宿主存在可加载的这类额外驱动，现有审计仍会拒绝，不能宣称支持该宿主。

## 安装前提与正式切换

- 系统必须为实测兼容的 x86_64 / glibc 2.36，并支持非 root Chromium namespace sandbox；禁止添加 `--no-sandbox` 绕过。系统需有 `runuser`、标准 POSIX/Linux 工具和可信 `/usr/bin/python3`。安装钩子使用系统 Python 进行保留目录的安全属主恢复；包内 Python 或 python312 应用不能替代这个可信路径。缺少时安装明确失败，管理员应通过另行审核的官方系统安装方案准备 Python，然后重试；FPK 不自动修改 NAS apt 环境。
- 新建安装显式选择 fresh，填写真实 NAS HTTPS 主地址和附加 Origin。通过飞牛「系统设置 → 应用 → 五成ERP → 常规 → 桌面访问」管理应用入口。选择「设备内所有用户」会允许该设备的所有飞牛账号使用 ERP。账本保存在安装卷物理目录的 `@wuchengerp-data/erp`，卸载时保留。
- 现有实例迁移先停写、完整备份并恢复验证，再选择 migrate 和已经校验的停写副本。禁止旧容器和原生服务同时写入。保留原身份、锁、密码、历史和 UVCS 队列；不支持的原件绝对路径必须阻止切换。
- 当前实例已启用 UVCS 时，必须验证原生 cm 可执行及原 HOME/认证/队列，不能关闭托管以通过迁移。UVCS 不随 FPK 再分发；向导可明确选择由 root-owned appcenter 钩子安装固定官方 11.0.16.10616-1 amd64 deb，核对大小/SHA256/包字段后安装，禁止升级/移除无关软件。不设置认证，不携带私有凭据。
- 生命周期只在短暂准备阶段使用 root，Node/collector/两套浏览器全部使用专用 package 用户。长服务由已有 supervisor 管理，启停核对 generation、真实命令和账本身份；失败明确暴露。
- 运行目录使用飞牛提供的 `TRIM_PKGVAR`，先解析平台路径，再以 package 用户创建私有 `runtime` 子目录。日志、派生模块注册表和浏览器临时文件写入此处；账本、HOME、持久浏览器 profile、身份、密码、审计及权威控制/归属锁继续保存在 DATA。迁移不通过批量 chmod 旧业务文件解决日志写入问题。目录规范见[飞牛应用目录结构](https://developer.fnnas.com/docs/core-concepts/framework/)。

完成隔离诊断后，正式切换仍须依次验证账本摘要、两种入口的相同 serverId/dataSetId、权限/匿名拒绝、真实浏览器登录、UVCS、停止原 ERP 容器后的原生重启，以及 NAS 重启。保留旧 Docker 停机配置和原备份用于回退，不修改其他业务。

## 独立诊断包

`wuchengerpdiag` 只用于合成数据：独立包 UID、私有 `@wuchengerpdiag-data`、独立 Chromium profiles、29430–29434/29222–29223/29322–29323 回环端口和 display 222/223。它有单独编译固定 helper 路径的 Xvfb，不依赖正式 target，不加载正式 native_env，不读取正式配置、账本、UVCS 或 Tailscale。无远程入口、身份代理或长期报告服务。

官方安装 callback 降权后同步执行一次 smoke，240 秒后 TERM、再留 45 秒清理，返回后再用真实 nativeLifecycle stop 核对。成功后应用保持 stopped，证据位于 `@wuchengerpdiag-data/run-*/evidence/`。fnOS 对安装 hook 的实际时限尚未实机验证；若平台更早结束安装，应当作为诊断失败检查保留证据，不能据此宣称主包失败或擅自后台重试。命令行可用该包 `cmd/acceptance` 明确重试。

活跃诊断由系统 flock 租约串行化。外部 `cmd/main stop` 以诊断 UID 写入本次作业的取消请求，并等待作业及其客户端/fixture/原生进程清理结束；每次 native start 前同步检查取消。45 秒内无法确认作业清理时明确失败，不返回停止成功；原有 timeout 和真实 nativeLifecycle stop 继续保底。CI 分别在配置生成前和首次启动/MCP 连接后执行真实外部 stop 回归。

验收包含真实 SQLite、nativeLifecycle/collector、MCP 导航/快照/输入/下载、HTTPS/NSS、namespace/seccomp sandbox、上游 noVNC 到 x11vnc 的真实 RFB 画面和键鼠、中文显示截图、持久合成浏览器 session 和重启停止。中文输入法、真实平台登录和正式 fnOS 授权 GUI 仍需实机人工验收；诊断成功不替代正式主包固定路径与身份验收。


## 停写副本的 UVCS 连续性

旧 Windows 的 `originals\文件` 相对引用在文件读取边界转换为可移植分隔符，数据库、审计、锁、原件、版本快照和 outbox 不改写。盘符、UNC、绝对路径、点段、遍历、缺失原件和符号链接仍阻止迁移。新生成的销售备份使用规范相对路径并合并同一原件的重复引用。

启用 UVCS 的停写迁移副本必须附带可信的原工作区 ID、名称、仓库 RepSpec 和当前 `.plastic` 摘要。首次从旧部署封存时，操作员从原部署的只读记录取得身份后，传入固定 CLI 参数；不能把目标注册结果当作预期 ID：

```sh
node server/fnos-native/lifecycle.mjs seal-source --source /物理停写副本 --workspace-id 原工作区ID --workspace-name 原工作区名 --repository 原仓库规格
```

副本校验及 stage 原子发布后，package 用户仅以官方 `cm workspace list`、`cm showselector 最终工作区`、再次 `cm workspace list` 完成登记准备。全工作区字节必须不变，允许副本 HOME 的官方登记更新。准备失败会保留完整已发布账本、配置和 pending 状态，普通启动及直接 supervisor 启动都被阻止；修复环境后用 existing 配置重试。不能重建 workspace、编辑官方 XML、创建旧路径别名、回删已发布账本或关闭 UVCS。合法的新提交可以改变 `.plastic`；后续启动保留原身份，备份重新封存当前元数据摘要。

应用中心的“仅执行原生 UVCS 只读验证”默认关闭。开启时配置向导先安全停服，忽略本页其他设置，以 package 用户执行固定验证命令；不运行 prepare、安装 UVCS 或保存配置。它要求已准备且已登记的原工作区、现有 HOME、队列、CLI、停止的服务及无未确认命令租约。先核对本地登记，再查官方仓库和全部 submitted 事件的唯一 changeset；不创建 worker、不提交、不重试、不清理 staging。单个查询最多 60 秒，查询总预算最多 180 秒，超时取消确认本次子进程退出。

新脱敏报告保存至私有 `state/diagnostics/uvcs-verify-时间-随机ID.json`（0600），包含 UID、平台、Docker 标记、版本和事件匹配结果，不包含仓库地址、路径、凭据、人员或原始 CLI 输出。对 HOME、workspace、队列逻辑行和相关文件做前后检查；官方客户端若刷新认证或缓存，会报告状态变化并失败，不能称为纯只读成功。完成后在应用中心手动启动。报告只证明该执行环境的认证、仓库及已有提交映射，不证明附件恢复、新云端提交或真实平台登录。

系统 CLI 配置会将官方 `/usr/bin/cm` 链接解析为实体路径。只对系统 CLI 的链接链、实体和祖先应用 root 所有权检查：拒绝其他用户所有或任意用户可写，组可写仅接受 `gid=0` 的可信 root 组。官方固定包的 `/opt/plasticscm5/client` 为 root:root 775，属于这个明确假设；不修改它的权限。此例外不适用于账本、HOME、报告或 root 恢复钩子。每次直接 supervisor 启动还会在持有实例所有权后，以最多 10 秒的官方本地 list 核对当前登记，缺登记/身份漂移不会触发隐式修复；启动取消会终止这次查询。
