# 云仓库存同步

这是灵兔电商启动台与云仓同步模块的源码仓库。0.8.0 起，首次安装只提供启动台；云仓同步、采购台、销售台按需下载，采购中的历史订单导出台和销售中的经营收支总览独立安装。

模块及固定版本运行环境由官方 GitHub Releases 分发，支持完整离线扩展包。现有用户沿用原账本和登录目录，卸载模块只删除托管程序文件。安装器无需用户预装 Node.js、npm 或 Chrome。

安装、签名、版本兼容和接口见 [按需扩展接口 v1](docs/按需扩展接口-v1.md)。原本机扩展协议见 [业务接口 v1](docs/本机扩展接口-v1.md)；托管模块的路径和运行环境以新文档为准。

## 当前能力

- 菜鸟云仓库存本地采集与登录状态维护
- 来源日期、SKU 数量和库存合计校验
- 全量商品库存、近 30 天销量、可售天数和补货预警
- 钉钉企业应用机器人本地直发
- Windows 桌面设置、计划任务和在线升级
- 面向 AI 的只读诊断、CLI、MCP 和受信扩展接口
- 敏感配置使用 Electron `safeStorage` 保存，不写入 Git
- [各功能说明书与技术原理](docs/feature-manual.md)：各页右上角可离线阅读，含操作步骤、数据来源、核对口径、常见问题及未接通能力

## V2 边界

- 不包含旧 Web ERP 或服务器部署代码
- 不包含云端 ERP 写入、SSH、WSL 或旧云同步入口
- 不迁移数据库、账号、密码、Token、Webhook、登录态、日志和构建密钥
- 程序与数据分离；升级复用原数据位置，首次接入前备份

## 本地开发

要求 Windows、Node.js 24 和 npm。

```powershell
npm.cmd ci --ignore-scripts
node node_modules/electron/install.js
npm.cmd run test:desktop
npm.cmd run launcher
```

构建 Windows 安装包：

```powershell
npm.cmd run launcher:build
```

上述命令生成纯启动台。`desktop:build` 保留为云仓业务模块的独立构建入口，不能代替启动台发布。采购、销售、总览、导出台在各自工作区维护，按 `scripts/build-module-pack.mjs` 的白名单打包；签名私钥必须保存在仓库外。

## AI 接口

```powershell
npm.cmd run ai:status
npm.cmd run ai:doctor
npm.cmd run ai:mcp
npm.cmd run ai:inspect:tools
```

会产生真实登录、采集或发送副作用的操作仍需要显式确认。接口不会返回密码、密钥或 Token。

## 目录

- `desktop/`：Electron 界面、CLI、MCP、诊断和扩展运行时
- `core/`：本地库存采集、校验、数据库与钉钉适配器
- `tests/`：单元、接口和桌面界面验收
- `build/`：Windows 打包配置
- `docs/`：运行、AI 接口和扩展说明

## 仓库

GitHub：<https://github.com/907609732/wucheng-ecommerce-erp-v2>

本仓库为企业内部私有项目。

## v0.6.0 功能范围

仅保留云仓库存同步、库存明细、补货预警、云仓销量和必要公共设置。其他业务模块的源码、专用资源和业务表已删除。
