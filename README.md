# 浏览器工作台（日常入口）

采购、销售、经营总览已支持系统 Node.js 24 直接运行。`npm.cmd run dev` 启动浏览器开发入口 http://127.0.0.1:28430，使用隔离数据；其他电脑通过正式 Tailscale HTTPS 入口访问。

- 修改前端后刷新，修改模块后端后自动重启对应服务。
- `npm.cmd run web:check` 检查环境与入口；`npm.cmd run web:status` 检查服务。
- 正式运行、备份、免安装包更新与 WinSW 配置见 [浏览器运维说明](docs/browser-service.md)。
- 原 Electron 源码开发入口保留为 `npm.cmd run desktop:dev`。

# 五成电子商务 ERP 工作台

当前唯一维护主线：五模块轻量业务工作台。保留云仓同步、采购、销售、经营收支总览、历史订单导出及外部 MCP/CLI；继续使用独立预览身份，不迁移正式账本。本轮源码改造与交付验收状态分开记录。

## 当前文档

- [统一功能架构](docs/architecture.md)：模块、进程、接口、数据与验证状态。
- [开发与构建](docs/development.md)：环境、缓存和唯一命令入口。
- [发布与打包](docs/release-packaging-policy.md)：轻量安装器、签名组件和发布边界。
- [验收规则](docs/verification.md)：快速、集成、发版及性能测量。
- [运行维护](docs/operations.md)：数据位置、备份与故障排查。
- [功能说明](docs/feature-manual.md)：云仓页面操作和业务口径。
- [当前优化清单](docs/轻量化方案-0.11.8.md)：已选方向、卡点与待验证事项。

## 常用命令

日常开发直接运行 `npm.cmd run dev` 从源码打开软件，再按改动运行 `npm.cmd run verify:quick` 和相关页面验收，无需构建或安装。只有明确需要交付安装包，或验证安装、升级、组件分发时才运行构建与打包。

`npm.cmd run dev` 启动隔离预览；`npm.cmd run build` 增量构建资源；`npm.cmd run build:installer` 扫描、签名并生成轻量安装器；`npm.cmd run verify:quick`、`verify:integration`、`verify:release` 分层验证。

默认只生产轻量安装器，业务模块和共享运行时从匹配版本的 GitHub Release 按需下载。新版本未发布时下载地址尚不可用，必须明确报告失败；构建成功不代表已经安装、联网或完成真实平台验收。

## 源码与证据

模块唯一清单：`desktop/product/modules.mjs`。`desktop` 为外壳、共享服务及业务接口，`core` 为云仓业务，`apps` 为其余模块，`scripts/engineering` 为统一流程，`tooling/build-units` 为 Turborepo 任务。

测试与构建报告在 `.codex-artifacts/engineering`，不再为每轮运行增加 docs 文档。旧路线文档已删除，历史从 Git 追溯；清理前未提交文档另留本地副本。机器可读覆盖清单保留供现有工具使用。
