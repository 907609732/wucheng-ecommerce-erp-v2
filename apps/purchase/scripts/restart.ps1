$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskUrl = 'http://127.0.0.1:17868'
$taskListener = @(Get-NetTCPConnection -LocalPort 17868 -State Listen -ErrorAction SilentlyContinue)
if ($taskListener.Count -gt 0) {
    $taskHealth = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 2
    if ($taskHealth.app -ne 'purchase-desk') { throw 'Port 17868 belongs to another application.' }
    $taskPidPath = Join-Path $taskRoot 'logs\server.pid'
    if (-not (Test-Path -LiteralPath $taskPidPath)) { throw 'Cannot safely identify the app process: server.pid is missing.' }
    $taskServerId = [int](Get-Content -LiteralPath $taskPidPath -Raw).Trim()
    if (@($taskListener | Where-Object OwningProcess -ne $taskServerId).Count -gt 0) { throw 'The listener does not match the saved app process.' }
    $taskServer = Get-CimInstance Win32_Process -Filter "ProcessId=$taskServerId"
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    if ($taskServer.ExecutablePath -ne $taskNode -or $taskServer.CommandLine -notmatch '\bserver\.mjs(?:"|\s|$)') { throw 'The saved process is not the expected Node app.' }
    Stop-Process -Id $taskServerId -ErrorAction Stop
    Wait-Process -Id $taskServerId -Timeout 10 -ErrorAction SilentlyContinue
}
& (Join-Path $PSScriptRoot 'start.ps1')
