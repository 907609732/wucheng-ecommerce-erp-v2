# 五成 ERP

**简体中文（默认）** | [English](README.en.md)

采购、销售、经营总览共用的浏览器工作台。正式环境使用飞牛应用中心安装的原生应用，从飞牛桌面进入；运行不依赖 Docker，也不需要在电脑上另装 ERP。

## 版本状态

截至 2026-11-12 的验收记录：

| 版本 | 状态 | 菜鸟浏览器 |
| --- | --- | --- |
| [0.15.6](https://github.com/907609732/wucheng-ecommerce-erp-v2/releases/tag/v0.15.6) | 最近一次实机核验的正式安装版本 | 销售与经营总览分别保留登录资料 |
| 0.15.7 | 已构建并归档到私有发布草稿，尚未安装到正式 NAS | 一个 Chromium 共用登录状态，各模块使用受控标签页 |

候选包软件提交：`aa6218c2f004c98b609b7ce97b91c91b55ef4ead`。[完整构建](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/43155768567)有 962 项通过、0 项失败、3 项条件跳过，并通过干净运行环境验收。[归档任务](https://github.com/907609732/wucheng-ecommerce-erp-v2/actions/runs/43157591549)保留同次 FPK、对应源码及校验文件。CI 通过不代表正式 NAS 已升级，也不代替真实平台账号采集验收。

## 飞牛使用与更新

- 从飞牛桌面打开五成 ERP，桌面访问允许设备内所有用户。ERP 仍校验飞牛可信入口与会话；业务密码、复核和月锁继续生效。
- 「菜鸟登录」显示 NAS 上的 Chromium，随包提供 Xvfb、VNC 和 noVNC；不使用另装的飞牛 Chrome，也不需要额外浏览器容器。
- 用户自行完成登录和人机验证。0.15.7 共用原销售资料，保留旧经营总览资料，不合并 Cookie 数据库。切换平台账号影响两个模块，采集前须确认账号。
- 先隔离试装并验证备份，再升级正式应用；选择沿用已有数据，核对程序版本、账本身份和数据版本托管状态。不能新建空账本替代原账本。

完整步骤见 [运行维护（中文）](docs/operations.md) / [Operations (English)](docs/operations.en.md)。账本、附件、登录资料、密钥和备份不提交 Git。

## 源码开发

需要 Node.js 24 或更新版本、npm、Git。发行包自带运行环境；开发数据与正式账本隔离。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd --prefix apps/purchase ci --ignore-scripts
npm.cmd --prefix apps/sales ci --ignore-scripts
npm.cmd --prefix apps/overview ci --ignore-scripts
npm.cmd run web:dev
```

开发入口为 `http://127.0.0.1:28430/`，默认数据目录为 `.codex-artifacts/web-dev/data`。端口冲突时传入独立的 development 配置及数据目录：`npm.cmd run web:dev -- --config <配置路径>`。

```powershell
npm.cmd run web:check
npm.cmd test
npm.cmd run test:purchase
npm.cmd run test:sales
npm.cmd run test:overview
npm.cmd run check:ui
```

模块：`apps/purchase`、`apps/sales`、`apps/overview`；宿主与网关：`server/`；共享协议：`shared/`；共享样式：`ui/`。云仓和买家订单导出使用独立项目。

## 文档导航

- [开发说明](docs/development.md) · [架构](docs/architecture.md) · [共享 UI](ui/README.md)
- [原生飞牛打包工作流](.github/workflows/fnos-native.yml) · [验收规则](docs/verification.md)
- [数据版本托管](docs/data-version-operations.md) · [历史迁移记录](docs/browser-only-migration.md)

历史浏览器服务和迁移文档用于追溯，当前环境以运行维护文档为准。清理旧程序或测试目录前须核对运行实例、挂载及备份用途，不执行全局 Docker prune，不连带删除账本、独立云仓或其他服务。仓库保留源码、锁文件、运行资源和文档；构建产物由发布流程交付。
