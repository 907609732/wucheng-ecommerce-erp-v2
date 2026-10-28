# Beta 资源打包与依赖核对

正式构建脚本不能用于 Agent Beta：其固定清单不包含新 host/runtime、适配器及双引擎。测试包交付前，集成组需冻结 `agent-beta-resources/v1` 清单，提供两个引擎的包内入口和 SHA-256，以及四个独立应用各自包内根目录与适配器入口；仓库构建还须包含云仓适配器。将 runtime、host、各适配器及受信赖引擎资源纳入独立 Beta staging，并根据合入后的锁文件以生产依赖方式安装 `cron-parser` 和官方 ACP SDK；禁止复制个人 AI 配置或密钥。

运行 `node scripts/agent-beta-package-audit.mjs <stage>`：检查清单、引擎摘要、依赖是否在 staging、host/runtime 入口和独立模块的相对引用不越界。验证器只扫描静态字面量导入/require；动态表达式、Electron 内置模块和二进制运行行为必须由真实打包运行测试另外覆盖。尚未合入的 host、双引擎与模块适配器需由各负责人提供确切入口；当前没有 staging 构建器或可发行 Beta 包，原有 Beta 构建入口继续强制拒绝。

公共审批证明若从独立应用用 `../../../desktop/agent-runtime` 导入，将越出其独立包；模块负责人需将证明验证实现作为模块内受控公共依赖或明确 vendoring，同一版本与哈希应由集成测试固定，不能让独立服务访问工作区源码。
