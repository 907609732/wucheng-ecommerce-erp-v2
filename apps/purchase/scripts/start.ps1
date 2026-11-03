$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskUrl = 'http://127.0.0.1:17868'
$taskHealth = $null
try { $taskHealth = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 2 } catch {}
if ($taskHealth) {
    if ($taskHealth.app -eq 'purchase-desk') {
        $taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
        if ($taskHealth.version -ne $taskVersion) { throw "后台仍是 $($taskHealth.version)，本地文件为 $taskVersion。旧后台没有退出，请关闭旧灵兔采购台后台或重启电脑后再启动。" }
        Start-Process $taskUrl
        exit 0
    }
    throw 'Port 17868 is in use by another application.'
}
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\express'))) {
    throw 'Dependencies are missing. Run npm.cmd ci in this folder first.'
}
$taskLogs = Join-Path $taskRoot 'logs'
New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
$taskProc = Start-Process -FilePath $taskNode -ArgumentList 'server.mjs' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLogs 'server.log') -RedirectStandardError (Join-Path $taskLogs 'server-error.log')
$taskProc.Id | Set-Content -LiteralPath (Join-Path $taskLogs 'server.pid')
for ($taskRetry = 0; $taskRetry -lt 40; $taskRetry++) {
    Start-Sleep -Milliseconds 500
    if ($taskProc.HasExited) { throw 'The app failed to start. See logs/server-error.log.' }
    try { $taskHealth = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 1; if ($taskHealth.app -eq 'purchase-desk') { Start-Process $taskUrl; exit 0 } } catch {}
}
throw 'App startup timed out. See logs/server-error.log.'
