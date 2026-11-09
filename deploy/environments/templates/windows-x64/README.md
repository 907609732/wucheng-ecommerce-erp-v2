# Windows x64 环境包

使用 `start.ps1 configure` 首次配置，明确提供 HTTPS origin 与独立数据目录；随后可用 `start.ps1 start|serve|status|stop` 管理进程。所有命令固定使用包内 `runtime/node/node.exe`。请将账本、配置和备份放在包目录之外。

Windows 使用现有用户浏览器扩展，不会安装或登录浏览器。默认以前台当前用户运行。需要 Windows 服务时，可自行评估 WinSW 并引用仓库中的 `server/service-config.mjs` 配置约定；本包不会自动安装服务，也不会以 LocalSystem 启动。
