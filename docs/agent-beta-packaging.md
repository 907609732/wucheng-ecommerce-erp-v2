# Beta 资源打包与依赖核对

正式构建脚本不能用于 Agent Beta：其固定清单不包含新 host/runtime、适配器及双引擎。测试包交付前，集成组需冻结 `agent-beta-resources/v1` 清单，提供两个引擎协议适配器的包内入口和 SHA-256（实际 Codex、Hermes 使用系统安装版本及独立 profile），以及四个独立应用各自包内根目录与适配器入口；仓库构建还须包含云仓适配器。将 runtime、host、各适配器及受信赖引擎资源纳入独立 Beta staging，并根据合入后的锁文件以生产依赖方式安装 `cron-parser` 和官方 ACP SDK；禁止复制个人 AI 配置或密钥。

运行 `node scripts/agent-beta-package-audit.mjs <stage>`：检查清单、引擎摘要、依赖是否在 staging、host/runtime 入口和独立模块的相对引用不越界。验证器只扫描静态字面量导入/require；动态表达式、Electron 内置模块和二进制运行行为必须由真实打包运行测试另外覆盖。尚未合入的 host、双引擎与模块适配器需由各负责人提供确切入口；现有 staging 构建器在计划、锁定依赖、五份审批证明或签名 vendor 缺失时拒绝，实际适配器尚未合入，尚无已验证的 staging 或可发行 Beta 包，安装器入口会在真实覆盖证据、资源审计和隔离运行证据全部通过前拒绝。

公共审批证明若从独立应用用 `../../../desktop/agent-runtime` 导入，将越出其独立包；模块负责人需将证明验证实现作为模块内受控公共依赖或明确 vendoring，同一版本与哈希应由集成测试固定，不能让独立服务访问工作区源码。

运行 `node scripts/agent-beta-stage.mjs --prepare` 会在 `dist/agent-beta/stages` 新建独立 staging，从当前仓库复制公开允许列表，分别安装锁定生产依赖并编译导出台；准备不产生安装器。导出台的 Electron 程序由其锁定版本构建并使用独立 Beta appId，随后校验资源清单。实际入口、导出台用户数据隔离和引擎登录仍需集成组在真实打包运行中验证。

当前 `build/agent-beta-stage-plan.json` 根据各组公开的源码入口预配置，Beta 版本暂定 0.11.6；如集成后的主程序版本不低于该版本，必须调整后重做证据。`dist/agent-beta/vendor` 须提供可信签名 catalog 及对应固定 Node 和浏览器 ZIP，构建器核对签名、大小和 SHA-256。引擎依赖系统已有官方安装，不打包个人完整运行时或个人配置。

准备开始前及复制后均调用 `scripts/sync-agent-approval.mjs` 的默认只读检查；源代码、模块副本或构建期间哈希变化时失败，绝不自动同步安全协议。主机需要在首次准备时将经验证的程序集放入独立 Beta programs 路径后再调用 `validateBetaReady`；账本缺失时设置页可以显示未准备，但业务操作必须拒绝。

Hermes Python 进程无法直接执行 ASAR 内虚拟路径。Beta 构建配置将 `hermes-bootstrap.py` 复制到 `resources/agent-engines/hermes-bootstrap.py`；运行时组必须让打包态显式使用该包外路径，并通过真实打包验证。

内部隔离目录构建使用 LINGTU_AGENT_BETA_INTERNAL_DIR=1 并显式传 --dir；须先准备与 staging 摘要绑定的 stage-public-scan.json，禁止用该模式生成 NSIS。真实安装器仍要求完整能力证据与真实打包隔离运行证据。云仓 worker 及 core 随主程序与网关一起装入；动态子进程实际运行仍需验证。Beta 组件必须由主机激活器安装到独立 programs 路径，不能回退旧稳定版目录；当前激活器联调未完成。

预览与完整 Beta 的宿主版本由 build/agent-beta-stage-plan.json 唯一提供；预览使用隔离 staging 的 package.json 作为 NSIS 项目并根据该版本定位产物。主机和独立网关为各业务适配器携带各自锁定的生产依赖；各目录及动态 worker、原生 Electron 程序仍须在统一打包验收中实际启动。
