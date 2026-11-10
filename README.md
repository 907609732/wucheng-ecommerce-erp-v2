# 五成 ERP 浏览器工作台

采购、销售、经营总览共用一套代码，浏览器访问。开发环境使用系统 Node.js 24；Windows、Linux、飞牛发行包自带 Node.js，运行不依赖 Docker。ERP 已移除 Electron、组件下载、内置云仓和历史订单导出；云仓和灵兔买家订单导出使用各自的独立工作区。

```powershell
npm.cmd run web:dev
npm.cmd run web:check
npm.cmd run web:status
npm.cmd test
```

开发入口：http://127.0.0.1:28430/ 。默认使用 `.codex-artifacts/web-dev/data` 隔离账本，不自动连接正式数据。前端修改后刷新，模块后端修改后在空闲时自动重启。正式服务使用独立验收版本、显式数据配置和 Tailscale HTTPS。

日常修改先直接运行源码开发版；相关业务源码推送主分支后，统一工作流构建同次三平台环境包，不自动部署或切换正式入口。已有正式服务占用默认端口时，使用 `npm.cmd run web:dev -- --config <开发配置路径>` 指定另一组端口及工作区外的隔离数据目录；该配置必须为 `development`，开发命令拒绝正式数据配置。

- [开发说明](docs/development.md)
- [Windows、Linux、飞牛环境包](docs/environment-packages.md)
- [架构](docs/architecture.md)
- [运行、备份、更新与回退](docs/browser-service.md)
- [验收规则](docs/verification.md)
- [正式数据版本托管](docs/data-version-operations.md)
- [本次迁移状态](docs/browser-only-migration.md)

模块源码位于 `apps/purchase`、`apps/sales`、`apps/overview`；宿主与网关位于 `server/`；共享协议和加载资源位于 `shared/`。正式账本、登录授权、附件和备份不提交源码管理。旧版本源码从 Git 历史追溯。

## 仓库与工作区清理约定

仓库保留源码、文档、运行资源、测试夹具、依赖锁文件及 CI 配置。程序包、安装器、node_modules、账本、登录资料、临时报告与构建产物不作为仓库内容维护。历史发布说明、标签和 Git 历史保留；旧发布附件与 Actions 产物已清理。

源码工作区清理后，需要开发时先在根目录及三个 apps 模块执行 `npm.cmd ci --ignore-scripts`。正式运行使用工作区外的独立版本与数据目录，不依赖这里的 node_modules。CI 不持久化 npm 缓存；主分支相关源码更新会统一构建三平台包，也保留手动构建入口。

## 统一样式与时间选择

三个业务台及浏览器导航共用 ui/ 的设计令牌。统计期间、筛选月份、任务月份和月度确认使用同一期间组件；修改共享层后执行 `npm.cmd run sync:ui`，用 `npm.cmd run check:ui` 校验副本。恢复来源及接口见 [共享 UI 说明](ui/README.md)。
