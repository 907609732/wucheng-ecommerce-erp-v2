# 云仓库存同步（Windows EXE）

## 功能

- 所有业务配置统一放在“设置”页，菜鸟账号、钉钉机器人和自动任务可分别保存。
- 密码、Client Secret 和 Webhook 由 Electron `safeStorage` 调用 Windows DPAPI 加密保存。
- 支持钉钉企业应用机器人和群 Webhook 两种发送方式。
- 支持立即同步、人工刷新菜鸟登录态、运行中强制中止任务、每日库存同步、每月销量同步和登录 Windows 后自动启动。
- “销售趋势”页支持月/年折线图、单 SKU、Top 5、月度排名和最近 24 个月历史补抓；月销量任务不会发送钉钉。
- 支持从私有 GitHub Releases 自动检查、后台下载并重启安装新版本。
- AI Runtime 支持源码、CLI、本地 stdio MCP、便携 EXE 和安装版，并提供能力发现、Debug Bundle、显式信任扩展和脱敏日志检索。
- 每日库存链路固定为本机直发，不要求云端 ERP、SSH 或 WSL；企业应用机器人配置仍由 Windows DPAPI 保护。
- 登录过期、验证码/滑块、库存数据校验失败或发送失败时立即停止，不自动重试。
- 数据、登录态、日志和 SQLite 数据库保存在当前 Windows 用户的应用数据目录，不写回安装目录。

## 使用

1. 安装 `CloudWarehouseInventorySync-Setup-版本-x64.exe`，或直接启动 `CloudWarehouseInventorySync-Portable-版本-x64.exe`。
2. 进入“设置”，在“菜鸟账号”中单独保存账号和密码。
3. 在“钉钉机器人”中单独选择发送方式：
   - 企业应用机器人：填写 Client ID、Client Secret、Robot Code、群会话 ID；目标用户 ID 可选。
   - 群 Webhook：填写 Webhook 地址；启用了加签时再填写加签密钥。
4. 在“自动任务”中保存每日执行时间、低库存阈值和开机启动选项。
5. 首次使用或登录失效时点击“登录 / 刷新菜鸟状态”，在弹出的 Chrome 中完成人工验证。
6. 点击“立即同步并发送”验证完整流程。
7. 在线升级凭据由企业发布流程内置，每台电脑无需填写 Token；软件启动后会自动检查，也可在运行概览点击“检查更新”。
8. 在“AI 接口”区域查看运行形态、扩展目录、CLI 命令和 MCP 配置；完整说明见 [ai-interface.md](ai-interface.md) 与 [extensions.md](extensions.md)。

软件启用每日任务后，关闭主窗口只会隐藏程序；再次从桌面或开始菜单启动即可恢复窗口。
首次安装时自动同步和开机启动均保持关闭，只有保存完整配置并主动勾选后才会启用。

## 构建

```powershell
npm.cmd install
npm.cmd run test:desktop
npm.cmd run desktop:build
```

输出位于 `dist/`：NSIS 安装包和 portable EXE。未配置 Windows 代码签名证书时，构建产物是未签名版本，其他电脑首次运行可能显示 SmartScreen“未知发布者”。

## GitHub 发布

推送 `v*` 标签后，`.github/workflows/release.yml` 会在 Windows runner 上测试、构建，并发布 NSIS 安装包、portable EXE、`latest.yml` 和 blockmap。在线更新以 NSIS 安装版为准；portable 版本用于免安装运行，不参与原位更新。

发布仓库必须配置 Actions Secret `CAINIAO_INTERNAL_UPDATE_TOKEN`。它应当是仅授权本私有仓库、只有 `Contents: Read` 权限的专用 Fine-grained Token。构建时令牌进入独立资源文件；客户端首次启动后将其转存 Windows DPAPI，并删除安装目录中的资源副本。
