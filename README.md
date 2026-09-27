# 五成电子商务集团 ERP V2

这是五成电子商务集团的新一代本地优先 ERP。当前仓库以已经验证可用的 Windows 桌面库存工具为起点，逐步重做旧 ERP；旧服务器、旧 Web ERP 和云端同步链路不进入 V2。

## 当前能力

- 菜鸟云仓库存本地采集与登录状态维护
- 来源日期、SKU 数量和库存合计校验
- 全量商品库存、近 30 天销量、可售天数和补货预警
- 钉钉企业应用机器人本地直发
- Windows 桌面设置、计划任务和在线升级
- 面向 AI 的只读诊断、CLI、MCP 和受信扩展接口
- 敏感配置使用 Electron `safeStorage` 保存，不写入 Git

## V2 边界

- 不包含旧 Web ERP 或服务器部署代码
- 不包含云端 ERP 写入、SSH、WSL 或旧云同步入口
- 不迁移数据库、账号、密码、Token、Webhook、登录态、日志和构建密钥
- 新应用使用独立数据目录，不会覆盖旧软件的数据

## 本地开发

要求 Windows、Node.js 24 和 npm。

```powershell
npm.cmd ci --ignore-scripts
node node_modules/electron/install.js
npm.cmd run test:desktop
npm.cmd run desktop
```

构建 Windows 安装包：

```powershell
npm.cmd run desktop:build
```

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
