param(
    [string]$ConfigPath = 'E:\WuchengERP\config.json',
    [string]$BackupPath = 'E:\WuchengERP\backups\nas-precutover-20261104'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请以管理员身份运行；备份需要暂时停止并重新启动 WuchengERPWeb 服务。'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'ERP 配置文件不存在。' }
if (Test-Path -LiteralPath $BackupPath) { throw '目标备份目录已存在，拒绝覆盖。' }

Push-Location -LiteralPath $repo
try {
    & $node 'server/cli.mjs' backup --config $ConfigPath --output $BackupPath
    if ($LASTEXITCODE -ne 0) { throw '正式账本备份失败。' }
    & $node 'server/cli.mjs' verify-backup --backup $BackupPath
    if ($LASTEXITCODE -ne 0) { throw '备份完整性校验失败。' }
    $service = Get-Service -Name WuchengERPWeb -ErrorAction Stop
    if ($service.Status -ne 'Running') { throw '备份后 ERP Windows 服务未恢复运行。' }
    Write-Output "备份及校验成功：$BackupPath"
} finally {
    Pop-Location
}
