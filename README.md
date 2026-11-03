# 五成 ERP 浏览器工作台

采购、销售、经营总览通过系统 Node.js 24 运行，浏览器访问。ERP 已移除 Electron、安装器、组件下载、内置云仓和历史订单导出；云仓和灵兔买家订单导出使用各自的独立工作区。

```powershell
npm.cmd run web:dev
npm.cmd run web:check
npm.cmd run web:status
npm.cmd test
```

开发入口：http://127.0.0.1:28430/ 。默认使用 `.codex-artifacts/web-dev/data` 隔离账本，不自动连接正式数据。前端修改后刷新，模块后端修改后在空闲时自动重启。正式服务使用独立验收版本、显式数据配置和 Tailscale HTTPS。

- [开发说明](docs/development.md)
- [架构](docs/architecture.md)
- [运行、备份、更新与回退](docs/browser-service.md)
- [验收规则](docs/verification.md)
- [本次迁移状态](docs/browser-only-migration.md)

模块源码位于 `apps/purchase`、`apps/sales`、`apps/overview`；宿主与网关位于 `server/`；共享协议和加载资源位于 `shared/`。正式账本、登录授权、附件和备份不提交源码管理。旧版本源码从 Git 历史追溯。
