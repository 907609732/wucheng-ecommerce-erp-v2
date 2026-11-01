param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$OverviewRoot = Split-Path -Parent $PSScriptRoot
$OverviewPort = if ($env:OVERVIEW_PORT) { [int]$env:OVERVIEW_PORT } else { 17890 }
$OverviewUrl = "http://127.0.0.1:$OverviewPort"
$OverviewHealthy = $false
try { $OverviewHealth = Invoke-RestMethod "$OverviewUrl/api/health" -TimeoutSec 2; $OverviewHealthy = $OverviewHealth.app -eq 'lingtu-business-overview' } catch {}
if (-not $OverviewHealthy) {
    if (Get-NetTCPConnection -State Listen -LocalPort $OverviewPort -ErrorAction SilentlyContinue) { throw "端口 $OverviewPort 被其他程序占用。请设置 OVERVIEW_PORT 为其他空闲端口。" }
    $OverviewNode = (Get-Command node.exe).Source
    $OverviewLog = Join-Path $OverviewRoot 'data'
    New-Item -ItemType Directory -Force -Path $OverviewLog | Out-Null
    $OverviewProcess = Start-Process -FilePath $OverviewNode -ArgumentList 'server.mjs' -WorkingDirectory $OverviewRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $OverviewLog 'server.log') -RedirectStandardError (Join-Path $OverviewLog 'server-error.log') -PassThru
    Set-Content -LiteralPath (Join-Path $OverviewLog 'server.pid') -Value $OverviewProcess.Id -Encoding ascii
    for ($OverviewAttempt=0; $OverviewAttempt -lt 30; $OverviewAttempt++) {
        Start-Sleep -Milliseconds 300
        try { $OverviewHealth = Invoke-RestMethod "$OverviewUrl/api/health" -TimeoutSec 1; if ($OverviewHealth.app -eq 'lingtu-business-overview') { $OverviewHealthy=$true; break } } catch {}
        if ($OverviewProcess.HasExited) { break }
    }
    if (-not $OverviewHealthy) { throw "启动失败，请查看 $OverviewLog\server-error.log" }
}
if (-not $NoBrowser) { Start-Process $OverviewUrl }
Write-Output $OverviewUrl
