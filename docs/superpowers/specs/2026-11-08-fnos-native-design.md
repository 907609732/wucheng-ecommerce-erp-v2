# 完整飞牛原生 ERP 应用

## 目标与授权

用户明确选择完整原生飞牛应用，授权直接实施、保留现有账本与 Tailscale 备用入口，迁移前备份。继续由开发子智能体执行，主智能体监督集成。此要求替代上一版薄入口包的职责；沿用现有 ERP 界面和权限规则。

## 方案

选择官方 Native FPK：内含固定版本 Node 24、Linux 生产依赖、ERP 三模块、原生采集浏览器及远程登录界面。应用中心管理启停，不再调用或依赖 Docker。先支持实测 x86_64 NAS，包 manifest 必须 platform=x86；ARM 另行验证，不能标 all。

比较：继续依赖系统应用运行时会增加他人安装的前提；Docker 包不满足用户目标。采用构建阶段准备依赖、官方 fnpack 生成包的方式。复用官方 Native 示例、Debian 软件包、Chromium、现有 Playwright MCP、noVNC 与成熟反向代理组件，不重写打包、远程桌面或浏览器协议。

## 程序、数据和身份

- 可替换程序位于 TRIM_APPDEST；持久账本/附件/网关身份/统一月锁密码/审计/UVCS 队列/浏览器 profile 位于独立持久数据根，安装向导提供新建和迁移两种明确模式。默认持久根为物理存储空间 `TRIM_APPDEST_VOL/@wuchengerp-data`，不置于可能随卸载删除的 var。root 只创建并严格核对这一个私有目录，运行用户拥有0700权限；卸载始终保留数据，并显示位置。
- 迁移输入必须是已停止写入并校验完整的副本。复制进私有持久根，保留 serverId/dataSetId、原件、锁和密钥；原 Docker 数据保留为停机回退材料。迁移不能把缺失数据库当新建初始化。正式旧容器与原生服务不得同时写入。
- 迁移不能批量 UPDATE 原件路径：真实账本有数据版本触发器和月锁，业务库、快照、outbox 字节须保留。正常相对路径直接沿用目录布局；只读检查旧绝对路径，如存在则由明确旧根映射在文件读取边界解析，未实现或无法核实的映射必须阻止切换，不能删除触发器、临时解锁或注册假授权函数绕过。
- 新建安装显式初始化三个空账本，之后切为 production；不放入开发身份或开放 TCP。向导收集 NAS 访问地址、授权 UID；实例身份首次生成且持久保存。新建默认 fnOS-only，TCP 身份入口禁用，publicOrigin 使用用户配置的真实 NAS HTTPS 地址；可另配 Tailscale。迁移沿用原授权、instanceId 与 Tailscale publicOrigin，并启用原 TCP 备用入口。
- Unix 网关保持受控物理目录、当前运行用户拥有、0600 socket 和既有唯一 generation 契约。应用生命周期可用最小 root 准备目录/属主，所有长期服务降权为专用 package 用户；不赋予 Docker socket 或主机根目录访问权限。
- 保留 127.0.0.1:28430 和现有 Tailscale Serve；不启动第二套 Tailscale、不修改网络/DNS、不带走他人的凭据。
- 分发包不含真实账本、NAS 地址/UID白名单、管理员密码、会话、UVCS 认证或浏览器 profile。

## 生命周期

主入口实际启动一个受控 supervisor，启动 ERP、collector 和两套浏览器；保存 PID 与随机 generation 并检查真实命令/身份，不能依靠任意 pidfile kill。start 等待健康就绪；status 同时核对 ERP 身份与 supervisor；stop 先停写、排空任务，再有界停止进程树，不能 pkill 广泛匹配。异常进程记录明确失败并有界恢复，避免重启循环。端口/锁冲突失败而非覆盖。

升级先维护停写，完成完整备份/恢复检查后更新；程序失败保留原账本回退，不自动恢复陈旧数据。默认卸载保留账本，并给出可恢复位置；删除数据需要单独明确选择，且仅限本应用实际持久目录。持久目录不得在可替换 target 内。

## 原生浏览器

沿用销售和经营总览两套独立 profile 与回环 CDP 端口 19222/19223。原生 Xvfb + x11vnc + Debian bookworm-security Chromium；Playwright MCP 继续使用锁文件版本，连接现有 CDP 适配器，构建验收必须证明导航、快照、输入和下载兼容。当前 Playwright 下载的是 Chrome for Testing，未核实其二进制再分发授权，因此采用 Debian 可再分发构建，并提供对应源码及许可证。noVNC 复用上游组件；LibVNCServer 原生 WebSocket 经成熟代理转发，不编写 VNC 桥。

图形登录页从 ERP 已认证入口打开；静态资源、HTTP 与 WebSocket 均校验身份和会话，WebSocket 强制同源 Origin。未认证不能看到已登录浏览器。CDP/VNC/X11 均不监听公网；不允许客户端选择代理目标。保留人工扫码/验证码流程，不能声称迁移后登录态一定有效；需要时由用户重新登录。浏览器和相关服务也由应用启停，Docker 关闭后仍可用。

## 构建与外部依赖

Linux Debian bookworm CI 构建生产依赖（sharp/canvas 等原生模块），不能使用 Windows node_modules。捆绑固定 Node 24 官方发行并校验 SHA256；准备浏览器 ELF、共享库、X11/字体资源，使用现成 lddtree/dpkg 工具核对依赖，NAS 不临时 apt 安装依赖。捆绑组件版本、许可证、来源与对应源码材料随发行提供。

UVCS 为可选集成，新用户不预设用户仓库。当前实例需保留已启用的 UVCS 及专用 HOME/认证/队列；仅在确认原生 cm 路径可运行后迁移，不静默关闭托管。运行时/第三方 CLI 可按官方安装方式系统安装（用户已授权常用系统环境），分发说明应明确可选集成条件，不能将专有 CLI 凭据放入 FPK。

## 验收与迁移顺序

1. 当前 NAS 只读环境核对 CPU、OS/libc、包用户、运行路径、浏览器及 UVCS；记录当前三模块摘要、身份与队列。
2. 在隔离目录验证新安装、迁移失败保护、升级/停止/重启、密码与锁保留、浏览器握手、字体/交互、未授权访问拒绝；运行 Linux 自动化与 GitHub 检查。
3. 停写 ERP 与采集、停止旧浏览器，完整备份 config/data/state/data-version/UVCS HOME/browser profiles 并恢复到副本验证；再迁移切换原生唯一服务。
4. 验证飞牛本地/公网入口及 Tailscale 同一账本、摘要一致、UVCS 无异常、浏览器可人工登录；停止全部 ERP 相关 Docker 容器后重复检查，正常应用重启验收。
5. 旧 Docker 保留停机可回退配置；不删除其他 Docker 应用或全局 Docker 服务。交付可独立安装 FPK 与 SHA256、简短使用说明和明确未完成项。无实机证据不宣称可用。
