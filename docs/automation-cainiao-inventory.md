# 菜鸟库存每日本地直发流程

> Windows 本机完成菜鸟库存采集、数据校验、本地导入和钉钉企业应用机器人发送。
> 从 v0.4.1 起，日常库存流程不再依赖云端 ERP、SSH、WSL 或服务器目录。

## 推荐入口

桌面程序、CLI 和 MCP 共用同一套本地流程。普通用户优先使用已安装的桌面程序；源码运行使用：

```powershell
npm.cmd run sync:inventory:local
```

V2 只保留 `sync:inventory:local`；旧的 `sync:inventory:full` 和 `sync:inventory:cloud` 入口已移除。

AI 或脚本可调用：

```powershell
& "$env:LOCALAPPDATA\Programs\wucheng-ecommerce-erp-v2\五成电子商务集团 ERP V2.exe" --cli sync --confirm-send
```

该入口会依次完成：

1. 使用本机登录态进入菜鸟云仓库存页面。
2. 导出当前可用的最新库存明细。
3. 校验来源日期、SKU 行数、库存计算和跨日连续性。
4. 将通过校验的数据导入本机 SQLite。
5. 生成库存 Markdown 报告。
6. 由本机直接调用钉钉企业应用机器人发送唯一一条报告。

不会上传数据库，不会访问 ERP 服务器，也不会使用 WSL。

## 前置条件

源码模式必须确认：

- Node 和 `npm.cmd` 可用。
- `config.json` 能由 Node `JSON.parse` 解析。
- `tests/.auth/cainiao.json` 存在且能由 Node `JSON.parse` 解析。
- `.env.local` 包含菜鸟账号、钉钉企业应用机器人配置和低库存阈值。
- 没有活动的 `state/cloud-sync.lock` 或其他库存同步进程。

桌面模式的账号、密码和机器人配置保存在 Windows DPAPI 中。必须使用“企业应用机器人”发送方式，并配置：

- Client ID
- Client Secret
- Robot Code
- 群会话 ID
- 目标用户 ID（可选）

敏感值不得写入日志、Debug Bundle、Git 或自动化提示词。

## 登录处理

登录态文件结构有效不代表线上会话仍有效。登录态缺失或失效时：

```powershell
& "$env:LOCALAPPDATA\Programs\wucheng-ecommerce-erp-v2\五成电子商务集团 ERP V2.exe" --cli login --confirm-open-browser
```

程序会自动填写已保存的账号密码。出现验证码、滑块或短信验证时，必须由用户本人处理；超时或失败后停止，不自动循环重试。

## 发布门禁

`inventory_data_validations` 是发送前的强制门禁。以下任一情况都会阻止导入后续步骤和钉钉发送：

- 来源日期缺失或不符合显式指定日期。
- SKU 行数不足。
- 库存算术不平。
- 与相邻历史库存不连续。
- 报告快照日期与校验来源日期不一致。

本地直发失败后不得改用 Webhook，不得自动重试发送，也不得发送旧库存报告。

## 调度与防重复

Windows 桌面程序是唯一的每日调度器：

- 每天 `22:00` 执行。
- 随 Windows 登录启动并在后台保持运行。
- `workspace/state/desktop-task.lock` 阻止登录和同步并发。
- `state/cloud-sync.lock` 继续作为旧流程兼容锁检查，但本地直发不会创建服务器同步任务。

不要同时启用 Codex 每日自动化、Windows 任务计划或其他外部定时器，否则可能重复发送。

## 输入输出

| 类型 | 位置 | 说明 |
| --- | --- | --- |
| 登录态 | `tests/.auth/cainiao.json` | Playwright storage state |
| 下载文件 | `downloads/库存明细_YYYY-MM-DD_xxx.xlsx` | 菜鸟原始库存文件 |
| 数据库 | `data/erp.sqlite` | 本机 SQLite 数据和校验记录 |
| 桌面日志 | `%APPDATA%/wucheng-ecommerce-erp-v2/workspace/logs/desktop.log` | 脱敏运行日志 |
| 通知 | 钉钉群 | 企业应用机器人 Markdown 报告 |

## Agent 调用约定

当用户要求“抓取云仓库存并发送到钉钉”时：

1. 按本文件完成只读预检。
2. 登录态失效时先调用登录工具；验证码或滑块交给用户。
3. 仅在预检全部通过后执行一次 `sync:inventory:local` 或 CLI `sync --confirm-send`。
4. V2 不包含云同步或远程 ERP 入口。
5. 数据校验或发送失败后立即停止，不绕过门禁，不切换 Webhook，不自动重发。
6. 成功后报告来源日期、SKU 数、库存合计、钉钉发送结果和日志位置。
