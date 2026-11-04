param(
    [string]$Config = 'E:/WuchengERP/development/config.json',
    [switch]$CheckOnly,
    [switch]$Debug
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try { $Host.UI.RawUI.WindowTitle = '五成 ERP · 开发版运行状态' } catch {}
$logLevel = if ($Debug) { 'debug' } elseif ($env:ERP_LOG_LEVEL) { $env:ERP_LOG_LEVEL } else { 'info' }
$workspace = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if ($settings.mode -ne 'development') { throw '此入口仅允许使用隔离开发配置。' }
$origin = 'http://127.0.0.1:' + $settings.port
$logDir = Split-Path $Config -Parent
$stdout = Join-Path $logDir 'stdout.log'
$stderr = Join-Path $logDir 'stderr.log'
$webLog = Join-Path $logDir 'logs\web.log'

function Test-ErpHealth {
    try { return [bool](Invoke-RestMethod ($origin + '/api/workbench/v1/health') -TimeoutSec 2).ok }
    catch { return $false }
}

# 只读新增的完整行，避免每轮重复打印最后几行。
. (Join-Path $PSScriptRoot 'console-logs.ps1')

if ($CheckOnly) {
    [pscustomobject]@{ Workspace = $workspace; Mode = $settings.mode; Address = $origin; Running = (Test-ErpHealth); Log = $webLog }
    return
}
$created = $false
$mutex = [Threading.Mutex]::new($true, ('Local\WuchengERPDevConsole-' + $settings.port), [ref]$created)
if (-not $created) {
    Write-Host '开发服务已由另一个控制台管理，请使用原窗口。' -ForegroundColor Yellow
    $mutex.Dispose()
    return
}
Add-Type -Path (Join-Path $PSScriptRoot 'console-job.cs')
$job = [ErpConsoleJob]::Create()
$node = (Get-Command node.exe -ErrorAction Stop).Source
try {
Write-Host '五成 ERP · 源码开发版' -ForegroundColor Cyan
Write-Host ('访问地址：' + $origin)
Write-Host ('实时日志：' + $stdout + '   ' + $stderr)
Write-Host ('历史日志：' + $webLog)
Write-Host ('日志级别：' + $(if ($logLevel -eq 'debug') { 'debug（记录每个请求，排查用）' } else { 'info（错误、告警、慢请求、模块启停）' }))
Write-Host '关闭此窗口将停止开发服务及全部模块；重新双击 BAT 可启动。'
Write-Host ''
if (Test-ErpHealth) {
    Write-Host '正在将现有开发服务切换为控制台管理……' -ForegroundColor Yellow
    & $node (Join-Path $workspace 'server/cli.mjs') stop --config $Config
    if ($LASTEXITCODE -ne 0 -or (Test-ErpHealth)) { throw '原开发服务未能停止，取消启动。' }
}
if (-not (Test-ErpHealth)) {
    Write-Host '正在启动服务……' -ForegroundColor Yellow
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $arguments = @('server/cli.mjs', 'dev', '--config', ('"' + $Config + '"'))
    if ($Debug) { $arguments += '--debug' }
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    if (-not [ErpConsoleJob]::AssignProcessToJobObject($job, $process.Handle)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw '无法绑定服务进程到控制台，已取消启动。'
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Test-ErpHealth) { $ready = $true; break }
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready) {
        Write-Host '启动未成功，请查看以下错误和日志文件。' -ForegroundColor Red
        if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -Tail 20 -Encoding UTF8 | ForEach-Object { Write-ErpLine $_ } }
        if (Test-Path $stdout) { Get-Content -LiteralPath $stdout -Tail 20 -Encoding UTF8 | ForEach-Object { Write-ErpLine $_ } }
        if (Test-Path $webLog) { Write-Host ('--- 历史日志：' + $webLog + ' ---') -ForegroundColor DarkGray; Get-Content -LiteralPath $webLog -Tail 20 -Encoding UTF8 | ForEach-Object { Write-ErpLine $_ } }
        return
    }
} else {
    Write-Host '检测到服务已经启动，直接复用。' -ForegroundColor Green
    foreach ($file in @($stdout, $stderr)) { Skip-Existing -File $file }
}
Start-Process ($origin + '/#sales')
$previous = $null
$lastError = ''
while ($true) {
    $running = Test-ErpHealth
    if ($running -ne $previous) {
        $label = if ($running) { '运行中 · 可以正常访问' } else { '服务无响应或已停止 · 请检查日志，重新打开入口可启动' }
        $color = if ($running) { 'Green' } else { 'Red' }
        Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $label) -ForegroundColor $color
        $previous = $running
    }
    foreach ($file in @($stdout, $stderr)) {
        foreach ($line in (Read-NewLines -File $file)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            Write-ErpLine -Line $line
            if ($line -match '\sERROR\s') { $lastError = $line.Trim() }
        }
    }
    $title = '五成 ERP · ' + $(if ($running) { '运行中' } else { '服务无响应/已停止' }) + ' · 检查于 ' + (Get-Date -Format 'HH:mm:ss')
    if ($lastError) { $title = $title + ' · 最近错误：' + $lastError.Substring(0, [Math]::Min(70, $lastError.Length)) }
    try { $Host.UI.RawUI.WindowTitle = $title } catch {}
    Start-Sleep -Seconds 1
}

} finally {
    try { & $node (Join-Path $workspace 'server/cli.mjs') stop --config $Config } catch {}
    [void][ErpConsoleJob]::CloseHandle($job)
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
