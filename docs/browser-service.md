# 浏览器工作台：开发、更新与恢复

采购、销售、经营总览使用浏览器和系统 Node.js 24；云仓与订单导出的桌面入口保留。本方案不生成 Electron 安装包。主机关机、休眠或网络断开时远程不可用。

## 日常修改

```powershell
npm.cmd run dev
npm.cmd run web:check
npm.cmd run web:status
node --test tests/web-*.test.mjs
```

浏览器打开 `http://127.0.0.1:28430/`。默认开发账本在源码目录 `.codex-artifacts/web-dev/data`，不会查询正式注册表或回退到正式数据。开发入口只监听本机；不要用反向代理把开发入口暴露给其他人。页面修改后刷新；模块 `lib/` 或 `server.mjs` 修改后，已启动模块会在无活动任务时重启。宿主 `server/` 的修改需要重启开发命令。原桌面源码启动命令为 `npm.cmd run desktop:dev`。

依赖缺失时使用系统 Node/npm，在源码根目录及三个 `apps/<模块>` 执行 `npm.cmd ci --ignore-scripts`。日常不重复安装依赖，不下载 Electron 或 Playwright Chromium 运行时。

## 正式版本与数据

正式程序使用源码目录以外的独立版本目录；配置、账本、附件、日志和备份放在稳定的数据目录。先核对 `Documents/LingtuWorkbench/workbench-location.json` 与注册表，不照示例猜测正式账本位置。

```powershell
node server/release.mjs E:\WuchengERP\releases\2026-11-03
npm.cmd run web:start -- --config E:\WuchengERP\config.json
npm.cmd run web:status -- --config E:\WuchengERP\config.json
npm.cmd run web:stop -- --config E:\WuchengERP\config.json
```

`release.mjs` 使用 Git 源码清单和 npm 锁文件准备目录；网页宿主仅安装 Fastify 及其 Cookie/代理插件，模块保留自己的锁定依赖。隔离服务验收通过才写入 accepted 清单。源码摘要变化后必须重新准备版本。它不生成安装器、ZIP 或桌面包。不要在已验收版本目录中继续修改源码。

配置示例（所有路径需换成实际核实的位置）：

```json
{
  "schemaVersion": 1,
  "mode": "production",
  "host": "127.0.0.1",
  "port": 28430,
  "publicOrigin": "https://你的主机.你的tailnet.ts.net",
  "stateDir": "E:/WuchengERP/state",
  "releaseRoot": "E:/WuchengERP/releases/2026-11-03",
  "modules": {
    "purchase": {"root":"E:/WuchengERP/releases/2026-11-03/apps/purchase","dataDir":"E:/WuchengERP/data/purchase","port":28431,"mobilePort":28434},
    "sales": {"root":"E:/WuchengERP/releases/2026-11-03/apps/sales","dataDir":"E:/WuchengERP/data/sales","port":28432},
    "overview": {"root":"E:/WuchengERP/releases/2026-11-03/apps/overview","dataDir":"E:/WuchengERP/data/overview","port":28433}
  }
}
```

正式模式拒绝缺失账本，不自动新建空账本。系统只托管三个模块，并阻止接管来源不明的已运行服务。宿主崩溃后，通过持久化归属记录、原启动记录及模块身份核对后恢复自己启动的子进程。

## Tailscale 与用户会话采集

使用系统 Tailscale 客户端，不使用旧内嵌 Tailnet 原型。核对客户端已登录、主机 MagicDNS 名称、HTTPS 能力与成员访问规则后配置 Serve，将私有 HTTPS 转发到 `http://127.0.0.1:28430`。保留其他 Serve 配置，不执行全局 reset；不启用 Funnel。

真实成员访问必须携带 Serve 注入的 `Tailscale-User-Login`。带标签的客户端设备没有该用户身份，不能建立网页会话；不要用自行填写请求头替代真实双机验收。所有已认证成员同权；范围由 Tailnet 网络访问规则限制。

需要菜鸟采集时，在原 Windows 用户已登录的会话中运行：

```powershell
npm.cmd run web:collector -- --config E:\WuchengERP\config.json
```

采集助手复用现有 Playwright MCP 扩展和固定业务适配器；不自动登录、连接或下载。账本服务通过带随机凭据的本机接口调用它，无法请求任意脚本或任意下载目录。Chrome 授权仍由原 Windows 用户的 DPAPI 保存。助手离线时界面提示需启动用户会话助手，记账与查询仍可使用。真实平台登录、验证码、下载与账单核对需单独实测。

## Windows 后台服务

使用官方 WinSW 2.12.0，下载入口为 `https://github.com/winsw/winsw/releases/tag/v2.12.0`，不自行实现 Windows 服务框架。

```powershell
node server/service-config.mjs E:\WuchengERP\config.json C:\ProgramData\WuchengERP\tools\WinSW-x64.exe E:\WuchengERP\service
```

该命令生成 XML 与固定的服务启动入口，并记录 wrapper 配置。核对输出后，使用返回的 install/start 命令注册和启动。启动入口每次读取当前 releaseRoot，更新程序无需重装服务。XML 配置开机启动、异常重启、日志轮转和 90 秒优雅停止；采集助手仍运行在用户会话中。Windows 服务账户须能访问版本和数据目录，不把浏览器授权改为系统级凭据。

## 备份、更新与回退

```powershell
npm.cmd run web:backup -- --config E:\WuchengERP\config.json --output E:\WuchengERP\backups\2026-11-03
node server/cli.mjs verify-backup --backup E:\WuchengERP\backups\2026-11-03
node server/cli.mjs restore-copy --backup E:\WuchengERP\backups\2026-11-03 --target E:\WuchengERP\restore-check
npm.cmd run web:update -- --config E:\WuchengERP\config.json --candidate E:\WuchengERP\releases\新版本
```

更新顺序：源码与环境检查 → 阻止新写入 → 等待在途启动、写入和采集 → 停止已托管模块及宿主 → SQLite 一致性备份与文件摘要校验 → 在业务副本上验证旧版、新版及回退读取结果 → 切换版本 → 启动三个模块并验证账本身份及关键只读 API。失败时保留或回退程序配置；不自动恢复旧账本。

备份目标必须为新目录；恢复只写入新目录，禁止覆盖现有账本。备份不包含历史备份、运行锁、日志、临时下载和采集助手连接记录。数据库与附件通过 SHA-256 和 SQLite integrity_check 校验。外部副本仍须复制到实际可信的外部存储并做恢复演练；源码版本管理不能替代业务备份。网关配置、身份和审计目录在 `stateDir/gateway`，应另随主机配置备份；更新过程持续保留该目录。

Unity Version Control 管理源码、配置模板与变更历史；忽略规则模板为 `docs/uvcs-ignore.conf`，根目录没有 `ignore.conf` 时可复制使用，已有规则须合并保留。正式配置、密钥、授权、SQLite、附件、运行状态及备份不提交。运行目录放在仓库外，开发产物位于已忽略的 `.codex-artifacts/`。

## 验收边界

本机接口测试、合成账本与正式账本副本验收可以自动执行。真实 Tailscale HTTPS、另一台设备、主机重启后的 Windows 服务、浏览器登录采集和正式切换必须逐项记录实际结果，不能由自动测试或 XML 存在代替。
