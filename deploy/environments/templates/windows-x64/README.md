# Windows x64 环境包

使用 `start.ps1 configure` 首次配置，明确提供 HTTPS origin 与独立数据目录；随后可用 `start.ps1 start|serve|status|stop` 管理进程。所有命令固定使用包内 `runtime/node/node.exe`。请将账本、配置和备份放在包目录之外。

在解压目录打开 PowerShell，首次新建示例（将地址改为这台机器实际的 Tailscale HTTPS 地址）：

```powershell
$data = Join-Path $env:LOCALAPPDATA 'WuchengERP\data'
.\start.ps1 configure --mode fresh --release (Join-Path $PWD.Path 'erp') --data $data --origin 'https://YOUR-HOST.YOUR-TAILNET.ts.net'
.\start.ps1 serve --config (Join-Path $data 'config\web.json')
```

已有账本不要使用 fresh；先备份，再按明确的 existing/migrate 流程处理。HTTPS 转发由主机上的 Tailscale Serve 配置，环境包不会更改组网设置。

Windows 使用现有用户浏览器扩展，不会安装或登录浏览器。默认以前台当前用户运行。需要 Windows 服务时，可自行评估 WinSW 并引用仓库中的 `server/service-config.mjs` 配置约定；本包不会自动安装服务，也不会以 LocalSystem 启动。
